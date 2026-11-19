import { defineStore } from 'pinia'
import { appWindow, call, isTauri, on, onWindows, postWindows, windowLabel } from '~/composables/useBackend'
import {
  MAIN_WINDOW, claimsFor, holderOf, lostChats, ownerOf, parseWindowQuery, returningChats, withClaims, withoutWindow,
  type ChatRef, type Claim, type ClaimTable, type WindowPlace, type WindowSpec,
} from '~/utils/windows'
import { flushHistory } from '~/utils/chatHistory'
import { flushRemoteChats } from '~/utils/remoteChats'
import { useThreads } from '~/stores/threads'
import { useWorkspace } from '~/stores/workspace'

/**
 * Mango's windows, from inside one of them: what this window shows (`spec`, from its URL), which
 * window holds which project or chat (`table`, see `utils/windows.ts`), and the messages that keep
 * the windows in step. Every window runs this store; the main window is the one Mango starts with.
 *
 * - `start()` asks the open windows what they hold (`who`), before any chat is loaded.
 * - A window's claims follow what it has open (`sync`, on every change). Claiming something another
 *   window holds is a `take`: each window that holds chats it would lose saves them, lets them go and
 *   answers; one with such a chat still running refuses, and the claim is given back.
 * - A window going away (`bye`, or the backend's `window://closed` when it crashed or was killed)
 *   returns what it held: the window that owns it next reads those chats from the database.
 * - `openProjectWindow` / `openChatWindow` open another window (`window_open`); the new window
 *   makes its own claim when it starts.
 */

type Body =
  | { t: 'who' }
  | { t: 'here'; claims: Claim[] }
  | { t: 'claims'; claims: Claim[] }
  | { t: 'take'; for: string; claims: Claim[] }
  | { t: 'taken'; ok: boolean; reason?: string }
  | { t: 'bye'; id: string }
  | { t: 'focus'; id: string }
type Message = Body & { from: string; inst: string; req?: string; to?: string }

/** This page's own id: two windows may briefly share a label (a reload), never this. */
const INST = Math.random().toString(36).slice(2, 10)
const reqId = () => `${INST}-${Math.random().toString(36).slice(2, 8)}`
/** Waiting on windows that were seen: after this long one that did not answer is taken as gone. */
const ANSWER_MS = 4000
/** The browser preview cannot list its windows: whoever answers this quickly is there. */
const PREVIEW_WHO_MS = 300

const sameClaims = (a: Claim[] = [], b: Claim[] = []) =>
  a.length === b.length && a.every(c => b.some(d => d.kind === c.kind && d.key === c.key))

/** Why a project's terminals keep it in this window, or null when it has none running here. */
function terminalBlocker(path: string): string | null {
  const n = useWorkspace().terminalsOf(path).length
  if (!n) return null
  return `${n === 1 ? 'A terminal is' : `${n} terminals are`} open for this project here, and terminals stay in their window. Close ${n === 1 ? 'it' : 'them'} first.`
}

const waiting = new Map<string, (m: Message) => void>()
let reclaimTimer: ReturnType<typeof setTimeout> | null = null
/** Chats coming back from a chat window that closed: shown as tabs once they are read (`_reclaim`). */
let returning: string[] = []
let syncing: Promise<void> = Promise.resolve()

export const useWindows = defineStore('windows', {
  state: () => ({
    /** This window's id: its label in the app (`main`, `w-<n>`). */
    self: MAIN_WINDOW,
    spec: { kind: 'main' } as WindowSpec,
    /** Each window's claims, this one's included. */
    table: {} as ClaimTable,
    /** Chats this window claims beyond its projects: one it opened on, ones still running in a project it closed. */
    chats: [] as string[],
    started: false,
    /** Something this window could not take over (shown in a notice). Not persisted. */
    refused: null as null | string,
    /** The main window, closed while others were open: hidden until something brings it back (`_park`). */
    parked: false,
  }),

  getters: {
    isMain: s => s.spec.kind === 'main',
    /** The window holding a project, when it is another one. */
    projectElsewhere: s => (path: string | null | undefined): string | null => {
      if (!path) return null
      const h = holderOf(s.table, { kind: 'project', key: path })
      return h && h !== s.self ? h : null
    },
    /** Whether this window owns a chat (see `ownerOf`). */
    owns: s => (chat: Pick<ChatRef, 'projectPath' | 'rootId'>): boolean => ownerOf(s.table, chat) === s.self,
    /** How many other windows are open. */
    others: s => Object.keys(s.table).filter(id => id !== s.self).length,
  },

  actions: {
    /** Once, before the chats load: who this window is, and what the other windows hold. */
    async start() {
      if (this.started) return
      this.started = true
      const parsed = parseWindowQuery(typeof location === 'undefined' ? '' : location.search)
      const { id, ...spec } = parsed as WindowSpec & { id?: string }
      this.spec = spec as WindowSpec
      this.self = windowLabel() ?? (spec.kind === 'main' ? MAIN_WINDOW : id ?? `w-${INST}`)
      this.table = { [this.self]: [] }
      await onWindows(m => this._receive(m as Message))
      if (isTauri()) await on('window://closed', ({ label }) => { if (label !== this.self) this._gone(label) })
      const peers = isTauri() ? (await call('window_list', {}).catch(() => [] as string[])).filter(l => l !== this.self) : null
      if (!peers || peers.length) {
        for (const m of await this._ask({ t: 'who' }, peers, peers ? ANSWER_MS : PREVIEW_WHO_MS)) {
          if (m.t === 'here') this.table = { ...this.table, [m.from]: m.claims }
        }
      }
      // Leaving: what this window held goes back. A window that is closed on purpose has saved
      // first (`_closing`); a reload just says goodbye, and takes its things again when it is back.
      window.addEventListener('pagehide', () => { void this._post({ t: 'bye', id: this.self }) })
      if (!this.isMain) void appWindow.onClose(() => this._closing())
      // The main window closed while others are open: the backend hid it; it lets go of its projects.
      else if (isTauri()) {
        await on('window://parked', () => { void this._park() })
        window.addEventListener('focus', () => { this.parked = false })
      }
    },

    /**
     * Keep this window's claims in step with what it has open. Call after the chats and projects
     * have loaded; it then follows the open projects by itself.
     */
    follow() {
      const ws = useWorkspace()
      watch(() => ws.openProjects.map(p => p.path).join('\n'), () => { void this.sync() }, { immediate: true })
      if (this.spec.kind === 'chat') this._followOwnTab(this.spec.threadId)
    },

    /** A chat window lives for its chat: closing its tab (or deleting it) gives it back and closes the window. */
    _followOwnTab(id: string) {
      const threads = useThreads()
      let seen = false
      watch(() => threads.tabs.includes(id), (open) => {
        if (open) { seen = true; return }
        if (!seen) return
        const t = threads.byId(id)
        if (t && threads.isBusyChat(id)) {
          // A run cannot follow the chat to another window: keep it here until it is done.
          threads.show(id)
          useWorkspace().notify('Still working', `“${t.title}” stays in this window until it is done. Stop it first to return it.`)
          return
        }
        void this.returnChat()
      }, { immediate: true })
    },

    /** Claim what this window has open; give up what it closed. Runs one at a time. */
    sync(): Promise<void> {
      syncing = syncing.then(() => this._sync()).catch((e) => { console.error('Mango could not sync its windows:', e) })
      return syncing
    },

    async _sync(): Promise<void> {
      const ws = useWorkspace()
      const want = claimsFor(this.spec, ws.openProjects.map(p => p.path), this.chats)
      const have = this.table[this.self] ?? []
      const added = want.filter(c => !have.some(h => h.kind === c.kind && h.key === c.key))
      if (added.length) {
        const reason = await this.take(this.self, added)
        if (reason) {
          // Someone else keeps it: show the reason, and close what could not be had.
          this.refused = reason
          for (const c of added) if (c.kind === 'project') ws.closeProject(c.key)
          if (this.spec.kind === 'chat' && added.some(c => c.key === (this.spec as { threadId: string }).threadId)) void appWindow.close()
          return
        }
        await this._reclaim()
      }
      const removed = have.filter(h => !want.some(c => c.kind === h.kind && c.key === h.key))
      if (removed.length) {
        const next = { ...this.table, [this.self]: want }
        // Closed here but still running: those chats stay claimed until this window closes.
        const threads = useThreads()
        const lose = lostChats(threads.heldRefs(), next, this.self)
        const busy = lose.filter(c => threads.isBusyChat(c.rootId)).map(c => c.rootId)
        if (busy.length) {
          this.chats = [...new Set([...this.chats, ...busy])]
          return this._sync()
        }
        if (lose.length) {
          await flushHistory()
          threads.release(lose.map(c => c.id))
        }
        this.table = next
        await this._post({ t: 'claims', claims: want })
      }
    },

    /**
     * Make `window` the holder of `claims`. Every window holding chats that move saves and lets them
     * go first. Resolves to null, or the reason it was refused (a chat still running there).
     */
    async take(window: string, claims: Claim[]): Promise<string | null> {
      const before = this.table[window] ?? []
      const next = withClaims(this.table, window, claims)
      const mine = await this._give(next)
      if (mine) return mine
      this.table = next
      const peers = Object.keys(this.table).filter(id => id !== this.self && id !== window)
      const answers = peers.length ? await this._ask({ t: 'take', for: window, claims }, peers, ANSWER_MS) : []
      const refused = answers.find(m => m.t === 'taken' && !m.ok)
      if (!refused) return null
      // Give it all back: the windows that let go take their chats again.
      if (window === this.self) {
        this.table = { ...this.table, [this.self]: before }
        await this._post({ t: 'claims', claims: before })
      } else {
        this.table = withoutWindow(this.table, window)
        await this._post({ t: 'bye', id: window })
      }
      return (refused as { reason?: string }).reason ?? 'Another window is using it.'
    },

    /** Let go of the chats this window would lose under `next` (saved first). The reason when it cannot. */
    async _give(next: ClaimTable): Promise<string | null> {
      const threads = useThreads()
      const lose = lostChats(threads.heldRefs(), next, this.self)
      const busy = lose.find(c => threads.isBusyChat(c.id))
      if (busy) {
        const t = threads.byId(busy.rootId) ?? threads.byId(busy.id)
        return `“${t?.title ?? 'A chat'}” is still working in another window. Stop it there first, or wait until it is done.`
      }
      // A chat window shows its chat's project without holding it: that project stays open there.
      const ws = useWorkspace()
      const projects = this.spec.kind === 'chat' ? [] : [...ws.openProjects]
      // A project with shells open here stays here: a terminal cannot move to another window.
      for (const p of projects) {
        const h = holderOf(next, { kind: 'project', key: p.path })
        const shells = h && h !== this.self ? terminalBlocker(p.path) : null
        if (shells) return shells
      }
      if (lose.length) {
        await flushHistory()
        threads.release(lose.map(c => c.id))
        // Changes on their way to a remote project's environment go before another window takes over.
        void flushRemoteChats()
      }
      // Projects that go to another window leave this one.
      for (const p of projects) {
        const h = holderOf(next, { kind: 'project', key: p.path })
        if (h && h !== this.self) ws.lend(p.path)
      }
      return null
    },

    /** Read the chats this window now owns but does not hold yet, and take back projects lent out. */
    async _reclaim() {
      const threads = useThreads()
      await threads.reclaim()
      useWorkspace().takeBackLent()
      const back = returning
      returning = []
      await this._reveal(back.filter(id => threads.byId(id)))
    },

    /** Chats that came back from their own window: their tabs open here, the last one in front. */
    async _reveal(ids: string[]) {
      // A parked main window does not pop up for them: they are in its sidebar once it is back.
      if (!ids.length || this.spec.kind === 'chat' || this.parked) return
      const threads = useThreads()
      const ws = useWorkspace()
      for (const id of ids) {
        const t = threads.byId(id)
        if (!t) continue
        // Its project was not open here (closed meanwhile): open it again.
        if (!ws.openProjects.some(p => p.path === t.projectPath)) {
          try { await ws.openProject(t.projectPath) } catch { continue }
        }
        threads.addTab(id)
      }
      const last = threads.byId(ids[ids.length - 1])
      if (!last || !ws.openProjects.some(p => p.path === last.projectPath)) return
      ws.setActiveProject(last.projectPath)
      threads.show(last.id)
    },

    _reclaimSoon() {
      if (reclaimTimer) clearTimeout(reclaimTimer)
      reclaimTimer = setTimeout(() => {
        reclaimTimer = null
        syncing = syncing.then(() => this._reclaim()).catch(() => {})
      }, 60)
    },

    /** A window is gone: forget its claims; what it held goes to whoever owns it next. */
    _gone(id: string) {
      if (!(id in this.table)) return
      returning = [...new Set([...returning, ...returningChats(this.table[id])])]
      this.table = withoutWindow(this.table, id)
      this._reclaimSoon()
    },

    /** This (not main) window is closing: stop its runs, save, say goodbye. */
    async _closing() {
      // The last window on screen (the main one is parked): its projects are what Mango reopens next time.
      if (isTauri() && await call('window_alone', {}).catch(() => false)) useWorkspace().handOverSession()
      await this._shutDown()
      await this._post({ t: 'bye', id: this.self })
    },

    /** Stop this window's runs and terminals, and save its chats. */
    async _shutDown() {
      const threads = useThreads()
      for (const c of threads.heldRefs()) if (threads.isBusyChat(c.id)) threads.stop(c.id)
      const ws = useWorkspace()
      for (const t of ws.terminalTabs) if (t.ptyId && !t.exited) await call('pty_kill', { id: t.ptyId }).catch(() => {})
      await flushHistory()
      await Promise.race([flushRemoteChats(), new Promise(r => setTimeout(r, 1500))])
    },

    /**
     * The main window was closed while other windows are open: the backend hid it instead (it holds
     * what no window claims, so it stays). Like a closed window it stops and saves what it ran, then
     * lets go of its projects so the other windows can open them. Shown again (another start of
     * Mango, a returned chat), it is on the welcome screen.
     */
    async _park() {
      this.parked = true
      await this._shutDown()
      this.chats = []
      useWorkspace().park()
      await this.sync()
    },

    async _receive(m: Message) {
      if (!m || typeof m !== 'object' || m.inst === INST) return
      if (m.to && m.to !== this.self) return
      if (m.req && waiting.has(m.req) && (m.t === 'here' || m.t === 'taken')) {
        waiting.get(m.req)!(m)
        return
      }
      switch (m.t) {
        case 'who':
          await this._post({ t: 'here', claims: this.table[this.self] ?? [] }, m)
          break
        case 'here':
          break
        case 'claims': {
          const next = { ...this.table, [m.from]: m.claims }
          await this._give(next)
          const shrank = (this.table[m.from] ?? []).some(c => !m.claims.some(n => n.kind === c.kind && n.key === c.key))
          this.table = next
          if (shrank) this._reclaimSoon()
          break
        }
        case 'take': {
          if (m.for === this.self) break
          const next = withClaims(this.table, m.for, m.claims)
          const reason = await this._give(next)
          if (!reason) this.table = next
          await this._post({ t: 'taken', ok: !reason, ...(reason ? { reason } : {}) }, m)
          break
        }
        case 'bye':
          if (m.id !== this.self) this._gone(m.id)
          break
        case 'focus':
          if (m.id === this.self) window.focus()
          break
      }
    },

    _post(body: Body, replyTo?: Message): Promise<void> {
      const m: Message = { ...body, from: this.self, inst: INST, ...(replyTo ? { req: replyTo.req, to: replyTo.from } : {}) }
      return postWindows(m)
    },

    /** Send `body` and collect the answers: from each of `peers`, or (null) whoever answers within `ms`. */
    async _ask(body: Body, peers: string[] | null, ms: number): Promise<Message[]> {
      const req = reqId()
      const got: Message[] = []
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, ms)
        function done() { clearTimeout(timer); waiting.delete(req); resolve() }
        waiting.set(req, (m) => {
          if (got.some(g => g.from === m.from)) return
          got.push(m)
          if (peers && peers.every(p => got.some(g => g.from === p))) done()
        })
        void postWindows({ ...body, from: this.self, inst: INST, req } satisfies Message).catch(done)
      })
      return got
    },

    /** A chat just made here: claim it when this window would not own it otherwise (a chat window). */
    claimNew(id: string, projectPath: string) {
      if (ownerOf(this.table, { projectPath, rootId: id }) === this.self) return
      this.chats = [...this.chats, id]
      void this.sync()
    },

    /** Bring a window to the front. */
    async focus(id: string) {
      if (isTauri()) await call('window_focus', { label: id }).catch(() => {})
      else await this._post({ t: 'focus', id })
    },

    /**
     * Why a project cannot move to another window now (a chat of it running here, or its terminals
     * open here), or null: a short `hint` for menu items and the full `reason`.
     */
    moveBlocker(path: string): { hint: string; reason: string } | null {
      const t = useThreads().busyIn(path)
      if (t) return { hint: 'A chat is still working', reason: `“${t.title}” is still working. Stop it first, or wait until it is done.` }
      const shells = terminalBlocker(path)
      return shells ? { hint: 'Its terminals stay in this window', reason: shells } : null
    },

    /**
     * Open a project in a window of its own (none: a new window on the welcome screen). Already open
     * in another window: that window comes to the front. Throws the reason when it cannot move now.
     */
    async openProjectWindow(path: string | null, place: WindowPlace = {}): Promise<void> {
      if (path) {
        const elsewhere = this.projectElsewhere(path)
        if (elsewhere) return this.focus(elsewhere)
        const blocked = this.moveBlocker(path)
        if (blocked) throw new Error(blocked.reason)
        // What is pending is on disk before the new window reads it.
        await flushHistory()
      }
      await call('window_open', { kind: 'project', path, ...place })
    },

    /** `openProjectWindow` for a menu or command: when it cannot, the user is told why. */
    async openInNewWindow(path: string | null) {
      try {
        await this.openProjectWindow(path)
      } catch (e) {
        useWorkspace().notify('Not opened in a new window', e instanceof Error ? e.message : String(e))
      }
    },

    /**
     * Open one chat (with its sub-agent chats) in a window of its own, e.g. at `place` where a tab
     * was dropped. The new window claims it when it starts; until then it stays here. Throws the reason
     * when it cannot move now. Already in another window: that one comes to the front.
     */
    async openChatWindow(threadId: string, place: WindowPlace = {}): Promise<void> {
      const threads = useThreads()
      const root = threads.rootOf(threadId)
      if (!root) {
        const h = holderOf(this.table, { kind: 'chat', key: threadId })
        if (h && h !== this.self) return this.focus(h)
        throw new Error('That chat is not in this window.')
      }
      if (threads.isBusyChat(root.id)) throw new Error(`“${root.title}” is still working. Stop it first, or wait until it is done.`)
      await flushHistory()
      await call('window_open', { kind: 'chat', threadId: root.id, path: root.projectPath, ...place })
    },

    /* ---------- a chat in a window of its own ---------- */

    /** Whether `id` is (a sub-agent chat of) this chat window's own chat. */
    isOwnChat(id: string): boolean {
      return this.spec.kind === 'chat' && useThreads().rootOf(id)?.id === this.spec.threadId
    },

    /** The menu entry that moves a chat to a window of its own, or (its own window) back. */
    moveChatAction(id: string): { label: string; hint?: string; disabled?: boolean; divider?: boolean; onSelect: () => void } {
      if (this.isOwnChat(id)) return { label: 'Return to main window', divider: true, onSelect: () => void this.returnChat() }
      const busy = useThreads().isBusyChat(id)
      return {
        label: 'Move to new window',
        divider: true,
        disabled: busy,
        hint: busy ? 'Still working' : undefined,
        onSelect: () => void this.moveChatToWindow(id),
      }
    },

    /** `openChatWindow` for a menu, a command or a drop: when it cannot, the user is told why. */
    async moveChatToWindow(id: string, place: WindowPlace = {}) {
      try {
        await this.openChatWindow(id, place)
      } catch (e) {
        useWorkspace().notify('Not moved to a new window', e instanceof Error ? e.message : String(e))
      }
    },

    /**
     * A chat's tab was let go outside the window, at `screen`. Its own window's chat goes back when it
     * lands on another Mango window; any other chat opens in a new window at `place`.
     */
    async tearOff(id: string, place: WindowPlace, screen: { x: number; y: number }) {
      if (!this.isOwnChat(id)) return this.moveChatToWindow(id, place)
      const under = isTauri() ? await call('window_at', screen).catch(() => null) : null
      if (under) await this.returnChat()
    },

    /**
     * This chat window gives its chat back: to the window that has its project (the main window when
     * none has), where its tab opens again. The window then closes.
     */
    async returnChat() {
      if (this.spec.kind !== 'chat') return
      const threads = useThreads()
      const root = threads.byId(this.spec.threadId)
      if (root && threads.isBusyChat(root.id)) {
        useWorkspace().notify('Not returned yet', `“${root.title}” is still working. Stop it first, or wait until it is done.`)
        return
      }
      await flushHistory()
      const to = root ? ownerOf(withoutWindow(this.table, this.self), { projectPath: root.projectPath, rootId: root.id }) : MAIN_WINDOW
      await this.focus(to)
      await appWindow.close()
    },
  },
})
