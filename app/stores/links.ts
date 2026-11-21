import { defineStore } from 'pinia'
import type { GhCheck, GhItem, GhJob, GhMergeMethod, GhOpenItems } from '~/types/ipc'
import type { LinkedItem } from '~/types/chat'
import { call } from '~/composables/useBackend'
import { useThreads } from '~/stores/threads'
import { useWorkspace } from '~/stores/workspace'
import { linkFromItem } from '~/utils/githubLinks'

/**
 * Pull requests and issues as GitHub reports them, for the Pull requests tool window. Which items
 * belong to which chat is the chat's own business (`Thread.links`, in the threads store); this
 * keeps what was read about them. Not saved: it is read again when shown.
 */

export interface LinkDetail {
  item: GhItem | null
  loading: boolean
  /** The read in progress is a background one (keeping checks current), not one the user asked for. */
  quiet: boolean
  error: string | null
  fetchedAt: number
  /** When the description shown was read: its picture links lapse, see STALE_MS. */
  bodyAt: number
}

/** A GitHub Actions job as last read, for the check log view. */
export interface JobDetail {
  job: GhJob | null
  loading: boolean
  error: string | null
  fetchedAt: number
}

/** A project's open pull requests and issues as last listed, to pick one to link. */
export interface OpenList {
  list: GhOpenItems | null
  loading: boolean
  error: string | null
  fetchedAt: number
}

/** The check whose log the tool window shows, over the pull request it belongs to. */
export interface OpenCheck {
  /** The pull request's link key: the log closes when another item opens. */
  linkKey: string
  /** Its details link, a GitHub Actions job (see `isJobUrl`). */
  url: string
  name: string
  workflow: string | null
}

/** A check's details link that `gh_job` can read: a GitHub Actions job. */
export const isJobUrl = (url: string | null | undefined): url is string =>
  !!url && /^https:\/\/[^/]+\/[^/]+\/[^/]+\/actions\/runs\/\d+\/job\/\d+(?:[?#].*)?$/.test(url)

/** The open list is listed again when it is older than this. */
const OPEN_FRESH_MS = 60_000

/** The picture links in a description are signed for a few minutes only: read it again before they lapse. */
const STALE_MS = 4 * 60_000

/** The latest read started per link key: an older read that finishes later is dropped. */
const reads = new Map<string, number>()
/** Where each item was last read from (its link and project), to read it again when the network is back. */
const sources = new Map<string, { url: string; projectPath: string }>()
/** The same for job reads, by job link. */
const jobReads = new Map<string, number>()

const message = (e: unknown) => (typeof e === 'string' ? e : e instanceof Error ? e.message : String(e))

export const useLinks = defineStore('links', {
  state: () => ({
    /** By link key (`LinkedItem.key`). */
    details: {} as Record<string, LinkDetail>,
    /** The item the tool window has open; null shows the chat's list. */
    focused: null as string | null,
    /** GitHub Actions jobs, by link. */
    jobs: {} as Record<string, JobDetail>,
    /** The check whose log is open over its pull request; null shows the pull request. */
    check: null as OpenCheck | null,
    /** Open pull requests and issues, by project path. */
    open: {} as Record<string, OpenList>,
  }),

  actions: {
    /**
     * Read an item from GitHub, unless what we have is recent (or `force`). A `quiet` read keeps
     * the description already shown while its pictures are still good: GitHub signs picture links
     * afresh on every read, and swapping them in would reload every picture each time.
     */
    async load(link: Pick<LinkedItem, 'key' | 'url'>, projectPath: string, force = false, quiet = false) {
      const had = this.details[link.key]
      // A read the user asked for goes ahead even while another runs; the newest one wins.
      if (had?.loading && (quiet || !force)) return
      if (!force && had?.item && !had.error && Date.now() - had.bodyAt < STALE_MS) return
      const mine = (reads.get(link.key) ?? 0) + 1
      reads.set(link.key, mine)
      sources.set(link.key, { url: link.url, projectPath })
      const keep = { item: had?.item ?? null, fetchedAt: had?.fetchedAt ?? 0, bodyAt: had?.bodyAt ?? 0 }
      this.details[link.key] = { ...keep, loading: true, quiet, error: null }
      try {
        const read = await call('gh_item', { path: projectPath, reference: link.url })
        if (reads.get(link.key) !== mine) return
        const now = Date.now()
        const old = this.details[link.key]?.item
        const keepBody = quiet && old?.url === read.url && now - keep.bodyAt < STALE_MS
        const item = keepBody ? { ...read, bodyHtml: old!.bodyHtml } : read
        this.details[link.key] = { item, loading: false, quiet: false, error: null, fetchedAt: now, bodyAt: keepBody ? keep.bodyAt : now }
        useThreads()._updateLinks(link.key, { title: item.title, state: item.state, url: item.url, kind: item.kind })
      } catch (e) {
        if (reads.get(link.key) !== mine) return
        this.details[link.key] = { ...keep, loading: false, quiet: false, error: message(e) }
      }
    },

    /**
     * Merge a pull request on GitHub as it was last read (GitHub refuses if its branch moved since),
     * then read it again. Rejects with a message to show.
     */
    async merge(link: Pick<LinkedItem, 'key' | 'url'>, projectPath: string, method: GhMergeMethod) {
      const headSha = this.details[link.key]?.item?.headSha
      if (!headSha) throw new Error('Read the pull request again before merging it.')
      try {
        await call('gh_merge', { path: projectPath, reference: link.url, method, headSha })
      } catch (e) {
        void this.load(link, projectPath, true, true)
        throw new Error(message(e))
      }
      await this.load(link, projectPath, true)
    },

    /**
     * Link the pull request or issue the user named (a link, `owner/repo#12` or `#12`) to a chat and
     * open it. Rejects with a message to show when GitHub cannot be asked or has no such item.
     */
    async linkByReference(threadId: string, reference: string): Promise<LinkedItem> {
      const threads = useThreads()
      const chat = threads.rootOf(threadId)
      if (!chat) throw new Error('That chat is gone.')
      let item: GhItem
      try {
        item = await call('gh_item', { path: chat.projectPath, reference: reference.trim() })
      } catch (e) {
        throw new Error(message(e))
      }
      const link = linkFromItem(item, 'user')
      this.details[link.key] = { item, loading: false, quiet: false, error: null, fetchedAt: Date.now(), bodyAt: Date.now() }
      threads.link(chat.id, link)
      this.focused = link.key
      return link
    },

    /** List the project's open pull requests and issues, unless the last list is recent (or `force`). */
    async loadOpen(projectPath: string, force = false) {
      const had = this.open[projectPath]
      if (had?.loading) return
      if (!force && had?.list && !had.error && Date.now() - had.fetchedAt < OPEN_FRESH_MS) return
      const keep = { list: had?.list ?? null, fetchedAt: had?.fetchedAt ?? 0 }
      this.open[projectPath] = { ...keep, loading: true, error: null }
      try {
        const list = await call('gh_open_items', { path: projectPath })
        this.open[projectPath] = { list, loading: false, error: null, fetchedAt: Date.now() }
      } catch (e) {
        this.open[projectPath] = { ...keep, loading: false, error: message(e) }
      }
    },

    /** Show a check's log over the pull request `linkKey`. Only GitHub Actions jobs have one here. */
    openCheck(linkKey: string, check: GhCheck) {
      if (!isJobUrl(check.url)) return
      this.check = { linkKey, url: check.url, name: check.name, workflow: check.workflow }
    },

    closeCheck() {
      this.check = null
    },

    /** Read a job (its steps, and its log once it finished). The newest read wins. */
    async loadJob(url: string) {
      const had = this.jobs[url]
      const mine = (jobReads.get(url) ?? 0) + 1
      jobReads.set(url, mine)
      this.jobs[url] = { job: had?.job ?? null, fetchedAt: had?.fetchedAt ?? 0, loading: true, error: null }
      try {
        const job = await call('gh_job', { url })
        if (jobReads.get(url) !== mine) return
        this.jobs[url] = { job, loading: false, error: null, fetchedAt: Date.now() }
      } catch (e) {
        if (jobReads.get(url) !== mine) return
        this.jobs[url] = { job: had?.job ?? null, fetchedAt: had?.fetchedAt ?? 0, loading: false, error: message(e) }
      }
    },

    /** The network is back: read again what failed while it was gone (the open item and its check log). */
    retryFailed() {
      for (const [key, d] of Object.entries(this.details)) {
        const from = sources.get(key)
        if (d.error && !d.loading && from) void this.load({ key, url: from.url }, from.projectPath, true, true)
      }
      for (const [url, j] of Object.entries(this.jobs)) if (j.error && !j.loading) void this.loadJob(url)
    },

    /** Open an item in the tool window. */
    show(key: string) {
      this.focused = key
      useWorkspace().openTool('links')
    },
  },
})
