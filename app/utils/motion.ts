/**
 * Motion for the Web Animations API, which cannot read the CSS duration tokens itself.
 * Mirrors `--dur-*` and `--ease-out` in tokens.css and honours `--motion-scale` (reduced motion).
 */
export const DUR = { fast: 120, med: 220, slow: 420 } as const
export const EASE_OUT = 'cubic-bezier(0.16, 1, 0.3, 1)'

export function motionMs(base: number): number {
  const scale = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--motion-scale'))
  return base * (Number.isFinite(scale) ? scale : 1)
}
