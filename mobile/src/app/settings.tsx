import { useEffect, useState } from 'react'
import { Platform, Switch, View } from 'react-native'
import { useRouter } from 'expo-router'
import Constants from 'expo-constants'
import { Languages, LayoutGrid, Link2, Moon, Plus, QrCode, SendHorizontal, Server, ShieldCheck, Smartphone, Sun } from 'lucide-react-native'
import { space, useAppearance, useTheme, type Appearance } from '@/theme'
import { Banner, ListRow, ListSection, Segmented, Sheet, Text, haptic } from '@/ui'
import { backend } from '@/remote'
import { useEnvs } from '@/state/envs'
import { EnvActions } from '@/screens/EnvActions'
import { ScreenScroll } from '@/screens/Screen'
import { connectionText } from '@/screens/names'
import { languageLabel, useVoicePrefs, voiceEngine, VOICE_LANGUAGES } from '@/voice'

/**
 * Settings: appearance, the environments on this phone (each opens to its projects; a long press
 * holds rename, check connection and remove; joining one or adding a server starts here), voice
 * input, and what this build is.
 */
export default function SettingsScreen() {
  const t = useTheme()
  const router = useRouter()
  const { appearance, setAppearance } = useAppearance()
  const envs = useEnvs(st => st.envs)
  const status = useEnvs(st => st.status)
  const [editing, setEditing] = useState<string | null>(null)
  const version = Constants.expoConfig?.version ?? '–'

  return (
    <ScreenScroll>
      <View style={{ gap: 6 }}>
        <Text variant="captionStrong" tone="subtle" accessibilityRole="header" style={{ paddingHorizontal: space[4] }}>Appearance</Text>
        <Segmented<Appearance>
          label="Appearance"
          value={appearance}
          onChange={setAppearance}
          options={[
            { value: 'system', label: 'System', icon: Smartphone },
            { value: 'dark', label: 'Dark', icon: Moon },
            { value: 'light', label: 'Light', icon: Sun },
          ]}
        />
      </View>

      <ListSection
        title="Environments"
        footer={envs.length ? 'Long press one to rename, check or remove it. Removing deletes this phone\'s key for it; its chats stay in the environment.' : 'Share an environment in Mango on your computer and scan its code here, or add a server.'}
      >
        {envs.map((e) => {
          const c = connectionText(status[e.id])
          const Icon = e.joined ? Link2 : Server
          return (
            <ListRow
              key={e.id}
              title={e.name}
              subtitle={c.text}
              subtitleTone={c.tone}
              leading={<Icon size={20} strokeWidth={1.75} color={t.colors.fgSubtle} />}
              detail={e.joined ? 'Joined' : undefined}
              onPress={() => router.push({ pathname: '/env/[id]', params: { id: e.id } })}
              onLongPress={() => setEditing(e.id)}
            />
          )
        })}
        <ListRow
          title="Join with a share code"
          leading={<QrCode size={20} strokeWidth={1.75} color={t.colors.accentInk} />}
          accessory="none"
          onPress={() => router.push('/join')}
        />
        <ListRow
          title="Add a server"
          leading={<Plus size={20} strokeWidth={1.75} color={t.colors.accentInk} />}
          accessory="none"
          onPress={() => router.push('/add-server')}
        />
      </ListSection>

      <VoiceSection />

      <ListSection title="About">
        <ListRow title="Version" trailing={<Text variant="bodySm" tone="muted" tabular selectable>{version}</Text>} />
        <ListRow title="Connections" trailing={<Text variant="bodySm" tone="muted">{backend.real ? 'SSH' : 'Simulated'}</Text>} />
        {__DEV__
          ? <ListRow title="Component gallery" leading={<LayoutGrid size={20} strokeWidth={1.75} color={t.colors.fgSubtle} />} onPress={() => router.push('/dev/gallery')} />
          : null}
      </ListSection>

      {backend.real
        ? null
        : <Banner title="Simulated" message="This preview has no SSH connection: the environments, their git repositories and every agent reply are simulated." />}

      {editing ? <EnvActions envId={editing} visible onClose={() => setEditing(null)} /> : null}
    </ScreenScroll>
  )
}

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

/** Voice: the dictation language and "send after", as Settings > Voice on the desktop. */
function VoiceSection() {
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
    <>
      <ListSection title="Voice" footer={place.footer}>
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
    </>
  )
}
