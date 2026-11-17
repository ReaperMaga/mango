import type { Thread } from '~/types/chat'
import { isSafeId } from '@/state/threadModel'

/**
 * The phone's working copy of its chats: one JSON file per chat (see `chatFiles.native.ts`),
 * a port of the desktop's `app/utils/chatHistory.ts`. Saves are debounced and incremental: only
 * chats marked changed are serialised, and only the ones whose JSON differs from the last save
 * are written. A sweep (no id given) compares every chat, and is the only thing that deletes.
 * Every save is reported (`onSaved`), so remote projects' chats go on to their environment.
 */

/** Where chats are kept. Abstract so tests (and the web preview) need no native module. */
export interface ChatFiles {
  /** Every saved chat's JSON (unreadable files skipped). */
  readAll(): Promise<string[]>
  write(id: string, json: string): Promise<void>
  remove(id: string): Promise<void>
}

/** Chats in memory only: tests, and anywhere without storage. */
export function memoryChatFiles(initial: Record<string, string> = {}): ChatFiles & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial))
  return {
    data,
    async readAll() { return [...data.values()] },
    async write(id, json) { data.set(id, json) },
    async remove(id) { data.delete(id) },
  }
}

const DEBOUNCE_MS = 400
/** While an agent streams, changes keep coming: save at least this often anyway. */
const MAX_WAIT_MS = 2000

export interface HistorySource {
  threads: () => Thread[]
  byId: (id: string) => Thread | null
}

export type SavedHook = (changed: Thread[], removed: { id: string; projectPath: string }[]) => void

export class ChatHistory {
  /** Each saved chat's JSON as last written: what a save compares against. */
  private saved = new Map<string, string>()
  /** Each saved chat's project: where a deleted one was. */
  private savedProject = new Map<string, string>()
  private dirty = new Set<string>()
  private sweep = false
  private source: HistorySource | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private firstChangeAt = 0
  private queue: Promise<boolean> = Promise.resolve(true)
  private reported = false

  constructor(private files: ChatFiles, private onSaved: SavedHook) {}

  /** The saved chats (parsed; unreadable or unsafe ones dropped). Remembers what is on disk. */
  async load(): Promise<Thread[]> {
    const threads: Thread[] = []
    for (const json of await this.files.readAll()) {
      try {
        const t = JSON.parse(json) as Thread
        if (t && isSafeId(t.id) && Array.isArray(t.messages)) {
          threads.push(t)
          this.saved.set(t.id, json)
          this.savedProject.set(t.id, t.projectPath)
        }
      } catch { /* a damaged file is skipped, not fatal */ }
    }
    return threads
  }

  /** Start saving. Nothing is saved before this, so a save can never overwrite what was not loaded yet. */
  attach(s: HistorySource) {
    this.source = s
  }

  /** Something changed: these chats (none given: compare all of them, and drop deleted ones). */
  markChanged(ids?: string | string[]) {
    if (ids === undefined) this.sweep = true
    else for (const id of Array.isArray(ids) ? ids : [ids]) this.dirty.add(id)
    if (!this.source) return
    const now = Date.now()
    if (!this.timer) this.firstChangeAt = now
    else clearTimeout(this.timer)
    const wait = Math.max(0, Math.min(DEBOUNCE_MS, this.firstChangeAt + MAX_WAIT_MS - now))
    this.timer = setTimeout(() => { void this.flush() }, wait)
  }

  /** Save what is pending now. Resolves true when everything up to now is written. */
  flush(): Promise<boolean> {
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
    if (!this.source) return this.queue
    const batch = this.collect(this.source)
    if (batch) {
      this.queue = this.queue.then(async () => {
        try {
          for (const r of batch.upsert) await this.files.write(r.id, r.json)
          for (const id of batch.remove) await this.files.remove(id)
          return true
        } catch (e) {
          // Make the next save write all of it again rather than lose it.
          for (const r of batch.upsert) this.saved.delete(r.id)
          for (const id of batch.remove) this.saved.set(id, '')
          this.sweep = true
          if (!this.reported) { this.reported = true; console.error('Mango could not save its chats:', e) }
          return false
        }
      })
    }
    return this.queue
  }

  /** Stop the timer (tests, or before loading another set of chats). */
  dispose() {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.source = null
  }

  private collect(s: HistorySource): { upsert: { id: string; json: string }[]; remove: string[] } | null {
    const upsert: { id: string; json: string }[] = []
    const remove: string[] = []
    const changed: Thread[] = []
    const consider = (t: Thread) => {
      if (!isSafeId(t.id)) return
      const json = JSON.stringify(t)
      if (this.saved.get(t.id) === json) return
      this.saved.set(t.id, json)
      this.savedProject.set(t.id, t.projectPath)
      changed.push(t)
      upsert.push({ id: t.id, json })
    }
    if (this.sweep) {
      const present = new Set<string>()
      for (const t of s.threads()) { present.add(t.id); consider(t) }
      for (const id of this.saved.keys()) if (!present.has(id)) remove.push(id)
    } else {
      for (const id of this.dirty) {
        const t = s.byId(id)
        if (t) consider(t)
        else if (this.saved.has(id)) remove.push(id)
      }
    }
    const removed = remove.map(id => ({ id, projectPath: this.savedProject.get(id) ?? '' }))
    for (const id of remove) { this.saved.delete(id); this.savedProject.delete(id) }
    if (changed.length || removed.length) {
      try { this.onSaved(changed, removed) } catch (e) { console.warn('Mango could not pass saved chats on:', e) }
    }
    this.sweep = false
    this.dirty.clear()
    return upsert.length || remove.length ? { upsert, remove } : null
  }
}
