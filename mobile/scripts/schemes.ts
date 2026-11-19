/**
 * Builds the phone's colour schemes from the desktop's `app/assets/css/tokens.css`:
 *
 *   node scripts/schemes.ts          writes src/theme/schemes.generated.ts
 *   node scripts/schemes.ts --check  exits 1 when that file is out of date
 *
 * A scheme in tokens.css is a few custom properties (`--hue-ground`, `--ground-tint`, the accent
 * family) that the theme blocks turn into colours. This reads those blocks the way a browser does
 * for the root element (matching rules, the cascade by specificity then source order, `var()` and
 * `calc()`), resolves every `oklch()` to sRGB (`oklch.ts`), and adds the few `color-mix()` values
 * the desktop computes in components. Plain TypeScript (runs in Node, no dependencies).
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { hex, mixOklch, oklchToRgb, type Oklch } from './oklch.ts'

const CSS = fileURLToPath(new URL('../../app/assets/css/tokens.css', import.meta.url))
const OUT = fileURLToPath(new URL('../src/theme/schemes.generated.ts', import.meta.url))

export const SCHEMES = ['mango', 'blue', 'teal', 'green', 'purple', 'pink', 'red', 'slate', 'uchiha', 'graphite'] as const
export type Scheme = typeof SCHEMES[number]
export type Theme = 'dark' | 'light'

/* ---------- reading the stylesheet ---------- */

interface Rule { selector: string; decls: Array<[string, string]>; order: number }

function parseRules(css: string): Rule[] {
  const body = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const rules: Rule[] = []
  const re = /([^{}]+)\{([^{}]*)\}/g
  for (let m = re.exec(body), order = 0; m; m = re.exec(body), order++) {
    const decls: Array<[string, string]> = []
    for (const d of m[2]!.split(';')) {
      const i = d.indexOf(':')
      if (i > 0 && d.trim().startsWith('--')) decls.push([d.slice(0, i).trim(), d.slice(i + 1).trim()])
    }
    if (decls.length) rules.push({ selector: m[1]!.trim(), decls, order })
  }
  return rules
}

/** Specificity of a compound selector the way the cascade counts it here: each attribute test and `:root`. */
const specificity = (s: string) => (s.match(/\[/g)?.length ?? 0) + (s.match(/:root/g)?.length ?? 0)

/** The root element carries `data-theme` and `data-scheme`; descendant selectors are for previews and never match it. */
function matches(selector: string, theme: Theme, scheme: Scheme): number | null {
  let best: number | null = null
  for (const sel of selector.split(',').map(s => s.trim())) {
    if (/\s/.test(sel)) continue
    const t = /\[data-theme='(\w+)'\]/.exec(sel)
    const s = /\[data-scheme='(\w+)'\]/.exec(sel)
    if (t && t[1] !== theme) continue
    if (s && s[1] !== scheme) continue
    best = Math.max(best ?? 0, specificity(sel))
  }
  return best
}

/** Every custom property of the root for a theme and scheme, after the cascade. */
function cascade(rules: Rule[], theme: Theme, scheme: Scheme): Map<string, string> {
  const hits: Array<{ spec: number; order: number; decls: Array<[string, string]> }> = []
  for (const r of rules) {
    const spec = matches(r.selector, theme, scheme)
    if (spec !== null) hits.push({ spec, order: r.order, decls: r.decls })
  }
  hits.sort((a, b) => a.spec - b.spec || a.order - b.order)
  const vars = new Map<string, string>()
  for (const h of hits) for (const [k, v] of h.decls) vars.set(k, v)
  return vars
}

/* ---------- evaluating values ---------- */

const num = (s: string, vars: Map<string, string>): number => {
  const t = s.trim()
  const v = /^var\(--([\w-]+)\)$/.exec(t)
  if (v) return num(vars.get(`--${v[1]}`) ?? '', vars)
  const calc = /^calc\((.*)\)$/.exec(t)
  if (calc) return calc[1]!.split('*').reduce((p, f) => p * num(f, vars), 1)
  const n = Number(t)
  if (Number.isNaN(n)) throw new Error(`not a number: ${s}`)
  return n
}

/** `oklch(L C H / A)` with `var()` and `calc()` inside. */
function oklchOf(value: string, vars: Map<string, string>): { color: Oklch; alpha: number } {
  const m = /^oklch\((.*)\)$/.exec(value.trim())
  if (!m) throw new Error(`not oklch: ${value}`)
  const [parts, alpha] = m[1]!.split('/')
  // Split on spaces that are not inside parentheses.
  const words: string[] = []
  let depth = 0
  let cur = ''
  for (const ch of parts!.trim()) {
    if (ch === '(') depth++
    if (ch === ')') depth--
    if (ch === ' ' && depth === 0) { if (cur) words.push(cur); cur = '' } else cur += ch
  }
  if (cur) words.push(cur)
  const [l, c, h] = words.map(w => num(w, vars))
  return { color: { l: l!, c: c!, h: h! }, alpha: alpha === undefined ? 1 : num(alpha, vars) }
}

const alphaText = (a: number) => String(Math.round(a * 1000) / 1000)
const rgba = (rgb: number[], a: number) => `rgba(${rgb.join(', ')}, ${alphaText(a)})`

/** A colour token as the string React Native takes: `#rrggbb`, or `rgba()` when translucent. */
function colorToken(value: string, vars: Map<string, string>): string {
  if (value.startsWith('#')) return value
  const { color, alpha } = oklchOf(value, vars)
  const rgb = oklchToRgb(color)
  return alpha >= 1 ? hex(rgb) : rgba(rgb, alpha)
}

/** A box-shadow made of oklch colours: each layer as `x y blur spread rgba()` (React Native's `boxShadow`). */
function shadowToken(value: string, vars: Map<string, string>): string {
  const layers: string[] = []
  let depth = 0
  let cur = ''
  for (const ch of value) {
    if (ch === '(') depth++
    if (ch === ')') depth--
    if (ch === ',' && depth === 0) { layers.push(cur.trim()); cur = '' } else cur += ch
  }
  layers.push(cur.trim())
  return layers.map((layer) => {
    const at = layer.indexOf('oklch(')
    const lengths = layer.slice(0, at).trim().split(/\s+/).map(v => (v === '0' ? '0px' : v))
    if (lengths.length === 3) lengths.push('0px')
    return `${lengths.join(' ')} ${colorToken(layer.slice(at), vars)}`
  }).join(', ')
}

/* ---------- the palette ---------- */

const camel = (name: string) => name.replace(/^--/, '').replace(/-(\w)/g, (_, c: string) => c.toUpperCase())

const COLOR_TOKENS = [
  'bg-app', 'bg-canvas', 'bg-panel', 'bg-raised', 'bg-inset', 'bg-hover', 'bg-active',
  'line', 'line-soft', 'line-strong',
  'fg', 'fg-muted', 'fg-subtle', 'fg-faint',
  'accent', 'accent-strong', 'accent-fg', 'accent-ink', 'accent-soft', 'accent-line',
  'ripe-idle', 'ripe-queued', 'ripe-running', 'ripe-waiting', 'ripe-done', 'ripe-error',
  'ripe-queued-fg', 'ripe-running-fg', 'ripe-waiting-fg', 'ripe-done-fg', 'ripe-error-fg',
  'diff-add-bg', 'diff-add-fg', 'diff-del-bg', 'diff-del-fg',
  'scrim', 'selection', 'focus-ring',
]

export type Palette = Record<string, string>

export function palette(rules: Rule[], theme: Theme, scheme: Scheme): { colors: Palette; shadow: { pop: string; soft: string } } {
  const vars = cascade(rules, theme, scheme)
  const get = (n: string) => {
    const v = vars.get(`--${n}`)
    if (v === undefined) throw new Error(`--${n} is not set for ${scheme} ${theme}`)
    return v
  }
  const colors: Palette = {}
  for (const t of COLOR_TOKENS) colors[camel(t)] = colorToken(get(t), vars)

  // The few color-mix() values components compute on the desktop, resolved the same way.
  const col = (n: string) => oklchOf(get(n), vars)
  const mix = (a: string, pct: number, b: string) => {
    const m = mixOklch(col(a).color, col(b).color, pct / 100)
    return hex(oklchToRgb(m))
  }
  const withAlpha = (n: string, a: number) => rgba(oklchToRgb(col(n).color), a)
  colors.waitingWash = mix('ripe-waiting', 7, 'bg-panel')
  colors.waitingLine = withAlpha('ripe-waiting', 0.55)
  colors.accentWash = mix('accent', 9, 'bg-panel')
  colors.errorWash = withAlpha('ripe-error', 0.12)
  colors.errorLine = withAlpha('ripe-error', 0.4)
  colors.errorLineStrong = withAlpha('ripe-error', 0.6)
  colors.chipAccent = withAlpha('accent-ink', 0.14)
  colors.chipAdd = withAlpha('diff-add-fg', 0.14)
  colors.chipDel = withAlpha('diff-del-fg', 0.14)
  colors.chipQueued = withAlpha('ripe-queued-fg', 0.14)
  colors.chipError = withAlpha('ripe-error-fg', 0.14)
  colors.brandClaude = get('brand-claude')

  return { colors, shadow: { pop: shadowToken(get('shadow-pop'), vars), soft: shadowToken(get('shadow-soft'), vars) } }
}

export function build(css: string) {
  const rules = parseRules(css)
  const out: Record<string, Record<string, ReturnType<typeof palette>>> = {}
  for (const s of SCHEMES) {
    out[s] = {}
    for (const t of ['dark', 'light'] as const) out[s]![t] = palette(rules, t, s)
  }
  return out
}

function render(): string {
  const all = build(readFileSync(CSS, 'utf8'))
  const lines = [
    '/**',
    ' * Generated by `node scripts/schemes.ts` from the desktop\'s `app/assets/css/tokens.css`: every colour scheme,',
    ' * dark and light, resolved to sRGB. Do not edit; change tokens.css and run the script again.',
    ' */',
    '',
    `export const SCHEME_NAMES = ${JSON.stringify(SCHEMES)} as const`,
    '',
    'export type SchemeId = typeof SCHEME_NAMES[number]',
    '',
    'export const generated = ' + JSON.stringify(all, null, 2) + ' as const',
    '',
  ]
  return lines.join('\n')
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const text = render()
  if (process.argv.includes('--check')) {
    let current = ''
    try { current = readFileSync(OUT, 'utf8') } catch { /* missing */ }
    if (current !== text) {
      console.error('src/theme/schemes.generated.ts is out of date: run `node scripts/schemes.ts`.')
      process.exit(1)
    }
  } else {
    writeFileSync(OUT, text)
    console.log(`wrote ${OUT}`)
  }
}
