import { defineStore } from 'pinia'
import type { PlasticReviews } from '~/types/ipc'
import { call } from '~/composables/useBackend'

/**
 * Unity VCS code reviews for the Pull requests tool window, by workspace folder: the branch's own
 * and the repository's open ones, as `cm` last reported them. Not saved: read again when shown.
 */

export interface ReviewsState {
  data: PlasticReviews | null
  loading: boolean
  error: string | null
  fetchedAt: number
}

/** Reading again sooner than this when the window reopens is not worth a `cm` round trip. */
const FRESH_MS = 60_000

/** The latest read started per folder: an older read that finishes later is dropped. */
const reads = new Map<string, number>()

const message = (e: unknown) => (typeof e === 'string' ? e : e instanceof Error ? e.message : String(e)).trim() || 'Something went wrong'

export const useReviews = defineStore('reviews', {
  state: () => ({
    byPath: {} as Record<string, ReviewsState>,
  }),

  actions: {
    async load(path: string, force = false) {
      const had = this.byPath[path]
      if (had?.loading && !force) return
      if (!force && had?.data && !had.error && Date.now() - had.fetchedAt < FRESH_MS) return
      const mine = (reads.get(path) ?? 0) + 1
      reads.set(path, mine)
      this.byPath[path] = { data: had?.data ?? null, fetchedAt: had?.fetchedAt ?? 0, loading: true, error: null }
      try {
        const data = await call('plastic_reviews', { path })
        if (reads.get(path) !== mine) return
        this.byPath[path] = { data, loading: false, error: null, fetchedAt: Date.now() }
      } catch (e) {
        if (reads.get(path) !== mine) return
        this.byPath[path] = { data: had?.data ?? null, fetchedAt: had?.fetchedAt ?? 0, loading: false, error: message(e) }
      }
    },

    /** Ask for a review of the workspace's branch, then read the list again. Rejects with a message to show. */
    async request(path: string, title: string, reviewers: string): Promise<number> {
      let id: number
      try {
        id = await call('plastic_review_create', { path, title: title.trim(), reviewers: reviewers.trim() || null })
      } catch (e) {
        throw new Error(message(e))
      }
      await this.load(path, true)
      return id
    },
  },
})
