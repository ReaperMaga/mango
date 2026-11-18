import { defineStore } from 'pinia'
import type { AgentId, Attachment, BackgroundTask, LinkedItem, Message, Part, QuestionAnswers, Thread } from '~/types/chat'
import { AGENTS, awaitsUser } from '~/types/chat'
import { answerQuestion, interruptRun, isRunning, respondApproval, runAgentTurn, steerRun, stopTask } from '~/agents'
import { useWorkspace } from '~/stores/workspace'
import { useModels } from '~/stores/models'
import { isDiffTab, parseDiffTab } from '~/utils/diffTabs'
import { useGit } from '~/stores/git'
import { useFiles } from '~/stores/files'
import { isFileTab, parseFileTab, tabProject } from '~/utils/fileTabs'
import { isBrowserTab, parseBrowserTab } from '~/utils/browserTabs'
import { isTerminalTab, parseTerminalTab, placeBefore, terminalTabId } from '~/utils/terminalTabs'
import { useBrowser } from '~/stores/browser'
import { demoThreads } from '~/utils/demoThreads'
import { createdBy } from '~/utils/githubLinks'
import { useLinks } from '~/stores/links'
import { createPrPrompt } from '~/utils/createPr'
import { branchFromMessage, untakenName, workdirOf, worktreeName } from '~/utils/worktrees'
import { vcsTerms } from '~/utils/vcs'
import { call } from '~/composables/useBackend'
import { movedEnvPath } from '~/utils/envPath'
import { attachHistory, flushHistory, forgetHistory, loadHistory, loadMoreHistory, markChanged, type Keep } from '~/utils/chatHistory'
import { adoptRemote, attachRemoteChats, forgetRemote } from '~/utils/remoteChats'
import { useWindows } from '~/stores/windows'
import { chatRefs, rootIds, type ChatRef } from '~/utils/windows'

/** Where builds before the chat history database kept chats: read once, to move them over. */
const LS_KEY = 'mango.threads.v1'
const uid = (p: string) => `${p}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
/** A message that is a slash command (`/compact`, `/review …`): it runs as a turn of its own. */
const isCommand = (text: string) => /^\/[\w.:-]+(\s|$)/.test(text.trim())
/** Mango's own `/clear`: handled here, never sent to the agent. */
const isClear = (text: string) => /^\/clear\s*$/.test(text.trim())

export interface Pane { id: string; threadId: string | null }

/** A message written while the agent works: it waits for the turn to end unless the user sends it now. */
export interface QueuedMessage {
  id: string
  text: string
  attachments: Attachment[]
  /** Already in the chat (sent now, but the run could not take it): only its turn is still due. */
  shown?: boolean
}

/** What a running chat has going on besides its reply. Not saved: it dies with the run. */
export interface LiveState {
  /** Background commands and sub-agents of the run, finished ones included until it ends. */
  tasks: BackgroundTask[]
  /** The agent has answered and only waits on background tasks. */
  idle: boolean
}

export const useThreads = defineStore('threads', {
  state: () => ({
    threads: [] as Thread[],
    /** Open tabs, in order (thread ids). */
    tabs: [] as string[],
    /** One or two side-by-side chat panes. */
    panes: [{ id: 'pane-a', threadId: null }] as Pane[],
    activePaneId: 'pane-a',
    /**
     * While split, each pane has its own tab strip: the pane a tab belongs to, by tab id. Only the
     * right pane is written down; a tab without an entry is the left pane's. A tab shown in a pane
     * always belongs to that pane (see groupOf). Ignored while there is one pane.
     */
    groups: {} as Record<string, string>,
    /** Default agent for new chats. */
    defaultAgent: 'claude' as AgentId,
    /** Per chat id, while its run has background work (see LiveState). */
    live: {} as Record<string, LiveState>,
    /** Per chat id: messages waiting for the running turn to end. Not saved: it dies with the app. */
    queue: {} as Record<string, QueuedMessage[]>,
  }),

  getters: {
    byId: s => (id: string | null | undefined) => s.threads.find(t => t.id === id) ?? null,
    /**
     * A project's chats in the user's order (see byListOrder), without the archived ones.
     * Sub-agent chats are not in it: they sit under their parent (childrenOf).
     */
    forProject: s => (path: string) =>
      s.threads.filter(t => t.projectPath === path && !t.archived && !t.parentId).sort(byListOrder),
    archivedFor: s => (path: string) =>
      s.threads.filter(t => t.projectPath === path && t.archived && !t.parentId).sort((a, b) => b.updatedAt - a.updatedAt),
    /** The sub-agent chats a chat (or a sub-agent) started, oldest first. */
    childrenOf: s => (id: string) =>
      s.threads.filter(t => t.parentId === id).sort((a, b) => a.createdAt - b.createdAt),
    /** The top-level chat a sub-agent chat belongs to, whose run fills it (a top-level chat is its own). */
    rootOf(): (id: string) => Thread | null {
      return (id) => {
        let t = this.byId(id)
        for (let hops = 0; t?.parentId && hops < 32; hops++) t = this.byId(t.parentId)
        return t
      }
    },
    activePane: s => s.panes.find(p => p.id === s.activePaneId) ?? s.panes[0]!,
    activeThread(): Thread | null {
      return this.byId(this.activePane.threadId)
    },
    isSplit: s => s.panes.length > 1,
    /** The project a tab belongs to: a chat's own, or the one named in a diff or file tab's id. */
    projectOf(): (id: string | null | undefined) => string | null {
      return (id) => {
        const path = tabProject(id)
        return path ? this.ownerOf(path) : this.byId(id)?.projectPath ?? null
      }
    },
    /**
     * The project a folder belongs to: a worktree a chat works in belongs to that chat's project
     * (diff and file tabs opened from it carry the worktree's folder); anything else is its own.
     */
    ownerOf: s => (path: string): string =>
      s.threads.find(t => t.worktree === path)?.projectPath ?? path,
    /** The folder a chat works in: its top-level chat's worktree, or the project. */
    workdirFor(): (id: string | null | undefined) => string | null {
      return (id) => {
        const root = this.rootOf(id ?? '')
        return root ? workdirOf(root) : null
      }
    },
    /**
     * The working copy in view: what the Changes and Files tool windows, the branch in the titlebar
     * and a new terminal follow. The chat in the active pane decides (its worktree, or the project);
     * a diff or file tab keeps the folder it was opened from; anything else is the project.
     */
    workdir(): string | null {
      const project = useWorkspace().activeProjectPath
      if (!project) return null
      const id = this.activePane.threadId
      const tabPath = parseDiffTab(id)?.projectPath ?? parseFileTab(id)?.projectPath
      if (tabPath && this.ownerOf(tabPath) === project) return tabPath
      const t = this.byId(id)
      if (t && t.projectPath === project) return this.workdirFor(t.id)
      return project
    },
    /** Every worktree folder a chat of this project works in, archived chats included. */
    worktreesOf: s => (projectPath: string): string[] =>
      [...new Set(s.threads.filter(t => t.projectPath === projectPath && t.worktree).map(t => t.worktree!))],
    /**
     * The active project's tabs, in order. `tabs` holds every project's tabs; only these
     * are on screen, so only these may be put in a pane (closing a tab, split, Ctrl+1–9).
     */
    visibleTabs(): string[] {
      const path = useWorkspace().activeProjectPath
      return path ? this.tabs.filter(id => this.projectOf(id) === path) : []
    },
    /** The pane whose tab strip holds a tab: the pane showing it, else the one it was put in, else the left one. */
    groupOf(): (id: string) => string {
      return (id) => {
        const shown = this.panes.find(p => p.threadId === id)
        if (shown) return shown.id
        if (this.panes.length === 1) return this.panes[0]!.id
        const g = this.groups[id]
        return g && this.panes.some(p => p.id === g) ? g : this.panes[0]!.id
      }
    },
    /** One pane's tabs (the active project's), in order: what its tab strip shows and Ctrl+1–9 count. */
    groupTabs(): (paneId: string) => string[] {
      return (paneId) => this.visibleTabs.filter(id => this.groupOf(id) === paneId)
    },
    /** Threads that need the user: shown as a count in the titlebar. */
    attentionCount: s => s.threads.filter(t => !t.archived && !t.parentId && (t.status === 'waiting' || (t.status === 'done' && !t.seen))).length,
  },

  actions: {
    /**
     * Read the chat history (a SQLite file, see `utils/chatHistory.ts`) and start saving to it.
     * The first time, chats saved by older builds in localStorage move into it.
     * Only the chats this window owns are read (`stores/windows.ts`); only the main window has a
     * saved layout (tabs, panes): another window starts with its project's latest chat.
     */
    async load() {
      const main = useWindows().isMain
      let threads: Thread[] = []
      let layout: any = null
      try {
        ({ threads, layout } = await loadHistory(ownedKeep()))
        if (!main) layout = null
      } catch (e) {
        console.error('Mango could not read the chat history:', e)
      }
      let migrating = false
      if (main && !threads.length && !layout) {
        try {
          const old = JSON.parse(localStorage.getItem(LS_KEY) || 'null')
          if (Array.isArray(old?.threads)) { threads = old.threads; layout = old; migrating = true }
        } catch { /* nothing to move */ }
      }
      try {
        // Anything that was mid-run when the app closed is no longer running.
        this.threads = threads.map(normalizeLoaded)
        if (layout) {
          this.tabs = (Array.isArray(layout.tabs) ? layout.tabs : []).filter((id: string) => this.threads.some(t => t.id === id))
          this.panes = Array.isArray(layout.panes) && layout.panes.length ? layout.panes : this.panes
          this.activePaneId = this.panes.some(p => p.id === layout.activePaneId) ? layout.activePaneId : this.panes[0]!.id
          // Builds before per-pane tab strips saved none: every tab starts in the left pane.
          const groups = layout.groups && typeof layout.groups === 'object' ? layout.groups : {}
          this.groups = Object.fromEntries(Object.entries(groups).filter(([id, pane]) => pane === 'pane-b' && this.tabs.includes(id))) as Record<string, string>
          this.defaultAgent = layout.defaultAgent in AGENTS ? layout.defaultAgent : 'claude'
        }
      } catch { /* start fresh */ }
      attachHistory({
        threads: () => this.threads,
        byId: id => this.byId(id),
        layout: !main ? undefined : () => ({
          // Diff and file tabs are views onto the disk, and a browser's page and a terminal's shell die
          // with the app: none of them is something to restore next time.
          tabs: this.tabs.filter(id => !isViewTab(id)),
          panes: this.panes.map(p => (isViewTab(p.threadId) ? { ...p, threadId: null } : p)),
          groups: Object.fromEntries(Object.entries(this.groups).filter(([id]) => !isViewTab(id) && this.tabs.includes(id))),
          activePaneId: this.activePaneId, defaultAgent: this.defaultAgent,
        }),
      })
      // Remote projects' chats are kept in their environment too (see `utils/remoteChats.ts`).
      attachRemoteChats({
        byId: id => this.byId(id),
        threads: () => this.threads,
        busy: t => isBusy(t) || isRunning(t.id),
        adopt: incoming => this._adoptRemote(incoming),
        drop: ids => { for (const id of ids) if (this.byId(id)) this.remove(id) },
      })
      // Statuses changed by loading (a run cut off by closing the app) are saved too.
      markChanged()
      if (migrating && await flushHistory()) localStorage.removeItem(LS_KEY)
    },

    /**
     * Save soon (debounced). With chat ids, only those chats are compared; without, every chat is,
     * which also drops deleted ones. The layout (tabs, panes) is compared every time.
     */
    persist(ids?: string | string[]) {
      markChanged(ids)
    },

    /** Save the layout only: tabs, panes, the default agent. */
    persistLayout() {
      markChanged([])
    },

    /* ---------- windows (see stores/windows.ts) ---------- */

    /** The chats this window holds, as window ownership sees them. */
    heldRefs(): ChatRef[] {
      return chatRefs(this.threads)
    },

    /** A chat (or its top-level chat's run) is working here: it cannot move to another window now. */
    isBusyChat(id: string): boolean {
      const t = this.byId(id)
      const root = this.rootOf(id)
      return !!t && (isBusy(t) || isRunning(t.id) || (!!root && (isBusy(root) || isRunning(root.id))))
    },

    /** A chat of this project working in this window, if any. */
    busyIn(projectPath: string): Thread | null {
      return this.threads.find(t => t.projectPath === projectPath && this.isBusyChat(t.id)) ?? null
    },

    /**
     * These chats now belong to another window (saved already): drop them here, with their tabs,
     * without deleting them. Their project's other tabs (diffs, files, browsers) go too when no chat
     * of it is left.
     */
    release(ids: string[]) {
      const gone = new Set(ids)
      if (!gone.size) return
      const projects = new Set(this.threads.filter(t => gone.has(t.id)).map(t => t.projectPath))
      this.threads = this.threads.filter(t => !gone.has(t.id))
      for (const p of projects) if (this.threads.some(t => t.projectPath === p)) projects.delete(p)
      const leaving = (tab: string) => gone.has(tab) || (!this.byId(tab) && projects.has(this.projectOf(tab) ?? ''))
      for (const tab of this.tabs.filter(leaving)) {
        const browser = parseBrowserTab(tab)
        if (browser) useBrowser().forget(browser.browserId)
        if (isFileTab(tab)) useFiles().forget(tab)
      }
      for (const tab of this.tabs.filter(leaving)) delete this.groups[tab]
      this.tabs = this.tabs.filter(tab => !leaving(tab))
      // A pane that showed one of them shows the next tab of its own strip, or closes when that is empty.
      for (const p of [...this.panes]) {
        if (p.threadId && leaving(p.threadId)) { p.threadId = null; this._refill(p.id) }
      }
      if (!this.panes.some(p => p.id === this.activePaneId)) this.activePaneId = this.panes[0]!.id
      for (const id of gone) { delete this.queue[id]; delete this.live[id]; held.delete(id) }
      forgetHistory(gone)
      forgetRemote(gone)
      this.persistLayout()
    },

    /**
     * Read the chats this window owns now but does not hold (another window closed or let them go),
     * as saved by that window. A window other than the main one then shows its project's latest chat
     * when nothing is on screen.
     */
    async reclaim() {
      let more: Thread[] = []
      try {
        more = await loadMoreHistory(ownedKeep())
      } catch (e) {
        console.error('Mango could not read the chat history:', e)
        return
      }
      const fresh = more.map(normalizeLoaded).filter(t => !this.byId(t.id))
      if (fresh.length) {
        this.threads.push(...fresh)
        adoptRemote(fresh.map(t => t.id))
        // Statuses changed by loading (a run cut off when its window closed) are saved too.
        this.persist(fresh.map(t => t.id))
      }
      const win = useWindows()
      if (win.isMain || this.panes.some(p => p.threadId)) return
      const spec = win.spec
      const pick = spec.kind === 'chat'
        ? this.byId(spec.threadId)
        : this.threads.filter(t => t.projectPath === useWorkspace().activeProjectPath && !t.archived && !t.parentId)
            .sort((a, b) => b.updatedAt - a.updatedAt)[0]
      if (pick) this.show(pick.id)
    },

    /**
     * Chats from a remote project's environment (saved there by another computer, or by this one
     * before): new ones are added, newer copies replace the ones here. Nothing in them runs here.
     */
    _adoptRemote(incoming: Thread[]): Thread[] {
      const out: Thread[] = []
      // Chats another window holds are that window's to take (same environment open in two windows).
      const keep = ownedKeep()
      const all = [...this.threads, ...incoming]
      for (const raw of incoming) {
        if (!this.byId(raw.id) && !keep(raw, all)) continue
        const t = normalizeLoaded(raw)
        const i = this.threads.findIndex(x => x.id === t.id)
        if (i === -1) this.threads.push(t)
        else this.threads[i] = t
        out.push(this.byId(t.id)!)
      }
      if (out.length) this.persist(out.map(t => t.id))
      return out
    },

    /** Seed realistic demo threads for a project (command palette: “Load demo threads”). */
    loadDemo(projectPath: string) {
      const demo = demoThreads(projectPath)
      this.threads.push(...demo)
      for (const t of demo.slice(0, 3)) if (!this.tabs.includes(t.id)) this.tabs.push(t.id)
      this.show(demo[0]!.id)
      this.persist()
    },

    /**
     * A new chat; with `worktree`, one that works in that linked worktree (see `createInWorktree`);
     * with `awaitingWorktree`, one whose worktree is made when its first message is sent
     * (see `createAwaitingWorktree`).
     */
    create(projectPath: string, agentArg?: AgentId, branch: string | null = null, worktree: string | null = null, awaitingWorktree = false): Thread {
      const project = useWorkspace().projectPrefs[projectPath]
      const agent = agentArg ?? project?.agent ?? this.defaultAgent
      // Reuse an untouched empty chat (in the same folder, waiting for a worktree or not) instead of piling up "New chat" rows.
      const blank = this.threads.find(x => x.projectPath === projectPath && (x.worktree ?? null) === worktree && !!x.awaitingWorktree === awaitingWorktree
        && x.messages.length === 0 && x.title === 'New chat' && !x.archived && !x.parentId)
      if (blank) {
        if (agentArg) { blank.agent = agentArg; blank.model = AGENTS[agentArg].models[0]!.id; blank.effort = null }
        // A new chat opens where it was asked for (the active pane), even when its blank tab sits in the other one.
        this.show(blank.id, this.activePaneId)
        return blank
      }
      const t: Thread = {
        id: uid('t'),
        projectPath,
        title: 'New chat',
        agent,
        model: !agentArg && project?.model && useModels().find(agent, project.model) ? project.model : AGENTS[agent].models[0]!.id,
        mode: project?.mode ?? useWorkspace().defaultMode,
        effort: null,
        status: 'working',
        messages: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
        seen: true,
        branch,
        ...(worktree ? { worktree } : {}),
        ...(awaitingWorktree && !worktree ? { awaitingWorktree: true as const } : {}),
      }
      this.threads.push(t)
      // A window that does not hold the whole project (a chat window) claims the chats it starts.
      useWindows().claimNew(t.id, projectPath)
      this.show(t.id)
      this.persist(t.id)
      return t
    },

    /**
     * A chat that works in its own git worktree, so it can run beside the project's other chats.
     * `existing`: a worktree folder that is already there; otherwise a new one is added for
     * `branch` (a new branch from `from`, or the existing local branch when `create` is false).
     * Rejects with git's reason when the worktree cannot be made.
     */
    async createInWorktree(projectPath: string, opts: { existing?: string; branch?: string; from?: string | null; create?: boolean; agent?: AgentId }): Promise<Thread> {
      let folder = opts.existing ?? null
      let branch: string | null = null
      if (folder) {
        const list = await call('git_worktrees', { path: projectPath }).catch(() => [])
        branch = list.find(w => w.path === folder)?.branch ?? null
      } else {
        const wt = await call('git_worktree_add', { path: projectPath, branch: opts.branch ?? '', from: opts.from ?? null, create: opts.create ?? true })
        folder = wt.path
        branch = wt.branch
      }
      const t = this.create(projectPath, opts.agent, branch, folder)
      void useGit().loadWorktrees(projectPath)
      return t
    },

    /**
     * "New chat in a worktree": a chat that runs nowhere yet. Its first message names a new branch
     * and the worktree (for Unity VCS: a workspace of its own) is added for it before the agent starts
     * (`_addWorktreeFor`). Projects without version control get a plain chat.
     */
    createAwaitingWorktree(projectPath: string, agent?: AgentId): Thread {
      const project = useWorkspace().openProjects.find(p => p.path === projectPath)
      if (!project?.isGit || !vcsTerms(project.vcs).worktrees) return this.create(projectPath, agent)
      return this.create(projectPath, agent, null, null, true)
    },

    /**
     * The chat (its top-level chat, for a sub-agent) now works in `folder`: a linked worktree, or
     * the project folder itself (the agent left its worktree). `branch` when known; otherwise it is
     * read from git in that folder. Worktrees Claude Code makes itself (`<repo>/.claude/worktrees/<name>`)
     * are linked worktrees like any other. Nothing happens when nothing changed.
     */
    async moveToWorktree(id: string, folder: string, branch: string | null) {
      const t = this.rootOf(id)
      if (!t || !folder) return
      const worktree = folder === t.projectPath ? null : folder
      const git = useGit()
      if (!branch) {
        await git.refresh(folder).catch(() => {})
        // The project folder's branch is also known from the project itself.
        branch = git.status(folder)?.branch ?? (worktree ? null : useWorkspace().openProjects.find(p => p.path === folder)?.branch ?? null)
      }
      // The chat may have moved on while git was read.
      const now = this.byId(t.id)
      if (!now) return
      const same = (now.worktree ?? null) === worktree && !now.awaitingWorktree && (!branch || now.branch === branch)
      if (same) return
      now.worktree = worktree
      if (branch) now.branch = branch
      delete now.awaitingWorktree
      this.persist(now.id)
      void git.loadWorktrees(now.projectPath)
    },

    /**
     * Add the worktree a chat waits for: a new branch named after its first message (`-2`, `-3` …
     * when that branch or folder is taken), from the project's HEAD. Rejects with git's reason.
     * Unity VCS: a child of the project's branch (`/main/task/fix-the-login`) in a new workspace,
     * which downloads the branch's files first, so this can take minutes on a big project.
     */
    async _addWorktreeFor(id: string) {
      const t = this.byId(id)
      if (!t?.awaitingWorktree) return
      const path = t.projectPath
      const first = t.messages.find(m => m.role === 'user')
      const firstText = first?.parts.map(p => (p.type === 'text' ? p.text : '')).join(' ') ?? ''
      const base = branchFromMessage(firstText || t.title)
      const [branches, trees] = await Promise.all([
        useGit().loadBranchList(path).catch(() => null),
        call('git_worktrees', { path }).catch(() => []),
      ])
      // Unity VCS names the new branch as a child of the current one: its siblings' last parts are taken.
      const current = branches?.current
      const children = vcsTerms(useWorkspace().openProjects.find(p => p.path === path)?.vcs).pathBranches && current
        ? (branches?.local ?? []).map(b => b.name).filter(n => n.startsWith(`${current}/`)).map(n => n.slice(current.length + 1))
        : []
      const taken = [
        ...(branches?.local.map(b => b.name) ?? []),
        ...children,
        ...trees.flatMap(w => [worktreeName(w.path), ...(w.branch ? [w.branch] : [])]),
      ]
      let failure: unknown = null
      // A name taken since the list was read (or one the list missed) is tried again with the next number.
      for (let attempt = 0; attempt < 4; attempt++) {
        const branch = untakenName(base, taken)
        try {
          const wt = await call('git_worktree_add', { path, branch, from: null, create: true })
          await this.moveToWorktree(id, wt.path, wt.branch ?? branch)
          return
        } catch (e) {
          failure = e
          if (!/already (exists|checked out|used)|not empty/i.test(errorText(e))) break
          taken.push(branch)
        }
      }
      throw failure
    },

    /**
     * Remove the worktree a chat works in (its branch stays). Every chat that worked there goes
     * back to the project folder. Rejects with the reason (uncommitted changes, unless `force`).
     */
    async removeWorktree(id: string, force = false) {
      const t = this.byId(id)
      const folder = t?.worktree
      if (!t || !folder) return
      const users = this.threads.filter(x => x.worktree === folder)
      const term = vcsTerms(useWorkspace().openProjects.find(p => p.path === t.projectPath)?.vcs).worktree
      if (users.some(isBusy)) throw new Error(`A chat is still working in this ${term}. Stop it first.`)
      await call('git_worktree_remove', { path: t.projectPath, worktree: folder, force })
      for (const x of users) x.worktree = null
      // Diff and file tabs opened from the folder show nothing now.
      for (const tab of [...this.tabs]) {
        if ((parseDiffTab(tab)?.projectPath ?? parseFileTab(tab)?.projectPath) === folder) this.closeTab(tab)
      }
      const git = useGit()
      delete git.repos[folder]
      void git.loadWorktrees(t.projectPath)
      this.persist(users.map(x => x.id))
    },

    /**
     * Show a tab. In `paneId` when given (it moves to that pane's strip); otherwise where it already
     * is: the pane showing it, or the pane whose strip holds it. A tab not open yet opens in the active pane.
     */
    show(id: string, paneId?: string) {
      const isNew = !this.tabs.includes(id)
      if (isNew) this.tabs.push(id)
      const from = this.panes.find(p => p.threadId === id)
      const pane = (paneId ? this.panes.find(p => p.id === paneId) : null)
        ?? from
        ?? (isNew ? this.activePane : this.panes.find(p => p.id === this.groupOf(id)))
        ?? this.panes[0]!
      const at = this.tabs.indexOf(id)
      if (from && from !== pane) from.threadId = null
      pane.threadId = id
      this._setGroup(id, pane.id)
      this.activePaneId = pane.id
      // The pane it moved out of shows its strip's next tab, or closes when its strip is empty now.
      if (from && from !== pane) this._refill(from.id, at)
      const t = this.byId(id)
      if (t && (t.status === 'working' || t.status === 'done')) t.seen = true
      this.persist(id)
    },

    /** Put a tab in a pane's strip (the left one: no entry, see `groups`). */
    _setGroup(id: string, paneId: string) {
      if (this.panes.length > 1 && paneId !== this.panes[0]!.id) this.groups[id] = paneId
      else delete this.groups[id]
    },

    /**
     * A pane shows nothing now: give it the tab of its own strip nearest to `near` (an index in `tabs`)
     * that no other pane shows. A split pane whose strip is empty closes; the only pane stays empty.
     */
    _refill(paneId: string, near = 0) {
      const pane = this.panes.find(p => p.id === paneId)
      if (!pane || pane.threadId) return
      const free = this.groupTabs(paneId).filter(x => !this.panes.some(p => p.threadId === x))
      const next = free.reduce<string | null>((best, x) =>
        best === null || Math.abs(this.tabs.indexOf(x) - near) < Math.abs(this.tabs.indexOf(best) - near) ? x : best, null)
      if (next) pane.threadId = next
      else if (this.panes.length > 1) this.closePane(paneId)
    },

    closeTab(id: string) {
      const i = this.tabs.indexOf(id)
      if (i === -1) return
      // A file with unsaved edits asks first, in its own pane.
      if (parseFileTab(id) && useFiles().isDirty(id)) {
        this.show(id)
        useFiles().askClose(id)
        return
      }
      const diff = parseDiffTab(id)
      if (diff) useGit().closeDiff(diff.projectPath, diff.key)
      if (isFileTab(id)) useFiles().forget(id)
      const browser = parseBrowserTab(id)
      if (browser) useBrowser().forget(browser.browserId)
      this.removeTab(id)
      // Closing a terminal's tab ends its shell, as closing it in the panel does.
      const term = parseTerminalTab(id)
      if (term) useWorkspace().closeTerminal(term.terminalId)
    },

    /** Take a tab out of the strip and the panes, with nothing else: what it showed lives on (a terminal moving back to the panel). */
    removeTab(id: string) {
      const i = this.tabs.indexOf(id)
      if (i === -1) return
      const shownIn = this.panes.filter(p => p.threadId === id)
      this.tabs.splice(i, 1)
      delete this.groups[id]
      // The neighbouring tab of the same pane's strip takes its place (the strips only hold the active
      // project's tabs: another project's chat would run in that other project's folder). A split
      // pane left with an empty strip closes.
      for (const p of shownIn) { p.threadId = null; this._refill(p.id, i) }
      this.persistLayout()
    },

    /** Put a tab in the strip before `before` (null: at the end), moving it when it is open already; into `paneId`'s strip when given. */
    placeTab(id: string, before: string | null, paneId?: string) {
      this.tabs = placeBefore(this.tabs, id, before)
      if (paneId && !this.panes.some(p => p.threadId === id)) this._setGroup(id, paneId)
      this.persistLayout()
    },

    /**
     * Show a tab in one pane (a terminal can be drawn in one place): it moves to that pane's strip,
     * and the pane it left shows its strip's next tab. 'split' opens it in a new pane on the right.
     */
    showOnly(id: string, paneId: string | 'split') {
      if (paneId === 'split' && this.panes.length === 1) {
        this.split(id)
        return
      }
      this.show(id, paneId === 'split' ? this.panes[1]!.id : paneId)
      this.persistLayout()
    },

    /** Add a tab without showing it, after `after` when that is open (else at the end), in `after`'s strip (else the active pane's). */
    addTab(id: string, after: string | null = null) {
      if (this.tabs.includes(id)) return
      const at = after ? this.tabs.indexOf(after) : -1
      if (at >= 0) this.tabs.splice(at + 1, 0, id)
      else this.tabs.push(id)
      this._setGroup(id, at >= 0 ? this.groupOf(after!) : this.activePaneId)
    },

    /**
     * Show `id` in the pane beside the one showing `beside` (the active pane when that is not
     * on screen), splitting when there is one pane; its tab goes into that pane's strip. The focus
     * stays where it was unless `focus`: a browser an agent or a link opens must not take the
     * keyboard from the chat.
     */
    showBeside(id: string, beside: string | null, focus = false) {
      const keep = this.activePaneId
      if (!this.panes.some(p => p.threadId === id)) {
        const anchor = this.panes.find(p => p.threadId === beside) ?? this.activePane
        this.addTab(id, beside)
        if (this.panes.length === 1) this.split(id)
        else this.show(id, this.panes.find(p => p.id !== anchor.id)!.id)
      }
      const target = this.panes.find(p => p.threadId === id)
      this.activePaneId = focus || !target || !this.panes.some(p => p.id === keep) ? target?.id ?? this.panes[0]!.id : keep
      this.persistLayout()
    },

    /** Show `next` in the place of the tab `old` (browsing diffs reuses one tab instead of piling them up). */
    replaceTab(old: string, next: string) {
      const i = this.tabs.indexOf(old)
      if (i === -1 || this.tabs.includes(next)) {
        this.show(next)
        if (i !== -1 && old !== next) this.closeTab(old)
        return
      }
      this.tabs[i] = next
      if (this.groups[old]) this.groups[next] = this.groups[old]!
      delete this.groups[old]
      for (const p of this.panes) if (p.threadId === old) p.threadId = next
      const diff = parseDiffTab(old)
      if (diff) useGit().closeDiff(diff.projectPath, diff.key)
    },

    focusPane(paneId: string) {
      this.activePaneId = paneId
      const t = this.byId(this.panes.find(p => p.id === paneId)?.threadId)
      if (t && (t.status === 'working' || t.status === 'done')) t.seen = true
    },

    /**
     * Open a second pane to the right with its own tab strip, holding `threadId` or the active project's
     * next tab (moved out of the left strip). Already split: show `threadId` in the right pane.
     */
    split(threadId?: string) {
      if (this.panes.length > 1) {
        if (threadId) this.show(threadId, this.panes[1]!.id)
        return
      }
      const left = this.panes[0]!
      const next = threadId ?? this.visibleTabs.find(id => id !== left.threadId) ?? null
      if (next && !this.tabs.includes(next)) this.tabs.push(next)
      // A fresh split: the project's tabs all start on the left, but the one moving right.
      for (const id of this.visibleTabs) delete this.groups[id]
      this.panes.push({ id: 'pane-b', threadId: next })
      if (next) this.groups[next] = 'pane-b'
      this.activePaneId = 'pane-b'
      // It was on the left: the left pane shows its next tab (with none, there is nothing to split).
      if (next && left.threadId === next) { left.threadId = null; this._refill(left.id, this.tabs.indexOf(next)) }
      this.persistLayout()
    },

    /** Close a pane; its tabs join the other pane's strip. */
    closePane(paneId: string) {
      if (this.panes.length === 1) return
      for (const id of this.visibleTabs) delete this.groups[id]
      this.panes = this.panes.filter(p => p.id !== paneId)
      this.panes[0]!.id = 'pane-a'
      this.activePaneId = 'pane-a'
      this.persistLayout()
    },

    /**
     * Move a chat within its project's list, next to `targetId`. From then on
     * that project keeps the hand-made order (new chats still arrive on top).
     */
    reorder(id: string, targetId: string, where: 'before' | 'after') {
      const t = this.byId(id)
      if (!t || id === targetId) return
      const ids = this.forProject(t.projectPath).map(x => x.id).filter(x => x !== id)
      const at = ids.indexOf(targetId)
      if (at === -1) return
      ids.splice(where === 'before' ? at : at + 1, 0, id)
      ids.forEach((x, i) => { const th = this.byId(x); if (th) th.order = i })
      this.persist()
    },
    /** Keyboard / menu version of dragging: one place up or down. */
    move(id: string, by: -1 | 1) {
      const t = this.byId(id)
      if (!t) return
      const ids = this.forProject(t.projectPath).map(x => x.id)
      const target = ids[ids.indexOf(id) + by]
      if (target) this.reorder(id, target, by < 0 ? 'before' : 'after')
    },
    /**
     * An environment's instance was renamed: chats in it follow it to `env://<hostId>/<to>/…` (the
     * agent's session lives in the same folder inside, so it resumes). Diff, file and browser tabs of
     * it close: their ids carry the old place.
     */
    moveEnvInstance(hostId: string, from: string, to: string) {
      for (const id of [...this.tabs]) {
        const moved = movedEnvPath(tabProject(id), hostId, from, to)
        if (!moved) continue
        // A terminal's shell keeps running: its tab follows the project instead of closing.
        const term = parseTerminalTab(id)
        if (term) this.replaceTab(id, terminalTabId(moved, term.terminalId))
        else this.closeTab(id)
      }
      for (const t of this.threads) {
        const path = movedEnvPath(t.projectPath, hostId, from, to)
        if (path) t.projectPath = path
        const wt = movedEnvPath(t.worktree, hostId, from, to)
        if (wt) t.worktree = wt
      }
      this.persist()
    },

    /** Forget the hand-made order of a project: newest first again. */
    resetOrder(projectPath: string) {
      for (const t of this.threads) if (t.projectPath === projectPath) delete t.order
      this.persist()
    },

    /** Set a chat's status by hand: Working, or Settled (the sidebar mark). While an agent runs, the run owns the status.
     *  Settling puts the chat away: its tab (and a pane left empty by it) closes, as archiving does. */
    setStatus(id: string, status: 'working' | 'done') {
      const t = this.byId(id)
      if (!t || isBusy(t)) return
      t.status = status
      t.seen = true
      t.archived = false
      if (status === 'done') this.closeTab(id)
      this.persist(id)
    },

    /** Put a chat away: it leaves the list and its tab closes, nothing is deleted. */
    archive(id: string) {
      const t = this.byId(id)
      if (!t || isBusy(t)) return
      t.archived = true
      t.seen = true
      this.closeTab(id)
      this.persist(id)
    },

    unarchive(id: string) {
      const t = this.byId(id)
      if (!t) return
      t.archived = false
      this.persist(id)
    },

    rename(id: string, title: string) {
      const t = this.byId(id)
      if (t && title.trim()) { t.title = title.trim(); this.persist(id) }
    },

    /** Delete a chat, with the sub-agent chats under it. */
    remove(id: string) {
      const doomed = new Set([id])
      for (let grew = true; grew;) {
        grew = false
        for (const t of this.threads) if (t.parentId && doomed.has(t.parentId) && !doomed.has(t.id)) { doomed.add(t.id); grew = true }
      }
      for (const x of doomed) { this.closeTab(x); delete this.queue[x]; held.delete(x) }
      this.threads = this.threads.filter(t => !doomed.has(t.id))
      for (const p of this.panes) if (p.threadId && doomed.has(p.threadId)) p.threadId = null
      this.persist()
    },

    setAgent(id: string, agent: AgentId) {
      const t = this.byId(id)
      if (!t) return
      if (t.agent !== agent) {
        t.agent = agent
        t.model = AGENTS[agent].models[0]!.id
        t.effort = null
        // Each CLI keeps its own conversation; the other agent starts fresh.
        t.sessionId = null
      }
      this.defaultAgent = agent
      this.persist(id)
    },

    /** The sidebar's agent choice: for the chat on screen, and for new chats from now on. */
    chooseAgent(agent: AgentId) {
      const open = this.activeThread
      if (open && !open.parentId) this.setAgent(open.id, agent)
      else {
        this.defaultAgent = agent
        this.persistLayout()
      }
    },

    /** `efforts`: the levels the new model accepts; an effort it doesn't know is dropped. */
    setModel(id: string, model: string, efforts?: string[]) {
      const t = this.byId(id)
      if (!t) return
      t.model = model
      if (t.effort && efforts && !efforts.includes(t.effort)) t.effort = null
      this.persist(id)
    },

    setEffort(id: string, effort: string | null) {
      const t = this.byId(id)
      if (t) { t.effort = effort; this.persist(id) }
    },

    setMode(id: string, mode: Thread['mode']) {
      const t = this.byId(id)
      if (t) { t.mode = mode; this.persist(id) }
    },

    /**
     * Append a user message (text, attachments or both) and start the agent. While the agent
     * is working the message waits in the chat's queue and goes out as the next turn, so the run
     * is not disturbed; `sendNow` hands it to the running turn instead.
     */
    async send(id: string, text: string, attachments: Attachment[] = [], opposite = false) {
      const t = this.byId(id)
      // A sub-agent's chat is written by its parent's run only.
      if (!t || t.parentId || (!text.trim() && !attachments.length)) return
      t.archived = false // writing in an archived chat brings it back
      if (isBusy(t)) {
        const queued = { id: uid('q'), text: text.trim(), attachments }
        ;(this.queue[id] ??= []).push(queued)
        // Steer: hand it to the running turn now. Queue: it waits for the turn to end. `opposite` flips the
        // setting for this one message. When the agent has answered and only background tasks (a dev server)
        // keep the run open there is nothing to disturb, so it goes straight in unless queueing was asked for.
        const ws = useWorkspace()
        const steer = (ws.followUp === 'steer') !== opposite
        if ((steer || (this.live[id]?.idle && !opposite)) && !isCommand(queued.text)) await this.sendNow(id, queued.id)
        return
      }
      held.delete(id)
      this._appendUser(t, text.trim(), attachments)
      await this._runTurn(t.id, text.trim(), attachments)
      await this._sendFollowUps(t.id)
    },

    /**
     * Give a waiting message to the running turn now: the agent reads it at its next step. A turn
     * that cannot take it (or none running) answers it as the next turn.
     */
    async sendNow(id: string, queuedId: string) {
      const t = this.byId(id)
      const list = this.queue[id]
      const i = list?.findIndex(q => q.id === queuedId) ?? -1
      if (!t || !list || i < 0) return
      // No run to hand it to (between turns, or the simulated agent of the browser preview): it stays queued.
      if (!isRunning(id)) return
      const [q] = list.splice(i, 1) as [QueuedMessage]
      if (!list.length) delete this.queue[id]
      held.delete(id)
      this._appendUser(t, q.text, q.attachments)
      if (!isBusy(t)) {
        await this._runTurn(id, q.text, q.attachments)
        await this._sendFollowUps(id)
        return
      }
      // A command waits for the turn to end and then runs on its own; anything else steers.
      if (!isCommand(q.text) && await steerRun(id, q.text, q.attachments)) return
      const waiting = this.queue[id] ?? (this.queue[id] = [])
      waiting.unshift({ ...q, shown: true })
      // The turn may have ended while the steer was being tried: nothing else would send it then.
      if (!isBusy(t)) await this._sendFollowUps(id)
    },

    /** Take a waiting message back without sending it. */
    dropQueued(id: string, queuedId: string) {
      const rest = (this.queue[id] ?? []).filter(q => q.id !== queuedId)
      if (rest.length) this.queue[id] = rest
      else delete this.queue[id]
    },

    /** A user message into the chat (the title follows the first one). */
    _appendUser(t: Thread, text: string, attachments: Attachment[]) {
      const msg: Message = {
        id: uid('m'),
        role: 'user',
        parts: text ? [{ type: 'text', text }] : [],
        createdAt: Date.now(),
      }
      if (attachments.length) msg.attachments = attachments.map(a => ({ ...a }))
      t.messages.push(msg)
      if (t.title === 'New chat' && !isClear(text)) t.title = createPrPrompt(text) ? 'Create a pull request' : titleFrom(text.trim() || attachments[0]!.name)
      t.updatedAt = Date.now()
      this.persist(t.id)
    },

    /** One turn for a message already in the chat, or Mango's own `/clear` and `/create-pr`. */
    async _runTurn(id: string, text: string, attachments: Attachment[]) {
      const t = this.byId(id)
      if (!t) return
      if (isClear(text) && !attachments.length) {
        // The CLI's conversation is left behind; the next message starts a fresh one.
        t.sessionId = null
        const m = this._pushAgentMessage(id)
        if (m) this._pushPart(id, m, { type: 'notice', level: 'info', text: `New conversation. ${AGENTS[t.agent].name} no longer sees the messages above.` })
        this.persist(id)
        return
      }
      t.status = 'queued'
      this.persist(id)
      if (t.awaitingWorktree) {
        // Nothing has run in this chat yet: a message kept from a failed try goes along with this one.
        const asked = t.messages.filter(m => m.role === 'user')
        if (asked.length > 1) {
          text = asked.map(m => m.parts.map(p => (p.type === 'text' ? p.text : '')).join('')).filter(Boolean).join('\n\n')
          attachments = asked.flatMap(m => m.attachments ?? [])
        }
        try {
          await this._addWorktreeFor(id)
        } catch (e) {
          const m = this._pushAgentMessage(id)
          if (m) {
            this._pushPart(id, m, {
              type: 'notice',
              level: 'error',
              text: `Could not make a ${vcsTerms(useWorkspace().openProjects.find(p => p.path === t.projectPath)?.vcs).worktree} for this chat: ${errorText(e)}. Nothing ran yet; send a message to try again (what you wrote goes along).`,
            })
          }
          this._setStatus(id, 'error', 'error')
          return
        }
        // Stopped while the worktree was being made: the chat is ready there, the turn does not start.
        if (t.status !== 'queued') { stopFlags.delete(id); return }
      }
      // Mango's own `/create-pr`: the chat keeps the command, the agent gets the instructions.
      await runAgentTurn(this, id, createPrPrompt(text) ?? text, attachments)
    },

    /** Messages written while the last turn ran: one turn answers all the plain ones in a row. */
    async _sendFollowUps(id: string) {
      for (;;) {
        const t = this.byId(id)
        const waiting = this.queue[id]
        if (!t || !waiting?.length || isBusy(t) || held.has(id)) return
        // A command goes out on its own; plain messages written in a row go out together.
        let n = 1
        if (!isCommand(waiting[0]!.text)) while (n < waiting.length && !isCommand(waiting[n]!.text)) n++
        const batch = waiting.splice(0, n)
        if (!waiting.length) delete this.queue[id]
        for (const w of batch) if (!w.shown) this._appendUser(t, w.text, w.attachments)
        await this._runTurn(id, batch.map(w => w.text).filter(Boolean).join('\n\n'), batch.flatMap(w => w.attachments))
      }
    },

    /** Resolve an approval request inside a message. */
    resolveApproval(threadId: string, messageId: string, partIndex: number, allow: boolean) {
      const t = this.byId(threadId)
      const part = t?.messages.find(m => m.id === messageId)?.parts[partIndex]
      if (!t || !part || part.type !== 'approval' || part.state !== 'pending') return
      part.state = allow ? 'allowed' : 'denied'
      if (!t.messages.some(m => m.parts.some(awaitsUser)) && t.status === 'waiting') t.status = 'running'
      this.persist(threadId)
      if (part.id) respondApproval(threadId, part.id, allow)
      // The simulated agent (browser preview) awaits this instead.
      approvalWaiters.get(`${threadId}:${messageId}:${partIndex}`)?.(allow)
    },

    /** Answer an agent's multiple-choice questions (null: dismissed without an answer). */
    answerQuestion(threadId: string, messageId: string, partIndex: number, answers: QuestionAnswers | null) {
      const t = this.byId(threadId)
      const part = t?.messages.find(m => m.id === messageId)?.parts[partIndex]
      if (!t || !part || part.type !== 'question' || part.state !== 'pending') return
      part.state = answers ? 'answered' : 'dismissed'
      // A secret answer goes to the agent only, never into the saved chat.
      if (answers) part.answers = answers.map((a, i) => (part.questions[i]?.secret && a.length ? ['••••••'] : a))
      if (!t.messages.some(m => m.parts.some(awaitsUser)) && t.status === 'waiting') t.status = 'running'
      this.persist(threadId)
      if (part.id) answerQuestion(threadId, part.id, answers)
    },

    stop(id: string) {
      const t = this.byId(id)
      if (!t || (t.status !== 'running' && t.status !== 'queued' && t.status !== 'waiting')) return
      // A sub-agent stops on its own; the run it belongs to goes on.
      if (t.parentId) {
        const root = this.rootOf(id)
        if (root && t.toolId) stopTask(root.id, t.toolId)
        return
      }
      // Stop means stop: messages waiting for the next turn stay in the queue but are not sent.
      held.add(id)
      // A real run winds down by itself and reports 'stopped'; the simulated one is just flagged.
      if (interruptRun(id)) return
      stopFlags.add(id)
      this._clearLive(id)
      for (const c of this.childrenOf(id)) if (c.status === 'running') c.status = 'error'
      t.status = 'working'
      this.persist()
    },

    /**
     * Link a pull request or issue to a chat (a sub-agent's link goes to its top-level chat).
     * Linking one that is already there refreshes what is known about it. True when it is new.
     */
    link(id: string, link: LinkedItem): boolean {
      const t = this.rootOf(id)
      if (!t) return false
      const links = (t.links ??= [])
      const had = links.find(l => l.key === link.key)
      if (had) Object.assign(had, { url: link.url, kind: link.kind, ...(link.title ? { title: link.title } : {}), ...(link.state ? { state: link.state } : {}) })
      else links.push({ ...link })
      this.persist(t.id)
      return !had
    },

    unlink(id: string, key: string) {
      const t = this.rootOf(id)
      if (!t?.links) return
      t.links = t.links.filter(l => l.key !== key)
      if (!t.links.length) delete t.links
      this.persist(t.id)
    },

    /** What GitHub said about an item, on every chat that links it. */
    _updateLinks(key: string, patch: Partial<Pick<LinkedItem, 'title' | 'state' | 'url' | 'kind'>>) {
      let changed = false
      for (const t of this.threads) {
        const l = t.links?.find(x => x.key === key)
        if (!l) continue
        for (const [k, v] of Object.entries(patch) as Array<[keyof typeof patch, string]>) {
          if (v !== undefined && l[k] !== v) { (l as Record<string, unknown>)[k] = v; changed = true }
        }
      }
      if (changed) this.persist()
    },

    /**
     * A tool call finished: when it created a pull request or issue, link it to the chat. If the
     * chat is the one in front of the user, the new item opens in the Pull requests tool window.
     */
    _linkCreated(id: string, part: Extract<Part, { type: 'tool' }>) {
      const root = this.rootOf(id)
      if (!root) return
      for (const ref of createdBy(part)) {
        const fresh = this.link(root.id, { ...ref, source: 'agent', linkedAt: Date.now() })
        const links = useLinks()
        void links.load(ref, root.projectPath, true)
        if (fresh && this.activePane.threadId === root.id) links.show(ref.key)
      }
    },

    /* -------- low-level mutations used by the agent driver -------- */

    /**
     * A chat for a sub-agent that the run of `parentId` started: read-only, listed under its
     * parent, opening with the task the parent agent wrote. Not shown until the user opens it.
     */
    _createSubagent(parentId: string, opts: { toolId: string; title: string; agentType?: string; prompt?: string }): Thread | null {
      const parent = this.byId(parentId)
      if (!parent) return null
      const now = Date.now()
      const t: Thread = {
        id: uid('t'),
        projectPath: parent.projectPath,
        title: titleFrom(opts.title) || 'Sub-agent',
        agent: parent.agent,
        model: parent.model,
        mode: parent.mode,
        effort: null,
        status: 'running',
        messages: opts.prompt ? [{ id: uid('m'), role: 'user', parts: [{ type: 'text', text: opts.prompt }], createdAt: now, fromAgent: true }] : [],
        createdAt: now,
        updatedAt: now,
        seen: true,
        simulated: parent.simulated,
        branch: parent.branch ?? null,
        parentId,
        toolId: opts.toolId,
        ...(opts.agentType ? { agentType: opts.agentType } : {}),
      }
      this.threads.push(t)
      this.persist([t.id, parentId])
      return this.byId(t.id)
    },

    _liveFor(id: string): LiveState {
      return (this.live[id] ??= { tasks: [], idle: false })
    },
    _taskStart(id: string, task: Omit<BackgroundTask, 'status' | 'startedAt'>) {
      const live = this._liveFor(id)
      if (live.tasks.some(x => x.id === task.id)) return
      live.tasks.push({ ...task, status: 'running', startedAt: Date.now() })
    },
    _taskUpdate(id: string, taskId: string, patch: Partial<Pick<BackgroundTask, 'title' | 'activity'>>) {
      const task = this.live[id]?.tasks.find(x => x.id === taskId)
      if (task) Object.assign(task, patch)
    },
    _taskEnd(id: string, taskId: string, status: BackgroundTask['status'], summary?: string) {
      const task = this.live[id]?.tasks.find(x => x.id === taskId)
      if (!task || task.status !== 'running') return
      task.status = status
      task.endedAt = Date.now()
      task.activity = undefined
      if (summary) task.summary = summary
    },
    _setIdle(id: string, idle: boolean) {
      if (idle || this.live[id]) this._liveFor(id).idle = idle
    },
    /** The run ended: its background work is over. */
    _clearLive(id: string) {
      delete this.live[id]
    },
    _pushAgentMessage(id: string): Message | null {
      const t = this.byId(id)
      if (!t) return null
      const m: Message = { id: uid('m'), role: 'agent', parts: [], createdAt: Date.now() }
      t.messages.push(m)
      return t.messages[t.messages.length - 1]!
    },
    _pushPart(id: string, msg: Message, part: Part) {
      msg.parts.push(part)
      this._touch(id)
      return msg.parts[msg.parts.length - 1]!
    },
    /** `outcome` says how a run ended; a finished turn goes back to Working, never to Settled. */
    _setStatus(id: string, status: Thread['status'], outcome?: Message['outcome']) {
      const t = this.byId(id)
      if (!t) return
      // A run just ended: note on its message how long the whole turn took.
      const wasBusy = isBusy(t)
      t.status = status
      if (wasBusy && !isBusy(t)) {
        const last = t.messages[t.messages.length - 1]
        if (last?.role === 'agent' && last.elapsedMs === undefined) {
          const asked = [...t.messages].reverse().find(m => m.role === 'user')
          last.elapsedMs = Date.now() - (asked?.createdAt ?? last.createdAt)
          last.outcome = outcome ?? (status === 'error' ? 'error' : 'stopped')
        }
      }
      const visible = this.panes.some(p => p.threadId === id)
      if (outcome === 'done') t.seen = visible
      this._touch(id)
      this.persist(id)
    },
    /** The chat changed (an agent's output too): note the time, and save it soon. */
    _touch(id: string) {
      const t = this.byId(id)
      if (t) t.updatedAt = Date.now()
      this.persist(id)
    },
  },
})

/**
 * Sidebar order is the user's: chats placed by hand keep their place; chats without a
 * place (new ones) come first, newest created on top. Activity never moves a chat, so
 * the list holds still while agents answer.
 */
function byListOrder(a: Thread, b: Thread) {
  if (a.order === undefined && b.order === undefined) return b.createdAt - a.createdAt
  if (a.order === undefined) return -1
  if (b.order === undefined) return 1
  return a.order - b.order
}

/** Which saved chats this window takes: the ones it owns (`utils/windows.ts`). */
function ownedKeep(): Keep {
  const win = useWindows()
  let roots: Map<string, string> | null = null
  let seen: Thread[] | null = null
  return (t, all) => {
    if (seen !== all) { roots = rootIds(all); seen = all }
    return win.owns({ projectPath: t.projectPath, rootId: roots!.get(t.id) ?? t.id })
  }
}

/** Running, starting or waiting for an approval: its status belongs to the run. */
export const isBusy = (t: Thread) => t.status === 'running' || t.status === 'queued' || t.status === 'waiting'

export const approvalWaiters = new Map<string, (allow: boolean) => void>()
/** Chats whose queue waits for the user: the run was stopped, so nothing goes out by itself. */
const held = new Set<string>()
export const stopFlags = new Set<string>()

/** Threads from disk: nothing is running after a restart, and older builds stored other model/mode values. */
/** A tab that shows something other than a chat; none of them is saved with the layout. */
const isViewTab = (id: string | null | undefined) => isDiffTab(id) || isFileTab(id) || isBrowserTab(id) || isTerminalTab(id)

function normalizeLoaded(t: Thread): Thread {
  const agent: AgentId = t.agent in AGENTS ? t.agent : 'claude'
  // Any id the CLI offered is fine (the list comes from the CLI); only junk falls back.
  const model = typeof t.model === 'string' && t.model.trim() ? t.model : AGENTS[agent].models[0]!.id
  const effort = typeof t.effort === 'string' && t.effort ? t.effort : null
  const mode = (['plan', 'ask', 'edits', 'auto'] as const).includes(t.mode) ? t.mode : 'ask'
  // Older builds also had an 'idle' status; it is Working now.
  const interrupted = ['running', 'queued', 'waiting', 'idle'].includes(t.status)
  // A sub-agent cut off by closing the app did not finish.
  const after: Thread['status'] = t.parentId ? 'error' : 'working'
  const messages = t.messages.map(m => ({
    ...m,
    ...(Array.isArray(m.attachments) ? { attachments: m.attachments.filter(a => a && typeof a.path === 'string') } : { attachments: undefined }),
    parts: m.parts.map((p): Part => {
      if ((p.type === 'approval' || p.type === 'question') && p.state === 'pending') return { ...p, state: 'cancelled' }
      if (p.type === 'tool' && p.status === 'running') return { ...p, status: 'error', summary: 'did not finish' }
      return p
    }),
  }))
  const links = Array.isArray(t.links)
    ? t.links.filter(l => l && typeof l.key === 'string' && typeof l.url === 'string' && typeof l.number === 'number')
    : []
  const worktree = typeof t.worktree === 'string' && t.worktree && !t.parentId ? t.worktree : undefined
  // Still waiting for its worktree only while it has none (a top-level chat).
  const awaitingWorktree = t.awaitingWorktree === true && !worktree && !t.parentId ? true as const : undefined
  return { ...t, agent, model, mode, effort, messages, status: interrupted ? after : t.status, links: links.length ? links : undefined, worktree, awaitingWorktree }
}

/** The reason in a rejected backend call or a thrown error, without a trailing period. */
function errorText(e: unknown): string {
  const text = e instanceof Error ? e.message : typeof e === 'string' ? e : String(e)
  return text.trim().replace(/\.$/, '') || 'git gave no reason'
}

function titleFrom(text: string) {
  const line = text.trim().split('\n')[0]!.replace(/[`*_#>]/g, '')
  return line.length > 48 ? `${line.slice(0, 46).trimEnd()}…` : line
}
