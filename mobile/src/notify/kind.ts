import type { Message, Thread, ThreadStatus } from '~/types/chat'
import type { NotifyKind } from '~/utils/notifications'

/**
 * Which of the three things (if any) a status change is, as the desktop's `composables/notify.ts`.
 * A sub-agent's chat never counts: its parent speaks for it.
 */
export function notifyKindOf(
  t: Pick<Thread, 'parentId'>,
  before: ThreadStatus,
  now: ThreadStatus,
  outcome: Message['outcome'] | undefined,
): NotifyKind | null {
  if (t.parentId) return null
  if (now === 'waiting') return before === 'waiting' ? null : 'needsYou'
  // Only a run that was going can finish or fail; a user's stop is neither.
  if (!(before === 'running' || before === 'queued' || before === 'waiting')) return null
  if (now === 'error' && outcome === 'error') return 'failed'
  if (outcome === 'done') return 'done'
  return null
}
