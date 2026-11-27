import { defineStore } from 'pinia'
import type { GhRunAction, GhRunJob, GhRunList } from '~/types/ipc'
import { call } from '~/composables/useBackend'
import type { OpenCheck } from '~/stores/links'
import { useReleases } from '~/stores/releases'
import { runKey } from '~/utils/releaseRuns'

/**
 * The Actions tool window: a project's recent GitHub Actions runs (GitLab: pipelines), all of them or
 * the current branch's, read through `gh_runs`. Kept per project and branch; not saved, read again when
 * shown (see useActionsWatch). A run's jobs are read through the Releases store (`loadRun`), which
 * already keeps runs by id, so both windows share them.
 */

export interface RunListRead {
  data: GhRunList | null
  loading: boolean
  /** The read keeps what is shown current; the user did not ask for it. */
  quiet: boolean
  error: string | null
  fetchedAt: number
  /** How many runs are asked for ("Show more" adds a page). */
  count: number
}

export const RUN_PAGE = 30
const MAX = 100
/** A list read this recently is not read again unless asked. */
const FRESH_MS = 20_000

const message = (e: unknown) => (typeof e === 'string' ? e : e instanceof Error ? e.message : String(e))
/** Where a list is kept: the project, then the branch ('' for all of them). */
export const listKey = (path: string, branch: string | null) => `${path}\n${branch ?? ''}`

const reads = new Map<string, number>()
function begin(key: string) {
  const mine = (reads.get(key) ?? 0) + 1
  reads.set(key, mine)
  return () => reads.get(key) === mine
}

export const useActions = defineStore('actions', {
  state: () => ({
    lists: {} as Record<string, RunListRead>,
    /** All of the repository's runs, or only the current branch's. */
    scope: 'all' as 'all' | 'branch',
    /** One workflow's runs only (its id), or all of them. */
    workflow: null as number | null,
    /** The run the window has open, in which project; null shows the list. */
    focused: null as { path: string; id: number } | null,
    /** The job whose log is open over the run. */
    job: null as OpenCheck | null,
    /** An action on a run under way, by run id. */
    acting: {} as Record<number, GhRunAction>,
  }),

  getters: {
    list: state => (path: string | null, branch: string | null): RunListRead | undefined =>
      (path ? state.lists[listKey(path, branch)] : undefined),
  },

  actions: {
    /** Read a project's runs (a branch's when named), unless the last read is recent (or `force`). */
    async load(path: string, branch: string | null, opts: { force?: boolean; quiet?: boolean } = {}) {
      const key = listKey(path, branch)
      const had = this.lists[key]
      if (had?.loading && (opts.quiet || !opts.force)) return
      if (!opts.force && had?.data && !had.error && Date.now() - had.fetchedAt < FRESH_MS) return
      const current = begin(key)
      const count = had?.count ?? RUN_PAGE
      const keep = { data: had?.data ?? null, fetchedAt: had?.fetchedAt ?? 0, count }
      this.lists[key] = { ...keep, loading: true, quiet: !!opts.quiet, error: null }
      try {
        const data = await call('gh_runs', { path, branch, count })
        if (!current()) return
        this.lists[key] = { data, count, loading: false, quiet: false, error: null, fetchedAt: Date.now() }
      } catch (e) {
        if (!current()) return
        this.lists[key] = { ...keep, loading: false, quiet: false, error: message(e) }
      }
    },

    /** List a page of older runs too. */
    async more(path: string, branch: string | null) {
      const had = this.lists[listKey(path, branch)]
      if (!had) return
      had.count = Math.min(MAX, had.count + RUN_PAGE)
      await this.load(path, branch, { force: true })
    },

    /** Read a run and its jobs (kept in the Releases store, by `run:<id>`). */
    loadRun(path: string, id: number) {
      return useReleases().loadRun(path, runKey(id))
    },

    /** Re-run or cancel a run, then read it and the list again. Rejects with a message to show. */
    async act(path: string, branch: string | null, id: number, action: GhRunAction) {
      if (this.acting[id]) return
      this.acting[id] = action
      try {
        await call('gh_run_action', { path, id, action })
      } catch (e) {
        throw new Error(message(e))
      } finally {
        delete this.acting[id]
      }
      // The forge takes a moment to show the new state.
      await new Promise(r => setTimeout(r, 1500))
      await Promise.all([this.loadRun(path, id), this.load(path, branch, { force: true, quiet: true })])
    },

    setScope(scope: 'all' | 'branch') {
      this.scope = scope
    },
    setWorkflow(id: number | null) {
      this.workflow = id
    },
    open(path: string, id: number) {
      this.focused = { path, id }
      this.job = null
    },
    back() {
      this.focused = null
      this.job = null
    },
    openJob(job: GhRunJob, workflow: string) {
      if (!this.focused) return
      this.job = { linkKey: `actions\n${this.focused.id}`, url: job.url, name: job.name, workflow }
    },
    closeJob() {
      this.job = null
    },
  },
})
