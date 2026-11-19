/**
 * Mango's design tokens for the phone: `app/assets/css/tokens.css` (the desktop's only source of
 * colour, type, space, radius and motion) translated for React Native. Names follow the CSS ones
 * in camelCase (`--accent-ink` is `accentInk`, `--ripe-waiting-fg` is `ripeWaitingFg`), so a rule
 * in DESIGN.md reads the same here.
 *
 * Colours are the Mango scheme (ground hue 160, ink hue 150) resolved from OKLCH to sRGB once,
 * with CSS Color 4 gamut mapping (chroma reduced until in sRGB), because React Native takes
 * hex/rgba only. Translucent tokens keep their alpha as rgba(). The few `color-mix()` values the
 * desktop computes in components (the waiting card's wash, a selected option's wash, tinted
 * borders) are resolved here too, under their own names, so components still read tokens only.
 * Regenerate them the same way if tokens.css changes.
 */

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
}

const dark: Colors = {
  bgApp: '#0b100d',
  bgCanvas: '#111613',
  bgPanel: '#151b18',
  bgRaised: '#1d2320',
  bgInset: '#070b09',
  bgHover: 'rgba(34, 40, 36, 0.55)',
  bgActive: 'rgba(40, 48, 43, 0.7)',

  line: '#29302c',
  lineSoft: '#202622',
  lineStrong: '#3c4540',

  fg: '#e8ede8',
  fgMuted: '#b9c0ba',
  fgSubtle: '#969e97',
  fgFaint: '#878e88',

  accent: '#ff9d43',
  accentStrong: '#ffaf64',
  accentFg: '#281606',
  accentInk: '#ffac52',
  accentSoft: 'rgba(255, 164, 69, 0.14)',
  accentLine: 'rgba(255, 164, 69, 0.45)',

  ripeIdle: '#737d77',
  ripeQueued: '#69b27a',
  ripeRunning: '#ff903d',
  ripeWaiting: '#f47c6e',
  ripeDone: '#a1e24c',
  ripeError: '#f0555b',
  ripeQueuedFg: '#82cb92',
  ripeRunningFg: '#ffac52',
  ripeWaitingFg: '#ff9284',
  ripeDoneFg: '#a9e85e',
  ripeErrorFg: '#ff7d7c',

  diffAddBg: 'rgba(105, 178, 122, 0.12)',
  diffAddFg: '#7ccd8e',
  diffDelBg: 'rgba(240, 85, 91, 0.12)',
  diffDelFg: '#f68482',

  scrim: 'rgba(1, 2, 1, 0.55)',
  selection: 'rgba(255, 164, 69, 0.28)',
  focusRing: 'rgba(255, 164, 69, 0.7)',

  waitingWash: '#1b251d',
  waitingLine: 'rgba(244, 124, 110, 0.55)',
  accentWash: '#1d2920',
  errorWash: 'rgba(240, 85, 91, 0.12)',
  errorLine: 'rgba(240, 85, 91, 0.4)',
  errorLineStrong: 'rgba(240, 85, 91, 0.6)',
  chipAccent: 'rgba(255, 172, 82, 0.14)',
  chipAdd: 'rgba(124, 205, 142, 0.14)',
  chipDel: 'rgba(246, 132, 130, 0.14)',
  chipQueued: 'rgba(130, 203, 146, 0.14)',
  chipError: 'rgba(255, 125, 124, 0.14)',

  brandClaude: '#d97757',

  fileBlue: '#5eaceb',
  fileYellow: '#e7c952',
  fileOrange: '#f78955',
  fileGreen: '#6fc884',
  filePurple: '#b093e5',
  fileRed: '#ed7473',
}

const light: Colors = {
  bgApp: '#edf1ee',
  bgCanvas: '#f8fbf9',
  bgPanel: '#ffffff',
  bgRaised: '#ffffff',
  bgInset: '#f4f8f5',
  bgHover: 'rgba(218, 224, 218, 0.55)',
  bgActive: 'rgba(209, 218, 211, 0.75)',

  line: '#d4d9d5',
  lineSoft: '#e2e6e2',
  lineStrong: '#b9c0ba',

  fg: '#19221d',
  fgMuted: '#3c4540',
  fgSubtle: '#545d58',
  fgFaint: '#666e69',

  accent: '#f68c11',
  accentStrong: '#ea7e00',
  accentFg: '#281606',
  accentInk: '#a94700',
  accentSoft: 'rgba(235, 136, 31, 0.16)',
  accentLine: 'rgba(222, 111, 0, 0.45)',

  ripeIdle: '#8c9590',
  ripeQueued: '#3d8e53',
  ripeRunning: '#ec6f00',
  ripeWaiting: '#d95448',
  ripeDone: '#6fb511',
  ripeError: '#d02b31',
  ripeQueuedFg: '#0f6a31',
  ripeRunningFg: '#a64b00',
  ripeWaitingFg: '#b6322b',
  ripeDoneFg: '#3c740d',
  ripeErrorFg: '#b71824',

  diffAddBg: 'rgba(99, 179, 118, 0.14)',
  diffAddFg: '#09672e',
  diffDelBg: 'rgba(226, 73, 71, 0.12)',
  diffDelFg: '#b32228',

  scrim: 'rgba(37, 49, 42, 0.25)',
  selection: 'rgba(235, 136, 31, 0.25)',
  focusRing: 'rgba(203, 90, 0, 0.7)',

  waitingWash: '#fef3f2',
  waitingLine: 'rgba(217, 84, 72, 0.55)',
  accentWash: '#fff5ed',
  errorWash: 'rgba(208, 43, 49, 0.12)',
  errorLine: 'rgba(208, 43, 49, 0.4)',
  errorLineStrong: 'rgba(208, 43, 49, 0.6)',
  chipAccent: 'rgba(169, 71, 0, 0.14)',
  chipAdd: 'rgba(9, 103, 46, 0.14)',
  chipDel: 'rgba(179, 34, 40, 0.14)',
  chipQueued: 'rgba(15, 106, 49, 0.14)',
  chipError: 'rgba(183, 24, 36, 0.14)',

  brandClaude: '#d97757',

  fileBlue: '#1f74bf',
  fileYellow: '#c28f00',
  fileOrange: '#d16022',
  fileGreen: '#2d8949',
  filePurple: '#8059bb',
  fileRed: '#c8393a',
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

const darkShadows: Shadows = {
  pop: '0px 12px 32px -8px rgba(0, 1, 0, 0.6), 0px 2px 6px 0px rgba(0, 1, 0, 0.35)',
  soft: '0px 4px 14px -6px rgba(0, 1, 0, 0.5)',
}
const lightShadows: Shadows = {
  pop: '0px 14px 34px -10px rgba(32, 51, 41, 0.28), 0px 2px 6px 0px rgba(32, 51, 41, 0.1)',
  soft: '0px 4px 14px -6px rgba(32, 51, 41, 0.18)',
}

export const palettes: Record<SchemeName, { colors: Colors; shadow: Shadows }> = {
  dark: { colors: dark, shadow: darkShadows },
  light: { colors: light, shadow: lightShadows },
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

export const fonts = {
  regular: 'Inter_400Regular',
  medium: 'Inter_500Medium',
  semibold: 'Inter_600SemiBold',
  bold: 'Inter_700Bold',
  /** Emphasis in agent prose (custom fonts get no synthesized italic on iOS). */
  italic: 'Inter_400Regular_Italic',
  mono: 'JetBrainsMono_400Regular',
  monoMedium: 'JetBrainsMono_500Medium',
  monoSemibold: 'JetBrainsMono_600SemiBold',
} as const

export const fontSize = {
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

export const leading = { tight: 1.25, normal: 1.5, chat: 1.62 } as const

const lh = (size: number, ratio: number) => Math.round(size * ratio)

/** Ready-made text styles (no colour: pair with a `Colors` ink). */
export const type = {
  display: { fontFamily: fonts.semibold, fontSize: fontSize.display, lineHeight: lh(fontSize.display, leading.tight), letterSpacing: -0.8 },
  headline: { fontFamily: fonts.semibold, fontSize: fontSize.headline, lineHeight: lh(fontSize.headline, 1.3), letterSpacing: -0.33 },
  title: { fontFamily: fonts.semibold, fontSize: fontSize.title, lineHeight: lh(fontSize.title, 1.35), letterSpacing: -0.17 },
  body: { fontFamily: fonts.regular, fontSize: fontSize.body, lineHeight: lh(fontSize.body, leading.normal) },
  chat: { fontFamily: fonts.regular, fontSize: fontSize.body, lineHeight: lh(fontSize.body, leading.chat) },
  bodySm: { fontFamily: fonts.regular, fontSize: fontSize.bodySm, lineHeight: lh(fontSize.bodySm, leading.normal) },
  label: { fontFamily: fonts.medium, fontSize: fontSize.bodySm, lineHeight: lh(fontSize.bodySm, leading.tight) },
  caption: { fontFamily: fonts.regular, fontSize: fontSize.caption, lineHeight: lh(fontSize.caption, leading.normal) },
  captionStrong: { fontFamily: fonts.medium, fontSize: fontSize.caption, lineHeight: lh(fontSize.caption, leading.normal) },
  micro: { fontFamily: fonts.regular, fontSize: fontSize.micro, lineHeight: lh(fontSize.micro, leading.normal) },
  mono: { fontFamily: fonts.mono, fontSize: fontSize.mono, lineHeight: lh(fontSize.mono, leading.normal) },
  monoSm: { fontFamily: fonts.mono, fontSize: fontSize.monoSm, lineHeight: lh(fontSize.monoSm, leading.normal) },
  code: { fontFamily: fonts.mono, fontSize: fontSize.code, lineHeight: lh(fontSize.code, 1.55) },
} as const

/* ---------- Space (4pt grid) ---------- */
export const space = { 1: 4, 2: 8, 3: 12, 4: 16, 5: 20, 6: 24, 8: 32, 10: 40, 12: 48 } as const

/* ---------- Shape: radius follows the size of the thing (4, 6, 8, 12) ---------- */
export const radius = { xs: 4, sm: 6, md: 8, lg: 12, pill: 999 } as const

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
