/**
 * Canvas-drawn libraries (xterm, Monaco) want hex colours; the tokens are
 * oklch. Paint the token on a 1px canvas and read it back.
 */

let paintCtx: CanvasRenderingContext2D | null | undefined
const SENTINEL = '#010203'

export function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

export const hex2 = (n: number) => Math.round(Math.min(255, Math.max(0, n))).toString(16).padStart(2, '0')

/** Resolve any CSS colour (oklch, var-substituted, with alpha) to #rrggbb[aa]. */
export function toHex(value: string, fallback: string): string {
  if (!value) return fallback
  if (paintCtx === undefined) {
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 1
    paintCtx = canvas.getContext('2d', { willReadFrequently: true })
  }
  const ctx = paintCtx
  if (!ctx) return fallback
  ctx.clearRect(0, 0, 1, 1)
  ctx.fillStyle = SENTINEL
  ctx.fillStyle = value
  // An unparseable value leaves the sentinel in place.
  if (String(ctx.fillStyle).toLowerCase() === SENTINEL && value.toLowerCase() !== SENTINEL) return fallback
  ctx.fillRect(0, 0, 1, 1)
  const [r = 0, g = 0, b = 0, a = 255] = ctx.getImageData(0, 0, 1, 1).data
  return `#${hex2(r)}${hex2(g)}${hex2(b)}${a < 255 ? hex2(a) : ''}`
}

/** A token as hex, or `fallback` when it does not resolve. */
export const tokenHex = (name: string, fallback: string) => toHex(cssVar(name), fallback)
