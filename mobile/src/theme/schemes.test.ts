import { describe, expect, it } from 'vitest'
import { generated, SCHEME_NAMES } from './schemes.generated'
import { darkColors, lightColors } from './shippedMango.fixture'

/** `#rrggbb` or `rgba(r, g, b, a)` as numbers, so two spellings of a colour can be compared. */
const channels = (c: string): number[] => {
  const h = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(c)
  if (h) return [1, 2, 3].map(i => parseInt(h[i]!, 16)).concat(1)
  const m = /^rgba?\(([^)]+)\)$/.exec(c)
  if (!m) throw new Error(`not a colour: ${c}`)
  const n = m[1]!.split(',').map(Number)
  return [n[0]!, n[1]!, n[2]!, n[3] ?? 1]
}

describe('the generated colour schemes', () => {
  it('lists every scheme the desktop offers, dark and light', () => {
    expect(SCHEME_NAMES).toHaveLength(10)
    for (const s of SCHEME_NAMES) {
      expect(Object.keys(generated[s])).toEqual(['dark', 'light'])
    }
  })

  for (const theme of ['dark', 'light'] as const) {
    it(`reproduces the Mango ${theme} palette the phone shipped with`, () => {
      const made = generated.mango[theme].colors as Record<string, string>
      const hand = (theme === 'dark' ? darkColors : lightColors) as unknown as Record<string, string>
      expect(Object.keys(made).sort()).toEqual(Object.keys(hand).sort())
      const off: string[] = []
      for (const key of Object.keys(hand)) {
        const a = channels(made[key]!)
        const b = channels(hand[key]!)
        // One step in a channel is rounding; alpha is exact to a thousandth.
        if (a.slice(0, 3).some((v, i) => Math.abs(v - b[i]!) > 1) || Math.abs(a[3]! - b[3]!) > 0.001) off.push(`${key}: ${made[key]} vs ${hand[key]}`)
      }
      expect(off).toEqual([])
    })
  }
})
