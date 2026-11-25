/** The planner's colours as CSS values that work in both themes, whatever colour the user made up. */

import { isCustomColor, type Color, type NamedColor } from '../model.ts'

/** Categories, not chat states: the file tints, so nothing here reads as a chat's status. */
const TOKENS: Record<Exclude<NamedColor, 'neutral'>, string> = {
  blue: 'var(--file-blue)',
  green: 'var(--file-green)',
  yellow: 'var(--file-yellow)',
  orange: 'var(--file-orange)',
  red: 'var(--file-red)',
  purple: 'var(--file-purple)',
  pink: 'color-mix(in oklab, var(--file-red) 50%, var(--file-purple))',
}

/**
 * How far a colour may go, as OKLCH lightness: text dark enough for light grounds and light enough for dark ones,
 * marks a little less so. `chroma` keeps a glaring colour inside what screens show. Fills take only the hue, at one
 * lightness, so black and white do not make a hole or a glare: `tint`, `strong` and `line` are how much of it.
 * tests/plannerColors.test.ts measures the contrast these give.
 */
export const LIMITS = {
  text: { light: 0.46, dark: 0.79, chroma: 0.15 },
  mark: { light: 0.63, dark: 0.56, chroma: 0.2 },
  fill: 0.65,
  tint: 8,
  strong: 18,
  line: 28,
} as const

/** The colour with its lightness held back for each theme (`color-scheme` follows Mango's). */
const held = (color: string, l: { light: number; dark: number; chroma: number }) =>
  `light-dark(oklch(from ${color} min(l, ${l.light}) min(c, ${l.chroma}) h), oklch(from ${color} max(l, ${l.dark}) min(c, ${l.chroma}) h))`

export interface ColorVars {
  /** Marks: dots, icons. */
  readonly dot: string
  /** Text, AA on the panel, on `tint` and on a tag. */
  readonly fg: string
  /** A very faint fill for a whole column. */
  readonly tint: string
  /** Its border. */
  readonly line: string
  /** A fill that is lit: the place a drag would drop. */
  readonly strong: string
}

const NEUTRAL: ColorVars = {
  dot: 'var(--fg-faint)',
  fg: 'var(--fg-muted)',
  tint: 'var(--bg-panel)',
  line: 'var(--line-soft)',
  strong: 'var(--bg-active)',
}
const made = new Map<Color, ColorVars>()

export function colorVar(color: Color): ColorVars {
  if (color === 'neutral') return NEUTRAL
  let vars = made.get(color)
  if (!vars) {
    const source = isCustomColor(color) ? color : TOKENS[color]
    const dot = held(source, LIMITS.mark)
    const fill = `oklch(from ${source} ${LIMITS.fill} min(c, ${LIMITS.mark.chroma}) h)`
    const mix = (percent: number, ground: string) => `color-mix(in oklab, ${fill} ${percent}%, var(${ground}))`
    vars = {
      dot,
      fg: held(source, LIMITS.text),
      tint: mix(LIMITS.tint, '--bg-panel'),
      line: mix(LIMITS.line, '--line-soft'),
      strong: mix(LIMITS.strong, '--bg-panel'),
    }
    // A colour being dragged makes many.
    if (made.size > 500) made.clear()
    made.set(color, vars)
  }
  return vars
}

/** The colour itself, not held back: in the picker. */
export const rawColor = (color: Color): string => (color === 'neutral' ? NEUTRAL.dot : isCustomColor(color) ? color : TOKENS[color])
