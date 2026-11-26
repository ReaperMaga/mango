import * as Notifications from 'expo-notifications'
import type { NotifyPermission, SystemNotifier } from './types'

// A notification only reaches the handler while Mango is in front: `notify()` already decided that
// is wanted (the Try it button), so show it, with the sound it asked for.
Notifications.setNotificationHandler({
  handleNotification: async n => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: !!n.request.content.sound,
    shouldSetBadge: false,
  }),
})

const asPermission = (p: Notifications.NotificationPermissionsStatus): NotifyPermission =>
  p.granted || p.ios?.status === Notifications.IosAuthorizationStatus.PROVISIONAL
    ? 'granted'
    : p.canAskAgain ? 'undetermined' : 'denied'

export const systemNotifier: SystemNotifier = {
  kind: 'system',
  permission: () => Notifications.getPermissionsAsync().then(asPermission),
  async request() {
    const p = await Notifications.requestPermissionsAsync({ ios: { allowAlert: true, allowSound: true } })
    return p.granted ? 'granted' : 'denied'
  },
  async show(n) {
    await Notifications.scheduleNotificationAsync({
      content: { title: n.title, body: n.body, sound: n.sound, data: n.threadId ? { threadId: n.threadId } : {} },
      trigger: null,
    })
  },
}
