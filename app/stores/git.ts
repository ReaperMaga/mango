import { defineStore } from 'pinia'
import { markRaw } from 'vue'
import type { GhItem, GitAhead, GitBranches, GitBranchList, GitCommit, GitFile, GitStatus, GitWorktree, VcsLock, VcsShelve } from '~/types/ipc'
import { t } from '~/i18n'
import { call } from '~/composables/useBackend'
import { useWorkspace } from '~/stores/workspace'
import { useFiles } from '~/stores/files'
import { vcsTerms } from '~/utils/vcs'
import { sameStatus } from '~/utils/rowWindow'

/** The one action that can run at a time. */
export type GitAction = 'stage' | 'unstage' | 'discard' | 'commit' | 'fetch' | 'pull' | 'push' | 'checkout' | 'init' | 'merge' | 'pr' | 'lock' | 'shelve' | 'abort' | 'continue' | 'skip' | 'take'

export interface GitDiffEntry {
  /** Unified diff text; null until the first load finishes. */
  text: string | null
  loading: boolean
  error: string | null
}

/** Everything the panel knows about one project's repository. */
export interface GitRepoState {
  status: GitStatus | null
  /** True only while the very first status is being read. */
  loading: boolean
  /** Why the last status read failed. */
  error: string | null
  branches: GitBranches | null
  log: GitCommit[]
  /** HEAD the log was read at, so it reloads only when history moved. `undefined`: never read. */
  logHead: string | null | undefined
  historyOpen: boolean
  /** Commit message draft. */
  message: string
  /** Keys (see `gitFileKey`) of the rows whose diff is open. */
  expanded: string[]
  /** Diff cache by key. */
  diffs: Record<string, GitDiffEntry>
  /** The repository's working trees, main first (`git worktree list`); null until read. */
  worktrees: GitWorktree[] | null
  /**
   * A linked worktree only: its branch against the one checked out in the main folder (what it merges
   * into). Null when this is no linked worktree, or the count can't be read (a detached main folder).
   */
  vsMain: GitAhead | null
  /** Unity VCS: the repository's locks, by path; null until read (and for git). */
  locks: VcsLock[] | null
  /** Unity VCS shelves, newest first; null until read. Read when the Shelves section opens and after each shelve action. */
  shelves: VcsShelve[] | null
  shelvesOpen: boolean
  /** Why the last shelves read failed. */
  shelvesError: string | null
}

export const HISTORY_LIMIT = 20

/** Identity of a row: the same file can appear once staged and once unstaged. */
export const gitFileKey = (file: string, staged: boolean) => `${staged ? 'staged' : 'changes'}:${file}`
const parseKey = (key: string) => {
  const at = key.indexOf(':')
  return { staged: key.slice(0, at) === 'staged', file: key.slice(at + 1) }
}

/** Tauri rejects with the Rust error string; the browser mock throws Errors. */
const reason = (e: unknown) => (typeof e === 'string' ? e : e instanceof Error ? e.message : String(e)).trim() || t('git.somethingWrong')

const newRepo = (): GitRepoState => ({
  status: null, loading: false, error: null, branches: null, log: [], logHead: undefined, historyOpen: false, message: '', expanded: [], diffs: {}, worktrees: null, vsMain: null, locks: null, shelves: null, shelvesOpen: false, shelvesError: null,
})

/**
 * Locks are read from the server, so a refresh re-reads them at most this often. Actions that
 * take or release locks (`LOCK_ACTIONS`) and a manual refresh read them at once.
 */
const LOCKS_TTL_MS = 30_000
/** When each project's locks were last read. */
const locksAt = new Map<string, number>()
/** Lock, unlock, undo (releases a checkout's lock), checkin (releases or retains it), switch branch. */
const LOCK_ACTIONS: GitAction[] = ['lock', 'discard', 'commit', 'checkout']
/** Actions that leave the working copy's files as they are: open files save first, and go on saving meanwhile. */
const READ_ACTIONS: GitAction[] = ['stage', 'unstage', 'fetch', 'push', 'pr', 'init']

/** Each lock list by path, for `lockOf`; lists are replaced, never changed in place. */
const lockMaps = new WeakMap<VcsLock[], Map<string, VcsLock>>()

/* Refreshes are coalesced per project: one running, at most one queued behind it. */
const running = new Map<string, Promise<void>>()
const queued = new Map<string, Promise<void>>()

/*
 * Branch list reads (`loadBranchList`), per project: the newest one started, and the number of the
 * newest one whose answer was kept, so a slow older answer never replaces a newer one.
 */
let branchReadSeq = 0
const branchReads = new Map<string, { seq: number; started: number; promise: Promise<GitBranchList> }>()
const branchApplied = new Map<string, number>()

export const useGit = defineStore('git', {
  state: () => ({
    /** Repository state by project path. */
    repos: {} as Record<string, GitRepoState>,
    /** The action in flight, if any, and the project it belongs to. */
    busy: null as GitAction | null,
    busyPath: null as string | null,
    /** Result of the last action: a failure, or git's output worth reading. */
    lastError: null as string | null,
    lastOutput: null as string | null,
    /** Project the last result belongs to. */
    noticePath: null as string | null,
    /** Key of the row that was last opened or acted on. */
    selected: null as string | null,
    /**
     * The branch popup's list by project path: the last one read, shown at once while a fresh one
     * loads. Only projects whose popup was opened (or about to be) have one.
     */
    branchLists: {} as Record<string, GitBranchList>,
    /** Branch list reads in flight, by project path. */
    branchListReads: {} as Record<string, number>,
  }),

  getters: {
    repo: s => (path: string | null | undefined): GitRepoState | null => (path ? s.repos[path] ?? null : null),
    /** The working trees of the repository at `path` (main first); empty until read or for Unity VCS. */
    worktrees: s => (path: string | null | undefined): GitWorktree[] => (path ? s.repos[path]?.worktrees ?? [] : []),
    status: s => (path: string | null | undefined): GitStatus | null => (path ? s.repos[path]?.status ?? null : null),
    /** Rows of the Staged section. */
    stagedFiles: s => (path: string | null | undefined): GitFile[] =>
      (path ? s.repos[path]?.status?.files ?? [] : []).filter(f => f.index && !f.conflicted),
    /** Rows of the Changes section: conflicts first, then tracked edits, then new files. */
    changedFiles: s => (path: string | null | undefined): GitFile[] => {
      const rank = (f: GitFile) => (f.conflicted ? 0 : f.worktree === '?' ? 2 : 1)
      return (path ? s.repos[path]?.status?.files ?? [] : [])
        .filter(f => f.worktree || f.conflicted)
        .sort((a, b) => rank(a) - rank(b))
    },
    /** Unity VCS: the repository's locks; empty until read and for git. */
    locks: s => (path: string | null | undefined): VcsLock[] => (path ? s.repos[path]?.locks ?? [] : []),
    /** Unity VCS: the lock on one file (a path relative to the root), if any. */
    lockOf: s => (path: string | null | undefined, file: string): VcsLock | null => {
      const list = path ? s.repos[path]?.locks : null
      if (!list) return null
      // Asked once per row of the Changes view: look up, don't scan. A new list gets a new map.
      let byPath = lockMaps.get(list)
      if (!byPath) lockMaps.set(list, byPath = new Map(list.map(l => [l.path, l])))
      return byPath.get(file) ?? null
    },
    /** Whether the branch list of `path` is being read. */
    readingBranchList: s => (path: string | null | undefined): boolean => !!path && (s.branchListReads[path] ?? 0) > 0,
    isBusy: s => (path: string | null | undefined, action?: GitAction) =>
      !!s.busy && s.busyPath === path && (!action || s.busy === action),
  },

  actions: {
    ensure(path: string): GitRepoState {
      // Read it back through the store: the proxy is what tracks changes.
      if (!this.repos[path]) this.repos[path] = newRepo()
      return this.repos[path]!
    },

    /**
     * Re-read the repository: status, then whatever is on screen that depends
     * on it (open diffs, branches, history). Safe to call often.
     * A remote project (`env://…`) works the same: the backend runs git in its environment.
     */
    refresh(path: string): Promise<void> {
      const current = running.get(path)
      if (current) {
        // Something may have changed since that read started: run once more after it.
        let next = queued.get(path)
        if (!next) {
          next = current.then(() => {
            queued.delete(path)
            return this.refresh(path)
          })
          queued.set(path, next)
        }
        return next
      }
      const run = this.read(path).finally(() => running.delete(path))
      running.set(path, run)
      return run
    },

    /** The periodic refresh: skipped while one is already under way or an action runs. */
    poll(path: string) {
      if (!running.has(path) && !this.busy) void this.refresh(path)
    },

    async read(path: string) {
      const repo = this.ensure(path)
      if (!repo.status) repo.loading = true
      const started = Date.now()
      try {
        const status = await call('git_status', { path })
        const before = repo.status
        // Polling mostly returns the same thing; keep the old object so nothing re-renders. A status is
        // only ever replaced, never changed in place, so it stays raw: a Unity project lists tens of
        // thousands of files, and making each one reactive costs more than everything that reads them.
        if (!sameStatus(before, status)) repo.status = markRaw(status)
        repo.error = null
        // A merge that just stopped: its commit message is ready in the box (git's MERGE_MSG, Lore's own).
        const op = status.operation
        if (op?.kind === 'merge' && op.message && !before?.operation && !repo.message.trim()) repo.message = op.message
        this.syncProject(path, status)
        if (!status.isRepo) {
          Object.assign(repo, { branches: null, log: [], logHead: undefined, expanded: [], diffs: {}, worktrees: null, vsMain: null, locks: null })
          delete this.branchLists[path]
          return
        }
        // A kept branch list follows what status says moved (branch, HEAD, upstream counts), in the
        // background. Unchanged polls cost nothing extra; a read started since this one began is enough.
        const tracking = (st: GitStatus | null | undefined) => st && [st.branch, st.head, st.upstream, st.ahead, st.behind].join('\u0000')
        if (this.branchLists[path] && tracking(before) !== tracking(status)) this.loadBranchList(path, started).catch(() => {})
        this.reconcileDiffs(path)
        const moved = before?.branch !== status.branch || before?.head !== status.head
        await Promise.all([
          ...repo.expanded.map(key => this.loadDiff(path, key)),
          repo.branches === null || moved ? this.loadBranches(path) : null,
          repo.historyOpen && repo.logHead !== status.head ? this.loadLog(path) : null,
          // Worktrees come and go rarely: read once, and again when one is added or removed (or branches move).
          status.vcs === 'git' && (repo.worktrees === null || moved) ? this.loadWorktrees(path) : null,
          // The main folder's branch moves without this folder knowing: read it every time.
          status.vcs === 'git' && status.mainRoot ? this.loadVsMain(path) : (repo.vsMain = null),
          vcsTerms(status.vcs).locks ? this.loadLocks(path) : (repo.locks = null),
        ])
      } catch (e) {
        repo.error = reason(e)
      } finally {
        repo.loading = false
      }
    },

    /** Keep the project's branch (titlebar, pane headers) in step with what git or Unity VCS says. */
    syncProject(path: string, status: GitStatus) {
      const project = useWorkspace().openProjects.find(p => p.path === path)
      const vcs = status.isRepo ? status.vcs : null
      if (project && (project.branch !== status.branch || project.isGit !== status.isRepo || (project.vcs ?? null) !== vcs)) {
        project.branch = status.branch
        project.isGit = status.isRepo
        project.vcs = vcs
      }
    },

    /** Drop open rows and cached diffs for files that are no longer in that list. */
    reconcileDiffs(path: string) {
      const repo = this.ensure(path)
      const live = new Set<string>()
      for (const f of repo.status?.files ?? []) {
        if (f.index && !f.conflicted) live.add(gitFileKey(f.path, true))
        if (f.worktree || f.conflicted) live.add(gitFileKey(f.path, false))
      }
      if (repo.expanded.some(k => !live.has(k))) repo.expanded = repo.expanded.filter(k => live.has(k))
      for (const key of Object.keys(repo.diffs)) {
        // Closed rows are re-read when they open again; their text may be stale by then.
        if (!live.has(key) || !repo.expanded.includes(key)) delete repo.diffs[key]
      }
    },

    async loadDiff(path: string, key: string) {
      const repo = this.ensure(path)
      const { file, staged } = parseKey(key)
      if (!repo.diffs[key]) repo.diffs[key] = { text: null, loading: false, error: null }
      const entry = repo.diffs[key]!
      entry.loading = true
      try {
        const text = await call('git_diff', { path, file, staged })
        if (entry.text !== text) entry.text = text
        entry.error = null
      } catch (e) {
        entry.error = reason(e)
      } finally {
        entry.loading = false
      }
    },

    async loadBranches(path: string) {
      const repo = this.ensure(path)
      try {
        repo.branches = await call('git_branches', { path })
      } catch { /* the switcher falls back to the current branch */ }
    },

    /**
     * Read the branch list of `path` into `branchLists`. A read started at `since` or later (in flight
     * or done) is reused rather than repeated; the default asks for a fresh one. Rejects with git's reason.
     */
    loadBranchList(path: string, since = Date.now()): Promise<GitBranchList> {
      const last = branchReads.get(path)
      if (last && last.started >= since) return last.promise
      const seq = ++branchReadSeq
      const started = Date.now()
      this.branchListReads[path] = (this.branchListReads[path] ?? 0) + 1
      const promise = call('git_branch_list', { path })
        .then((list) => {
          if (seq > (branchApplied.get(path) ?? 0)) {
            branchApplied.set(path, seq)
            if (JSON.stringify(list) !== JSON.stringify(this.branchLists[path])) this.branchLists[path] = list
          }
          return list
        })
        .catch((e) => {
          // A failed read is never reused.
          if (branchReads.get(path)?.seq === seq) branchReads.delete(path)
          throw e
        })
        .finally(() => {
          this.branchListReads[path] = Math.max(0, (this.branchListReads[path] ?? 1) - 1)
        })
      branchReads.set(path, { seq, started, promise })
      return promise
    },

    async loadWorktrees(path: string) {
      const repo = this.ensure(path)
      try {
        const list = await call('git_worktrees', { path })
        if (JSON.stringify(list) !== JSON.stringify(repo.worktrees)) repo.worktrees = list
      } catch { /* keep the last list */ }
    },

    async loadVsMain(path: string) {
      const repo = this.ensure(path)
      try {
        const next = await call('git_ahead', { path, base: null })
        if (JSON.stringify(next) !== JSON.stringify(repo.vsMain)) repo.vsMain = next
      } catch {
        repo.vsMain = null
      }
    },

    /** Unity VCS: re-read the locks when the last read is older than `LOCKS_TTL_MS`, or always with `force`. */
    async loadLocks(path: string, force = false) {
      const at = locksAt.get(path)
      if (!force && at !== undefined && Date.now() - at < LOCKS_TTL_MS) return
      locksAt.set(path, Date.now())
      const repo = this.ensure(path)
      try {
        const list = await call('vcs_locks', { path })
        if (JSON.stringify(list) !== JSON.stringify(repo.locks)) repo.locks = list
      } catch {
        // Not knowing who holds what is no reason to fail the Changes view; try again on the next refresh.
        locksAt.delete(path)
      }
    },
    /** Read the locks again on the next refresh. */
    staleLocks(path: string) {
      locksAt.delete(path)
    },

    async loadLog(path: string) {
      const repo = this.ensure(path)
      const head = repo.status?.head ?? null
      try {
        repo.log = await call('git_log', { path, limit: HISTORY_LIMIT })
        repo.logHead = head
      } catch { /* history stays as it was */ }
    },

    async loadShelves(path: string) {
      const repo = this.ensure(path)
      try {
        const list = await call('vcs_shelves', { path })
        if (JSON.stringify(list) !== JSON.stringify(repo.shelves)) repo.shelves = list
        repo.shelvesError = null
      } catch (e) {
        repo.shelvesError = reason(e)
      }
    },
    toggleShelves(path: string) {
      const repo = this.ensure(path)
      repo.shelvesOpen = !repo.shelvesOpen
      if (repo.shelvesOpen) void this.loadShelves(path)
    },

    /* ---------- view state ---------- */

    isExpanded(path: string, key: string) {
      return this.repos[path]?.expanded.includes(key) ?? false
    },
    toggleExpanded(path: string, key: string) {
      const repo = this.ensure(path)
      this.selected = key
      if (repo.expanded.includes(key)) {
        repo.expanded = repo.expanded.filter(k => k !== key)
      } else {
        repo.expanded = [...repo.expanded, key]
        void this.loadDiff(path, key)
      }
    },
    /** Keep a file's diff loaded and fresh (it is shown in the main pane). */
    openDiff(path: string, key: string) {
      const repo = this.ensure(path)
      this.selected = key
      if (!repo.expanded.includes(key)) repo.expanded = [...repo.expanded, key]
      void this.loadDiff(path, key)
    },
    closeDiff(path: string, key: string) {
      const repo = this.repos[path]
      if (repo?.expanded.includes(key)) repo.expanded = repo.expanded.filter(k => k !== key)
    },
    toggleHistory(path: string) {
      const repo = this.ensure(path)
      repo.historyOpen = !repo.historyOpen
      if (repo.historyOpen && repo.logHead !== (repo.status?.head ?? null)) void this.loadLog(path)
    },
    dismiss() {
      this.lastError = null
      this.lastOutput = null
    },

    /* ---------- actions ---------- */

    /**
     * Run one git action, then re-read the repository whether it worked or
     * not. Failures land in `lastError`; resolves to whether it succeeded. Open files are saved
     * first (`files.aroundChange`); `also`: other working copies it changes.
     */
    async run(path: string, action: GitAction, work: () => Promise<string | void>, also: string[] = []): Promise<boolean> {
      if (this.busy) return false
      this.busy = action
      this.busyPath = path
      this.lastError = null
      this.lastOutput = null
      this.noticePath = path
      let ok = true
      try {
        const files = useFiles()
        const output = await (READ_ACTIONS.includes(action) ? files.aroundRead([path], work) : files.aroundChange([path, ...also], work))
        if (output) this.lastOutput = output
      } catch (e) {
        ok = false
        this.lastError = reason(e)
      }
      if (LOCK_ACTIONS.includes(action)) locksAt.delete(path)
      await this.refresh(path)
      this.busy = null
      this.busyPath = null
      return ok
    },

    /** Stage these files (their paths); an empty list stages every change. */
    stage(path: string, files: string[] = []) {
      return this.run(path, 'stage', () => call('git_stage', { path, files }))
    },
    /** Unstage these files; an empty list unstages everything. */
    unstage(path: string, files: string[] = []) {
      return this.run(path, 'unstage', () => call('git_unstage', { path, files }))
    },
    /** Throw away working-tree changes for these files; an empty list means all of them. Destroys work. */
    discard(path: string, files: string[] = []) {
      return this.run(path, 'discard', () => call('git_discard', { path, files }))
    },

    /**
     * Commit what is staged with the drafted message. With nothing staged,
     * stages every change first ("commit all"). Clears the draft on success.
     */
    async commit(path: string, opts: { amend?: boolean } = {}) {
      const repo = this.ensure(path)
      const message = repo.message.trim()
      const amend = !!opts.amend
      if (!message && !amend) return false
      const ok = await this.run(path, 'commit', async () => {
        const files = repo.status?.files ?? []
        if (!amend && !files.some(f => f.index && !f.conflicted)) {
          // Never sweep an unresolved conflict into a commit.
          const conflicts = files.some(f => f.conflicted)
          await call('git_stage', { path, files: conflicts ? files.filter(f => !f.conflicted).map(f => f.path) : [] })
        }
        const hash = await call('git_commit', { path, message, amend })
        if (amend) return t('git.result.amended', { id: hash })
        return t(repo.status?.vcs === 'plastic' ? 'git.result.checkedIn' : 'git.result.committed', { id: hash })
      })
      if (ok) {
        repo.message = ''
        repo.logHead = undefined
        if (repo.historyOpen) void this.loadLog(path)
      }
      return ok
    },

    /**
     * Unity VCS: shelve what a checkin would take (the staged files, or every change when none are)
     * with `comment`. With `undo` the workspace drops those changes afterwards. Opens the Shelves list.
     */
    async shelve(path: string, comment: string, undo: boolean) {
      const repo = this.ensure(path)
      const ok = await this.run(path, 'shelve', () => call('vcs_shelve', { path, comment, undo }))
      if (ok) repo.shelvesOpen = true
      await this.loadShelves(path)
      return ok
    },
    /** Bring a shelve's changes back into the workspace as pending changes; the shelve stays. */
    async applyShelve(path: string, id: number) {
      const ok = await this.run(path, 'shelve', () => call('vcs_shelve_apply', { path, id }))
      await this.loadShelves(path)
      return ok
    },
    /** Delete a shelve from the server. Destroys work: the UI asks first. */
    async deleteShelve(path: string, id: number) {
      const ok = await this.run(path, 'shelve', async () => {
        await call('vcs_shelve_delete', { path, id })
        return t('git.result.deleted', { id: `sh:${id}` })
      })
      await this.loadShelves(path)
      return ok
    },

    /* ---------- a merge, rebase, cherry-pick or revert in progress ---------- */

    /** Go back to before it started. Destroys the resolutions made so far: the UI asks first. */
    async abortOperation(path: string) {
      const ok = await this.run(path, 'abort', () => call('git_operation_abort', { path }))
      if (ok) this.ensure(path).message = ''
      return ok
    },
    /** A rebase, cherry-pick or revert goes on once its conflicts are resolved. */
    continueOperation(path: string) {
      return this.run(path, 'continue', () => call('git_operation_continue', { path }))
    },
    /** A rebase leaves out the commit it is applying. */
    skipOperation(path: string) {
      return this.run(path, 'skip', () => call('git_operation_skip', { path }))
    },
    /**
     * Take one side of a conflicted file whole (git: into the working tree, to be marked resolved after;
     * Lore: resolved at once). Open files are saved first and reloaded after.
     */
    takeSide(path: string, file: string, side: 'ours' | 'theirs') {
      return this.run(path, 'take', () => call('git_conflict_take', { path, file, side }))
    },

    fetch(path: string) {
      return this.run(path, 'fetch', async () => (await call('git_fetch', { path })) || t('git.result.fetched'))
    },
    /** Git pull; for Unity VCS, `cm update`. */
    pull(path: string) {
      return this.run(path, 'pull', async () => (await call('git_pull', { path })) || t('git.result.upToDate'))
    },
    /** Push; publishes the branch (sets its upstream) when it has none. */
    push(path: string) {
      return this.run(path, 'push', async () => (await call('git_push', { path })) || t('git.result.pushed'))
    },
    async checkout(path: string, branch: string, create = false) {
      const ok = await this.run(path, 'checkout', () => call('git_checkout', { path, branch, create }))
      if (ok) await this.loadBranches(path)
      return ok
    },
    /**
     * Unity VCS: lock files by checking them out. The server's lock rules decide whether a checkout
     * locks; the result says when they didn't.
     */
    lock(path: string, files: string[]) {
      return this.run(path, 'lock', async () => {
        const note = await call('vcs_lock', { path, files })
        return note || (files.length === 1 ? t('git.result.locked', { name: fileName(files[0]!) }) : t('git.result.lockedFiles', files.length))
      })
    },
    /** Unity VCS: release the user's own locks on files; the files stay as they are. */
    unlock(path: string, files: string[]) {
      return this.run(path, 'lock', async () => {
        await call('vcs_unlock', { path, files })
        return files.length === 1 ? t('git.result.released', { name: fileName(files[0]!) }) : t('git.result.releasedFiles', files.length)
      })
    },
    init(path: string) {
      return this.run(path, 'init', () => call('git_init', { path }))
    },

    /**
     * Merge the branch of the linked worktree at `path` into the branch checked out in the main folder
     * `main` (the merge runs there). The result shows with `path`; both folders are read again.
     */
    mergeWorktree(path: string, main: string, branch: string) {
      return this.run(path, 'merge', async () => {
        try {
          return (await call('git_merge', { path: main, branch })) || t('git.result.merged', { branch })
        } finally {
          const project = useWorkspace().activeProjectPath
          await Promise.all([...new Set([main, project])].filter((p): p is string => !!p && p !== path).map(p => this.refresh(p)))
        }
      }, [main])
    },

    /**
     * Push the branch at `path` (publishing it when it has no upstream), then open a pull request from it
     * into `base` with the GitHub CLI, or find the one already open. Resolves to it; null on failure (in `lastError`).
     */
    async openPullRequest(path: string, base: string): Promise<GhItem | null> {
      let item: GhItem | null = null
      await this.run(path, 'pr', async () => {
        await call('git_push', { path })
        item = await call('gh_pr_create', { path, base })
        return `${t('git.result.prOpen', { number: item.number, title: item.title })}\n${item.url}`
      })
      return item
    },
  },
})

const fileName = (f: string) => f.slice(f.lastIndexOf('/') + 1)

/**
 * Re-read a project's repository (the active one by default). Call it when
 * something outside the panel may have changed files, e.g. an agent turn ended.
 */
export function refreshGit(path?: string): Promise<void> {
  const target = path ?? useWorkspace().activeProjectPath
  return target ? useGit().refresh(target) : Promise.resolve()
}
