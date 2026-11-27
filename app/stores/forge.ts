import { defineStore } from 'pinia'
import type { ForgeProvider, GhRepoLink } from '~/types/ipc'
import { call } from '~/composables/useBackend'

/**
 * Which forge each project's repository is on (GitHub or GitLab, and where), read from its git
 * remotes by `gh_repo_link` (no network). One cache for the titlebar's repository button and the
 * words of the Pull requests and Releases windows ("merge requests" and "pipelines" on GitLab).
 */

/** Reads under way, by path: asking again while one runs waits for it. */
const reading = new Map<string, Promise<GhRepoLink | null>>()

export const useForge = defineStore('forge', {
  state: () => ({
    /** By project (or worktree) path; null when no remote is on a forge, absent while unread. */
    links: {} as Record<string, GhRepoLink | null>,
  }),

  getters: {
    /** The provider of `path`'s repository; GitHub while unknown, the wording Mango always had. */
    providerOf: state => (path: string | null | undefined): ForgeProvider =>
      (path && state.links[path]?.provider === 'gitlab' ? 'gitlab' : 'github'),
    /** Whether `path`'s git remotes name a GitHub or GitLab repository; false while unread. */
    connected: state => (path: string | null | undefined): boolean => !!(path && state.links[path]),
  },

  actions: {
    /** Read `path`'s repository link again (when it comes into view, when the window comes back). */
    read(path: string): Promise<GhRepoLink | null> {
      const had = reading.get(path)
      if (had) return had
      const p = call('gh_repo_link', { path })
        .then((link) => { this.links[path] = link; return link })
        .catch(() => this.links[path] ?? null)
        .finally(() => reading.delete(path))
      reading.set(path, p)
      return p
    },

    /** Read it once: nothing happens when it is known already. */
    ensure(path: string | null | undefined) {
      if (path && !(path in this.links)) void this.read(path)
    },
  },
})
