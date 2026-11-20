import { useCallback, useState } from 'react'
import { Linking } from 'react-native'
import { useFocusEffect } from 'expo-router'
import { Bell, CircleAlert, CircleCheck, Eye, Hand, Send, Volume2 } from 'lucide-react-native'
import { useTheme } from '@/theme'
import { Banner, Button, ListRow, ListSection, ToggleRow, haptic } from '@/ui'
import { sendTestNotification, systemNotifier, type NotifyPermission } from '@/notify'
import { usePrefs } from '@/state/prefs'
import { SettingsPage } from '@/screens/settings/SettingsPage'

/**
 * Notifications: hear about a chat while you are in another app. The same three moments and
 * wording as the desktop (a chat needs you, finishes, fails). iOS asks once; its answer is final
 * until it is changed in iOS Settings.
 */
export default function NotificationsScreen() {
  const t = useTheme()
  const notify = usePrefs(s => s.notify)
  const [permission, setPermission] = useState<NotifyPermission>('undetermined')
  const [tested, setTested] = useState<'sent' | string | null>(null)
  const system = systemNotifier.kind === 'system'
  const icon = { size: 20, strokeWidth: 1.75, color: t.colors.fgSubtle }

  // The answer can change in iOS Settings while Mango is away: look again when this screen is shown.
  useFocusEffect(useCallback(() => { void systemNotifier.permission().then(setPermission) }, []))

  const toggle = async (on: boolean) => {
    if (on && system) {
      const answer = permission === 'denied' ? 'denied' : await systemNotifier.request()
      setPermission(answer)
      // Refused: stay off, and the banner says where to change it.
      if (answer !== 'granted') return
    }
    usePrefs.getState().setNotify('enabled', on)
  }

  const test = async () => {
    setTested(null)
    try {
      await sendTestNotification(notify.sound)
      haptic('success')
      setTested('sent')
    } catch (e) {
      setTested(e instanceof Error ? e.message : String(e))
    }
  }

  const blocked = system && permission === 'denied'
  const on = notify.enabled && !blocked

  return (
    <SettingsPage id="notifications">
      {blocked
        ? (
            <Banner
              tone="error"
              title="Notifications are off for Mango"
              message="iOS is not letting Mango show them. Allow them in Settings > Notifications > Mango."
              action={<Button label="Open Settings" size="sm" onPress={() => { void Linking.openSettings() }} />}
            />
          )
        : null}

      <ListSection footer="Mango can tell you only while iOS keeps it awake after you leave. Your agents keep working in their environment either way, and the chats are up to date when you come back.">
        <ToggleRow
          title="Notifications"
          subtitle="When a chat needs you, finishes or fails"
          leading={<Bell {...icon} />}
          value={on}
          onChange={v => { void toggle(v) }}
        />
      </ListSection>

      <ListSection title="Tell me when">
        <ToggleRow
          title="A chat needs you"
          subtitle="An approval is waiting; the agent stays stopped"
          leading={<Hand {...icon} />}
          disabled={!on}
          value={notify.needsYou}
          onChange={v => usePrefs.getState().setNotify('needsYou', v)}
        />
        <ToggleRow
          title="A chat finishes"
          subtitle="The agent ended its turn and has a reply"
          leading={<CircleCheck {...icon} />}
          disabled={!on}
          value={notify.done}
          onChange={v => usePrefs.getState().setNotify('done', v)}
        />
        <ToggleRow
          title="A chat fails"
          subtitle="The run stopped on an error"
          leading={<CircleAlert {...icon} />}
          disabled={!on}
          value={notify.failed}
          onChange={v => usePrefs.getState().setNotify('failed', v)}
        />
      </ListSection>

      <ListSection title="Each notification" footer="Without the chat and reply, a notification only says that something happened, so nothing from your work shows on a locked screen.">
        <ToggleRow
          title="Show the chat and its reply"
          leading={<Eye {...icon} />}
          disabled={!on}
          value={notify.preview}
          onChange={v => usePrefs.getState().setNotify('preview', v)}
        />
        <ToggleRow
          title="Play a sound"
          leading={<Volume2 {...icon} />}
          disabled={!on}
          value={notify.sound}
          onChange={v => usePrefs.getState().setNotify('sound', v)}
        />
      </ListSection>

      <ListSection
        footer={tested === 'sent'
          ? 'Sent. If nothing showed, check that Mango may show notifications in iOS Settings.'
          : tested
            ? tested
            : system ? 'Shows a notification now, whatever is switched on above.' : 'The web preview cannot show an iPhone\'s notifications.'}
      >
        <ListRow
          title="Send a test notification"
          leading={<Send size={20} strokeWidth={1.75} color={system && on ? t.colors.accentInk : t.colors.fgFaint} />}
          accessory="none"
          disabled={!system || !on}
          onPress={() => { void test() }}
        />
      </ListSection>

      {system ? null : <Banner title="Simulated" message="This preview has no notifications. The switches are saved, but nothing is shown." />}
    </SettingsPage>
  )
}
