import { Platform } from 'react-native'
import * as Haptics from 'expo-haptics'

/**
 * The few moments that get a tap in the hand: sending, stopping, allowing, denying, picking.
 * Fire and forget; silent where the device (or the web preview) has none.
 */
export type HapticKind = 'select' | 'light' | 'medium' | 'success' | 'warning'

export function haptic(kind: HapticKind) {
  if (Platform.OS === 'web') return
  const done = (p: Promise<void>) => { p.catch(() => {}) }
  switch (kind) {
    case 'select': return done(Haptics.selectionAsync())
    case 'light': return done(Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light))
    case 'medium': return done(Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium))
    case 'success': return done(Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success))
    case 'warning': return done(Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning))
  }
}
