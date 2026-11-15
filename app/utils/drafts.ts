import type { Attachment } from '~/types/chat'

/** Unsent composer text per thread id. In-memory only. */
export const drafts = reactive(new Map<string, string>())

/** Files waiting in the composer per thread id. In-memory only (the files themselves are on disk). */
export const attachmentDrafts = reactive(new Map<string, Attachment[]>())
