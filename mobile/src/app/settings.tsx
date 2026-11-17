import { useState } from 'react'
import { View } from 'react-native'
import { useRouter } from 'expo-router'
import Constants from 'expo-constants'
import { LayoutGrid, Link2, Moon, Plus, QrCode, Server, Smartphone, Sun } from 'lucide-react-native'
import { space, useAppearance, useTheme, type Appearance } from '@/theme'
import { Banner, ListRow, ListSection, Segmented, Text } from '@/ui'
import { backend } from '@/remote'
import { useEnvs } from '@/state/envs'
import { EnvActions } from '@/screens/EnvActions'
import { ScreenScroll } from '@/screens/Screen'
import { connectionText } from '@/screens/names'

/**
 * Settings: appearance, the environments on this phone (each opens to its projects; a long press
 * holds rename, check connection and remove; joining one or adding a server starts here), and
 * what this build is.
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
