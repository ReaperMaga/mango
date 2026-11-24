<script setup lang="ts">
import { Terminal, type ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { call, on, openExternal } from '~/composables/useBackend'
import { useWorkspace, type TerminalTab } from '~/stores/workspace'
import type { PtyDataEvent, PtyExitEvent } from '~/types/ipc'
import { enhanceTerminal, terminalFontFamily } from '~/utils/xtermSetup'
import { cssVar, hex2, toHex } from '~/utils/cssColor'
import { parseEnvPath } from '~/utils/envPath'
import { useBrowser } from '~/stores/browser'
import { useThreads } from '~/stores/threads'
import { useConnectivity } from '~/stores/connectivity'

/**
 * One xterm bound to one PTY. The panel keeps every view mounted (v-show)
 * so scrollback survives tab switches; `tab` is the store object and is
 * mutated in place (ptyId / exited). A terminal in the main area is the same
 * view, teleported into its pane: moving it never restarts the shell.
 */
const props = defineProps<{
  tab: TerminalTab
  /** this tab is the selected one */
  active: boolean
  /** the terminal panel is open */
  visible: boolean
  /** Where it is drawn ('panel' or a pane): a change moves the xterm's element, so it refits. */
  place?: string
}>()

const { t } = useI18n()
const ws = useWorkspace()
const host = ref<HTMLElement | null>(null)
/** The panel's height is animating (maximise, double-click): hold the grid and refit once, when it ends. */
const settling = inject<Readonly<Ref<boolean>>>('terminal-settling', ref(false))

/**
 * A link in the output: a dev server on this computer (`localhost:3000` from `npm run dev`)
 * opens in Mango's browser beside the chat in front; anything else in the system browser.
 * In a remote project that is the environment's localhost, tunnelled by the backend.
 */
function openLink(uri: string) {
  const threads = useThreads()
  const local = useBrowser().openLink(uri, ws.activeProjectPath, threads.activePane.threadId)
  if (!local) openExternal(uri).catch(() => {})
}

let term: Terminal | null = null
let fitAddon: FitAddon | null = null
let disposed = false
let spawning = false

/*
 * A remote tab whose `ssh` ended with 255 lost its connection (a deliberate exit has the shell's
 * own code): it starts a fresh shell when its server answers again (`useConnectivity`), not on a
 * timer. A shell that drops again within seconds of such a restart counts toward a limit, so a
 * server that answers checks but refuses shells ends in "press Enter" instead of a loop.
 */
const conn = useConnectivity()
/** The server this tab waits for (its host id), while it does. */
const waitingFor = ref<string | null>(null)
let shellStartedAt = 0
let autoRestarted = false
let quickDrops = 0
const QUICK_MS = 5_000
const MAX_QUICK_DROPS = 3
/** While a spawn is in flight we don't know our id yet: park events here. */
let backlog: Array<{ kind: 'data'; e: PtyDataEvent } | { kind: 'exit'; e: PtyExitEvent }> | null = null
/** Size last reported to the PTY. */
let ptySize = { cols: 0, rows: 0 }
const unlisteners: Array<() => void> = []
let resizeObserver: ResizeObserver | null = null
let themeObserver: MutationObserver | null = null
let fitFrame = 0
let resizeTimer: ReturnType<typeof setTimeout> | undefined

/* ------------------------------------------------------------------ */
/* Theme: xterm wants hex/rgb, tokens are oklch -> paint & read back    */
/* ------------------------------------------------------------------ */

/** Mix an opaque #rrggbb toward white (mix > 0) or black (mix < 0). */
function shade(hex: string, mix: number): string {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(hex)
  if (!m || mix === 0) return hex
  const target = mix > 0 ? 255 : 0
  const k = Math.abs(mix)
  return `#${[m[1], m[2], m[3]].map(c => hex2(parseInt(c!, 16) + (target - parseInt(c!, 16)) * k)).join('')}`
}

function buildTheme(): ITheme {
  const dark = document.documentElement.dataset.theme !== 'light'
  const c = (name: string, fallback: string) => toHex(cssVar(name), fallback)
  const lift = dark ? 0.14 : 0

  const bg = c('--term-bg', dark ? '#0f1311' : '#f6f8f7')
  const fg = c('--term-fg', dark ? '#e0e6e2' : '#2b322e')
  const black = c('--term-black', '#1a201d')
  const red = c('--term-red', '#f0766b')
  const green = c('--term-green', '#8fcf9a')
  const yellow = c('--term-yellow', '#f4c062')
  const blue = c('--term-blue', '#7fb2f0')
  const magenta = c('--term-magenta', '#d39af0')
  const cyan = c('--term-cyan', '#78d0c8')
  const white = c('--term-white', '#d9e0dc')

  return {
    background: bg,
    foreground: fg,
    cursor: c('--accent', fg),
    cursorAccent: bg,
    selectionBackground: c('--selection', '#f4c06247'),
    selectionInactiveBackground: c('--bg-active', '#ffffff1a'),
    scrollbarSliderBackground: c('--line', '#ffffff22'),
    scrollbarSliderHoverBackground: c('--line-strong', '#ffffff33'),
    scrollbarSliderActiveBackground: c('--fg-faint', '#ffffff44'),
    overviewRulerBorder: '#00000000',
    black,
    red,
    green,
    yellow,
    blue,
    magenta,
    cyan,
    white,
    brightBlack: c('--term-bright-black', shade(black, 0.3)),
    brightRed: shade(red, lift),
    brightGreen: shade(green, lift),
    brightYellow: shade(yellow, lift),
    brightBlue: shade(blue, lift),
    brightMagenta: shade(magenta, lift),
    brightCyan: shade(cyan, lift),
    brightWhite: dark ? shade(white, 0.5) : shade(white, -0.25),
  }
}

/* ------------------------------------------------------------------ */
/* Sizing                                                              */
/* ------------------------------------------------------------------ */

/** Hidden (v-show on us or the panel) -> no layout, don't fit. */
const measurable = () => !!host.value && host.value.offsetParent !== null

function fitNow() {
  if (!term || !fitAddon || !measurable()) return
  try {
    fitAddon.fit()
  } catch { /* renderer not ready yet */ }
  syncPtySize()
}

function scheduleFit() {
  if (fitFrame || settling.value) return
  fitFrame = requestAnimationFrame(() => {
    fitFrame = 0
    fitNow()
  })
}

/** Tell the PTY about the new grid; trailing-debounced so a drag doesn't spam SIGWINCH. */
function syncPtySize() {
  if (!term || !props.tab.ptyId || props.tab.exited) return
  if (term.cols === ptySize.cols && term.rows === ptySize.rows) return
  clearTimeout(resizeTimer)
  resizeTimer = setTimeout(() => {
    const id = props.tab.ptyId
    if (!term || !id || props.tab.exited) return
    const { cols, rows } = term
    if (cols === ptySize.cols && rows === ptySize.rows) return
    ptySize = { cols, rows }
    call('pty_resize', { id, cols, rows }).catch(() => {})
  }, 60)
}

/* ------------------------------------------------------------------ */
/* PTY wiring                                                          */
/* ------------------------------------------------------------------ */

function handleData(e: PtyDataEvent) {
  if (backlog) {
    backlog.push({ kind: 'data', e })
    return
  }
  if (e.id === props.tab.ptyId) term?.write(e.data)
}

function handleExit(e: PtyExitEvent) {
  if (backlog) {
    backlog.push({ kind: 'exit', e })
    return
  }
  if (e.id !== props.tab.ptyId || props.tab.exited) return
  props.tab.exited = true
  const env = parseEnvPath(props.tab.cwd)
  const lived = Date.now() - shellStartedAt
  // A quick 255 on a first start is a sign-in or address problem, which waiting would not fix.
  if (env && e.code === 255 && (lived >= QUICK_MS || autoRestarted)) {
    quickDrops = lived < QUICK_MS ? quickDrops + 1 : 0
    if (quickDrops < MAX_QUICK_DROPS) {
      waitingFor.value = env.hostId
      term?.write(`\r\n\x1b[2m${t('terminal.output.lost')}\x1b[0m\r\n\x1b[?25l`)
      conn.markDown(env.hostId)
      return
    }
  }
  quickDrops = 0
  waitingFor.value = null
  const what = e.code == null ? t('terminal.output.exited') : t('terminal.output.exitedCode', { code: e.code })
  // Hide the cursor while there's nothing to type into.
  term?.write(`\r\n\x1b[2m${what}\x1b[0m\r\n\x1b[?25l`)
}

async function spawn(auto = false) {
  if (!term || spawning || disposed) return
  spawning = true
  autoRestarted = auto
  waitingFor.value = null
  backlog = []
  try {
    const { cols, rows } = term
    // The tab's shell, if it is still installed; otherwise the backend's default.
    const profile = ws.terminalProfiles.find(p => p.id === props.tab.profileId)
    const command = profile ? [profile.path, ...profile.args] : null
    // A remote project's terminal is a login shell inside its instance; the rest works the same (a pty id).
    const remote = parseEnvPath(props.tab.cwd)
    const id = remote
      ? await call('env_shell', { hostId: remote.hostId, instance: remote.instance, cwd: remote.dir, cols, rows })
      : await call('pty_spawn', { cwd: props.tab.cwd, cols, rows, command })
    if (disposed) {
      call('pty_kill', { id }).catch(() => {})
      return
    }
    props.tab.ptyId = id
    props.tab.exited = false
    shellStartedAt = Date.now()
    term?.write('\x1b[?25h')
    ptySize = { cols, rows }
    const parked = backlog
    backlog = null
    for (const item of parked) {
      if (item.kind === 'data') handleData(item.e)
      else handleExit(item.e)
    }
    // The grid may have changed while we were waiting.
    syncPtySize()
  } catch (err) {
    backlog = null
    props.tab.exited = true
    const msg = err instanceof Error ? err.message : String(err)
    term?.write(`\x1b[31m${t('terminal.output.couldNotStart')}\x1b[0m ${msg}\r\n\x1b[2m${t('terminal.output.retry')}\x1b[0m\r\n\x1b[?25l`)
  } finally {
    backlog = null
    spawning = false
  }
}

async function loadFonts(family: string) {
  try {
    await Promise.all([
      document.fonts.load(`12.5px ${family}`),
      document.fonts.load(`bold 12.5px ${family}`),
    ])
    await document.fonts.ready
  } catch { /* fall back to whatever is available */ }
}

onMounted(async () => {
  // Subscribe before spawning so no early output is lost.
  const subs = Promise.all([on('pty://data', handleData), on('pty://exit', handleExit)])
  const fontFamily = terminalFontFamily(cssVar('--font-mono'))
  await loadFonts(fontFamily)
  const offs = await subs
  if (disposed) {
    offs.forEach(off => off())
    return
  }
  unlisteners.push(...offs)
  if (!host.value) return

  term = new Terminal({
    fontFamily,
    fontSize: ws.terminalFontSize,
    lineHeight: 1.25,
    cursorBlink: ws.terminalCursorBlink,
    cursorStyle: ws.terminalCursorStyle,
    cursorInactiveStyle: 'outline',
    // The unicode API (Unicode 11 widths) is still a proposed API.
    allowProposedApi: true,
    scrollback: 5000,
    macOptionIsMeta: true,
    theme: buildTheme(),
    // OSC 8 hyperlinks (CLIs print sign-in URLs this way): open in the system browser, no confirm dialog.
    linkHandler: { activate: (_event, uri) => openLink(uri) },
  })
  fitAddon = new FitAddon()
  term.loadAddon(fitAddon)
  term.loadAddon(new WebLinksAddon((event, uri) => {
    event.preventDefault()
    openLink(uri)
  }))
  term.open(host.value)
  enhanceTerminal(term)

  term.onData((data) => {
    if (props.tab.exited) {
      if (data === '\r' && !spawning) spawn()
      return
    }
    const id = props.tab.ptyId
    if (id) call('pty_write', { id, data }).catch(() => {})
  })

  fitNow()

  resizeObserver = new ResizeObserver(scheduleFit)
  resizeObserver.observe(host.value)

  themeObserver = new MutationObserver(async () => {
    if (!term) return
    term.options.theme = buildTheme()
    // A new code font (Settings > Appearance): load it, then refit to the new glyph size.
    const family = terminalFontFamily(cssVar('--font-mono'))
    if (term.options.fontFamily === family) return
    await loadFonts(family)
    if (!term) return
    term.options.fontFamily = family
    scheduleFit()
  })
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-scheme', 'data-font-mono'] })

  if (props.active && props.visible) term.focus()
  await spawn()
})

watch(settling, (moving) => { if (!moving) scheduleFit() })

// The server this tab lost is back: a fresh shell, in the same tab.
watch(() => (waitingFor.value ? conn.backAt[waitingFor.value] ?? 0 : 0), (at, before) => {
  if (!waitingFor.value || !at || at === before || !props.tab.exited) return
  term?.write(`\x1b[2m${t('terminal.output.reconnected')}\x1b[0m\r\n`)
  void spawn(true)
})

// Refit + focus when this tab is selected or the panel is reopened.
watch(() => props.active && props.visible, async (shown) => {
  if (!shown) return
  await nextTick()
  requestAnimationFrame(() => {
    fitNow()
    term?.focus()
  })
})

// Moved between the panel and a pane: the same xterm, in a box of another size.
watch(() => props.place, async () => {
  await nextTick()
  requestAnimationFrame(() => {
    fitNow()
    term?.refresh(0, term.rows - 1)
    if (props.active && props.visible) term?.focus()
  })
})

onBeforeUnmount(() => {
  disposed = true
  unlisteners.splice(0).forEach(off => off())
  resizeObserver?.disconnect()
  themeObserver?.disconnect()
  cancelAnimationFrame(fitFrame)
  clearTimeout(resizeTimer)

  // closeTerminal() already kills the PTY of a tab it removes; only kill
  // here when we're torn down for another reason (e.g. the workspace unmounts).
  const id = props.tab.ptyId
  const stillListed = ws.terminalTabs.some(x => x.id === props.tab.id)
  if (id && !props.tab.exited && stillListed) {
    call('pty_kill', { id }).catch(() => {})
    props.tab.ptyId = null
  }

  term?.dispose()
  term = null
  fitAddon = null
})

/* Terminal settings apply to open terminals straight away. */
watch(
  () => [ws.terminalFontSize, ws.terminalCursorStyle, ws.terminalCursorBlink] as const,
  ([size, style, blink]) => {
    if (!term) return
    term.options.fontSize = size
    term.options.cursorStyle = style
    term.options.cursorBlink = blink
    scheduleFit()
  },
)

defineExpose({ focus: () => term?.focus(), fit: fitNow })
</script>

<template>
  <div class="term-view" :class="{ 'is-exited': tab.exited }">
    <div ref="host" class="term-view__host" />
  </div>
</template>

<style scoped>
/* Padding lives on the wrapper: FitAddon measures the host's parent box. */
.term-view {
  height: 100%;
  min-height: 0;
  padding: 6px 10px;
  background: var(--term-bg);
}
.term-view__host {
  width: 100%;
  height: 100%;
  overflow: hidden;
}
.term-view__host :deep(.xterm) {
  height: 100%;
}
/* xterm.css paints the viewport #000 and v6 no longer themes it: let --term-bg show. */
.term-view__host :deep(.xterm .xterm-viewport) {
  background-color: transparent;
}
/* xterm content is meant to be selected; it handles its own selection. */
.term-view__host :deep(.xterm-screen) {
  cursor: text;
}
</style>
