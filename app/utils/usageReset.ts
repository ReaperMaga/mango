import type { UsageWindow } from '~/agents/types'

/** A limit that started over before its scheduled time (an extra reset, not the regular rollover). */
export interface UsageReset {
  windowId: string
  label: string
  /** percent used at the read before, and at the read that noticed it */
  from: number
  to: number
  /** Unix ms when Mango noticed it (the reset itself happened some time between two reads). */
  at: number
}

/** A drop smaller than this is noise, not a reset. */
const MIN_DROP = 15
/** A window due to reset within this long is treated as the regular rollover. */
const SOON_MS = 2 * 60_000

/**
 * Compare two reads of one agent's limits. A window that fell a lot while its scheduled reset
 * was still ahead has been reset early. Inferred from the numbers: the CLIs do not announce it.
 */
export function detectEarlyResets(before: UsageWindow[] | null | undefined, after: UsageWindow[], now: number): UsageReset[] {
  if (!before?.length) return []
  const out: UsageReset[] = []
  for (const was of before) {
    const is = after.find(w => w.id === was.id)
    if (!is) continue
    const scheduledAhead = was.resetsAt !== null && was.resetsAt - now > SOON_MS
    if (scheduledAhead && was.percent - is.percent >= MIN_DROP) {
      out.push({ windowId: was.id, label: is.label, from: Math.round(was.percent), to: Math.round(is.percent), at: now })
    }
  }
  return out
}
