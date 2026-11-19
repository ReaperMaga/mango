import { useRouter } from 'expo-router'
import Constants from 'expo-constants'
import { LayoutGrid } from 'lucide-react-native'
import { useTheme } from '@/theme'
import { Banner, ListRow, ListSection, Text } from '@/ui'
import { backend } from '@/remote'
import { SettingsPage } from '@/screens/settings/SettingsPage'

/** Settings > About: what this build is. */
export default function AboutSettings() {
  const t = useTheme()
  const router = useRouter()
  const version = Constants.expoConfig?.version ?? '–'
  return (
    <SettingsPage id="about">
      <ListSection>
        <ListRow title="Version" trailing={<Text variant="bodySm" tone="muted" tabular selectable>{version}</Text>} />
        <ListRow title="Connections" trailing={<Text variant="bodySm" tone="muted">{backend.real ? 'SSH' : 'Simulated'}</Text>} />
        {__DEV__
          ? <ListRow title="Component gallery" leading={<LayoutGrid size={20} strokeWidth={1.75} color={t.colors.fgSubtle} />} onPress={() => router.push('/dev/gallery')} />
          : null}
      </ListSection>

      {backend.real
        ? null
        : <Banner title="Simulated" message="This preview has no SSH connection: the environments, their git repositories and every agent reply are simulated." />}
    </SettingsPage>
  )
}
