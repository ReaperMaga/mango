import type { Colors, Shadows } from './tokens'

/**
 * The Mango palette as the phone shipped it, resolved by hand from tokens.css before the schemes were
 * generated (`scripts/schemes.ts`). Kept only so `schemes.test.ts` can prove the generator reproduces it.
 */

export const darkColors: Colors = {
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
}

export const lightColors: Colors = {
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
}

export const darkShadows: Shadows = {
  pop: '0px 12px 32px -8px rgba(0, 1, 0, 0.6), 0px 2px 6px 0px rgba(0, 1, 0, 0.35)',
  soft: '0px 4px 14px -6px rgba(0, 1, 0, 0.5)',
}
export const lightShadows: Shadows = {
  pop: '0px 14px 34px -10px rgba(32, 51, 41, 0.28), 0px 2px 6px 0px rgba(32, 51, 41, 0.1)',
  soft: '0px 4px 14px -6px rgba(32, 51, 41, 0.18)',
}

