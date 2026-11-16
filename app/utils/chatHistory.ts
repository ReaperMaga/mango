import { call } from '~/composables/useBackend'
import type { Thread } from '~/types/chat'
import type { ChatRow } from '~/types/ipc'

/**
 * Saving chats to the chat history database (`chats_load` / `chats_save`, a SQLite file in the
 * app data folder). Saves are debounced and incremental: only chats marked changed are
 * serialised, and only the ones whose JSON actually differs from the last save are sent.
 * A sweep (no id given) compares every chat, and is the only thing that deletes rows.
 */

const DEBOUNCE_MS = 400
/** While an agent streams, changes keep coming: save at least this often anyway. */
const MAX_WAIT_MS = 2000

interface Source {
  threads: () => Thread[]
  byId: (id: string) => Thread | null
  /** The layout to save (tabs, panes…): compared as JSON, so it can be rebuilt each time. */
  layout: () => unknown
}

/** Each saved chat's JSON as last sent: what a save compares against. */
const saved = new Map<string, string>()
let savedLayout: string | null = null
const dirty = new Set<string>()
let sweep = false
let source: Source | null = null
let timer: ReturnType<typeof setTimeout> | null = null
let firstChangeAt = 0
let queue: Promise<boolean> = Promise.resolve(true)
let reported = false

/** The saved chats (parsed; unreadable rows dropped) and layout. Remembers what is on disk. */
export async function loadHistory(): Promise<{ threads: Thread[]; layout: unknown }> {
  const snap = await call('chats_load', {})
  const threads: Thread[] = []
  for (const json of snap.threads) {
    try {
      const t = JSON.parse(json) as Thread
      if (t && typeof t.id === 'string' && Array.isArray(t.messages)) {
        threads.push(t)
        saved.set(t.id, json)
      }
    } catch { /* a damaged row is skipped, not fatal */ }
  }
  savedLayout = snap.ui
  let layout: unknown = null
  try { layout = snap.ui ? JSON.parse(snap.ui) : null } catch { /* default layout */ }
  return { threads, layout }
}

/** Start saving. Nothing is saved before this, so a save can never overwrite what was not loaded yet. */
export function attachHistory(s: Source) {
  source = s
  if (typeof window !== 'undefined') {
    // Closing or reloading: send what is pending (the backend finishes it even if the page goes).
    window.addEventListener('beforeunload', () => { void flushHistory() })
    document.addEventListener('visibilitychange', () => { if (document.hidden) void flushHistory() })
  }
}

/** Something changed: these chats (none given: compare all of them, and drop deleted ones), and the layout. */
export function markChanged(ids?: string | string[]) {
  if (ids === undefined) sweep = true
  else for (const id of Array.isArray(ids) ? ids : [ids]) dirty.add(id)
  if (!source) return
  const now = Date.now()
  if (!timer) firstChangeAt = now
  else clearTimeout(timer)
  const wait = Math.max(0, Math.min(DEBOUNCE_MS, firstChangeAt + MAX_WAIT_MS - now))
  timer = setTimeout(() => { void flushHistory() }, wait)
}

/** Save what is pending now. Resolves true when everything up to now is on disk. */
export function flushHistory(): Promise<boolean> {
  if (timer) { clearTimeout(timer); timer = null }
  if (!source) return queue
  const batch = collect(source)
  if (batch) {
    queue = queue.then(() => call('chats_save', batch).then(
      () => true,
      (e) => {
        // Make the next save send all of it again rather than lose it.
        for (const r of batch.upsert) saved.delete(r.id)
        for (const id of batch.remove) saved.set(id, '')
        savedLayout = null
        sweep = true
        if (!reported) { reported = true; console.error('Mango could not save the chat history:', e) }
        return false
      },
    ))
  }
  return queue
}

function collect(s: Source): { upsert: ChatRow[]; remove: string[]; ui: string | null } | null {
  const upsert: ChatRow[] = []
  const remove: string[] = []
  const consider = (t: Thread) => {
    const json = JSON.stringify(t)
    if (saved.get(t.id) === json) return
    saved.set(t.id, json)
    upsert.push({ id: t.id, projectPath: t.projectPath, updatedAt: t.updatedAt, data: json })
  }
  if (sweep) {
    const present = new Set<string>()
    for (const t of s.threads()) { present.add(t.id); consider(t) }
    for (const id of saved.keys()) if (!present.has(id)) remove.push(id)
  } else {
    for (const id of dirty) {
      const t = s.byId(id)
      if (t) consider(t)
      else if (saved.has(id)) remove.push(id)
    }
  }
  for (const id of remove) saved.delete(id)
  sweep = false
  dirty.clear()
  const layout = JSON.stringify(s.layout())
  const ui = layout === savedLayout ? null : layout
  if (ui !== null) savedLayout = ui
  return upsert.length || remove.length || ui !== null ? { upsert, remove, ui } : null
}
