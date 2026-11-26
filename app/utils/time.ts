import { formatLocale, t } from '../i18n/index.ts'

/** Compact relative time for lists: "now", "4m", "3h", "2d", "12 Mar". */
export function shortAgo(ts: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ts) / 1000))
  if (s < 45) return t('common.time.now')
  const m = Math.round(s / 60)
  if (m < 60) return t('common.time.m', { n: m })
  const h = Math.round(m / 60)
  if (h < 24) return t('common.time.h', { n: h })
  const d = Math.round(h / 24)
  if (d < 7) return t('common.time.d', { n: d })
  return new Date(ts).toLocaleDateString(formatLocale(), { day: 'numeric', month: 'short' })
}

/** A ticking "now" so relative times refresh every 30s. */
export function useNow(interval = 30_000) {
  const now = ref(Date.now())
  let timer: ReturnType<typeof setInterval> | undefined
  onMounted(() => { timer = setInterval(() => (now.value = Date.now()), interval) })
  onBeforeUnmount(() => clearInterval(timer))
  return now
}

/** "8s", "1m 12s", "1h 4m": how long something took. */
export function formatDuration(ms: number): string {
  const total = Math.round(ms / 1000)
  if (total < 60) return t('common.time.s', { n: total })
  const m = Math.floor(total / 60)
  if (m < 60) return t('common.time.ms', { m, s: total % 60 })
  return t('common.time.hm', { h: Math.floor(m / 60), m: m % 60 })
}

/** Whether two moments fall on the same calendar day here. */
export function sameDay(a: number, b: number): boolean {
  const x = new Date(a)
  const y = new Date(b)
  return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate()
}

/** "Today", "Yesterday", "Mon 3 Mar", "3 Mar 2025": the mark between a chat's days. */
export function dayLabel(ts: number, now = Date.now()): string {
  if (sameDay(ts, now)) return t('common.time.today')
  if (sameDay(ts, now - 86_400_000)) return t('common.time.yesterdayLabel')
  const d = new Date(ts)
  const thisYear = d.getFullYear() === new Date(now).getFullYear()
  return d.toLocaleDateString(formatLocale(), thisYear
    ? { weekday: 'short', day: 'numeric', month: 'short' }
    : { day: 'numeric', month: 'short', year: 'numeric' })
}

/** "just now", "5 min ago", "3 h ago", "yesterday", "4 days ago", then a date: for columns with room for words. */
export function longAgo(ts: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ts) / 1000))
  if (s < 45) return t('common.time.justNow')
  const m = Math.round(s / 60)
  if (m < 60) return t('common.time.minAgo', { n: m })
  const h = Math.round(m / 60)
  if (h < 24) return t('common.time.hAgo', { n: h })
  const d = Math.round(h / 24)
  if (d === 1) return t('common.time.yesterday')
  if (d < 7) return t('common.time.daysAgo', d)
  const date = new Date(ts)
  const thisYear = date.getFullYear() === new Date(now).getFullYear()
  return date.toLocaleDateString(formatLocale(), thisYear ? { day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short', year: 'numeric' })
}

/** A full date and time, for tooltips and facts. */
export const fullDateTime = (ts: number) => new Date(ts).toLocaleString(formatLocale(), { dateStyle: 'medium', timeStyle: 'short' })
