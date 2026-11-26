import { defineStore } from 'pinia'
import type { GhReleases, GhRunAction, GhRunDetail, GhRunJob } from '~/types/ipc'
import { call } from '~/composables/useBackend'
import type { OpenCheck } from '~/stores/links'
import { sortReleases, stripeMark, type SortedReleases } from '~/utils/releaseRuns'

/**
 * GitHub or GitLab releases and the workflow runs (pipelines) that build them, for the Releases tool window and the mark
 * on its stripe button. Kept per project path; not saved, read again when shown. Which run belongs
 * to which release is worked out in `utils/releaseRuns.ts`.
 */

export interface ReleaseList {
  data: GhReleases | null
  loading: boolean
  /** The read in progress keeps what is shown current; it is not one the user asked for. */
  quiet: boolean
  error: string | null
  fetchedAt: number
  /** How many releases are asked for ("Show older" adds a page). */
  count: number
}

/** A release's newest run (or a run by id) with its jobs, as last read. */
export interface RunRead {
  detail: GhRunDetail | null
  /** No workflow (pipeline) ran for the release's tag. */
  none: boolean
  loading: boolean
  error: string | null
  fetchedAt: number
}

export const PAGE = 30
const MAX = 100
/** A list read this recently is not read again unless asked. */
const FRESH_MS = 30_000

const message = (e: unknown) => (typeof e === 'string' ? e : e instanceof Error ? e.message : String(e))
/** Where a run read is kept: the project, then the entry (`tag:<tag>` or `run:<id>`). */
const readKey = (path: string, key: string) => `${path}\n${key}`

/** The newest read started per list or run; an older one that finishes later is dropped. */
const reads = new Map<string, number>()
function begin(key: string) {
  const mine = (reads.get(key) ?? 0) + 1
  reads.set(key, mine)
  return () => reads.get(key) === mine
}

export const useReleases = defineStore('releases', {
  state: () => ({
    lists: {} as Record<string, ReleaseList>,
    runs: {} as Record<string, RunRead>,
    /** The entry the window has open (`tag:<tag>` or `run:<id>`) and in which project; null shows the list. */
    focused: null as { path: string; key: string } | null,
    /** The job whose log is open over the entry. */
    job: null as OpenCheck | null,
    /** An action on a run under way, by run id. */
    acting: {} as Record<number, GhRunAction>,
  }),

  getters: {
    sorted: state => (path: string | null): SortedReleases | null => {
      const data = path ? state.lists[path]?.data : null
      return data ? sortReleases(data.releases, data.runs, data.provider) : null
    },
    /** The stripe button's corner mark for a project. */
    mark(): (path: string | null) => 'running' | 'failed' | null {
      return (path) => {
        const s = this.sorted(path)
        return s ? stripeMark(s) : null
      }
    },
    run: state => (path: string, key: string): RunRead | undefined => state.runs[readKey(path, key)],
  },

  actions: {
    /** Read the project's releases, unless the last read is recent (or `force`). */
    async load(path: string, opts: { force?: boolean; quiet?: boolean } = {}) {
      const had = this.lists[path]
      if (had?.loading && (opts.quiet || !opts.force)) return
      if (!opts.force && had?.data && !had.error && Date.now() - had.fetchedAt < FRESH_MS) return
      const current = begin(`list\n${path}`)
      const count = had?.count ?? PAGE
      const keep = { data: had?.data ?? null, fetchedAt: had?.fetchedAt ?? 0, count }
      this.lists[path] = { ...keep, loading: true, quiet: !!opts.quiet, error: null }
      try {
        const data = await call('gh_releases', { path, count })
        if (!current()) return
        this.lists[path] = { data, count, loading: false, quiet: false, error: null, fetchedAt: Date.now() }
      } catch (e) {
        if (!current()) return
        this.lists[path] = { ...keep, loading: false, quiet: false, error: message(e) }
      }
    },

    /** List a page of older releases too. */
    async more(path: string) {
      const had = this.lists[path]
      if (!had) return
      had.count = Math.min(MAX, had.count + PAGE)
      await this.load(path, { force: true })
    },

    /** Read an entry's run and its jobs: a release's newest run by its tag, or a run by id. */
    async loadRun(path: string, key: string) {
      const at = readKey(path, key)
      const had = this.runs[at]
      const current = begin(`run\n${at}`)
      const keep = { detail: had?.detail ?? null, none: had?.none ?? false, fetchedAt: had?.fetchedAt ?? 0 }
      this.runs[at] = { ...keep, loading: true, error: null }
      try {
        const detail = key.startsWith('tag:')
          ? await call('gh_tag_run', { path, tag: key.slice(4) })
          : await call('gh_run', { path, id: Number(key.slice(4)) })
        if (!current()) return
        this.runs[at] = { detail, none: !detail, loading: false, error: null, fetchedAt: Date.now() }
      } catch (e) {
        if (!current()) return
        this.runs[at] = { ...keep, loading: false, error: message(e) }
      }
    },

    /** Re-run or cancel a run, then read it and the list again. Rejects with a message to show. */
    async act(path: string, key: string, runId: number, action: GhRunAction) {
      if (this.acting[runId]) return
      this.acting[runId] = action
      try {
        await call('gh_run_action', { path, id: runId, action })
      } catch (e) {
        throw new Error(message(e))
      } finally {
        delete this.acting[runId]
      }
      // The forge takes a moment to show the new state.
      await new Promise(r => setTimeout(r, 1500))
      await Promise.all([this.loadRun(path, key), this.load(path, { force: true, quiet: true })])
    },

    open(path: string, key: string) {
      this.focused = { path, key }
      this.job = null
    },
    back() {
      this.focused = null
      this.job = null
    },
    openJob(job: GhRunJob, workflow: string) {
      if (!this.focused) return
      this.job = { linkKey: `release\n${this.focused.key}`, url: job.url, name: job.name, workflow }
    },
    closeJob() {
      this.job = null
    },
  },
})
