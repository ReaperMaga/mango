import { create } from 'zustand'
import type { LinkedItem } from '~/types/chat'
import type { GhJob, GhMergeMethod } from '~/types/ipc'
import { linkFromItem } from '~/utils/githubLinks'
import { backend } from '@/remote'
import { validGhRef, type GhDetail } from '@/remote/github'
import { useThreads } from '@/state/threads'
import { isJobUrl, tidyReference, REFERENCE_HINT } from '@/chat/pulls'

/**
 * Pull requests and issues as GitHub reports them, for the pull request screen: the port of the
 * desktop's `app/stores/links.ts`. Which items belong to which chat is the chat's own business
 * (`Thread.links`, in the threads store); this keeps what was read about them. Not saved: it is
 * read again when shown. Links come from chat files (untrusted): only ones that pass `validGhRef`
 * are read, and jobs only by a github.com Actions link (`isJobUrl`).
 */

export interface LinkDetail {
  item: GhDetail | null
  loading: boolean
  /** The read in progress is a background one (keeping checks current), not one the user asked for. */
  quiet: boolean
  error: string | null
  fetchedAt: number
}

/** A GitHub Actions job as last read, for the check log screen. */
export interface JobDetail {
  job: GhJob | null
  loading: boolean
  error: string | null
  fetchedAt: number
}

/** What was read is good for this long before opening the item reads it again. */
const FRESH_MS = 4 * 60_000

type LinkRef = Pick<LinkedItem, 'key' | 'kind' | 'host' | 'owner' | 'repo' | 'number'>

/** The latest read started per link key: an older read that finishes later is dropped. */
const reads = new Map<string, number>()
/** Where each item was last read from, to read it again when the network is back. */
const sources = new Map<string, { link: LinkRef; projectPath: string; threadId: string }>()
/** The same for job reads, by job link. */
const jobReads = new Map<string, number>()
const jobSources = new Map<string, string>()

const message = (e: unknown) => (typeof e === 'string' ? e : e instanceof Error ? e.message : String(e))

export interface LinksState {
  /** By link key (`LinkedItem.key`). */
  details: Record<string, LinkDetail>
  /** GitHub Actions jobs, by link. */
  jobs: Record<string, JobDetail>

  /**
   * Read an item from GitHub, unless what we have is recent (or `force`), then keep its title and
   * state on the chat's link. A `quiet` read is a background one: it never starts while another runs.
   */
  load(threadId: string, link: LinkRef, projectPath: string, force?: boolean, quiet?: boolean): Promise<void>
  /** Merge a pull request as it was last read (GitHub refuses if its branch moved since), then read it again. Rejects with a message to show. */
  merge(threadId: string, link: LinkRef, projectPath: string, method: GhMergeMethod): Promise<void>
  /** Link the item the person named (a link, `owner/repo#12` or `#12`) to a chat. Rejects with a message to show. */
  linkByReference(threadId: string, reference: string): Promise<LinkedItem>
  /** Keep an item read elsewhere (a pull request just opened) and link it to a chat. */
  adopt(threadId: string | null, item: GhDetail): LinkedItem
  /** Read a job (its steps, and its log once it finished). The newest read wins. */
  loadJob(projectPath: string, url: string): Promise<void>
  /** The network is back: read again what failed while it was gone. */
  retryFailed(): void
}

export const useLinks = create<LinksState>()((set, get) => {
  const put = (key: string, d: LinkDetail) => set(s => ({ details: { ...s.details, [key]: d } }))
  const putJob = (url: string, j: JobDetail) => set(s => ({ jobs: { ...s.jobs, [url]: j } }))

  /** The chat's saved link follows what GitHub says, so the list reads well offline. */
  const keepOnChat = (threadId: string, key: string, item: GhDetail) => {
    const threads = useThreads.getState()
    const had = threads.rootOf(threadId)?.links?.find(l => l.key === key)
    if (had && (had.title !== item.title || had.state !== item.state || had.kind !== item.kind)) {
      threads.link(threadId, { ...had, kind: item.kind, title: item.title, state: item.state })
    }
  }

  return {
    details: {},
    jobs: {},

    async load(threadId, link, projectPath, force = false, quiet = false) {
      if (!validGhRef(link)) {
        put(link.key, { item: null, loading: false, quiet: false, error: 'Only pull requests and issues on github.com can be read here.', fetchedAt: 0 })
        return
      }
      const had = get().details[link.key]
      // A read the person asked for goes ahead even while another runs; the newest one wins.
      if (had?.loading && (quiet || !force)) return
      if (!force && had?.item && !had.error && Date.now() - had.fetchedAt < FRESH_MS) return
      const mine = (reads.get(link.key) ?? 0) + 1
      reads.set(link.key, mine)
      sources.set(link.key, { link, projectPath, threadId })
      const keep = { item: had?.item ?? null, fetchedAt: had?.fetchedAt ?? 0 }
      put(link.key, { ...keep, loading: true, quiet, error: null })
      try {
        const item = await backend.ghDetail(projectPath, link)
        if (reads.get(link.key) !== mine) return
        put(link.key, { item, loading: false, quiet: false, error: null, fetchedAt: Date.now() })
        keepOnChat(threadId, link.key, item)
      } catch (e) {
        if (reads.get(link.key) !== mine) return
        put(link.key, { ...keep, loading: false, quiet: false, error: message(e) })
      }
    },

    async merge(threadId, link, projectPath, method) {
      const headSha = get().details[link.key]?.item?.headSha
      if (!headSha) throw new Error('Read the pull request again before merging it.')
      try {
        await backend.ghMerge(projectPath, link, method, headSha)
      } catch (e) {
        void get().load(threadId, link, projectPath, true, true)
        throw new Error(message(e))
      }
      await get().load(threadId, link, projectPath, true)
    },

    async linkByReference(threadId, reference) {
      const chat = useThreads.getState().rootOf(threadId)
      if (!chat) throw new Error('That chat is gone.')
      const tidy = tidyReference(reference)
      if (!tidy) throw new Error(REFERENCE_HINT)
      let item: GhDetail
      try {
        item = await backend.ghResolve(chat.projectPath, tidy)
      } catch (e) {
        throw new Error(message(e))
      }
      return get().adopt(chat.id, item)
    },

    adopt(threadId, item) {
      // `linkFromItem` reads only the fields both shapes share; the description is not part of a link.
      const link = linkFromItem({ ...item, bodyHtml: '' }, 'user')
      if (!validGhRef(link)) throw new Error('Only pull requests and issues on github.com can be linked here.')
      put(link.key, { item, loading: false, quiet: false, error: null, fetchedAt: Date.now() })
      if (threadId) useThreads.getState().link(threadId, link)
      return link
    },

    async loadJob(projectPath, url) {
      if (!isJobUrl(url)) {
        putJob(url, { job: null, loading: false, error: 'Only GitHub Actions jobs on github.com have a log here.', fetchedAt: 0 })
        return
      }
      const had = get().jobs[url]
      const mine = (jobReads.get(url) ?? 0) + 1
      jobReads.set(url, mine)
      jobSources.set(url, projectPath)
      putJob(url, { job: had?.job ?? null, fetchedAt: had?.fetchedAt ?? 0, loading: true, error: null })
      try {
        const job = await backend.ghJob(projectPath, url)
        if (jobReads.get(url) !== mine) return
        putJob(url, { job, loading: false, error: null, fetchedAt: Date.now() })
      } catch (e) {
        if (jobReads.get(url) !== mine) return
        putJob(url, { job: had?.job ?? null, fetchedAt: had?.fetchedAt ?? 0, loading: false, error: message(e) })
      }
    },

    retryFailed() {
      for (const [key, d] of Object.entries(get().details)) {
        const from = sources.get(key)
        if (d.error && !d.loading && from) void get().load(from.threadId, from.link, from.projectPath, true, true)
      }
      for (const [url, j] of Object.entries(get().jobs)) {
        const from = jobSources.get(url)
        if (j.error && !j.loading && from) void get().loadJob(from, url)
      }
    },
  }
})
