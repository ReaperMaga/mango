import type { ChatPicture } from '@/remote/images'

/**
 * Pictures in agent replies, as the desktop's `app/utils/chatImages.ts`: each one is read from the
 * environment once, kept while the chat shows it, and a failed read is tried again a little later
 * (the agent may write the file a moment after it names it). Pure: the loader is passed in, so the
 * cache runs in tests without SSH.
 */

export type PictureState =
  | { status: 'loading' }
  | { status: 'ready'; uri: string; mime: string; size: number }
  | { status: 'error'; error: string; at: number }

/** A failed picture is tried again after this long. */
export const RETRY_MS = 5000
/** Ready pictures kept at most (they are held as data URIs); the oldest go first. */
export const KEEP = 24

const LOADING: PictureState = { status: 'loading' }

export interface PictureCache {
  /** The picture's state, starting its load the first time it is asked for (or again after a failure has aged). */
  get(base: string, path: string): PictureState
  /** Try a failed picture again now. */
  retry(base: string, path: string): void
  subscribe(fn: () => void): () => void
}

export function createPictureCache(load: (base: string, path: string) => Promise<ChatPicture>, now: () => number = Date.now): PictureCache {
  const settled = new Map<string, PictureState>()
  const inFlight = new Set<string>()
  const listeners = new Set<() => void>()
  const keyOf = (base: string, path: string) => `${base}\n${path}`

  const settle = (key: string, s: PictureState) => {
    settled.delete(key)
    settled.set(key, s)
    let ready = 0
    for (const v of settled.values()) if (v.status === 'ready') ready++
    for (const [k, v] of settled) {
      if (ready <= KEEP) break
      if (v.status === 'ready') { settled.delete(k); ready-- }
    }
    for (const fn of listeners) fn()
  }

  const start = (base: string, path: string, key: string) => {
    if (inFlight.has(key)) return
    inFlight.add(key)
    load(base, path)
      .then(
        p => settle(key, { status: 'ready', uri: `data:${p.mime};base64,${p.data}`, mime: p.mime, size: p.size }),
        (e: unknown) => settle(key, { status: 'error', error: e instanceof Error ? e.message : String(e), at: now() }),
      )
      .finally(() => inFlight.delete(key))
  }

  return {
    get(base, path) {
      const key = keyOf(base, path)
      const s = settled.get(key)
      if (s && (s.status !== 'error' || now() - s.at < RETRY_MS)) return s
      // Started outside the render that asked: React must not see a store change mid-render.
      queueMicrotask(() => start(base, path, key))
      return s ?? LOADING
    },
    retry(base, path) {
      const key = keyOf(base, path)
      if (settled.get(key)?.status !== 'error') return
      settle(key, LOADING)
      start(base, path, key)
    },
    subscribe(fn) {
      listeners.add(fn)
      return () => { listeners.delete(fn) }
    },
  }
}
