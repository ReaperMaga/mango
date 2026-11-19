import { useEffect, useState } from 'react'
import { Platform, Switch } from 'react-native'
import { Languages, SendHorizontal, ShieldCheck } from 'lucide-react-native'
import { useTheme } from '@/theme'
import { ListRow, ListSection, Sheet, Text, haptic } from '@/ui'
import { languageLabel, useVoicePrefs, voiceEngine, VOICE_LANGUAGES } from '@/voice'
import { SettingsPage } from '@/screens/settings/SettingsPage'

const DEVICE = Platform.OS === 'web' ? 'this browser' : 'this iPhone'

/** Where speech becomes text, as the Voice section names it. */
function recognitionPlace(): { label: string; footer: string } {
  switch (voiceEngine.kind) {
    case 'device':
      return voiceEngine.onDevice()
        ? { label: 'On this iPhone', footer: 'Tap the microphone in a message to dictate it. iOS turns your speech into text on this iPhone, so recordings stay on it. A language it cannot recognize offline goes to Apple\'s servers instead.' }
        : { label: 'Apple\'s servers', footer: 'Tap the microphone in a message to dictate it. This iPhone cannot recognize speech offline, so iOS sends recordings to Apple to turn them into text.' }
    case 'browser':
      return { label: 'This browser', footer: 'Tap the microphone in a message to dictate it. In the web preview your browser recognizes speech, which may send recordings to its maker. On an iPhone speech stays on the device.' }
    case 'simulated':
      return { label: 'Simulated', footer: 'This browser has no speech recognition, so the preview simulates dictation. On an iPhone, iOS recognizes speech on the device.' }
    case 'none':
      return { label: 'Not in this build', footer: 'This build of Mango has no speech recognition. Install the latest build to dictate messages.' }
  }
}

/** Settings > Voice: the dictation language and "send after", as Settings > Voice on the desktop. */
export default function VoiceSettings() {
  const t = useTheme()
  const language = useVoicePrefs(st => st.language)
  const sendAfter = useVoicePrefs(st => st.sendAfter)
  const [picking, setPicking] = useState(false)
  useEffect(() => { void useVoicePrefs.getState().load() }, [])
  const place = recognitionPlace()
  const pick = (code: string | null) => {
    haptic('select')
    useVoicePrefs.getState().setLanguage(code)
    setPicking(false)
  }
  return (
    <SettingsPage id="voice">
      <ListSection footer={place.footer}>
        <ListRow
          title="Language"
          leading={<Languages size={20} strokeWidth={1.75} color={t.colors.fgSubtle} />}
          detail={languageLabel(language)}
          onPress={() => setPicking(true)}
        />
        <ListRow
          title="Send after dictation"
          subtitle="Send as soon as you stop speaking"
          leading={<SendHorizontal size={20} strokeWidth={1.75} color={t.colors.fgSubtle} />}
          trailing={(
            <Switch
              value={sendAfter}
              onValueChange={(on) => { haptic('select'); useVoicePrefs.getState().setSendAfter(on) }}
              trackColor={{ false: t.colors.lineStrong, true: t.colors.accent }}
              ios_backgroundColor={t.colors.lineStrong}
              accessibilityLabel="Send after dictation"
            />
          )}
        />
        <ListRow
          title="Recognition"
          leading={<ShieldCheck size={20} strokeWidth={1.75} color={t.colors.fgSubtle} />}
          trailing={<Text variant="bodySm" tone="muted">{place.label}</Text>}
        />
      </ListSection>
      <Sheet visible={picking} onClose={() => setPicking(false)} title="Language">
        <ListSection footer="The language you dictate in. iOS recognizes one at a time.">
          {[null, ...VOICE_LANGUAGES.map(l => l.code)].map(code => (
            <ListRow
              key={code ?? 'device'}
              title={languageLabel(code)}
              subtitle={code === null ? `Follows ${DEVICE}'s language` : undefined}
              accessory={code === language ? 'check' : 'none'}
              onPress={() => pick(code)}
            />
          ))}
        </ListSection>
      </Sheet>
    </SettingsPage>
  )
}
