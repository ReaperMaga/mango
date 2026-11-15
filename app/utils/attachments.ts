import type { Attachment } from '~/types/chat'
import type { AgentImage } from '~/agents/types'

/**
 * Attachments on the webview side: what a file is, small previews, and turning
 * stored files into what an agent run needs. Storage itself is the backend's
 * (`attachment_*` commands); the browser preview mocks it in memory.
 */

/** Per message. */
export const MAX_ATTACHMENTS = 10
/** Same limit as the backend. */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024

const MIMES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
  json: 'application/json',
  md: 'text/markdown',
  markdown: 'text/markdown',
  csv: 'text/csv',
  html: 'text/html',
  htm: 'text/html',
  txt: 'text/plain',
  log: 'text/plain',
}

export function mimeFromName(name: string): string {
  const ext = /\.([^.\\/]+)$/.exec(name)?.[1]?.toLowerCase() ?? ''
  return MIMES[ext] ?? 'application/octet-stream'
}

/** Formats agents take as pictures; everything else is handed over by path. */
export const attachmentKind = (mime: string): Attachment['kind'] =>
  ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(mime) ? 'image' : 'file'

const EXT_FOR: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/bmp': 'bmp' }

/** Clipboard images arrive as "image.png" (or nameless): give them a name worth keeping apart. */
export function pastedName(file: File, index: number): string {
  if (file.name && !/^image\.\w+$/i.test(file.name)) return file.name
  const d = new Date()
  const stamp = [d.getHours(), d.getMinutes(), d.getSeconds()].map(n => String(n).padStart(2, '0')).join('')
  const ext = EXT_FOR[file.type] ?? (/\.(\w+)$/.exec(file.name)?.[1] ?? 'png')
  return `pasted-${stamp}${index ? `-${index + 1}` : ''}.${ext}`
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ''))
    r.onerror = () => reject(r.error ?? new Error('Could not read the file.'))
    r.readAsDataURL(blob)
  })
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('Not a readable image.'))
    img.src = src
  })
}

/** Draws `img` with its long edge at most `edge` px, as WebP (JPEG on a white ground where WebP can't be encoded). */
function encode(img: HTMLImageElement, edge: number, quality: number): string {
  const scale = Math.min(1, edge / Math.max(img.naturalWidth, img.naturalHeight))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(img.naturalWidth * scale))
  canvas.height = Math.max(1, Math.round(img.naturalHeight * scale))
  const ctx = canvas.getContext('2d')!
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
  const webp = canvas.toDataURL('image/webp', quality)
  if (webp.startsWith('data:image/webp')) return webp
  ctx.globalCompositeOperation = 'destination-over'
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  return canvas.toDataURL('image/jpeg', quality)
}

/** A small preview (long edge 240 px) for the composer and the sent message. Undefined when it isn't an image. */
export async function makeThumb(mime: string, base64: string): Promise<string | undefined> {
  if (!mime.startsWith('image/')) return undefined
  try {
    return encode(await loadImage(`data:${mime};base64,${base64}`), 240, 0.8)
  } catch {
    return undefined
  }
}

/** Claude takes images up to 5 MB and 8000 px; past that, send a smaller copy. */
const INLINE_BYTES = 3.5 * 1024 * 1024
const INLINE_EDGE = 7900

async function fitForAgent(mime: string, base64: string): Promise<{ mime: string; data: string }> {
  if (base64.length * 0.75 <= INLINE_BYTES && mime !== 'image/gif') {
    // Small enough by size; the pixel limit needs a look at the image.
    const img = await loadImage(`data:${mime};base64,${base64}`).catch(() => null)
    if (!img || Math.max(img.naturalWidth, img.naturalHeight) <= INLINE_EDGE) return { mime, data: base64 }
  }
  if (mime === 'image/gif' && base64.length * 0.75 <= INLINE_BYTES) return { mime, data: base64 }
  const img = await loadImage(`data:${mime};base64,${base64}`)
  for (const [edge, q] of [[2560, 0.9], [1920, 0.85], [1280, 0.8]] as const) {
    const url = encode(img, edge, q)
    const data = url.replace(/^data:[^,]*,/, '')
    if (data.length * 0.75 <= INLINE_BYTES) return { mime: url.slice(5, url.indexOf(';')), data }
  }
  throw new Error('too large')
}

/** The paragraph that tells the agent where the attached files are. */
export function attachmentNote(files: Pick<Attachment, 'name' | 'path'>[]): string {
  if (!files.length) return ''
  const one = files.length === 1
  return `The user attached ${one ? 'a file' : `${files.length} files`}. Read ${one ? 'it' : 'them'} from disk:\n${files.map(f => `- ${f.name}: ${f.path}`).join('\n')}`
}

/**
 * What an agent run gets for a message with attachments: images carry their bytes (shrunk
 * to fit when needed); every other file, or an image that can't be sent inline, is named by
 * path at the end of the prompt, and its folder is opened to the agent for reading.
 */
export async function forAgent(
  text: string,
  list: Attachment[],
  read: (path: string) => Promise<string>,
): Promise<{ prompt: string; images: AgentImage[]; readDirs: string[] }> {
  const images: AgentImage[] = []
  const byPath: Attachment[] = []
  for (const a of list) {
    if (a.kind === 'image') {
      try {
        const fitted = await fitForAgent(a.mime, await read(a.path))
        images.push({ name: a.name, path: a.path, mime: fitted.mime, data: fitted.data })
        continue
      } catch { /* hand it over by path instead */ }
    }
    byPath.push(a)
  }
  const prompt = [text.trim(), attachmentNote(byPath)].filter(Boolean).join('\n\n')
  // Codex reads images by path too, so their folders count.
  const readDirs = [...new Set(list.map(a => a.path.replace(/[\\/][^\\/]*$/, '')).filter(Boolean))]
  return { prompt, images, readDirs }
}
