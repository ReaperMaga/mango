/** Unsent composer text per thread id. In-memory only. */
export const drafts = reactive(new Map<string, string>())
