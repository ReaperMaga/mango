/** How full a usage window is: the gauge turns warm at 80% and red when it is used up. */
export type UsageLevel = 'ok' | 'high' | 'full'
export const usageLevel = (percent: number): UsageLevel => (percent >= 100 ? 'full' : percent >= 80 ? 'high' : 'ok')

const clock = (t: number) => new Date(t).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })

/** "Resets in 2 h 36 min", "Resets Wed 21:00", "Resets 16 Dec" (the desktop's `UsageList.vue`). */
export function resetText(at: number | null, now = Date.now()): string {
  if (at === null) return ''
  const mins = Math.ceil((at - now) / 60_000)
  if (mins <= 0) return 'Resetting now'
  if (mins < 60) return `Resets in ${mins} min`
  if (mins < 24 * 60) return `Resets in ${Math.floor(mins / 60)} h ${mins % 60} min`
  if (mins < 6 * 24 * 60) return `Resets ${new Date(at).toLocaleDateString(undefined, { weekday: 'short' })} ${clock(at)}`
  return `Resets ${new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

/** "you@example.com · Max · claude.ai": what the CLI says about the account, in the order a person looks for it. */
export function accountLine(a: { account: string | null; organization: string | null; plan: string | null; method: string | null }): string {
  return [a.account, a.organization, a.plan ? cap(a.plan) : null, a.method].filter(Boolean).join(' · ')
}
