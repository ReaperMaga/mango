import { call } from '~/composables/useBackend'

/**
 * Pictures in agent replies: `![alt](path)` pointing at a file on this computer. Web
 * addresses are never fetched (a picture URL can carry data out of the chat), only local
 * files, read through `chat_image`, which accepts real raster images and nothing else.
 */

export type ChatImageState =
  | { status: 'loading' }
  | { status: 'ready'; url: string; mime: string; size: number }
  | { status: 'error'; error: string; at: number }

/** A failed picture is tried again after this long (the agent may write the file a moment later). */
const RETRY_MS = 5000

/** Settled loads, by key; reactive so a reply re-renders when its pictures arrive. */
const settled = shallowReactive(new Map<string, ChatImageState>())
/** Loads in flight. Not reactive: starting a load must not dirty the render that asked for it. */
const inFlight = new Set<string>()

/**
 * The local file a markdown image points at; null for web addresses, data URLs and anything
 * else that is not a plain path. Takes `file://` URLs, Windows and POSIX absolute paths, and
 * relative paths (resolved against the chat's project folder by the backend).
 */
export function localImagePath(href: string): string | null {
  let h = href.trim()
  if (!h) return null
  if (/^file:/i.test(h)) {
    try {
      const u = new URL(h)
      let p = decodeURIComponent(u.pathname)
      if (/^\/[a-z]:\//i.test(p)) p = p.slice(1)
      return u.host ? `//${u.host}${p}` : p
    } catch {
      return null
    }
  }
  try { h = decodeURIComponent(h) } catch { /* keep it as written */ }
  if (/^[a-z]:[\\/]/i.test(h)) return h
  if (/^[a-z][a-z0-9+.-]*:/i.test(h) || h.startsWith('//')) return null
  return h
}

/** Can pictures be read for a chat in `base`? Not for remote projects (`env://…`): their files are not on this computer. */
export const localBase = (base: string | null | undefined) => !base || !/^[a-z][a-z0-9+.-]*:\/\//i.test(base)

const keyOf = (path: string, base: string | null) => `${base ?? ''}\n${path}`

function toBlobUrl(data: string, mime: string): string {
  const bin = atob(data)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return URL.createObjectURL(new Blob([bytes], { type: mime }))
}

/** The picture's state, starting its load the first time it is asked for. Reactive. */
export function chatImage(path: string, base: string | null): ChatImageState {
  const key = keyOf(path, base)
  const s = settled.get(key)
  if (s && (s.status !== 'error' || Date.now() - s.at < RETRY_MS)) return s
  if (!inFlight.has(key)) {
    inFlight.add(key)
    call('chat_image', { path, base })
      .then(
        img => settled.set(key, { status: 'ready', url: toBlobUrl(img.data, img.mime), mime: img.mime, size: img.size }),
        (e: unknown) => settled.set(key, { status: 'error', error: e instanceof Error ? e.message : String(e), at: Date.now() }),
      )
      .finally(() => inFlight.delete(key))
  }
  return s ?? { status: 'loading' }
}
