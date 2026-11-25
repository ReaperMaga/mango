/** The planner's named colours as Mango's tokens, for both themes. */

import type { Color } from '../model.ts'

/** Categories, not chat states: the file tints, so nothing here reads as a chat's status. */
const MARKS: Record<Color, string> = {
  neutral: 'var(--fg-faint)',
  blue: 'var(--file-blue)',
  green: 'var(--file-green)',
  yellow: 'var(--file-yellow)',
  orange: 'var(--file-orange)',
  red: 'var(--file-red)',
  purple: 'var(--file-purple)',
  pink: 'color-mix(in oklab, var(--file-red) 50%, var(--file-purple))',
}

/** `dot`: marks and icons. `fg`: text, readable on every ground. */
export function colorVar(color: Color): { dot: string; fg: string } {
  const dot = MARKS[color]
  return { dot, fg: color === 'neutral' ? 'var(--fg-muted)' : `color-mix(in oklab, ${dot} 25%, var(--fg))` }
}
