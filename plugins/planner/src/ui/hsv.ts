/** Hex colours as hue (0 to 360), saturation and value (0 to 1), for the picker. */

export interface Hsv { h: number; s: number; v: number }

export function hexToHsv(hex: string): Hsv {
  const [r, g, b] = [1, 3, 5].map(i => Number.parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number]
  const max = Math.max(r, g, b)
  const d = max - Math.min(r, g, b)
  const h = d === 0 ? 0 : max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4
  return { h: h * 60, s: max === 0 ? 0 : d / max, v: max }
}

export function hsvToHex({ h, s, v }: Hsv): `#${string}` {
  const part = (n: number) => {
    const k = (n + h / 60) % 6
    const x = v - v * s * Math.max(0, Math.min(k, 4 - k, 1))
    return Math.round(x * 255).toString(16).padStart(2, '0')
  }
  return `#${part(5)}${part(3)}${part(1)}`
}
