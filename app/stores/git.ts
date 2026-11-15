import { defineStore } from 'pinia'
import type { GitBranches, GitCommit, GitFile, GitStatus } from '~/types/ipc'
import { call } from '~/composables/useBackend'
import { useWorkspace } from '~/stores/workspace'

/** The one action that can run at a time. */
export type GitAction = 'stage' | 'unstage' | 'discard' | 'commit' | 'fetch' | 'pull' | 'push' | 'checkout' | 'init'

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
}

export const HISTORY_LIMIT = 20

/** Identity of a row: the same file can appear once staged and once unstaged. */
export const gitFileKey = (file: string, staged: boolean) => `${staged ? 'staged' : 'changes'}:${file}`
const parseKey = (key: string) => {
  const at = key.indexOf(':')
  return { staged: key.slice(0, at) === 'staged', file: key.slice(at + 1) }
}

/** Tauri rejects with the Rust error string; the browser mock throws Errors. */
const reason = (e: unknown) => (typeof e === 'string' ? e : e instanceof Error ? e.message : String(e)).trim() || 'Something went wrong'

const newRepo = (): GitRepoState => ({
  status: null, loading: false, error: null, branches: null, log: [], logHead: undefined, historyOpen: false, message: '', expanded: [], diffs: {},
})

/* Refreshes are coalesced per project: one running, at most one queued behind it. */
const running = new Map<string, Promise<void>>()
const queued = new Map<string, Promise<void>>()

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
  }),

  getters: {
    repo: s => (path: string | null | undefined): GitRepoState | null => (path ? s.repos[path] ?? null : null),
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
      try {
        const status = await call('git_status', { path })
        const before = repo.status
        // Polling mostly returns the same thing; keep the old object so nothing re-renders.
        if (JSON.stringify(before) !== JSON.stringify(status)) repo.status = status
        repo.error = null
        this.syncProject(path, status)
        if (!status.isRepo) {
          Object.assign(repo, { branches: null, log: [], logHead: undefined, expanded: [], diffs: {} })
          return
        }
        this.reconcileDiffs(path)
        const moved = before?.branch !== status.branch || before?.head !== status.head
        await Promise.all([
          ...repo.expanded.map(key => this.loadDiff(path, key)),
          repo.branches === null || moved ? this.loadBranches(path) : null,
          repo.historyOpen && repo.logHead !== status.head ? this.loadLog(path) : null,
        ])
      } catch (e) {
        repo.error = reason(e)
      } finally {
        repo.loading = false
      }
    },

    /** Keep the project's branch (titlebar, pane headers) in step with what git says. */
    syncProject(path: string, status: GitStatus) {
      const project = useWorkspace().openProjects.find(p => p.path === path)
      if (project && (project.branch !== status.branch || project.isGit !== status.isRepo)) {
        project.branch = status.branch
        project.isGit = status.isRepo
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

    async loadLog(path: string) {
      const repo = this.ensure(path)
      const head = repo.status?.head ?? null
      try {
        repo.log = await call('git_log', { path, limit: HISTORY_LIMIT })
        repo.logHead = head
      } catch { /* history stays as it was */ }
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
     * not. Failures land in `lastError`; resolves to whether it succeeded.
     */
    async run(path: string, action: GitAction, work: () => Promise<string | void>): Promise<boolean> {
      if (this.busy) return false
      this.busy = action
      this.busyPath = path
      this.lastError = null
      this.lastOutput = null
      this.noticePath = path
      let ok = true
      try {
        const output = await work()
        if (output) this.lastOutput = output
      } catch (e) {
        ok = false
        this.lastError = reason(e)
      }
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
        return `${amend ? 'Amended' : 'Committed'} ${hash}`
      })
      if (ok) {
        repo.message = ''
        repo.logHead = undefined
        if (repo.historyOpen) void this.loadLog(path)
      }
      return ok
    },

    fetch(path: string) {
      return this.run(path, 'fetch', async () => (await call('git_fetch', { path })) || 'Fetched. Nothing new on the remote.')
    },
    pull(path: string) {
      return this.run(path, 'pull', async () => (await call('git_pull', { path })) || 'Already up to date.')
    },
    /** Push; publishes the branch (sets its upstream) when it has none. */
    push(path: string) {
      return this.run(path, 'push', async () => (await call('git_push', { path })) || 'Pushed.')
    },
    async checkout(path: string, branch: string, create = false) {
      const ok = await this.run(path, 'checkout', () => call('git_checkout', { path, branch, create }))
      if (ok) await this.loadBranches(path)
      return ok
    },
    init(path: string) {
      return this.run(path, 'init', () => call('git_init', { path }))
    },
  },
})

/**
 * Re-read a project's repository (the active one by default). Call it when
 * something outside the panel may have changed files, e.g. an agent turn ended.
 */
export function refreshGit(path?: string): Promise<void> {
  const target = path ?? useWorkspace().activeProjectPath
  return target ? useGit().refresh(target) : Promise.resolve()
}
