import { create } from 'zustand'
import type { GhRunAction, GhRunDetail } from '~/types/ipc'
import { backend } from '@/remote'
import type { Releases } from '@/remote/releases'

/**
 * GitHub releases and the workflow runs that build them, for the Releases screens: the port of the
 * desktop's `app/stores/releases.ts`. Kept per project path; not saved, read again when shown. Which
 * run belongs to which release is the desktop's `~/utils/releaseRuns.ts`.
 */

export interface ReleaseList {
  data: Releases | null
  loading: boolean
  /** The read in progress keeps what is shown current; it is not one the person asked for. */
  quiet: boolean
  error: string | null
  fetchedAt: number
  /** How many releases are asked for ("Show older" adds a page). */
  count: number
}

/** A release's newest run (or a run by id) with its jobs, as last read. */
export interface RunRead {
  detail: GhRunDetail | null
  /** No workflow ran for the release's tag. */
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
export const readKey = (path: string, key: string) => `${path}\n${key}`

/** The newest read started per list or run; an older one that finishes later is dropped. */
const reads = new Map<string, number>()
function begin(key: string) {
  const mine = (reads.get(key) ?? 0) + 1
  reads.set(key, mine)
  return () => reads.get(key) === mine
}

export interface ReleasesState {
  lists: Record<string, ReleaseList>
  runs: Record<string, RunRead>
  /** An action on a run under way, by run id. */
  acting: Record<number, GhRunAction>

  /** Read the project's releases, unless the last read is recent (or `force`). */
  load(path: string, opts?: { force?: boolean; quiet?: boolean }): Promise<void>
  /** List a page of older releases too. */
  more(path: string): Promise<void>
  /** Read an entry's run and its jobs: a release's newest run by its tag, or a run by id. */
  loadRun(path: string, key: string): Promise<void>
  /** Re-run or cancel a run, then read it and the list again. Rejects with a message to show. */
  act(path: string, key: string, runId: number, action: GhRunAction): Promise<void>
  /** The network is back: read again what failed while it was gone. */
  retryFailed(): void
}

export const useReleases = create<ReleasesState>()((set, get) => {
  const putList = (path: string, l: ReleaseList) => set(s => ({ lists: { ...s.lists, [path]: l } }))
  const putRun = (at: string, r: RunRead) => set(s => ({ runs: { ...s.runs, [at]: r } }))

  return {
    lists: {},
    runs: {},
    acting: {},

    async load(path, opts = {}) {
      const had = get().lists[path]
      if (had?.loading && (opts.quiet || !opts.force)) return
      if (!opts.force && had?.data && !had.error && Date.now() - had.fetchedAt < FRESH_MS) return
      const current = begin(`list\n${path}`)
      const count = had?.count ?? PAGE
      const keep = { data: had?.data ?? null, fetchedAt: had?.fetchedAt ?? 0, count }
      putList(path, { ...keep, loading: true, quiet: !!opts.quiet, error: null })
      try {
        const data = await backend.ghReleases(path, count)
        if (!current()) return
        putList(path, { data, count, loading: false, quiet: false, error: null, fetchedAt: Date.now() })
      } catch (e) {
        if (!current()) return
        putList(path, { ...keep, loading: false, quiet: false, error: message(e) })
      }
    },

    async more(path) {
      const had = get().lists[path]
      if (!had) return
      putList(path, { ...had, count: Math.min(MAX, had.count + PAGE) })
      await get().load(path, { force: true })
    },

    async loadRun(path, key) {
      const at = readKey(path, key)
      const had = get().runs[at]
      const current = begin(`run\n${at}`)
      const keep = { detail: had?.detail ?? null, none: had?.none ?? false, fetchedAt: had?.fetchedAt ?? 0 }
      putRun(at, { ...keep, loading: true, error: null })
      try {
        const detail = key.startsWith('tag:')
          ? await backend.ghTagRun(path, key.slice(4))
          : await backend.ghRun(path, Number(key.slice(4)))
        if (!current()) return
        putRun(at, { detail, none: !detail, loading: false, error: null, fetchedAt: Date.now() })
      } catch (e) {
        if (!current()) return
        putRun(at, { ...keep, loading: false, error: message(e) })
      }
    },

    async act(path, key, runId, action) {
      if (get().acting[runId]) return
      set(s => ({ acting: { ...s.acting, [runId]: action } }))
      try {
        await backend.ghRunAction(path, runId, action)
      } catch (e) {
        throw new Error(message(e))
      } finally {
        set((s) => {
          const { [runId]: _, ...acting } = s.acting
          return { acting }
        })
      }
      // GitHub takes a moment to show the new state.
      await new Promise(r => setTimeout(r, 1500))
      await Promise.all([get().loadRun(path, key), get().load(path, { force: true, quiet: true })])
    },

    retryFailed() {
      for (const [path, l] of Object.entries(get().lists)) {
        if (l.error && !l.loading) void get().load(path, { force: true, quiet: true })
      }
      for (const [at, r] of Object.entries(get().runs)) {
        if (!r.error || r.loading) continue
        const nl = at.indexOf('\n')
        void get().loadRun(at.slice(0, nl), at.slice(nl + 1))
      }
    },
  }
})
