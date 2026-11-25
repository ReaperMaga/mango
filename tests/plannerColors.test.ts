/**
 * The planner's colours are readable in both themes, whatever the user made up. The CSS of `colorVar` is worked
 * out here the way a browser does, on the grounds tokens.css has.
 *
 *   node --test tests/plannerColors.test.ts     (or: pnpm test)
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { isCustomColor, normalizeCollection, readColor, type Color } from '../plugins/planner/src/model.ts'
import { colorVar, LIMITS } from '../plugins/planner/src/ui/colors.ts'
import { hexToHsv, hsvToHex } from '../plugins/planner/src/ui/hsv.ts'

type Vec = [number, number, number]
const toLinear = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)

function hexToOklab(hex: string): Vec {
  const [r, g, b] = [1, 3, 5].map(i => toLinear(Number.parseInt(hex.slice(i, i + 2), 16) / 255)) as Vec
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
  ]
}
function oklabToLinear([L, a, b]: Vec): Vec {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ].map(v => Math.min(1, Math.max(0, v))) as Vec
}
const luminance = (c: Vec) => {
  const [r, g, b] = oklabToLinear(c)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
const contrast = (a: Vec, b: Vec) => {
  const [x, y] = [luminance(a), luminance(b)]
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
}
const mix = (a: Vec, b: Vec, t: number) => a.map((v, i) => v * t + b[i]! * (1 - t)) as Vec
const fromLch = (l: number, c: number, h: number): Vec => [l, c * Math.cos((h * Math.PI) / 180), c * Math.sin((h * Math.PI) / 180)]

type Theme = 'light' | 'dark'
function held(hex: string, limit: { light: number; dark: number; chroma: number }, theme: Theme): Vec {
  const [L, a, b] = hexToOklab(hex)
  const c = Math.hypot(a, b)
  const k = c > limit.chroma ? limit.chroma / c : 1
  return [theme === 'light' ? Math.min(L, limit.light) : Math.max(L, limit.dark), a * k, b * k]
}

/** Mango's grounds, read from the tokens so a change there is noticed here. */
const css = readFileSync(new URL('../app/assets/css/tokens.css', import.meta.url), 'utf8')
const blocks = {
  dark: css.slice(css.indexOf("color-scheme: dark"), css.indexOf("color-scheme: light")),
  light: css.slice(css.indexOf("color-scheme: light"), css.indexOf('Colour schemes')),
}
function token(theme: Theme, name: string): Vec {
  const m = new RegExp(`${name}: oklch\\(([\\d.]+) (?:calc\\(([\\d.]+) \\*[^)]*\\)\\)|([\\d.]+)) (?:var\\(--hue-(ground|ink)\\)|([\\d.]+))(?: / ([\\d.]+))?\\)`).exec(blocks[theme])
  assert.ok(m, `${name} in ${theme}`)
  const hue = m[4] ? (m[4] === 'ground' ? 160 : 150) : Number(m[5])
  const v = fromLch(Number(m[1]), Number(m[2] ?? m[3]), hue)
  return m[6] ? mix(v, token(theme, '--bg-panel'), Number(m[6])) : v
}

const AWKWARD = ['#000000', '#010101', '#ffffff', '#fefefe', '#fffde7', '#ffff00', '#00ff00', '#0000ff', '#ff00ff', '#00ffff', '#ff0000', '#808080', '#0b0b3b', '#3b0b0b', '#f0e68c']
const ALL = [...AWKWARD]
for (let r = 0; r < 256; r += 51) for (let g = 0; g < 256; g += 51) for (let b = 0; b < 256; b += 51) ALL.push(`#${[r, g, b].map(v => v.toString(16).padStart(2, '0')).join('')}`)

for (const theme of ['dark', 'light'] as const) {
  test(`colours: text and marks are readable in ${theme}`, () => {
    const panel = token(theme, '--bg-panel')
    let text = 99
    let mark = 99
    for (const hex of ALL) {
      const fg = held(hex, LIMITS.text, theme)
      const dot = held(hex, LIMITS.mark, theme)
      const fill: Vec = [LIMITS.fill, dot[1], dot[2]]
      const tint = mix(fill, panel, LIMITS.tint / 100)
      const strong = mix(fill, panel, LIMITS.strong / 100)
      const grounds = { panel, tint, canvas: token(theme, '--bg-canvas'), raised: token(theme, '--bg-raised'), tag: token(theme, '--bg-active') }
      for (const [name, ground] of Object.entries(grounds)) {
        const c = contrast(fg, ground)
        text = Math.min(text, c)
        assert.ok(c >= 4.5, `${hex} text on ${name}: ${c.toFixed(2)}`)
      }
      assert.ok(contrast(fg, strong) >= 4, `${hex} text on strong: ${contrast(fg, strong).toFixed(2)}`)
      mark = Math.min(mark, contrast(dot, panel))
      assert.ok(contrast(dot, panel) >= 3, `${hex} dot: ${contrast(dot, panel).toFixed(2)}`)
      assert.ok(contrast(dot, tint) >= 2.5, `${hex} dot on tint: ${contrast(dot, tint).toFixed(2)}`)
      assert.ok(Math.abs(tint[0] - panel[0]) < 0.04, `${hex} tint is faint`)
    }
    assert.ok(text < 8 && mark < 6, 'the limits do not wash colours out')
  })
}

test('colours: the CSS is made of the limits', () => {
  const v = colorVar('#FFFF00'.toLowerCase() as Color)
  assert.match(v.fg, /^light-dark\(oklch\(from #ffff00 min\(l, 0\.46\) min\(c, 0\.15\) h\), oklch\(from #ffff00 max\(l, /)
  assert.match(v.tint, /^color-mix\(in oklab, oklch\(from #ffff00 0\.65 .*\) 8%, var\(--bg-panel\)\)$/)
  assert.equal(colorVar('neutral').tint, 'var(--bg-panel)')
  assert.equal(colorVar('blue'), colorVar('blue'))
})

test('colours: what is stored, typed and unreadable', () => {
  assert.equal(readColor('#ABC'), '#aabbcc')
  assert.equal(readColor(' 12aB9f '), '#12ab9f')
  assert.equal(readColor('pink'), 'pink')
  for (const bad of ['#12', 'red;', 'url(x)', '#gggggg', '', null, 3, 'constructor']) assert.equal(readColor(bad), null)
  assert.ok(isCustomColor('#123456') && !isCustomColor('blue'))
  const color = (c: unknown) => normalizeCollection({ color: c }, { id: 'c', createdAt: 0, updatedAt: 0 }).color
  assert.equal(color('#FF8800'), '#ff8800')
  assert.equal(color('#f80'), 'neutral')
  assert.equal(color('teal'), 'neutral')
  assert.equal(color(undefined), 'neutral')
})

test('colours: hsv and back', () => {
  for (const hex of ALL) assert.equal(hsvToHex(hexToHsv(hex)), hex)
  assert.deepEqual(hexToHsv('#ff0000'), { h: 0, s: 1, v: 1 })
  assert.equal(hsvToHex({ h: 360, s: 1, v: 1 }), '#ff0000')
})
