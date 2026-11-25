import type { Thread } from '~/types/chat'

/**
 * Large Claude Code chats after a break. The prompt cache of a conversation expires a while after its last
 * request; the next message then has the whole conversation read again. Compacting before that message
 * (Mango asks when the user comes back) keeps what follows small; compacting shortly before the cache
 * expires also reads the conversation for the last time while that is cheap (only when the user chose it).
 *
 * Pure functions, shared by the line over the composer and the timer (tests/idleCompaction.test.ts).
 */

/** Settings > Behaviour. 'auto' still asks where it could not compact by itself (the computer slept). */
export type IdleCompaction = 'ask' | 'auto' | 'off'

/** Below this a conversation is cheap enough to read again: compacting would mostly lose detail. */
export const MIN_TOKENS = 200_000
const HOUR_MS = 3_600_000
/** Automatic compaction starts this long before the cache expires... */
const LEAD_MS = 6 * 60_000
/** ...and no later than this: it has to resume the session and send its request while the cache holds. */
const MARGIN_MS = 60_000

/** What a conversation's cache was made with: another model or effort does not share it. */
export const cacheOwner = (t: Pick<Thread, 'model' | 'effort'>) => `${t.model} ${t.effort ?? ''}`

/** A chat whose conversation is large and at rest: worth compacting, if the user wants that. */
function compactable(t: Thread): boolean {
  if (t.agent !== 'claude' || t.parentId || !t.sessionId || t.keepContext || !t.cache) return false
  if (t.status !== 'working' && t.status !== 'done' && t.status !== 'error') return false
  if ((t.context?.used ?? 0) < MIN_TOKENS || t.messages.at(-1)?.role !== 'agent') return false
  // Never compact a compaction, whether it worked or not: the next message comes first.
  const asked = t.messages.findLast(m => m.role === 'user')
  return !asked?.parts.some(p => p.type === 'text' && /^\/compact(\s|$)/.test(p.text.trim()))
}

/** When the conversation was last in use: its last request, or a reply another computer added since. */
const lastUsed = (t: Thread) => Math.max(t.cache?.at ?? 0, t.messages.at(-1)?.createdAt ?? 0)

/** The break to ask about before the chat's next message, null when there is nothing to ask. */
export function breakToAsk(t: Thread, setting: IdleCompaction, now: number): { since: number; tokens: number } | null {
  if (setting === 'off' || !compactable(t)) return null
  const since = lastUsed(t)
  // A cache of five minutes (an API key) is gone after every pause: only a real break is worth a question.
  return now - since >= Math.max(t.cache!.ttlMs, HOUR_MS) ? { since, tokens: t.context!.used } : null
}

/**
 * Whether the chat is to be compacted by itself now: its cache is about to expire, its last turn ended well
 * and nothing about it is open. `busy`: something the caller knows of (a draft, queued messages, its window).
 */
export function dueForCompaction(t: Thread, setting: IdleCompaction, now: number, busy: boolean): boolean {
  if (setting !== 'auto' || busy || !compactable(t) || t.archived || t.simulated || t.status !== 'working') return false
  // In an environment another device may go on with the chat.
  if (t.projectPath.startsWith('env://')) return false
  const { at, ttlMs, for: owner, tried } = t.cache!
  if (tried || ttlMs !== HOUR_MS || owner !== cacheOwner(t)) return false
  if (t.messages.at(-1)!.outcome !== 'done') return false
  const expires = at + ttlMs
  return now >= expires - LEAD_MS && now < expires - MARGIN_MS
}
