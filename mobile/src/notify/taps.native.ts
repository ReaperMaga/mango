import { useEffect } from 'react'
import * as Notifications from 'expo-notifications'

/**
 * Opens the chat a tapped notification is about, also when the tap is what launched the app
 * (the last response is read once on mount).
 */
export function useNotificationTaps(open: (threadId: string) => void): void {
  const last = Notifications.useLastNotificationResponse()
  useEffect(() => {
    if (!last || last.actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER) return
    const id = last.notification.request.content.data?.threadId
    if (typeof id === 'string') open(id)
  }, [last, open])
}
