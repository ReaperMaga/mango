import { call } from '~/composables/useBackend'
import type { Thread } from '~/types/chat'
import { createSaves, saveDelay, type SaveSource } from '~/utils/chatSaves'
import { noteSaved } from '~/utils/remoteChats'

/**
 * Saving chats to the chat history database (`chats_load` / `chats_save`, a SQLite file in the
 * app data folder). Saves are debounced and incremental: only chats marked changed are
 * serialised, and only the ones whose JSON actually differs from the last save are sent
 * (`chatSaves.ts` keeps a fingerprint of each, not a copy). A marked chat that is gone is deleted.
 * A sweep (no id given) compares every chat and deletes the rows of chats gone: it serialises the
 * whole history, so it is only for when the chats cannot be named.
 * Remote projects' chats saved here also go to their environment (`remoteChats.ts`).
 *
 * With several windows (`utils/windows.ts`) each one knows only the chats it holds: it loads those
 * (`keep`), and a sweep deletes only rows it loaded or saved itself, never another window's chats.
 * Chats it hands to another window are forgotten (`forgetHistory`), not deleted. Only a window
 * given a `layout` saves one (the main window).
 */

/** Which saved chats this window takes (all of them, `all`, are given to find a chat's parents). */
export type Keep = (t: Thread, all: Thread[]) => boolean

const saves = createSaves()
let source: SaveSource | null = null
let timer: ReturnType<typeof setTimeout> | null = null
let firstChangeAt = 0
/** Something other than an agent's streamed output is pending: it saves soon. */
let urgent = false
let queue: Promise<boolean> = Promise.resolve(true)
let reported = false

/** Every saved chat, parsed (unreadable rows dropped), with its JSON. */
function parseRows(rows: string[]): { t: Thread; json: string }[] {
  const out: { t: Thread; json: string }[] = []
  for (const json of rows) {
    try {
      const t = JSON.parse(json) as Thread
      if (t && typeof t.id === 'string' && Array.isArray(t.messages)) out.push({ t, json })
    } catch { /* a damaged row is skipped, not fatal */ }
  }
  return out
}

/**
 * Take these rows as this window's: from now on they are compared, saved and deleted here.
 * With `normalize`, the chats come back as it makes them, and the ones it changed are saved.
 */
function remember(rows: { t: Thread; json: string }[], keep?: Keep, normalize?: (t: Thread) => Thread): Thread[] {
  const all = rows.map(r => r.t)
  const out: Thread[] = []
  for (const { t, json } of rows) {
    if (keep && !keep(t, all)) continue
    const kept = normalize ? normalize(t) : t
    saves.remember(t, json, normalize ? kept : undefined)
    out.push(kept)
  }
  settleSoon()
  return out
}

let settling = false
/** Fingerprint the rows just loaded a little at a time, so their JSON can go and loading is not held up. */
function settleSoon() {
  if (settling) return
  settling = true
  const step = () => {
    if (saves.settle(12)) setTimeout(step, 30)
    else settling = false
  }
  setTimeout(step, 1000)
}

/**
 * The saved chats this window takes (`keep`; all when not given) and the layout. Remembers what is on disk.
 * With `normalize`, chats come back normalized, and the ones that changed by it are saved once saving starts.
 */
export async function loadHistory(keep?: Keep, normalize?: (t: Thread) => Thread): Promise<{ threads: Thread[]; layout: unknown }> {
  const snap = await call('chats_load', {})
  const threads = remember(parseRows(snap.threads), keep, normalize)
  saves.setLayout(snap.ui)
  let layout: unknown = null
  try { layout = snap.ui ? JSON.parse(snap.ui) : null } catch { /* default layout */ }
  return { threads, layout }
}

/**
 * Saved chats this window does not hold yet and now takes (`keep`): another window closed or
 * gave them up. Read after that window saved them.
 */
export async function loadMoreHistory(keep: Keep): Promise<Thread[]> {
  const snap = await call('chats_load', {})
  return remember(parseRows(snap.threads).filter(r => !saves.has(r.t.id)), keep)
}

/** These chats now belong to another window: stop comparing and saving them here (they are not deleted). */
export function forgetHistory(ids: Iterable<string>) {
  saves.forget(ids)
}

/** Start saving. Nothing is saved before this, so a save can never overwrite what was not loaded yet. */
export function attachHistory(s: SaveSource) {
  source = s
  if (typeof window !== 'undefined') {
    // Closing or reloading: send what is pending (the backend finishes it even if the page goes).
    window.addEventListener('beforeunload', () => { void flushHistory() })
    document.addEventListener('visibilitychange', () => { if (document.hidden) void flushHistory() })
  }
}

/**
 * Something changed: these chats (a deleted one included), or, none given, every chat (which also
 * drops deleted ones); and the layout. `streaming`: an agent's output as it comes, which saves less
 * often (see `STREAM_MAX_WAIT_MS`); anything else pending saves at the usual pace.
 */
export function markChanged(ids?: string | string[], streaming = false) {
  saves.mark(ids)
  if (!source) return
  const now = Date.now()
  if (!timer) { firstChangeAt = now; urgent = false }
  else clearTimeout(timer)
  if (!streaming) urgent = true
  timer = setTimeout(() => { void flushHistory() }, saveDelay(now, firstChangeAt, urgent))
}

/** Save what is pending now. Resolves true when everything up to now is on disk. */
export function flushHistory(): Promise<boolean> {
  if (timer) { clearTimeout(timer); timer = null }
  if (!source) return queue
  const batch = saves.collect(source)
  if (batch) {
    if (batch.changed.length || batch.remove.length) noteSaved(batch.changed, batch.remove)
    const { upsert, ui } = batch
    queue = queue.then(() => call('chats_save', { upsert, remove: batch.remove.map(r => r.id), ui }).then(
      () => true,
      (e) => {
        // Make the next save send all of it again rather than lose it.
        saves.failed(batch)
        if (!reported) { reported = true; console.error('Mango could not save the chat history:', e) }
        return false
      },
    ))
  }
  return queue
}
