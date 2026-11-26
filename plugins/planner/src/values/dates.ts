/** Dates as people read and type them. */

import { addDays, localDate, localDateTime, parseDate, type DateValue } from '../model.ts'

const locale = () => document.documentElement.lang || undefined

/** A date string as a local moment. */
export function moment(date: string): Date {
  const [d, t] = date.split('T') as [string, string?]
  const [y, m, day] = d.split('-').map(Number) as [number, number, number]
  const [h, min] = (t ?? '0:0').split(':').map(Number) as [number, number]
  const out = new Date(2000, 0, 1, h, min)
  // Years before 100 are not the 1900s.
  out.setFullYear(y, m - 1, day)
  return out
}

const formats = new Map<string, Intl.DateTimeFormat>()
function format(options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${locale()}${JSON.stringify(options)}`
  let f = formats.get(key)
  if (!f) formats.set(key, (f = new Intl.DateTimeFormat(locale(), options)))
  return f
}

const DAY: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' }
const DAY_YEAR: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', year: 'numeric' }
const TIME: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }

function one(date: string, now: number, withYear: boolean): string {
  const d = moment(date)
  const year = withYear || d.getFullYear() !== new Date(now).getFullYear()
  const day = format(year ? DAY_YEAR : DAY).format(d)
  return date.includes('T') ? `${day}, ${format(TIME).format(d)}` : day
}

/** `Mar 1`, `Mar 1, 2027, 09:30`, `Mar 1 – Mar 4`. */
export function dateText(value: DateValue, now: number): string {
  if (!value.end) return one(value.start, now, false)
  const years = value.start.slice(0, 4) !== value.end.slice(0, 4)
  return `${one(value.start, now, years)} – ${one(value.end, now, years)}`
}

export const monthText = (month: string) => format({ month: 'long', year: 'numeric' }).format(moment(`${month}-01`))
export const fullDate = (date: string) => format({ weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(moment(date))

/** 0 Sunday … 6 Saturday, as this language's calendars start. */
export function firstWeekday(): number {
  try {
    const l = new Intl.Locale(locale() ?? navigator.language) as Intl.Locale & { getWeekInfo?(): { firstDay: number }; weekInfo?: { firstDay: number } }
    return ((l.getWeekInfo?.() ?? l.weekInfo)?.firstDay ?? 1) % 7
  } catch {
    return 1
  }
}

/** Short names, starting with that day. */
export function weekdayNames(first: number): string[] {
  // 2023-01-01 was a Sunday.
  return Array.from({ length: 7 }, (_, i) => format({ weekday: 'short' }).format(new Date(2023, 0, 1 + first + i)))
}

/** The month some months later: `2026-03`. */
export function addMonths(month: string, n: number): string {
  const [y, m] = month.split('-').map(Number) as [number, number]
  return new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 7)
}

/** The same day some months later, or that month's last. */
export function sameDayIn(date: string, n: number): string {
  const month = addMonths(date.slice(0, 7), n)
  const last = addDays(`${addMonths(month, 1)}-01`, -1)
  const day = `${month}-${date.slice(8, 10)}`
  return day > last ? last : day
}

/** ISO dates, and the few words people use: today, tomorrow, yesterday, now, +3, +2w. */
export function readDate(text: string, now: number): DateValue | null {
  const t = text.trim().toLowerCase()
  const today = localDate(now)
  if (t === 'now') return { start: localDateTime(now) }
  if (t === 'today') return { start: today }
  if (t === 'tomorrow') return { start: addDays(today, 1) }
  if (t === 'yesterday') return { start: addDays(today, -1) }
  const rel = /^([+-]\d{1,4})\s*(d|days?|w|weeks?)?$/.exec(t)
  if (rel) return { start: addDays(today, Number(rel[1]) * (rel[2]?.startsWith('w') ? 7 : 1)) }
  return parseDate(text.trim().replace(/^(\d{4})[./-](\d{1,2})[./-](\d{1,2})(?!\d)/, (_, y: string, m: string, d: string) => `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`).replace(/([ T])(\d:\d\d)/g, (_, a: string, b: string) => `${a}0${b}`))
}
