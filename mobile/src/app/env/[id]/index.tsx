import { useCallback, useMemo, useState } from 'react'
import { View } from 'react-native'
import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router'
import { Box, Ellipsis, Monitor, SquarePen } from 'lucide-react-native'
import { hasUnreadResult } from '~/types/chat'
import { space, useTheme } from '@/theme'
import { Banner, Button, EmptyState, IconButton, ListRow, ListSection, RipenessDot, Spinner, Text, dotStatus } from '@/ui'
import { envOf, syncEnv } from '@/remote/chatSync'
import { useEnvs } from '@/state/envs'
import { useNetwork } from '@/state/network'
import { useThreads } from '@/state/threads'
import { EnvActions } from '@/screens/EnvActions'
import { NewChatSheet } from '@/screens/NewChat'
import { ProjectList } from '@/screens/ProjectList'
import { ScreenScroll } from '@/screens/Screen'
import { INSTANCE_STATE, OFFLINE, connectionText, expiryText, mostUrgent, reconnectingText } from '@/screens/names'
import type { Thread } from '~/types/chat'

/**
 * One environment. A server lists its instances (running ones open to their projects); a joined
 * environment is a single instance, so its projects are right here. The "more" button holds
 * rename, check connection, this phone's key (servers) and remove.
 */
export default function EnvScreen() {
  const t = useTheme()
  const router = useRouter()
  const { id } = useLocalSearchParams<{ id: string }>()
  const env = useEnvs(st => st.envs.find(e => e.id === id) ?? null)
  const status = useEnvs(st => st.status[id])
  const offline = useNetwork(st => st.online === false)
  const instances = useEnvs(st => st.instances[id])
  const threads = useThreads(st => st.threads)
  const [menu, setMenu] = useState(false)
  const [newChat, setNewChat] = useState(false)
  const [refreshing, setRefreshing] = useState(false)

  const load = useCallback(async () => {
    const e = useEnvs.getState().byId(id)
    if (!e) return
    await useEnvs.getState().refresh(id)
    // Chats other computers wrote since: for a joined env its one instance, for a server every running one.
    const running = e.joined ? [e.joined.instance] : (useEnvs.getState().instances[id] ?? []).filter(i => i.state === 'running').map(i => i.name)
    await Promise.all(running.map(instance => syncEnv({ hostId: id, instance }).catch(() => {})))
  }, [id])

  useFocusEffect(useCallback(() => { void load() }, [load]))

  // The most urgent chat per instance, for the instance rows' dots.
  const topByInstance = useMemo(() => {
    const m = new Map<string, Thread[]>()
    for (const th of Object.values(threads)) {
      const at = envOf(th.projectPath)
      if (!at || at.hostId !== id || th.archived || th.parentId) continue
      m.set(at.instance, [...(m.get(at.instance) ?? []), th])
    }
    return new Map([...m].map(([k, list]) => [k, { top: mostUrgent(list), count: list.length }]))
  }, [threads, id])

  if (!env) {
    return (
      <ScreenScroll>
        <Stack.Screen options={{ title: '' }} />
        <EmptyState title="This environment is gone" body="It was removed from this phone." action={<Button label="Back to Home" onPress={() => router.back()} />} />
      </ScreenScroll>
    )
  }

  const refresh = async () => {
    setRefreshing(true)
    try { await load() } finally { setRefreshing(false) }
  }
  const conn = connectionText(status)

  return (
    <ScreenScroll refreshing={refreshing} onRefresh={refresh}>
      <Stack.Screen
        options={{
          title: env.name,
          headerRight: () => (
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
              <IconButton icon={SquarePen} label="New chat" onPress={() => setNewChat(true)} />
              <IconButton icon={Ellipsis} label="Environment actions" onPress={() => setMenu(true)} />
            </View>
          ),
        }}
      />

      {offline
        ? <Banner title={OFFLINE.title} message={OFFLINE.message} />
        : status?.state === 'reconnecting'
          ? <Banner message={reconnectingText([env.name])} />
          : null}
      {status?.state === 'error' && !offline
        ? <Banner tone="error" title="Can't connect" message={status.message ?? 'The environment did not answer.'} action={<Button label="Try again" size="sm" onPress={refresh} />} />
        : null}

      {env.joined
        ? (
            <>
              <ProjectList envId={env.id} instance={env.joined.instance} onRetry={refresh} />
              <ListSection title="Shared with you" footer="Chats here sync with every computer that opens this environment.">
                <ListRow title="Shared from" trailing={<Detail text={env.joined.sharedFrom || 'Not named'} />} />
                <ListRow title="Access" trailing={<Detail text={expiryText(env.joined.expiresAt)} />} />
                <ListRow title="Connection" subtitle={conn.text} subtitleTone={conn.tone} />
              </ListSection>
            </>
          )
        : !instances
            ? (status?.state === 'error' ? null : <View style={{ paddingVertical: space[8], alignItems: 'center' }}><Spinner size={18} label="Loading instances" /></View>)
            : !instances.length
                ? <EmptyState icon={Box} title="No instances on this server" body="Create one from Mango on your computer (Settings > Environments), then pull down to refresh." />
                : (
                    <ListSection title="Instances" footer={`${env.endpoint.user}@${env.endpoint.host}${env.endpoint.port === 22 ? '' : `:${env.endpoint.port}`}`}>
                      {instances.map((inst) => {
                        const st = INSTANCE_STATE[inst.state]
                        const info = topByInstance.get(inst.name)
                        const top = info?.top
                        const Icon = inst.kind === 'virtual-machine' ? Monitor : Box
                        const running = inst.state === 'running'
                        return (
                          <ListRow
                            key={inst.name}
                            title={inst.name}
                            subtitle={running && info?.count ? `${st.text} · ${info.count} chat${info.count === 1 ? '' : 's'}` : st.text}
                            subtitleTone={st.tone}
                            leading={top
                              ? <RipenessDot status={dotStatus(top)} unseen={hasUnreadResult(top) || top.status === 'waiting'} size={14} />
                              : <Icon size={20} strokeWidth={1.75} color={running ? t.colors.fgSubtle : t.colors.fgFaint} />}
                            detail={inst.kind === 'virtual-machine' ? 'VM' : undefined}
                            accessibilityHint={running ? 'Opens its projects' : 'Start it on your computer to open it'}
                            onPress={running ? () => router.push({ pathname: '/env/[id]/[instance]', params: { id: env.id, instance: inst.name } }) : undefined}
                          />
                        )
                      })}
                    </ListSection>
                  )}

      <NewChatSheet
        visible={newChat}
        envId={env.id}
        onClose={() => setNewChat(false)}
        onCreated={(chat) => { setNewChat(false); router.push({ pathname: '/chat/[id]', params: { id: chat } }) }}
      />
      <EnvActions envId={env.id} visible={menu} onClose={() => setMenu(false)} onRemoved={() => router.back()} />
    </ScreenScroll>
  )
}

function Detail({ text }: { text: string }) {
  return <Text variant="bodySm" tone="muted" numberOfLines={1} style={{ flexShrink: 1, maxWidth: 220, textAlign: 'right' }}>{text}</Text>
}
