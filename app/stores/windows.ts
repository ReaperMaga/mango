import { defineStore } from 'pinia'
import { appWindow, call, isTauri, on, onWindows, postWindows, windowLabel } from '~/composables/useBackend'
import {
  MAIN_WINDOW, claimsFor, holderOf, lostChats, ownerOf, parseWindowQuery, withClaims, withoutWindow,
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

const waiting = new Map<string, (m: Message) => void>()
let reclaimTimer: ReturnType<typeof setTimeout> | null = null
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
    },

    /**
     * Keep this window's claims in step with what it has open. Call after the chats and projects
     * have loaded; it then follows the open projects by itself.
     */
    follow() {
      const ws = useWorkspace()
      watch(() => ws.openProjects.map(p => p.path).join('\n'), () => { void this.sync() }, { immediate: true })
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
      if (lose.length) {
        await flushHistory()
        threads.release(lose.map(c => c.id))
        // Changes on their way to a remote project's environment go before another window takes over.
        void flushRemoteChats()
      }
      // Projects that go to another window leave this one.
      const ws = useWorkspace()
      for (const p of [...ws.openProjects]) {
        const h = holderOf(next, { kind: 'project', key: p.path })
        if (h && h !== this.self) ws.lend(p.path)
      }
      return null
    },

    /** Read the chats this window now owns but does not hold yet, and take back projects lent out. */
    async _reclaim() {
      await useThreads().reclaim()
      useWorkspace().takeBackLent()
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
      this.table = withoutWindow(this.table, id)
      this._reclaimSoon()
    },

    /** This (not main) window is closing: stop its runs, save, say goodbye. */
    async _closing() {
      const threads = useThreads()
      for (const c of threads.heldRefs()) if (threads.isBusyChat(c.id)) threads.stop(c.id)
      const ws = useWorkspace()
      for (const t of ws.terminalTabs) if (t.ptyId && !t.exited) await call('pty_kill', { id: t.ptyId }).catch(() => {})
      await flushHistory()
      await Promise.race([flushRemoteChats(), new Promise(r => setTimeout(r, 1500))])
      await this._post({ t: 'bye', id: this.self })
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
     * Why a project cannot move to another window now (a chat of it running here), or null.
     * Shown on the menu items that would move it.
     */
    moveBlocker(path: string): string | null {
      const t = useThreads().busyIn(path)
      return t ? `“${t.title}” is still working. Stop it first, or wait until it is done.` : null
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
        if (blocked) throw new Error(blocked)
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
  },
})
