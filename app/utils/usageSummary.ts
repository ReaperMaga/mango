import type { UsageWindow } from '~/agents/types'
import { t } from '../i18n/index.ts'

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
  if (mins < 60) return t('common.time.m', { n: mins })
  const h = Math.floor(mins / 60)
  if (h < 24) return mins % 60 ? t('common.time.hm', { h, m: mins % 60 }) : t('common.time.h', { n: h })
  const d = Math.floor(h / 24)
  return h % 24 ? t('shell.usage.dh', { d, h: h % 24 }) : t('common.time.d', { n: d })
}

/** A window's name: "Weekly", "5-hour", "Weekly · Opus"; `inline` within a sentence: "weekly", "weekly · opus". */
export function limitLabel(w: Pick<UsageWindow, 'id' | 'label'>, inline = false): string {
  if (w.id === 'five-hour') return t('shell.usage.fiveHour')
  if (w.id === 'weekly') return inline ? t('shell.usage.weeklyInline') : t('shell.usage.weekly')
  if (w.id.startsWith('weekly:')) {
    const model = w.label.split(' · ')[1] ?? w.id.slice('weekly:'.length)
    return inline ? t('shell.usage.weeklyModelInline', { model: model.toLowerCase() }) : t('shell.usage.weeklyModel', { model })
  }
  const mins = Number(/^window:(\d+)$/.exec(w.id)?.[1])
  if (mins) return mins % 1440 === 0 ? t('shell.usage.days', mins / 1440) : mins % 60 === 0 ? t('shell.usage.hours', mins / 60) : t('shell.usage.minutes', mins)
  return inline ? w.label.toLowerCase() : w.label
}

export function summarize(windows: readonly UsageWindow[], now: number): UsageSummary | null {
  const w = tightest(windows)
  if (!w) return null
  const percent = Math.max(0, Math.min(100, Math.round(w.percent)))
  const tone: UsageTone = percent >= 100 ? 'full' : percent >= 80 ? 'high' : 'calm'
  const left = w.resetsAt !== null && w.resetsAt > now ? shortIn(w.resetsAt - now) : null
  if (tone === 'full') {
    return {
      percent,
      tone,
      text: left ? t('shell.usage.backIn', { left }) : t('shell.usage.reached'),
      long: left ? t('shell.usage.windowReachedResets', { window: limitLabel(w), left }) : t('shell.usage.windowReached', { window: limitLabel(w) }),
    }
  }
  const window = limitLabel(w, true)
  return {
    percent,
    tone,
    text: t('shell.usage.short', { percent, window }),
    long: left ? t('shell.usage.usedResets', { percent, window, left }) : t('shell.usage.used', { percent, window }),
  }
}
