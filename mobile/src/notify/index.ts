import { AppState } from 'react-native'
import type { Message, Thread, ThreadStatus } from '~/types/chat'
import { notificationFor } from '~/utils/notifications'
import { usePrefs } from '@/state/prefs'
import { notifyKindOf } from './kind'
import { systemNotifier } from './system'

export { systemNotifier } from './system'
export type { NotifyPermission } from './types'

/**
 * Called by the chat store whenever a chat's status is set (`threads._setStatus`): shows a
 * notification when it is one of the moments Settings > Notifications asks for. It uses the
 * desktop's wording (`~/utils/notifications`). A notification that cannot be shown must not
 * break the chat, so a refused one is dropped.
 *
 * iOS suspends Mango soon after it leaves the screen, and a chat's status only changes here while
 * the app is awake: the agent keeps working in its environment, but a phone that is asleep hears
 * about it when it wakes (and `catchUp` pulls the chat).
 */
export function notifyChange(
  t: Thread,
  before: ThreadStatus,
  outcome: Message['outcome'] | undefined,
  ctx: { viewing: string | null; queued: number },
) {
  const kind = notifyKindOf(t, before, t.status, outcome)
  if (!kind) return
  const { notify } = usePrefs.getState()
  if (!notify.enabled || systemNotifier.kind === 'none') return
  // The next message in the queue starts at once: that is not a pause worth a ping.
  if (kind === 'done' && ctx.queued > 0) return
  const n = notificationFor(kind, t, notify, {
    windowFocused: AppState.currentState === 'active',
    chatVisible: ctx.viewing === t.id,
  })
  if (!n) return
  systemNotifier.show({ ...n, sound: notify.sound, threadId: t.id }).catch(() => { /* the system declined it */ })
}

/** The Try it button: a notification now, whatever the switches say. */
export function sendTestNotification(sound: boolean): Promise<void> {
  return systemNotifier.show({ title: 'Mango', body: 'Notifications work. This is how a finished chat looks.', sound })
}
