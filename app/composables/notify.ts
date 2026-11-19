import { call } from '~/composables/useBackend'
import { useWorkspace } from '~/stores/workspace'
import { useThreads } from '~/stores/threads'
import type { Message, Thread, ThreadStatus } from '~/types/chat'
import { notificationFor, type NotifyKind } from '~/utils/notifications'

/** Which of the three things (if any) a status change is. A sub-agent's chat never counts: its parent speaks for it. */
export function kindOf(t: Thread, before: ThreadStatus, now: ThreadStatus, outcome: Message['outcome'] | undefined): NotifyKind | null {
  if (t.parentId) return null
  if (now === 'waiting') return before === 'waiting' ? null : 'needsYou'
  // Only a run that was going can finish or fail; a user's stop is neither.
  if (!(before === 'running' || before === 'queued' || before === 'waiting')) return null
  if (now === 'error' && outcome === 'error') return 'failed'
  if (outcome === 'done') return 'done'
  return null
}

/**
 * Called by the threads store whenever a chat's status is set. Shows a desktop notification when it
 * is one of the moments Settings > Notifications asks for. Never throws: a notification that
 * cannot be shown must not break the chat.
 */
export function notifyChange(t: Thread, before: ThreadStatus, outcome: Message['outcome'] | undefined) {
  const kind = kindOf(t, before, t.status, outcome)
  if (!kind) return
  const ws = useWorkspace()
  if (!ws.notify.enabled) return
  const threads = useThreads()
  // The next message in the queue starts at once: that is not a pause worth a ping.
  if (kind === 'done' && (threads.queue[t.id]?.length ?? 0) > 0) return
  const n = notificationFor(kind, t, ws.notify, {
    windowFocused: document.hasFocus() && document.visibilityState === 'visible',
    chatVisible: threads.panes.some(p => p.threadId === t.id),
  })
  if (!n) return
  call('notify', { ...n, sound: ws.notify.sound }).catch(() => { /* the system declined it: the chat goes on */ })
}

/** The Test button in Settings: shows a notification regardless of the toggles, and says why it failed. */
export async function sendTestNotification(sound: boolean) {
  await call('notify', { title: 'Mango', body: 'Notifications work. This is how a finished chat looks.', sound })
}

