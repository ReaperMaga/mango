/**
 * Which project files open in the image viewer instead of the text editor.
 * SVG is text: it opens as a picture, with its source one click away.
 */

const RASTER: Record<string, string> = {
  png: 'image/png',
  apng: 'image/apng',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  jfif: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  cur: 'image/x-icon',
}

const ext = (file: string) => {
  const name = file.slice(file.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

export type ImageKind = 'raster' | 'svg'

export function imageKind(file: string): ImageKind | null {
  const e = ext(file)
  if (e === 'svg') return 'svg'
  return RASTER[e] ? 'raster' : null
}

export const imageMime = (file: string) => (ext(file) === 'svg' ? 'image/svg+xml' : RASTER[ext(file)] ?? 'application/octet-stream')

/**
 * SVG source as an image URL. Shown through `<img>`, an SVG cannot run
 * scripts or load anything from outside, so agent-written files are safe to show.
 */
export const svgUrl = (text: string) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(text)}`

/** The size an SVG asks for: its width and height, else its viewBox. Null when it says neither. */
export function svgSize(text: string): { width: number; height: number } | null {
  const doc = new DOMParser().parseFromString(text, 'image/svg+xml')
  const svg = doc.documentElement
  if (!svg || svg.nodeName.toLowerCase() !== 'svg') return null
  const px = (v: string | null) => {
    const m = v?.trim().match(/^(\d+(?:\.\d+)?)(px)?$/)
    return m ? Number(m[1]) : null
  }
  const box = svg.getAttribute('viewBox')?.trim().split(/[\s,]+/).map(Number)
  const vb = box && box.length === 4 && box.every(Number.isFinite) && box[2]! > 0 && box[3]! > 0 ? { width: box[2]!, height: box[3]! } : null
  const w = px(svg.getAttribute('width'))
  const h = px(svg.getAttribute('height'))
  if (w && h) return { width: w, height: h }
  if (vb && w) return { width: w, height: (w * vb.height) / vb.width }
  if (vb && h) return { width: (h * vb.width) / vb.height, height: h }
  return vb
}
