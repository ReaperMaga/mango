import { call } from '~/composables/useBackend'

export { localImagePath } from './imagePaths'

/**
 * Pictures in agent replies: `![alt](path)` pointing at a file on this computer, or inside
 * the environment for a remote project (`env://…`). Web addresses are never fetched (a picture
 * URL can carry data out of the chat), only files, read through `chat_image`, which accepts
 * real raster images and nothing else.
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
