import type { UsageWindow } from '~/agents/types'

/**
 * The one usage reading the sidebar footer shows for an agent: its tightest plan window.
 * Pure, so `tests/usageSummary.test.ts` runs it in plain Node.
 */

export type UsageTone = 'calm' | 'high' | 'full'

export interface UsageSummary {
  /** 0..100, rounded */
  percent: number
  tone: UsageTone
  /** "84% weekly", or "Limit · back in 42m" once a window is used up */
  text: string
  /** The sentence for the tooltip and screen readers. */
  long: string
}

/** The window with the highest percent; the first one wins a tie (the CLIs list the shortest first). */
export function tightest(windows: readonly UsageWindow[]): UsageWindow | null {
  let best: UsageWindow | null = null
  for (const w of windows) {
    if (typeof w.percent === 'number' && (!best || w.percent > best.percent)) best = w
  }
  return best
}

/** "42m", "2h 36m", "2d 4h": time until a reset, at the two largest units. */
export function shortIn(ms: number): string {
  const mins = Math.max(1, Math.ceil(ms / 60_000))
  if (mins < 60) return `${mins}m`
  const h = Math.floor(mins / 60)
  if (h < 24) return mins % 60 ? `${h}h ${mins % 60}m` : `${h}h`
  const d = Math.floor(h / 24)
  return h % 24 ? `${d}d ${h % 24}h` : `${d}d`
}

/** "weekly", "5-hour", "weekly · opus" */
const windowName = (w: UsageWindow) => w.label.toLowerCase()

export function summarize(windows: readonly UsageWindow[], now: number): UsageSummary | null {
  const w = tightest(windows)
  if (!w) return null
  const percent = Math.max(0, Math.min(100, Math.round(w.percent)))
  const tone: UsageTone = percent >= 100 ? 'full' : percent >= 80 ? 'high' : 'calm'
  const left = w.resetsAt !== null && w.resetsAt > now ? shortIn(w.resetsAt - now) : null
  const resets = left ? `, resets in ${left}` : ''
  if (tone === 'full') {
    return {
      percent,
      tone,
      text: left ? `Limit · back in ${left}` : 'Limit reached',
      long: `${w.label} limit reached${resets}.`,
    }
  }
  return { percent, tone, text: `${percent}% ${windowName(w)}`, long: `${percent}% of the ${windowName(w)} limit used${resets}.` }
}
