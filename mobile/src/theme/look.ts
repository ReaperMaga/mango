import { SCHEME_NAMES, type SchemeId } from './schemes.generated'

/**
 * What Settings > Appearance chooses besides light or dark: the desktop's own options
 * (`stores/workspace.ts`), with the same names and the same scales (`tokens.css`). Plain data, so it
 * runs in Node.
 */

export type ColorScheme = SchemeId
export type UiFont = 'inter' | 'geist' | 'dm-sans' | 'manrope' | 'system'
export type MonoFont = 'jetbrains-mono' | 'fira-code' | 'source-code-pro' | 'geist-mono' | 'system'
export type TextSize = 'small' | 'default' | 'large' | 'xlarge'
export type Corners = 'sharp' | 'default' | 'round'
/** Animations: follow the phone's Reduce Motion, or force them on or off. */
export type MotionPref = 'system' | 'full' | 'reduced'

export interface Look {
  scheme: ColorScheme
  fontUi: UiFont
  fontMono: MonoFont
  textSize: TextSize
  corners: Corners
  motion: MotionPref
}

export const DEFAULT_LOOK: Look = {
  scheme: 'mango',
  fontUi: 'inter',
  fontMono: 'jetbrains-mono',
  textSize: 'default',
  corners: 'default',
  motion: 'system',
}

type Choice<T extends string> = ReadonlyArray<{ value: T; label: string }>

export const SCHEMES: Choice<ColorScheme> = [
  { value: 'mango', label: 'Mango' },
  { value: 'blue', label: 'Blue' },
  { value: 'teal', label: 'Teal' },
  { value: 'green', label: 'Green' },
  { value: 'purple', label: 'Purple' },
  { value: 'pink', label: 'Pink' },
  { value: 'red', label: 'Red' },
  { value: 'slate', label: 'Slate' },
  { value: 'uchiha', label: 'Uchiha' },
  { value: 'graphite', label: 'Graphite' },
]

export const UI_FONTS: Choice<UiFont> = [
  { value: 'inter', label: 'Inter' },
  { value: 'geist', label: 'Geist' },
  { value: 'dm-sans', label: 'DM Sans' },
  { value: 'manrope', label: 'Manrope' },
  { value: 'system', label: 'System font' },
]

export const MONO_FONTS: Choice<MonoFont> = [
  { value: 'jetbrains-mono', label: 'JetBrains Mono' },
  { value: 'fira-code', label: 'Fira Code' },
  { value: 'source-code-pro', label: 'Source Code Pro' },
  { value: 'geist-mono', label: 'Geist Mono' },
  { value: 'system', label: 'System monospace' },
]

export const TEXT_SIZES: Choice<TextSize> = [
  { value: 'small', label: 'Small' },
  { value: 'default', label: 'Default' },
  { value: 'large', label: 'Large' },
  { value: 'xlarge', label: 'Extra large' },
]

export const CORNERS: Choice<Corners> = [
  { value: 'sharp', label: 'Sharp' },
  { value: 'default', label: 'Default' },
  { value: 'round', label: 'Round' },
]

export const MOTIONS: Choice<MotionPref> = [
  { value: 'system', label: 'System' },
  { value: 'full', label: 'Full' },
  { value: 'reduced', label: 'Reduced' },
]

/** `--text-scale` and `--radius-scale` of tokens.css. */
export const TEXT_SCALE: Record<TextSize, number> = { small: 0.92, default: 1, large: 1.08, xlarge: 1.16 }
export const RADIUS_SCALE: Record<Corners, number> = { sharp: 0.4, default: 1, round: 1.5 }

export const labelOf = <T extends string>(choices: Choice<T>, value: T): string => choices.find(c => c.value === value)?.label ?? value

const pick = <T extends string>(v: unknown, choices: Choice<T>, fallback: T): T =>
  typeof v === 'string' && choices.some(c => c.value === v) ? (v as T) : fallback

/** The look from whatever was saved: a missing or unknown choice falls back to the default, so older data loads. */
export function normalizeLook(raw: unknown): Look {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  return {
    scheme: pick(o.scheme, SCHEMES, DEFAULT_LOOK.scheme),
    fontUi: pick(o.fontUi, UI_FONTS, DEFAULT_LOOK.fontUi),
    fontMono: pick(o.fontMono, MONO_FONTS, DEFAULT_LOOK.fontMono),
    textSize: pick(o.textSize, TEXT_SIZES, DEFAULT_LOOK.textSize),
    corners: pick(o.corners, CORNERS, DEFAULT_LOOK.corners),
    motion: pick(o.motion, MOTIONS, DEFAULT_LOOK.motion),
  }
}

/** A short name for the look, for the Appearance row in Settings: "Mango", "Blue · Large text". */
export function lookSummary(look: Look): string {
  const parts: string[] = [labelOf(SCHEMES, look.scheme)]
  if (look.textSize !== 'default') parts.push(`${labelOf(TEXT_SIZES, look.textSize)} text`)
  return parts.join(' · ')
}

/** Two looks that differ only in what takes effect without loading anything. */
export const sameFonts = (a: Look, b: Look) => a.fontUi === b.fontUi && a.fontMono === b.fontMono

export const ALL_SCHEMES = SCHEME_NAMES
