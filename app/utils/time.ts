/** Compact relative time for lists: "now", "4m", "3h", "2d", "12 Mar". */
export function shortAgo(ts: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ts) / 1000))
  if (s < 45) return 'now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h`
  const d = Math.round(h / 24)
  if (d < 7) return `${d}d`
  return new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}

/** A ticking "now" so relative times refresh every 30s. */
export function useNow(interval = 30_000) {
  const now = ref(Date.now())
  let t: ReturnType<typeof setInterval> | undefined
  onMounted(() => { t = setInterval(() => (now.value = Date.now()), interval) })
  onBeforeUnmount(() => clearInterval(t))
  return now
}

/** "8s", "1m 12s", "1h 4m": how long something took. */
export function formatDuration(ms: number): string {
  const total = Math.round(ms / 1000)
  if (total < 60) return `${total}s`
  const m = Math.floor(total / 60)
  if (m < 60) return `${m}m ${total % 60}s`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}
