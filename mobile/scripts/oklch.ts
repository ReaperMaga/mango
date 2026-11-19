/**
 * OKLCH to sRGB, as CSS Color 4 does it, for `scripts/schemes.ts`: Oklab from polar, linear sRGB
 * through the published matrices, then the transfer curve. A colour outside sRGB is mapped in with
 * the spec's algorithm: chroma is reduced (lightness and hue kept) until clipping it changes the
 * colour by less than a just-noticeable difference (0.02 in Oklab).
 */

export interface Oklch { l: number; c: number; h: number }
export type Rgb = [number, number, number]

const polar = ({ l, c, h }: Oklch): [number, number, number] => [l, c * Math.cos((h * Math.PI) / 180), c * Math.sin((h * Math.PI) / 180)]

function oklabToLinear([l, a, b]: [number, number, number]): Rgb {
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3
  return [
    4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
    -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
    -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
  ]
}

function linearToOklab([r, g, b]: Rgb): [number, number, number] {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ]
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v))
const encode = (v: number) => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055)
const EPS = 1e-6
const inGamut = (rgb: Rgb) => rgb.every(v => v >= -EPS && v <= 1 + EPS)
const clip = (rgb: Rgb): Rgb => [clamp01(rgb[0]), clamp01(rgb[1]), clamp01(rgb[2])]
const deltaE = (a: [number, number, number], b: [number, number, number]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])

const JND = 0.02
const MAP_EPSILON = 0.0001

/** Linear sRGB of the colour, gamut-mapped (CSS Color 4 §13.2). */
function mapped(color: Oklch): Rgb {
  if (color.l >= 1) return [1, 1, 1]
  if (color.l <= 0) return [0, 0, 0]
  const direct = oklabToLinear(polar(color))
  if (inGamut(direct)) return clip(direct)
  let clipped = clip(direct)
  if (deltaE(linearToOklab(clipped), polar(color)) < JND) return clipped
  let min = 0
  let max = color.c
  let minInGamut = true
  while (max - min > MAP_EPSILON) {
    const chroma = (min + max) / 2
    const current = { ...color, c: chroma }
    const lin = oklabToLinear(polar(current))
    if (minInGamut && inGamut(lin)) { min = chroma; continue }
    clipped = clip(lin)
    const e = deltaE(linearToOklab(clipped), polar(current))
    if (e < JND) {
      if (JND - e < MAP_EPSILON) return clipped
      minInGamut = false
      min = chroma
    } else {
      max = chroma
    }
  }
  return clipped
}

/** The colour as 0 to 255 sRGB channels. */
export function oklchToRgb(color: Oklch): Rgb {
  return mapped(color).map(v => Math.round(encode(v) * 255)) as Rgb
}

export const hex = (rgb: Rgb) => `#${rgb.map(v => v.toString(16).padStart(2, '0')).join('')}`

/** `color-mix(in oklch, a w, b)`: lightness, chroma and hue (the shorter way round) mixed by the weight of `a`. */
export function mixOklch(a: Oklch, b: Oklch, w: number): Oklch {
  // A colourless side has no hue of its own: it takes the other's.
  const hueA = a.c < 1e-4 ? b.h : a.h
  const hueB = b.c < 1e-4 ? a.h : b.h
  let d = hueB - hueA
  if (d > 180) d -= 360
  else if (d < -180) d += 360
  return {
    l: a.l * w + b.l * (1 - w),
    c: a.c * w + b.c * (1 - w),
    h: (((hueA + d * (1 - w)) % 360) + 360) % 360,
  }
}
