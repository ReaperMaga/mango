<script setup lang="ts">
import { Terminal, type ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { call, on, openExternal } from '~/composables/useBackend'
import type { PtyDataEvent, PtyExitEvent } from '~/types/ipc'

/**
 * A small interactive terminal that runs one command (an agent CLI's sign-in)
 * in a PTY. The CLIs print a link, may open the browser and may ask for a
 * pasted code, so this is a real terminal: typing, paste, selection, links.
 * The PTY is killed when the component unmounts.
 */
const props = withDefaults(defineProps<{
  /** argv of the program to run, e.g. ['claude', 'auth', 'login'] */
  command: string[]
  /** accessible name of the terminal */
  label: string
  rows?: number
}>(), { rows: 14 })

const emit = defineEmits<{
  /** the process ended on its own */
  exit: [code: number | null]
  /** the process could not be started */
  failed: [message: string]
  /** a sign-in link appeared in the output */
  link: [url: string]
}>()

const host = ref<HTMLElement | null>(null)

let term: Terminal | null = null
let fitAddon: FitAddon | null = null
let disposed = false
let ptyId: string | null = null
let exited = false
/** While the spawn is in flight we don't know our id yet: park events here. */
let backlog: Array<{ kind: 'data'; e: PtyDataEvent } | { kind: 'exit'; e: PtyExitEvent }> | null = null
let ptySize = { cols: 0, rows: 0 }
const unlisteners: Array<() => void> = []
let resizeObserver: ResizeObserver | null = null
let themeObserver: MutationObserver | null = null
let fitFrame = 0
let resizeTimer: ReturnType<typeof setTimeout> | undefined
let heightPinned = false

/* ------------------------------------------------------------------ */
/* Theme: xterm wants hex/rgb, tokens are oklch -> paint & read back    */
/* (same approach as terminal/TerminalView.vue)                         */
/* ------------------------------------------------------------------ */

let paintCtx: CanvasRenderingContext2D | null | undefined
const SENTINEL = '#010203'

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

const hex2 = (n: number) => Math.round(Math.min(255, Math.max(0, n))).toString(16).padStart(2, '0')

function toHex(value: string, fallback: string): string {
  if (!value) return fallback
  if (paintCtx === undefined) {
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 1
    paintCtx = canvas.getContext('2d', { willReadFrequently: true })
  }
  const ctx = paintCtx
  if (!ctx) return fallback
  ctx.clearRect(0, 0, 1, 1)
  ctx.fillStyle = SENTINEL
  ctx.fillStyle = value
  if (String(ctx.fillStyle).toLowerCase() === SENTINEL && value.toLowerCase() !== SENTINEL) return fallback
  ctx.fillRect(0, 0, 1, 1)
  const [r = 0, g = 0, b = 0, a = 255] = ctx.getImageData(0, 0, 1, 1).data
  return `#${hex2(r)}${hex2(g)}${hex2(b)}${a < 255 ? hex2(a) : ''}`
}

function shade(hex: string, t: number): string {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(hex)
  if (!m || t === 0) return hex
  const target = t > 0 ? 255 : 0
  const k = Math.abs(t)
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
/* Sizing: a fixed number of rows, columns follow the width             */
/* ------------------------------------------------------------------ */

const measurable = () => !!host.value && host.value.offsetParent !== null

/** Make the box exactly `rows` cells tall, using the cell height xterm measured. */
function pinHeight() {
  if (heightPinned || !host.value || !term) return
  const screen = host.value.querySelector<HTMLElement>('.xterm-screen')
  const h = screen?.offsetHeight ?? 0
  if (h < 8 || term.rows < 1) return
  host.value.style.height = `${Math.ceil((h / term.rows) * props.rows) + 1}px`
  heightPinned = true
}

function fitNow() {
  if (!term || !fitAddon || !measurable()) return
  pinHeight()
  try {
    fitAddon.fit()
  } catch { /* renderer not ready yet */ }
  syncPtySize()
}

function scheduleFit() {
  if (fitFrame) return
  fitFrame = requestAnimationFrame(() => {
    fitFrame = 0
    fitNow()
  })
}

function syncPtySize() {
  if (!term || !ptyId || exited) return
  if (term.cols === ptySize.cols && term.rows === ptySize.rows) return
  clearTimeout(resizeTimer)
  resizeTimer = setTimeout(() => {
    if (!term || !ptyId || exited) return
    const { cols, rows } = term
    if (cols === ptySize.cols && rows === ptySize.rows) return
    ptySize = { cols, rows }
    call('pty_resize', { id: ptyId, cols, rows }).catch(() => {})
  }, 60)
}

/* ------------------------------------------------------------------ */
/* Sign-in link: lift it out of the output so it can be offered as a    */
/* button too (a wrapped link is hard to hit, and a browser may not     */
/* open on its own).                                                    */
/* ------------------------------------------------------------------ */

let seen = ''
let lastLink = ''
const LINK = /https?:\/\/[^\s\x07\x1b"'<>]+(?=[\s\x07\x1b"'<>])/g
const LOCAL = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])([:/]|$)/i

function scanLinks(chunk: string) {
  seen = (seen + chunk).slice(-16384)
  let found = ''
  for (const m of seen.matchAll(LINK)) {
    const url = m[0].replace(/[.,;:)\]]+$/, '')
    // The CLI's own callback server is not something to open.
    if (!LOCAL.test(url)) found = url
  }
  if (found && found !== lastLink) {
    lastLink = found
    emit('link', found)
  }
}

/* ------------------------------------------------------------------ */
/* Clipboard                                                           */
/* ------------------------------------------------------------------ */

function copySelection() {
  const text = term?.getSelection()
  if (!text) return
  const fallback = () => {
    // xterm answers the copy event with its own selection.
    try { document.execCommand('copy') } catch { /* nothing else to try */ }
  }
  if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).catch(fallback)
  else fallback()
}

/** Return false to keep a key away from the PTY and leave it to the webview. */
function keyFilter(e: KeyboardEvent): boolean {
  const mod = e.ctrlKey || e.metaKey
  const k = e.key.toLowerCase()

  // Tab moves focus on. Sign-in prompts never need it, and without this the
  // terminal would be a keyboard trap inside a settings page.
  if (e.key === 'Tab' && !mod && !e.altKey) return false

  // Copy: Ctrl+Shift+C / Cmd+C always; plain Ctrl+C only while text is
  // selected (otherwise it stays the interrupt key).
  if (mod && !e.altKey && k === 'c' && (e.shiftKey || e.metaKey || term?.hasSelection())) {
    if (e.type === 'keydown' && term?.hasSelection()) {
      copySelection()
      if (!e.metaKey) term.clearSelection()
      e.preventDefault()
    }
    return false
  }

  // Paste: let the webview raise its paste event; xterm forwards the text.
  if (mod && !e.altKey && k === 'v') return false
  if (e.shiftKey && e.key === 'Insert') return false

  return true
}

/* ------------------------------------------------------------------ */
/* PTY wiring                                                          */
/* ------------------------------------------------------------------ */

function handleData(e: PtyDataEvent) {
  if (backlog) {
    backlog.push({ kind: 'data', e })
    return
  }
  if (e.id !== ptyId) return
  term?.write(e.data)
  scanLinks(e.data)
}

function handleExit(e: PtyExitEvent) {
  if (backlog) {
    backlog.push({ kind: 'exit', e })
    return
  }
  if (e.id !== ptyId || exited) return
  exited = true
  const what = e.code == null ? 'process ended' : `process exited with code ${e.code}`
  // Nothing left to type into: hide the cursor.
  term?.write(`\r\n\x1b[2m[${what}]\x1b[0m\x1b[?25l`)
  emit('exit', e.code)
}

async function spawn() {
  if (!term || disposed) return
  backlog = []
  try {
    const { cols, rows } = term
    const id = await call('pty_spawn', { cwd: null, cols, rows, command: props.command })
    if (disposed) {
      call('pty_kill', { id }).catch(() => {})
      return
    }
    ptyId = id
    ptySize = { cols, rows }
    const parked = backlog
    backlog = null
    for (const item of parked) {
      if (item.kind === 'data') handleData(item.e)
      else handleExit(item.e)
    }
    syncPtySize()
  } catch (err) {
    backlog = null
    exited = true
    const msg = err instanceof Error ? err.message : String(err)
    term?.write(`\x1b[31mCould not start ${props.command.join(' ')}:\x1b[0m ${msg}\r\n\x1b[?25l`)
    emit('failed', msg)
  } finally {
    backlog = null
  }
}

function kill() {
  if (ptyId && !exited) call('pty_kill', { id: ptyId }).catch(() => {})
  exited = true
}

async function loadFonts(family: string) {
  try {
    await Promise.all([
      document.fonts.load(`12.5px ${family}`),
      document.fonts.load(`bold 12.5px ${family}`),
    ])
  } catch { /* fall back to whatever is available */ }
}

onMounted(async () => {
  // Subscribe before spawning so no early output is lost.
  const subs = Promise.all([on('pty://data', handleData), on('pty://exit', handleExit)])
  const fontFamily = cssVar('--font-mono') || 'monospace'
  await loadFonts(fontFamily)
  const offs = await subs
  if (disposed) {
    offs.forEach(off => off())
    return
  }
  unlisteners.push(...offs)
  if (!host.value) return

  const open = (uri: string) => {
    if (/^https?:\/\//i.test(uri)) openExternal(uri).catch(() => {})
  }

  term = new Terminal({
    rows: props.rows,
    cols: 80,
    fontFamily,
    fontSize: 12.5,
    lineHeight: 1.25,
    cursorBlink: true,
    cursorStyle: 'bar',
    cursorInactiveStyle: 'outline',
    allowProposedApi: false,
    scrollback: 2000,
    macOptionIsMeta: true,
    theme: buildTheme(),
    // Links the CLI marks up itself (OSC 8). Without a handler xterm asks
    // through window.confirm and window.open, which is wrong in a desktop app.
    linkHandler: { activate: (_event, uri) => open(uri) },
  })
  fitAddon = new FitAddon()
  term.loadAddon(fitAddon)
  // Plain URLs in the output.
  term.loadAddon(new WebLinksAddon((event, uri) => {
    event.preventDefault()
    open(uri)
  }))
  term.attachCustomKeyEventHandler(keyFilter)
  term.open(host.value)
  if (term.textarea) term.textarea.setAttribute('aria-label', props.label)

  term.onData((data) => {
    if (exited || !ptyId) return
    call('pty_write', { id: ptyId, data }).catch(() => {})
  })

  fitNow()

  resizeObserver = new ResizeObserver(scheduleFit)
  resizeObserver.observe(host.value.parentElement ?? host.value)

  themeObserver = new MutationObserver(() => {
    if (term) term.options.theme = buildTheme()
  })
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-scheme'] })

  term.focus()
  await spawn()
})

onBeforeUnmount(() => {
  disposed = true
  unlisteners.splice(0).forEach(off => off())
  resizeObserver?.disconnect()
  themeObserver?.disconnect()
  cancelAnimationFrame(fitFrame)
  clearTimeout(resizeTimer)
  kill()
  term?.dispose()
  term = null
  fitAddon = null
})

defineExpose({ focus: () => term?.focus(), kill })
</script>

<template>
  <div class="login-term" role="group" :aria-label="label">
    <div ref="host" class="login-term__host" />
  </div>
</template>

<style scoped>
/* Padding lives on the wrapper: FitAddon measures the host's parent box. */
.login-term {
  padding: var(--space-2) 10px;
  background: var(--term-bg);
}
.login-term__host {
  width: 100%;
  /* Until xterm has measured a cell; pinHeight() then sets the exact height. */
  height: 280px;
  overflow: hidden;
}
.login-term__host :deep(.xterm) {
  height: 100%;
}
/* xterm.css paints the viewport #000 and v6 no longer themes it: let --term-bg show. */
.login-term__host :deep(.xterm .xterm-viewport) {
  background-color: transparent;
}
.login-term__host :deep(.xterm-screen) {
  cursor: text;
}
</style>
