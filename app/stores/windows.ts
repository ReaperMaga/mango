import { defineStore } from 'pinia'
import { t } from '~/i18n'
import { appWindow, call, isTauri, on, onWindows, postWindows, windowLabel } from '~/composables/useBackend'
import {
  MAIN_WINDOW, claimsFor, holderOf, lostChats, onlyOpen, ownerOf, parseWindowQuery, returningChats, withClaims, withoutWindow,
  type ChatRef, type Claim, type ClaimTable, type WindowPlace, type WindowSpec,
} from '~/utils/windows'
import { onWindowClose, tellUnsaved } from '~/composables/windowClose'
import { flushHistory } from '~/utils/chatHistory'
import { flushRemoteChats } from '~/utils/remoteChats'
import { useFiles } from '~/stores/files'
import { useThreads } from '~/stores/threads'
import { useWorkspace } from '~/stores/workspace'

/** The question when files are not saved as the window closes, true to why they aren't. */
function notSavedQuestion({ failed, saving }: { failed: string[], saving: string[] }): string {
  const list = (all: string[]) => {
    const names = [...new Set(all)]
    const files = names.slice(0, 3).join(', ')
    return names.length > 3 ? t('shell.windows.andMore', { files, n: names.length - 3 }) : files
  }
  if (!failed.length) return t('shell.windows.savingAll', { files: list(saving) })
  if (!saving.length) return t('shell.windows.failedAll', { files: list(failed) })
  return t('shell.windows.failedSome', { failed: list(failed), saving: list(saving) })
}

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
 * - With autosave on (Settings > Editor) a window closes, hides or lets a project go only once its
 *   open files are saved; when one cannot be, it says so and waits for the user (`_savedToClose`).
 */

type Body =
  | { t: 'who' }
  | { t: 'here'; claims: Claim[] }
  | { t: 'claims'; claims: Claim[] }
  | { t: 'take'; for: string; claims: Claim[] }
  | { t: 'taken'; ok: boolean; reason?: string }
  | { t: 'bye'; id: string }
  | { t: 'focus'; id: string }
  | { t: 'save' }
  | { t: 'saved'; left: string[] }
type Message = Body & { from: string; inst: string; req?: string; to?: string }

/** This page's own id: two windows may briefly share a label (a reload), never this. */
const INST = Math.random().toString(36).slice(2, 10)
const reqId = () => `${INST}-${Math.random().toString(36).slice(2, 8)}`
/** Waiting on windows that were seen: after this long one that did not answer is taken as gone. */
const ANSWER_MS = 4000
/** Saving open files before answering another window: well inside `ANSWER_MS`. */
const SAVE_FOR_PEER_MS = 2500
/** A window being closed waits this long for its files to save, then asks. */
const SAVE_TO_CLOSE_MS = 6000
/** The browser preview cannot list its windows: whoever answers this quickly is there. */
const PREVIEW_WHO_MS = 300

/** Typed while a closing window did what else it had to: saved, or asked about, before it goes. */
const typedMeanwhile = () => useWorkspace().editorAutoSave && useFiles().hasUnsaved

const sameClaims = (a: Claim[] = [], b: Claim[] = []) =>
  a.length === b.length && a.every(c => b.some(d => d.kind === c.kind && d.key === c.key))

/** Why a project's terminals keep it in this window, or null when it has none running here. */
function terminalBlocker(path: string): string | null {
  const n = useWorkspace().terminalsOf(path).length
  if (!n) return null
  return t('shell.windows.terminals', n)
}

const waiting = new Map<string, (m: Message) => void>()
let reclaimTimer: ReturnType<typeof setTimeout> | null = null
/** Chats coming back from a chat window that closed: shown as tabs once they are read (`_reclaim`). */
let returning: string[] = []
let syncing: Promise<void> = Promise.resolve()
/** The main window letting go after it was hidden (`_park`): quitting waits for it. */
let parking: Promise<void> = Promise.resolve()
/** The projects and chats this window opened with are loaded (`follow`). */
let loaded = false

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
      if (isTauri()) tellUnsaved(() => useFiles().hasUnsaved)
      // Before anything slow: a close nobody hears is decided without the page.
      if (!this.isMain) await onWindowClose(() => this._mayClose())
      else if (isTauri()) {
        await onWindowClose(() => this._mayCloseMain())
        // The main window closed while others are open: the backend hid it; it lets go of its projects.
        await on('window://parked', () => { void this._park() })
        window.addEventListener('focus', () => { this.parked = false })
      }
      await onWindows(m => this._receive(m as Message))
      if (isTauri()) await on('window://closed', ({ label }) => { if (label !== this.self) this._gone(label) })
      const peers = isTauri() ? (await call('window_list', {}).catch(() => [] as string[])).filter(l => l !== this.self) : null
      if (!peers || peers.length) {
        for (const m of await this._ask({ t: 'who' }, peers, peers ? ANSWER_MS : PREVIEW_WHO_MS)) {
          if (m.t === 'here') this.table = { ...this.table, [m.from]: m.claims }
        }
      }
      // A reload keeps the label but not what the page had open: drop what the others still list for it.
      if (peers === null || peers.length) await this._post({ t: 'claims', claims: [] })
      // Coming back to a window: forget windows that went without a word.
      window.addEventListener('focus', () => { void this.prune() })
      // Leaving: what this window held goes back. A window that is closed on purpose has saved
      // first (`_mayClose`); a reload just says goodbye, and takes its things again when it is back.
      window.addEventListener('pagehide', () => { void this._post({ t: 'bye', id: this.self }) })
    },

    /**
     * Keep this window's claims in step with what it has open. Call after the chats and projects
     * have loaded; it then follows the open projects by itself.
     */
    follow() {
      loaded = true
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
        const chat = threads.byId(id)
        if (chat && threads.isBusyChat(id)) {
          // A run cannot follow the chat to another window: keep it here until it is done.
          threads.show(id)
          useWorkspace().notify(t('shell.chat.stillWorking'), t('shell.windows.stays', { title: chat.title }))
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
          await useFiles().saveAll(SAVE_FOR_PEER_MS, f => lose.some(c => c.projectPath === threads.ownerOf(f.projectPath)))
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
      return (refused as { reason?: string }).reason ?? t('shell.windows.inUse')
    },

    /** Let go of the chats this window would lose under `next` (saved first). The reason when it cannot. */
    async _give(next: ClaimTable): Promise<string | null> {
      const threads = useThreads()
      const moving = this.spec.kind === 'chat' ? [] : useWorkspace().openProjects.map(p => p.path).filter((path) => {
        const h = holderOf(next, { kind: 'project', key: path })
        return h && h !== this.self
      })
      // Saved before anything is decided below (it takes a moment): the other window reads these files.
      if (moving.length) {
        const [left] = await useFiles().saveAll(SAVE_FOR_PEER_MS, f => moving.includes(threads.ownerOf(f.projectPath)))
        if (left) return t('shell.windows.unsavedThere', { file: left })
      }
      const lose = lostChats(threads.heldRefs(), next, this.self)
      const busy = lose.find(c => threads.isBusyChat(c.id))
      if (busy) {
        const chat = threads.byId(busy.rootId) ?? threads.byId(busy.id)
        return t('shell.windows.busyThere', { title: chat?.title ?? t('shell.windows.aChat') })
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

    /**
     * Forget windows the backend no longer has (they went without `bye` or `window://closed`), so
     * nothing stays listed as open in a window that is not there. The browser preview cannot list them.
     */
    async prune() {
      if (!isTauri()) return
      const open = await call('window_list', {}).catch(() => null)
      if (!open) return
      const kept = onlyOpen(this.table, open, this.self)
      for (const id of Object.keys(this.table)) if (!(id in kept)) this._gone(id)
    },

    /** A window is gone: forget its claims; what it held goes to whoever owns it next. */
    _gone(id: string) {
      if (!(id in this.table)) return
      returning = [...new Set([...returning, ...returningChats(this.table[id])])]
      this.table = withoutWindow(this.table, id)
      this._reclaimSoon()
    },

    /**
     * Save the open files before this window goes. What is not saved in time is asked about until
     * the user answers, or until it is saved after all: then the question goes and closing goes on (a
     * Quit with it). False when the user keeps the window. Always true with autosave off.
     */
    async _savedToClose(): Promise<boolean> {
      const files = useFiles()
      if (!(await files.saveAll(SAVE_TO_CLOSE_MS)).length) return true
      const ws = useWorkspace()
      const question = () => notSavedQuestion(files.unsavedByCause())
      let answer!: (close: boolean) => void
      const answered = new Promise<boolean>(resolve => (answer = resolve))
      ws.confirm = {
        title: t('shell.windows.closeTitle'),
        body: question(),
        label: t('shell.windows.closeLabel'),
        danger: true,
        run: () => {
          // First: the dialog took the question away, which alone would mean Cancel.
          answer(true)
          files.discardUnsaved()
        },
      }
      const asked = ws.confirm
      const stop = watch(() => [ws.confirm === asked, files.hasUnsaved, question()] as const, ([up, unsaved, body]) => {
        if (!up) {
          answer(false)
        } else if (unsaved) {
          asked.body = body
        } else {
          answer(true)
          ws.confirm = null
        }
      }, { immediate: true })
      // A hidden window is shown only with the answer, which waits for the user.
      if (isTauri()) void call('window_focus', { label: this.self }).catch(() => {})
      const close = await answered
      stop()
      return close
    },

    /** This (not main) window was asked to close. */
    async _mayClose(): Promise<boolean> {
      let alone = false
      do {
        if (!await this._savedToClose()) return false
        // What else it saves on the way never keeps it open: that gets a few seconds.
        const chores = async () => {
          alone = loaded && isTauri() && await call('window_alone', {}).catch(() => false)
          await this._shutDown()
        }
        await Promise.race([chores().catch(() => {}), new Promise(r => setTimeout(r, 4000))])
      } while (typedMeanwhile())
      await Promise.race([this._closing(alone).catch(() => {}), new Promise(r => setTimeout(r, 1000))])
      return true
    },

    /**
     * The main window was asked to close: itself, or hidden, as the last window on screen closed.
     * It saves while it is still there to ask. With other windows open the backend then hides it
     * (`_park`); otherwise it ends Mango, so what it was saving gets a moment.
     */
    async _mayCloseMain(): Promise<boolean> {
      await Promise.race([parking, new Promise(r => setTimeout(r, 3000))])
      do {
        if (!await this._savedToClose()) {
          // A window that closed while this asked took it to be leaving, and handed over its session.
          const ws = useWorkspace()
          if (ws.openProjects.length) ws.persist()
          return false
        }
        await Promise.race([flushHistory(), new Promise(r => setTimeout(r, 2000))])
      } while (typedMeanwhile())
      return true
    },

    /**
     * Every window saves its open files (an update restarts Mango). Resolves with what could not be
     * saved: files, or a window that is there (hidden too) and did not answer.
     */
    async saveEverywhere(): Promise<string[]> {
      await this.prune()
      const peers = Object.keys(this.table).filter(id => id !== this.self)
      const [mine, answers] = await Promise.all([
        useFiles().saveAll(SAVE_TO_CLOSE_MS),
        peers.length ? this._ask({ t: 'save' }, peers, ANSWER_MS) : [],
      ])
      // With autosave off no window has anything to say.
      const silent = useWorkspace().editorAutoSave && peers.some(id => !answers.some(m => m.from === id))
      return [...mine, ...answers.flatMap(m => (m.t === 'saved' ? m.left : [])), ...(silent ? [t('shell.windows.silent')] : [])]
    },

    /**
     * This (not main) window has stopped its runs and saved (`_shutDown`): it says goodbye. Not before:
     * until then it may still stay, for text that cannot be saved. `alone`: it is the last on screen.
     */
    async _closing(alone: boolean) {
      // The last window on screen (the main one is parked): its projects are what Mango reopens next time.
      // (One closed before it loaded has nothing to hand over.)
      if (alone) useWorkspace().handOverSession()
      await this._post({ t: 'bye', id: this.self })
    },

    /** Stop this window's runs and terminals, and save its chats. */
    async _shutDown() {
      const threads = useThreads()
      for (const c of threads.heldRefs()) if (threads.isBusyChat(c.id)) threads.stop(c.id)
      const ws = useWorkspace()
      for (const t of ws.terminalTabs) if (t.ptyId && !t.exited) await call('pty_kill', { id: t.ptyId }).catch(() => {})
      // What was typed while it got this far.
      await useFiles().saveAll(1000)
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
      // At once: the last window may close, and hand over what it has open, while this one lets go.
      useWorkspace().forgetSession()
      parking = this._letGo()
      await parking
    },

    async _letGo() {
      // Hidden, it must let go whatever happens while saving: otherwise its projects stay
      // “open in another window” that nobody can see.
      try {
        await this._shutDown()
      } catch (e) {
        console.error('Mango could not save everything before hiding the main window:', e)
      } finally {
        this.chats = []
        useWorkspace().park()
        await this.sync()
      }
    },

    async _receive(m: Message) {
      if (!m || typeof m !== 'object' || m.inst === INST) return
      if (m.to && m.to !== this.self) return
      if (m.req && waiting.has(m.req) && (m.t === 'here' || m.t === 'taken' || m.t === 'saved')) {
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
        case 'save':
          await this._post({ t: 'saved', left: await useFiles().saveAll(SAVE_FOR_PEER_MS) }, m)
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
      const chat = useThreads().busyIn(path)
      if (chat) return { hint: t('shell.windows.busyHint'), reason: t('shell.windows.busy', { title: chat.title }) }
      const shells = terminalBlocker(path)
      return shells ? { hint: t('shell.windows.terminalsHint'), reason: shells } : null
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
        useWorkspace().notify(t('shell.windows.notOpened'), e instanceof Error ? e.message : String(e))
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
        throw new Error(t('shell.windows.notHere'))
      }
      if (threads.isBusyChat(root.id)) throw new Error(t('shell.windows.busy', { title: root.title }))
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
      if (this.isOwnChat(id)) return { label: t('shell.windows.return'), divider: true, onSelect: () => void this.returnChat() }
      const busy = useThreads().isBusyChat(id)
      return {
        label: t('shell.windows.move'),
        divider: true,
        disabled: busy,
        hint: busy ? t('shell.chat.stillWorking') : undefined,
        onSelect: () => void this.moveChatToWindow(id),
      }
    },

    /** `openChatWindow` for a menu, a command or a drop: when it cannot, the user is told why. */
    async moveChatToWindow(id: string, place: WindowPlace = {}) {
      try {
        await this.openChatWindow(id, place)
      } catch (e) {
        useWorkspace().notify(t('shell.windows.notMoved'), e instanceof Error ? e.message : String(e))
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
        useWorkspace().notify(t('shell.windows.notReturned'), t('shell.windows.busy', { title: root.title }))
        return
      }
      if (!await this._savedToClose()) {
        // It stays for the answer, with its chat.
        if (root) threads.show(root.id)
        return
      }
      await flushHistory()
      const to = root ? ownerOf(withoutWindow(this.table, this.self), { projectPath: root.projectPath, rootId: root.id }) : MAIN_WINDOW
      await this.focus(to)
      await appWindow.close()
    },
  },
})
