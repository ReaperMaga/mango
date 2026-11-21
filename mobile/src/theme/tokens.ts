/**
 * Mango's design tokens for the phone: `app/assets/css/tokens.css` (the desktop's only source of
 * colour, type, space, radius and motion) translated for React Native. Names follow the CSS ones
 * in camelCase (`--accent-ink` is `accentInk`, `--ripe-waiting-fg` is `ripeWaitingFg`), so a rule
 * in DESIGN.md reads the same here.
 *
 * Colours are every colour scheme of tokens.css (Mango, Blue, … Graphite), dark and light, resolved
 * from OKLCH to sRGB by `scripts/schemes.ts` into `schemes.generated.ts` (CSS Color 4 gamut mapping),
 * because React Native takes hex/rgba only. Translucent tokens keep their alpha as rgba(). The few
 * `color-mix()` values the desktop computes in components (the waiting card's wash, a selected
 * option's wash, tinted borders) are resolved there too, under their own names, so components still
 * read tokens only. Change tokens.css, then run `node scripts/schemes.ts` (CI runs it with `--check`).
 */

import type { FontFace, Fonts } from './fonts'
import { RADIUS_SCALE, TEXT_SCALE, type ColorScheme, type Corners, type TextSize } from './look'
import { generated } from './schemes.generated'

/** Light or dark. (The tinted palettes, Mango to Graphite, are `ColorScheme` in `look.ts`.) */
export type SchemeName = 'dark' | 'light'

export interface Colors {
  /** Ground ladder: app < canvas < panel < raised; inset is the well below them all. */
  bgApp: string
  bgCanvas: string
  bgPanel: string
  bgRaised: string
  bgInset: string
  /** Translucent washes: hover/shown, then pressed/current/selected. On a phone "hover" is the pressed tint of quiet rows. */
  bgHover: string
  bgActive: string

  line: string
  lineSoft: string
  lineStrong: string

  /** Ink, four steps; the faintest still clears 4.5:1 on every ground. */
  fg: string
  fgMuted: string
  fgSubtle: string
  fgFaint: string

  /** The Fill-or-Ink Rule: `accent` is a fill (with `accentFg` on it), `accentInk` is accent text and icons. */
  accent: string
  accentStrong: string
  accentFg: string
  accentInk: string
  accentSoft: string
  accentLine: string

  /** The Two-Grade Rule: `ripe*` for marks, borders and washes; `ripe*Fg` for words. */
  ripeIdle: string
  ripeQueued: string
  ripeRunning: string
  ripeWaiting: string
  ripeDone: string
  ripeError: string
  ripeQueuedFg: string
  ripeRunningFg: string
  ripeWaitingFg: string
  ripeDoneFg: string
  ripeErrorFg: string

  diffAddBg: string
  diffAddFg: string
  diffDelBg: string
  diffDelFg: string

  scrim: string
  selection: string
  focusRing: string

  /* Resolved color-mix() values (see the header). */
  /** `color-mix(in oklch, ripe-waiting 7%, bg-panel)`: a pending approval or question card. */
  waitingWash: string
  /** `ripe-waiting` at 55%: that card's border. */
  waitingLine: string
  /** `color-mix(in oklch, accent 9%, bg-panel)`: a picked option. */
  accentWash: string
  /** The app mark's lighter half: the accent lighter and turned towards gold (`ui/MangoMark.vue`). */
  markLight: string
  /** `ripe-error` at 12%, 40% and 60%: error banner wash, danger button border, field error border. */
  errorWash: string
  errorLine: string
  errorLineStrong: string
  /** Git file-kind chips: the kind's text grade at 14%. */
  chipAccent: string
  chipAdd: string
  chipDel: string
  chipQueued: string
  chipError: string

  /** Claude's brand orange: only the agent logo uses it, as on the desktop (`--brand-claude`). */
  brandClaude: string

  /** `--file-*`: file-type marks, also the categories of a context window's breakdown. */
  fileBlue: string
  fileYellow: string
  fileOrange: string
  fileGreen: string
  filePurple: string
  fileRed: string

  /** The terminal's ANSI palette (`--term-*`): colours in a GitHub Actions log, as the desktop shows them. */
  termRed: string
  termGreen: string
  termYellow: string
  termBlue: string
  termMagenta: string
  termCyan: string
  termBrightBlack: string
  /** `color-mix(in oklch, term-yellow 9%, transparent)`: a warning line in a log. */
  termYellowWash: string
}

/**
 * Shadows, as CSS box-shadow strings (React Native's `boxShadow` style, New Architecture).
 * The Floating Shadow Rule: only for layers that float (sheets) and the composer.
 */
export interface Shadows {
  /** `--shadow-pop`: sheets and anything else lifted off the canvas. */
  pop: string
  /** `--shadow-soft`: the composer and the pending approval card. */
  soft: string
}

/** The colours and shadows of a colour scheme in light or dark: generated from tokens.css (`scripts/schemes.ts`). */
export function paletteFor(scheme: ColorScheme, mode: SchemeName): { colors: Colors; shadow: Shadows } {
  return generated[scheme][mode] as unknown as { colors: Colors; shadow: Shadows }
}

/** `#rrggbb` at an alpha: the CSS `color-mix(in oklch, X p%, transparent)` the desktop uses for tinted borders and washes. */
export function withAlpha(hex: string, alpha: number): string {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex)
  if (!m) return hex
  return `rgba(${parseInt(m[1]!, 16)}, ${parseInt(m[2]!, 16)}, ${parseInt(m[3]!, 16)}, ${alpha})`
}

/* ---------- Type ----------
 * Inter for the interface, JetBrains Mono only for code, paths, branches and diffs (The Machine
 * Text Rule). The desktop runs Inter Variable at fractional weights; the phone has the static
 * cuts, so weights snap: 400 → Regular, 520–560 → Medium, 580–650 → SemiBold.
 *
 * Sizes are the desktop scale nudged up for a phone held at reading distance (iOS body is 17pt,
 * nothing under 11pt), each step landing on an iOS text style so Dynamic Type scales evenly:
 *
 *   desktop token        px     phone pt   iOS style it sits on    used for
 *   --text-2xs (micro)   10.5 →  11        caption 2                timestamps, keycaps, counters
 *   --text-xs (caption)  11.5 →  13        footnote                 meta lines, hints, status words, field labels
 *   --text-sm (body-sm)  12.5 →  15        subheadline              rows, tool lines, buttons, inputs' chrome
 *   --text-md (body)     13.5 →  16        callout                  chat prose, composer, inputs
 *   --text-lg (title)    15   →  17        headline / body          sheet titles, headings in prose
 *   --text-xl (headline) 19   →  22        title 2                  empty-state questions
 *   --text-2xl (display) 26   →  32        (large title is 34)      one per screen at most
 *   mono                 11.5 →  13                                 paths, branches, diff lines
 *   code                 12.5 →  14                                 code blocks in agent prose
 *
 * Line heights keep the desktop's ratios (tight 1.25, normal 1.5, chat 1.62) as points.
 */

/** The unscaled sizes; `fontSizeFor` applies Settings > Appearance > Text size. */
const BASE_FONT_SIZE = {
  micro: 11,
  caption: 13,
  bodySm: 15,
  body: 16,
  title: 17,
  headline: 22,
  display: 32,
  mono: 13,
  monoSm: 11,
  code: 14,
} as const

export type FontSizes = { [K in keyof typeof BASE_FONT_SIZE]: number }

/** The sizes at a text size (the desktop's `--text-scale`), whole points, never under 10. */
export function fontSizeFor(textSize: TextSize): FontSizes {
  const k = TEXT_SCALE[textSize]
  return Object.fromEntries(Object.entries(BASE_FONT_SIZE).map(([name, v]) => [name, Math.max(10, Math.round(v * k))])) as FontSizes
}

export const leading = { tight: 1.25, normal: 1.5, chat: 1.62 } as const

const lh = (size: number, ratio: number) => Math.round(size * ratio)

export type TextStyleName =
  | 'display' | 'headline' | 'title' | 'body' | 'chat' | 'bodySm' | 'label' | 'caption' | 'captionStrong' | 'micro' | 'mono' | 'monoSm' | 'code'

export interface TextStyleSpec extends FontFace {
  fontSize: number
  lineHeight: number
  letterSpacing?: number
}

/** Ready-made text styles for a font choice and size (no colour: pair with a `Colors` ink). */
export function typeFor(fonts: Fonts, size: FontSizes): Record<TextStyleName, TextStyleSpec> {
  return {
    display: { ...fonts.semibold, fontSize: size.display, lineHeight: lh(size.display, leading.tight), letterSpacing: -0.8 },
    headline: { ...fonts.semibold, fontSize: size.headline, lineHeight: lh(size.headline, 1.3), letterSpacing: -0.33 },
    title: { ...fonts.semibold, fontSize: size.title, lineHeight: lh(size.title, 1.35), letterSpacing: -0.17 },
    body: { ...fonts.regular, fontSize: size.body, lineHeight: lh(size.body, leading.normal) },
    chat: { ...fonts.regular, fontSize: size.body, lineHeight: lh(size.body, leading.chat) },
    bodySm: { ...fonts.regular, fontSize: size.bodySm, lineHeight: lh(size.bodySm, leading.normal) },
    label: { ...fonts.medium, fontSize: size.bodySm, lineHeight: lh(size.bodySm, leading.tight) },
    caption: { ...fonts.regular, fontSize: size.caption, lineHeight: lh(size.caption, leading.normal) },
    captionStrong: { ...fonts.medium, fontSize: size.caption, lineHeight: lh(size.caption, leading.normal) },
    micro: { ...fonts.regular, fontSize: size.micro, lineHeight: lh(size.micro, leading.normal) },
    mono: { ...fonts.mono, fontSize: size.mono, lineHeight: lh(size.mono, leading.normal) },
    monoSm: { ...fonts.mono, fontSize: size.monoSm, lineHeight: lh(size.monoSm, leading.normal) },
    code: { ...fonts.mono, fontSize: size.code, lineHeight: lh(size.code, 1.55) },
  }
}

/* ---------- Space (4pt grid) ---------- */
export const space = { 1: 4, 2: 8, 3: 12, 4: 16, 5: 20, 6: 24, 8: 32, 10: 40, 12: 48 } as const

/* ---------- Shape: radius follows the size of the thing (4, 6, 8, 12) ---------- */
const BASE_RADIUS = { xs: 4, sm: 6, md: 8, lg: 12 } as const
export type Radii = { xs: number; sm: number; md: number; lg: number; pill: number }

/** The radii at a corner choice (the desktop's `--radius-scale`); a pill stays a pill. */
export function radiusFor(corners: Corners): Radii {
  const k = RADIUS_SCALE[corners]
  const r = (v: number) => Math.round(v * k * 2) / 2
  return { xs: r(BASE_RADIUS.xs), sm: r(BASE_RADIUS.sm), md: r(BASE_RADIUS.md), lg: r(BASE_RADIUS.lg), pill: 999 }
}

/* ---------- Touch: the HIG's 44pt floor, and the desktop row heights it replaces ---------- */
export const touch = {
  /** Every tappable thing is at least this, by size or hitSlop. */
  min: 44,
  /** A one-line list row. */
  row: 48,
  /** A two-line row (thread, project). */
  row2: 64,
} as const

/* ---------- Motion ---------- */
export const motion = {
  /** --ease-out, --ease-in-out as cubic-bezier control points (for `Easing.bezier`). */
  easeOut: [0.16, 1, 0.3, 1] as const,
  easeInOut: [0.65, 0, 0.35, 1] as const,
  /** State changes. */
  fast: 120,
  /** Panels, sheets, colour of a status change. */
  med: 220,
  /** Fill level of a ripening dot. */
  slow: 420,
} as const
