import { defineStore } from 'pinia'
import type { GhItem } from '~/types/ipc'
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
  error: string | null
  fetchedAt: number
}

/** The picture links in a description are signed for a few minutes only: read it again before they lapse. */
const STALE_MS = 4 * 60_000

const message = (e: unknown) => (typeof e === 'string' ? e : e instanceof Error ? e.message : String(e))

export const useLinks = defineStore('links', {
  state: () => ({
    /** By link key (`LinkedItem.key`). */
    details: {} as Record<string, LinkDetail>,
    /** The item the tool window has open; null shows the chat's list. */
    focused: null as string | null,
  }),

  actions: {
    /** Read an item from GitHub, unless what we have is recent (or `force`). */
    async load(link: Pick<LinkedItem, 'key' | 'url'>, projectPath: string, force = false) {
      const had = this.details[link.key]
      if (had?.loading) return
      if (!force && had?.item && !had.error && Date.now() - had.fetchedAt < STALE_MS) return
      this.details[link.key] = { item: had?.item ?? null, loading: true, error: null, fetchedAt: had?.fetchedAt ?? 0 }
      try {
        const item = await call('gh_item', { path: projectPath, reference: link.url })
        this.details[link.key] = { item, loading: false, error: null, fetchedAt: Date.now() }
        useThreads()._updateLinks(link.key, { title: item.title, state: item.state, url: item.url, kind: item.kind })
      } catch (e) {
        this.details[link.key] = { item: had?.item ?? null, loading: false, error: message(e), fetchedAt: had?.fetchedAt ?? 0 }
      }
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
      this.details[link.key] = { item, loading: false, error: null, fetchedAt: Date.now() }
      threads.link(chat.id, link)
      this.focused = link.key
      return link
    },

    /** Open an item in the tool window. */
    show(key: string) {
      this.focused = key
      useWorkspace().openTool('links')
    },
  },
})
