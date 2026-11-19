import { displayStatus, hasUnreadResult, type Thread } from '~/types/chat'
import { parseEnvPath } from '~/utils/envPath'
import { baseName } from '~/utils/paths'
import type { Env, InstanceState } from '@/remote/types'
import type { EnvStatus } from '@/state/envs'

/**
 * Small words and orderings the screens share. Project paths are `env://<envId>/<instance>/<dir>`
 * strings: read them with `parseEnvPath`, never by splitting on slashes.
 */

/** A project's display name: its folder's name. */
export function projectName(path: string): string {
  const loc = parseEnvPath(path)
  return loc ? baseName(loc.dir) || loc.instance : baseName(path)
}

/** Where a project lives, for a subtitle: "dev on forge", or the joined env's name. */
export function placeOf(path: string, env: Env | null): string {
  const loc = parseEnvPath(path)
  if (!loc) return ''
  if (!env) return loc.instance
  return env.joined ? env.name : `${loc.instance} on ${env.name}`
}

/**
 * How much a chat asks for attention, highest first: needs you, failed, running, an unseen result,
 * then the rest. A project row shows the dot of its most urgent chat.
 */
export function urgency(t: Thread): number {
  if (t.archived) return 0
  if (t.status === 'waiting') return 6
  if (t.status === 'error') return 5
  if (t.status === 'running' || t.status === 'queued') return 4
  if (hasUnreadResult(t)) return 3
  return displayStatus(t) === 'working' ? 2 : 1
}

export function mostUrgent(threads: readonly Thread[]): Thread | null {
  let best: Thread | null = null
  for (const t of threads) if (!best || urgency(t) > urgency(best)) best = t
  return best
}

/** A connection status in words, and the tone to write it in. */
export function connectionText(s: EnvStatus | undefined): { text: string; tone: 'subtle' | 'faint' | 'error' | 'queued' } {
  switch (s?.state) {
    case 'ok': return { text: 'Connected', tone: 'queued' }
    case 'checking': return { text: 'Connecting…', tone: 'subtle' }
    case 'reconnecting': return { text: 'Reconnecting…', tone: 'subtle' }
    case 'error': return { text: s.message ? `Can't connect: ${s.message}` : "Can't connect", tone: 'error' }
    default: return { text: 'Not checked yet', tone: 'faint' }
  }
}

export const INSTANCE_STATE: Record<InstanceState, { text: string; tone: 'queued' | 'subtle' | 'faint' | 'error' }> = {
  running: { text: 'Running', tone: 'queued' },
  starting: { text: 'Starting…', tone: 'subtle' },
  stopping: { text: 'Stopping…', tone: 'subtle' },
  stopped: { text: 'Stopped', tone: 'faint' },
  frozen: { text: 'Paused', tone: 'faint' },
  error: { text: 'Error', tone: 'error' },
  unknown: { text: 'Unknown state', tone: 'faint' },
}

/** "5 chats", "1 chat", "No chats". */
export const chatCount = (n: number) => (n === 0 ? 'No chats' : n === 1 ? '1 chat' : `${n} chats`)

/** When a joined env's access ends, in words. */
export function expiryText(at: number | null, now = Date.now()): string {
  if (at === null) return 'No end date'
  const when = new Date(at).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
  return at <= now ? `Ended ${when}` : `Until ${when}`
}

export const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** The banner while the phone has no network: calm, it is not the environment's fault. */
export const OFFLINE = {
  title: 'No internet connection',
  message: 'Agents keep working in their environments. Mango reconnects and catches up when this phone is back online.',
}

/** "Reconnecting to Lab…", "Reconnecting to Lab and dev…", "Reconnecting to 3 environments…". */
export function reconnectingText(names: string[]): string {
  if (names.length <= 2) return `Reconnecting to ${names.join(' and ')}…`
  return `Reconnecting to ${names.length} environments…`
}
