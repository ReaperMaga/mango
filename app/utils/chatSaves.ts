import type { Thread } from '~/types/chat'
import type { ChatRow } from '~/types/ipc'

/**
 * The bookkeeping behind saving chats (`chatHistory.ts`), kept free of the backend so plain Node
 * can test it. A chat history can be large (hundreds of chats, tens of MB of JSON), so:
 * - only chats marked changed are serialised; a sweep (every chat compared, rows of chats gone
 *   deleted) is for the rare case that cannot name them (moving chats out of localStorage);
 * - what was last saved of each chat is kept as a fingerprint (length and a 64-bit hash of its
 *   JSON), not a second copy of the JSON. Rows just loaded keep their JSON until `settle` (in idle
 *   moments after loading) or their first save takes the fingerprint: hashing a whole history at
 *   once would hold up loading.
 * A chat that is gone is deleted by marking its id: a marked id with no chat is a deleted chat.
 */

/** Unchanged chats are told apart by this: the JSON's length and two 32-bit hashes of it. */
export function fingerprint(json: string): string {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < json.length; i++) {
    const c = json.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 2654435761)
    h2 = Math.imul(h2 ^ c, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return `${json.length}:${h1 >>> 0}:${h2 >>> 0}`
}

/** On disk, but what it holds is not known here: the next save of it is always sent. */
const UNKNOWN = ''

/** Saving debounces this long after a change. */
export const DEBOUNCE_MS = 400
/** Changes keep coming (typing, several actions): save at least this often anyway. */
export const MAX_WAIT_MS = 2000
/**
 * Only an agent's streamed output pending: save once it pauses this long, and at least this often
 * while it streams. Each save serialises the whole chat (a long one is over a megabyte). The end of
 * a turn, an approval, a status and closing the window save at once as before.
 */
export const STREAM_DEBOUNCE_MS = 2000
export const STREAM_MAX_WAIT_MS = 10_000

/** How long until the next save: `first` is when the first change since the last save came. */
export function saveDelay(now: number, first: number, urgent: boolean): number {
  const [debounce, max] = urgent ? [DEBOUNCE_MS, MAX_WAIT_MS] : [STREAM_DEBOUNCE_MS, STREAM_MAX_WAIT_MS]
  return Math.max(0, Math.min(debounce, first + max - now))
}

export interface SaveSource {
  threads: () => Thread[]
  byId: (id: string) => Thread | null
  /** The layout to save (tabs, panes…): compared as JSON, so it can be rebuilt each time. None: never saved. */
  layout?: () => unknown
}

export interface SaveBatch {
  upsert: ChatRow[]
  /** Rows to delete, and the project each chat was in. */
  remove: { id: string; projectPath: string }[]
  ui: string | null
  /** The chats in `upsert` with the JSON sent for them (for the remote mirror). */
  changed: { t: Thread; json: string }[]
}

export function createSaves() {
  /** Each saved chat's fingerprint as last sent (or `UNKNOWN`). */
  const saved = new Map<string, string>()
  /** Each saved chat's project: where a deleted one was. */
  const savedProject = new Map<string, string>()
  /** Rows loaded whose fingerprint is not taken yet: their JSON as on disk. */
  const pending = new Map<string, string>()
  let savedLayout: string | null = null
  const dirty = new Set<string>()
  let sweep = false

  /** What was last saved of a chat: its fingerprint (taken now from a loaded row's JSON). */
  const savedPrint = (id: string) => {
    const json = pending.get(id)
    if (json === undefined) return saved.get(id)
    pending.delete(id)
    const fp = fingerprint(json)
    saved.set(id, fp)
    return fp
  }

  return {
    /** A row this window holds now. With `normalized`, the chat as it will be kept: when its JSON differs from the row's, it is saved. */
    remember(t: Thread, json: string, normalized?: Thread) {
      savedProject.set(t.id, t.projectPath)
      saved.set(t.id, UNKNOWN)
      if (normalized && JSON.stringify(normalized) !== json) dirty.add(t.id)
      else pending.set(t.id, json)
    },
    /** Take the fingerprints of loaded rows for about `budgetMs`. True when some are left. */
    settle(budgetMs: number): boolean {
      const end = Date.now() + budgetMs
      for (const id of pending.keys()) {
        savedPrint(id)
        if (Date.now() >= end) break
      }
      return pending.size > 0
    },
    has: (id: string) => saved.has(id),
    /** Stop comparing, saving and deleting these here. */
    forget(ids: Iterable<string>) {
      for (const id of ids) { saved.delete(id); savedProject.delete(id); pending.delete(id); dirty.delete(id) }
    },
    setLayout(ui: string | null) { savedLayout = ui },
    /** These chats changed (a missing one: deleted). None given: compare every chat, and delete rows of the ones gone. */
    mark(ids?: string | string[]) {
      if (ids === undefined) sweep = true
      else for (const id of Array.isArray(ids) ? ids : [ids]) dirty.add(id)
    },
    /** What to send now, or null when nothing changed. The batch counts as saved until `failed` says otherwise. */
    collect(s: SaveSource): SaveBatch | null {
      const upsert: ChatRow[] = []
      const remove: SaveBatch['remove'] = []
      const changed: SaveBatch['changed'] = []
      const consider = (t: Thread) => {
        const json = JSON.stringify(t)
        const fp = fingerprint(json)
        if (savedPrint(t.id) === fp) return
        saved.set(t.id, fp)
        savedProject.set(t.id, t.projectPath)
        changed.push({ t, json })
        upsert.push({ id: t.id, projectPath: t.projectPath, updatedAt: t.updatedAt, data: json })
      }
      const drop = (id: string) => {
        remove.push({ id, projectPath: savedProject.get(id) ?? '' })
        saved.delete(id)
        savedProject.delete(id)
        pending.delete(id)
      }
      if (sweep) {
        const present = new Set<string>()
        for (const t of s.threads()) { present.add(t.id); consider(t) }
        for (const id of [...saved.keys()]) if (!present.has(id)) drop(id)
      } else {
        for (const id of dirty) {
          const t = s.byId(id)
          if (t) consider(t)
          else if (saved.has(id)) drop(id)
        }
      }
      sweep = false
      dirty.clear()
      const layout = s.layout ? JSON.stringify(s.layout()) : null
      const ui = layout === null || layout === savedLayout ? null : layout
      if (ui !== null) savedLayout = ui
      return upsert.length || remove.length || ui !== null ? { upsert, remove, ui, changed } : null
    },
    /** A batch did not reach the disk: the next save sends all of it again rather than lose it. */
    failed(batch: SaveBatch) {
      for (const r of batch.upsert) { saved.set(r.id, UNKNOWN); pending.delete(r.id); dirty.add(r.id) }
      for (const r of batch.remove) {
        if (!saved.has(r.id)) { saved.set(r.id, UNKNOWN); savedProject.set(r.id, r.projectPath) }
        dirty.add(r.id)
      }
      savedLayout = null
    },
  }
}

export type Saves = ReturnType<typeof createSaves>
