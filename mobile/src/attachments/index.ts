import { Platform } from 'react-native'
import { File } from 'expo-file-system'
import * as DocumentPicker from 'expo-document-picker'
import * as ImagePicker from 'expo-image-picker'
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator'
import type { Attachment } from '~/types/chat'
import { MAX_ATTACHMENT_BYTES, attachmentKind, formatSize, mimeFromName } from '~/utils/attachments'
import { backend } from '@/remote'
import { toBase64 } from '@/remote/bytes'
import type { EnvRemote } from '@/remote/types'
import { inlineCopies, safeName } from './input'

export { agentInput, inlineFor } from './input'
export { MAX_ATTACHMENTS } from '~/utils/attachments'

/**
 * Files attached to a message on the phone: picked from Photos, the camera or Files, given a
 * small preview, and put into the environment right away (`backend.attachmentPut`), so the agent
 * reads them there. Pictures also keep a copy fitted for the model, in memory, to go inline.
 */

/** A file the person picked, before it is read. */
export interface Picked {
  uri: string
  name: string
  mime: string
}

/** One attachment in the composer: uploading, ready (with what the message carries), or failed. */
export interface Pending {
  key: string
  name: string
  mime: string
  thumb?: string
  state: 'uploading' | 'ready' | 'error'
  error?: string
  attachment?: Attachment
}

const stamp = () => {
  const d = new Date()
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map(n => String(n).padStart(2, '0')).join('')
}

export async function pickPhotos(limit: number): Promise<Picked[]> {
  const r = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images'],
    allowsMultipleSelection: true,
    selectionLimit: limit,
    quality: 1,
    // HEIC becomes JPEG: agents and the desktop can read it.
    preferredAssetRepresentationMode: ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Compatible,
  })
  if (r.canceled) return []
  return r.assets.map((a, i) => {
    const mime = a.mimeType ?? 'image/jpeg'
    return { uri: a.uri, mime, name: a.fileName ?? `photo-${stamp()}${i ? `-${i + 1}` : ''}.${mime === 'image/png' ? 'png' : 'jpg'}` }
  })
}

/** Rejects when the camera may not be used, with what to do about it. */
export async function takePhoto(): Promise<Picked[]> {
  const p = await ImagePicker.requestCameraPermissionsAsync()
  if (!p.granted) throw new Error('Mango may not use the camera. Allow it in Settings > Mango > Camera.')
  const r = await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], quality: 0.9 })
  if (r.canceled) return []
  return r.assets.map(a => ({ uri: a.uri, mime: a.mimeType ?? 'image/jpeg', name: a.fileName ?? `photo-${stamp()}.jpg` }))
}

export async function pickFiles(): Promise<Picked[]> {
  const r = await DocumentPicker.getDocumentAsync({ multiple: true, copyToCacheDirectory: true })
  if (r.canceled) return []
  return r.assets.map(a => ({ uri: a.uri, name: a.name, mime: a.mimeType || mimeFromName(a.name) }))
}

async function readBytes(uri: string): Promise<Uint8Array> {
  // The web preview's picks are blob: URLs, which only fetch reads.
  const buf = Platform.OS === 'web' ? await (await fetch(uri)).arrayBuffer() : await new File(uri).arrayBuffer()
  return new Uint8Array(buf)
}

/** A JPEG copy with its long edge at most `edge`, as base64 (the desktop encodes WebP, which iOS can't). */
async function shrink(uri: string, edge: number, compress: number) {
  const ref = await ImageManipulator.manipulate(uri).renderAsync()
  const size = ref.width >= ref.height ? { width: Math.min(edge, ref.width) } : { height: Math.min(edge, ref.height) }
  const out = await (await ImageManipulator.manipulate(uri).resize(size).renderAsync()).saveAsync({ format: SaveFormat.JPEG, compress, base64: true })
  return { data: out.base64 ?? '', width: ref.width, height: ref.height }
}

/** Claude takes images up to 5 MB and 8000 px; past that, send a smaller copy (as the desktop does). */
const INLINE_BYTES = 3.5 * 1024 * 1024
const INLINE_EDGE = 7900

async function fitForModel(uri: string, mime: string, bytes: Uint8Array): Promise<{ mime: string; data: string } | undefined> {
  const { width, height } = await ImageManipulator.manipulate(uri).renderAsync()
  if (bytes.length <= INLINE_BYTES && (mime === 'image/gif' || Math.max(width, height) <= INLINE_EDGE)) {
    return { mime, data: toBase64(bytes) }
  }
  for (const [edge, q] of [[2560, 0.9], [1920, 0.85], [1280, 0.8]] as const) {
    const { data } = await shrink(uri, edge, q)
    if (data.length * 0.75 <= INLINE_BYTES) return { mime: 'image/jpeg', data }
  }
  return undefined
}

/**
 * Read a picked file, preview it, fit a picture for the model, and put it into the environment
 * of `at`. Resolves with the attachment as the message keeps it (its `path` is inside the
 * environment); rejects with a message a person can act on.
 */
export async function prepare(p: Picked, at: EnvRemote, id: string, onThumb: (thumb: string) => void): Promise<Attachment> {
  const bytes = await readBytes(p.uri)
  if (bytes.length > MAX_ATTACHMENT_BYTES) {
    throw new Error(`${p.name} is ${formatSize(bytes.length)}; attachments can be up to ${formatSize(MAX_ATTACHMENT_BYTES)}.`)
  }
  const name = safeName(p.name, `file-${stamp()}`)
  const kind = attachmentKind(p.mime)
  let thumb: string | undefined
  if (p.mime.startsWith('image/') && p.mime !== 'image/svg+xml') {
    try {
      thumb = `data:image/jpeg;base64,${(await shrink(p.uri, 240, 0.8)).data}`
      onThumb(thumb)
    } catch { /* no preview: the name says what it is */ }
  }
  if (kind === 'image') {
    try {
      const fitted = await fitForModel(p.uri, p.mime, bytes)
      if (fitted) inlineCopies.set(id, fitted)
    } catch { /* it goes by path instead */ }
  }
  const path = await backend.attachmentPut(at, id, name, toBase64(bytes))
  return { id, name, path, mime: p.mime, size: bytes.length, kind, ...(thumb ? { thumb } : {}) }
}
