import { useState } from 'react'
import { useRouter } from 'expo-router'
import { Link2, Plus, QrCode, Server } from 'lucide-react-native'
import { useTheme } from '@/theme'
import { ListRow, ListSection } from '@/ui'
import { useEnvs } from '@/state/envs'
import { EnvActions } from '@/screens/EnvActions'
import { connectionText } from '@/screens/names'
import { SettingsPage } from '@/screens/settings/SettingsPage'

/**
 * Settings > Environments: the environments on this phone (each opens to its projects; a long press
 * holds rename, check connection and remove). Joining one or adding a server starts here.
 */
export default function EnvironmentsSettings() {
  const t = useTheme()
  const router = useRouter()
  const envs = useEnvs(st => st.envs)
  const status = useEnvs(st => st.status)
  const [editing, setEditing] = useState<string | null>(null)
  return (
    <SettingsPage id="environments">
      <ListSection
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
      {editing ? <EnvActions envId={editing} visible onClose={() => setEditing(null)} /> : null}
    </SettingsPage>
  )
}
