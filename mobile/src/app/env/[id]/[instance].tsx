import { useCallback, useState } from 'react'
import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router'
import { SquarePen } from 'lucide-react-native'
import { IconButton } from '@/ui'
import { syncEnv } from '@/remote/chatSync'
import { useEnvs } from '@/state/envs'
import { NewChatSheet } from '@/screens/NewChat'
import { ProjectList } from '@/screens/ProjectList'
import { ScreenScroll } from '@/screens/Screen'

/** One running instance of a server: its projects, with their chats pulled in as it opens. */
export default function InstanceScreen() {
  const { id, instance } = useLocalSearchParams<{ id: string; instance: string }>()
  const envName = useEnvs(st => st.envs.find(e => e.id === id)?.name ?? '')
  const router = useRouter()
  const [refreshing, setRefreshing] = useState(false)
  const [newChat, setNewChat] = useState(false)

  const load = useCallback(async () => {
    if (!useEnvs.getState().byId(id)) return
    await Promise.all([
      useEnvs.getState().refreshProjects(id, instance).catch(() => {}),
      syncEnv({ hostId: id, instance }).catch(() => {}),
    ])
  }, [id, instance])

  useFocusEffect(useCallback(() => { void load() }, [load]))

  const refresh = async () => {
    setRefreshing(true)
    try { await load() } finally { setRefreshing(false) }
  }

  return (
    <ScreenScroll refreshing={refreshing} onRefresh={refresh}>
      <Stack.Screen
        options={{
          title: instance,
          headerBackTitle: envName,
          headerRight: () => <IconButton icon={SquarePen} label="New chat" onPress={() => setNewChat(true)} />,
        }}
      />
      <ProjectList envId={id} instance={instance} onRetry={refresh} />
      <NewChatSheet
        visible={newChat}
        envId={id}
        instance={instance}
        onClose={() => setNewChat(false)}
        onCreated={(chat) => { setNewChat(false); router.push({ pathname: '/chat/[id]', params: { id: chat } }) }}
      />
    </ScreenScroll>
  )
}
