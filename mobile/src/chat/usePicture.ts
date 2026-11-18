import { useSyncExternalStore } from 'react'
import { backend } from '@/remote'
import { createPictureCache, type PictureState } from './pictures'

/** One cache for the app: a picture read once shows in every chat that names it. */
export const pictures = createPictureCache((base, path) => backend.chatImage(base, path))

/**
 * A picture inside the environment of `base` (the chat's folder, an `env://` path). Re-renders as
 * it arrives. A failed one is read again when the reply renders after `RETRY_MS` (as on the desktop),
 * or at once through `pictures.retry` (tapping it); never on a timer, each read is a round trip.
 */
export function usePicture(base: string, path: string): PictureState {
  return useSyncExternalStore(pictures.subscribe, () => pictures.get(base, path))
}
