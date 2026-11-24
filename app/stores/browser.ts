import { defineStore } from 'pinia'
import type { BrowserBounds } from '~/types/ipc'
import { call, isTauri, on } from '~/composables/useBackend'
import { t } from '~/i18n'
import { overlayOpen } from '~/composables/useOverlay'
import { useThreads } from '~/stores/threads'
import { useWorkspace } from '~/stores/workspace'
import { browserTabId, hostOf, isBlank, isLocalDevUrl, parseBrowserTab } from '~/utils/browserTabs'

/**
 * Browsers: real pages in tabs beside the chats. Inside the app each one is a native
 * webview (src-tauri/src/browser.rs) laid over the main window where its tab's pane is,
 * created with the tab and kept until the tab closes, so a page keeps its state while
 * another tab is in front. Native views are drawn above all HTML: this store moves them
 * with their panes every frame and hides them whenever their tab is not on screen or a
 * menu, dialog or other layer floats over the workspace (composables/useOverlay.ts).
 *
 * An agent's browser tools (an MCP server Mango runs per chat) drive the same webviews;
 * the first call in a chat with no browser asks for one (`browser://agent-open`).
 * A remote project's browser reaches the environment's own localhost through an SSH tunnel
 * (the backend's business: it gets the project with `browser_open`).
 * The browser preview (`pnpm dev`) has no native webview: the pane shows a sandboxed iframe.
 */
export interface Browser {
  id: string
  projectPath: string
  /** The page's address; about:blank until something is loaded. */
  url: string
  title: string
  loading: boolean
  /** The chat whose agent opened it (its top-level chat). */
  threadId?: string
  /** Why the webview could not be created or the page could not be loaded. */
  error?: string
  /** Bumped to reload the preview's iframe (the browser preview only). */
  reloads: number
}

const newId = () => `b${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`

/* Not state: the webviews' bookkeeping. */
/** Resolves once `browser_open` has created the webview (rejects when it could not). */
const ready = new Map<string, Promise<void>>()
/** The placeholder element each shown browser's webview covers. */
const hosts = new Map<string, HTMLElement>()
/** What the webview was last told (`x,y,w,h` or `hidden`), and the call in flight. */
const sent = new Map<string, string>()
const sending = new Set<string>()
let lastBounds: BrowserBounds = { x: 0, y: 0, width: 800, height: 600 }
let frame = 0
/** Set once `init` has run: webviews are created only after the reset that starts it. */
let started: Promise<void> | null = null

const errorText = (e: unknown) => (e instanceof Error ? e.message : typeof e === 'string' ? e : t('terminal.browser.crashed'))

export const useBrowser = defineStore('browser', {
  state: () => ({
    browsers: {} as Record<string, Browser>,
  }),

  getters: {
    byId: s => (id: string | null | undefined): Browser | null => (id ? s.browsers[id] ?? null : null),
    /** The browser a tab shows. */
    forTab: s => (tabId: string | null | undefined): Browser | null => {
      const p = parseBrowserTab(tabId)
      return p ? s.browsers[p.browserId] ?? null : null
    },
  },

  actions: {
    /** Once, when the app starts: drop webviews a reloaded UI left behind, and listen. */
    init(): Promise<void> {
      started ??= this._init()
      return started
    },
    async _init() {
      if (isTauri()) await call('browser_reset', {}).catch(() => {})
      await on('browser://state', (s) => {
        const b = this.browsers[s.id]
        if (!b) return
        // The blank page a webview starts on says nothing about the page on its way.
        if (!isBlank(s.url) || isBlank(b.url)) b.url = s.url
        b.title = s.title
        b.loading = s.loading
        if (s.loading) b.error = undefined
      })
      await on('browser://agent-open', ({ id, threadId, url }) => this._agentOpen(id, threadId, url))
      watch(overlayOpen, kick)
      // A project closed in the window: its browsers go with it.
      const ws = useWorkspace()
      watch(() => ws.openProjects.map(p => p.path), (paths) => {
        const threads = useThreads()
        for (const b of Object.values(this.browsers)) {
          if (paths.includes(b.projectPath)) continue
          const tabId = browserTabId(b.projectPath, b.id)
          if (threads.tabs.includes(tabId)) threads.closeTab(tabId)
          else this.forget(b.id)
        }
      })
    },

    /**
     * A new browser tab in `projectPath`, its webview created hidden. `show`: 'here' puts it in
     * the active pane, 'beside' next to `beside` (a tab, usually the chat it is for) without
     * moving the focus, false only adds the tab. Returns the browser's id.
     */
    open(projectPath: string, url = 'about:blank', opts: { id?: string; threadId?: string; show?: 'here' | 'beside' | false; beside?: string | null } = {}): string {
      const id = opts.id ?? newId()
      const threads = useThreads()
      const tabId = browserTabId(projectPath, id)
      if (!this.browsers[id]) {
        this.browsers[id] = { id, projectPath, url, title: '', loading: !isBlank(url), reloads: 0, ...(opts.threadId ? { threadId: opts.threadId } : {}) }
        const created = this.init().then(() => call('browser_open', { id, url, bounds: lastBounds, visible: false, projectPath }))
        ready.set(id, created)
        created.then(kick, (e) => {
          const b = this.browsers[id]
          if (b) { b.error = errorText(e); b.loading = false }
        })
      }
      const show = opts.show ?? 'here'
      if (show === 'here') threads.show(tabId)
      else if (show === 'beside') threads.showBeside(tabId, opts.beside ?? null)
      else if (!threads.tabs.includes(tabId)) threads.addTab(tabId, opts.beside ?? null)
      return id
    },

    /** A new, empty browser tab in the active project, in the active pane. */
    openNew() {
      const ws = useWorkspace()
      if (!ws.activeProjectPath) return null
      return this.open(ws.activeProjectPath)
    },

    /**
     * A link to a page on this computer (a dev server) from a chat or a terminal: in a browser
     * tab beside the chat. A browser of the project already on that server loads it instead of
     * piling up tabs. False when the link is not for Mango's browser (the caller opens it as
     * it always has). In a remote project "localhost" is the environment's: the backend
     * tunnels it there.
     */
    openLink(url: string, projectPath: string | null, beside: string | null = null): boolean {
      if (!projectPath || !isLocalDevUrl(url)) return false
      const origin = new URL(url).origin
      const same = Object.values(this.browsers).find(b => b.projectPath === projectPath && !isBlank(b.url) && safeOrigin(b.url) === origin)
      const threads = useThreads()
      if (same) {
        const tabId = browserTabId(projectPath, same.id)
        if (!threads.panes.some(p => p.threadId === tabId)) threads.showBeside(tabId, beside)
        void this.navigate(same.id, url)
      } else {
        this.open(projectPath, url, { show: 'beside', beside })
      }
      return true
    },

    /** Load a page (a full URL: utils/browserTabs.ts `normalizeAddress` makes one of what was typed). */
    async navigate(id: string, url: string) {
      const b = this.browsers[id]
      if (!b) return
      b.url = url
      b.title = ''
      b.error = undefined
      b.loading = !isBlank(url)
      if (!isTauri()) b.reloads++
      try {
        await ready.get(id)
        await call('browser_navigate', { id, url })
      } catch (e) {
        const now = this.browsers[id]
        if (now) { now.error = errorText(e); now.loading = false }
      }
      kick()
    },

    async go(id: string, action: 'back' | 'forward' | 'reload' | 'stop') {
      const b = this.browsers[id]
      if (!b) return
      if (!isTauri()) {
        // The preview's iframe is another site's page: only a reload is in reach.
        if (action === 'reload') b.reloads++
        return
      }
      // Nothing to go back to, or a webview that never came: the toolbar has nothing better to say.
      await ready.get(id)?.then(() => call('browser_go', { id, action })).catch(() => {})
    },

    async devtools(id: string) {
      await ready.get(id)?.catch(() => {})
      await call('browser_devtools', { id }).catch(() => {})
    },

    /** The tab closed (threads.closeTab): the webview goes. */
    forget(id: string) {
      if (!this.browsers[id]) return
      delete this.browsers[id]
      hosts.delete(id)
      sent.delete(id)
      const created = ready.get(id)
      ready.delete(id)
      void (created ?? Promise.resolve()).catch(() => {}).then(() => call('browser_close', { id })).catch(() => {})
    },

    /** A pane shows the browser: its webview follows `el` until `detach`. */
    attach(id: string, el: HTMLElement) {
      hosts.set(id, el)
      kick()
    },
    detach(id: string, el: HTMLElement) {
      if (hosts.get(id) === el) hosts.delete(id)
      kick()
    },

    /** An agent called a browser tool in a chat with no browser: open one for it, with this id. */
    _agentOpen(id: string, threadId: string, url: string) {
      const threads = useThreads()
      const root = threads.rootOf(threadId)
      if (!root) return
      const target = isBlank(url) ? 'about:blank' : url
      const ws = useWorkspace()
      if (this.browsers[id]) {
        if (!isBlank(url)) void this.navigate(id, url)
        return
      }
      const shown = ws.activeProjectPath === root.projectPath && threads.panes.some(p => p.threadId === root.id)
      this.open(root.projectPath, target, { id, threadId: root.id, show: shown ? 'beside' : false, beside: root.id })
    },
  },
})

function safeOrigin(url: string) {
  try { return new URL(url).origin } catch { return null }
}

/* ---------- keeping the native webviews over their panes ---------- */

/** Look again on the next frame (and every frame while a browser is on screen). */
function kick() {
  if (!frame && typeof window !== 'undefined') frame = requestAnimationFrame(sync)
}

function sync() {
  frame = 0
  if (!isTauri()) return
  const store = useBrowser()
  for (const b of Object.values(store.browsers)) {
    const el = hosts.get(b.id)
    let want = 'hidden'
    let bounds = lastBounds
    if (el?.isConnected && !overlayOpen.value && !isBlank(b.url) && !b.error) {
      const r = el.getBoundingClientRect()
      bounds = { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) }
      if (bounds.width >= 2 && bounds.height >= 2) {
        want = `${bounds.x},${bounds.y},${bounds.width},${bounds.height}`
        lastBounds = bounds
      }
    }
    if (sent.get(b.id) !== want) void send(b.id, want, bounds)
  }
  // Panes move without telling anyone (split drags, panels sliding in, the terminal growing): keep looking.
  if (hosts.size) frame = requestAnimationFrame(sync)
}

/** One call at a time per webview, so a quick hide-then-show cannot arrive the wrong way round. */
async function send(id: string, want: string, bounds: BrowserBounds) {
  if (sending.has(id)) return
  const created = ready.get(id)
  if (!created) return
  sending.add(id)
  try {
    await created
    await call('browser_bounds', { id, bounds, visible: want !== 'hidden' })
  } catch {
    // Not created, or gone: nothing to move.
  } finally {
    if (ready.has(id)) sent.set(id, want)
    sending.delete(id)
  }
  kick()
}

/** The tab title: the page's title, its host, or "New tab". */
export function browserTitle(b: Browser | null | undefined): string {
  if (!b) return t('terminal.browser.label')
  if (b.title.trim()) return b.title.trim()
  if (!isBlank(b.url)) return hostOf(b.url)
  return t('terminal.browser.newTab')
}

