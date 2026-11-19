import { useState } from 'react'
import { View } from 'react-native'
import { Stack, useRouter } from 'expo-router'
import { useShallow } from 'zustand/react/shallow'
import { ClipboardPaste, MessagesSquare, Plus, QrCode, Server, Settings, SquarePen } from 'lucide-react-native'
import { makeStyles, space } from '@/theme'
import { Badge, Banner, Button, EmptyState, IconButton, ListSection, MangoMark, Spinner } from '@/ui'
import { ThreadRow, useNow } from '@/chat'
import { backend } from '@/remote'
import { envOf } from '@/remote/chatSync'
import { useEnvs } from '@/state/envs'
import { useNetwork } from '@/state/network'
import { useThreads } from '@/state/threads'
import { NewChatSheet } from '@/screens/NewChat'
import { ScreenScroll } from '@/screens/Screen'
import { refreshAll } from '@/screens/lifecycle'
import { OFFLINE, projectName, reconnectingText } from '@/screens/names'


/**
 * Home: chats. What needs the person first (waiting on an approval or an answer, in every
 * environment), then the latest ones, and New chat in the header. The environments themselves are
 * in Settings; an unreachable one still shows here, as a banner. With nothing saved yet it teaches
 * the way in: scan the share code Mango shows on the computer, or paste its link.
 */
export default function Home() {
  const s = useStyles()
  const router = useRouter()
  const now = useNow()
  const loaded = useEnvs(st => st.loaded)
  const envs = useEnvs(st => st.envs)
  const status = useEnvs(st => st.status)
  const [refreshing, setRefreshing] = useState(false)
  const [newChat, setNewChat] = useState(false)

  // Chats of saved environments only: top-level and not put away, latest first.
  const all = useThreads(useShallow(st => Object.values(st.threads).filter(th => !th.archived && !th.parentId)))
  const ids = new Set(envs.map(e => e.id))
  const chats = all.filter(th => ids.has(envOf(th.projectPath)?.hostId ?? '')).sort((a, b) => b.updatedAt - a.updatedAt)
  const waiting = chats.filter(th => th.status === 'waiting')
  const offline = useNetwork(st => st.online === false)
  // Offline, every environment is out of reach: one banner says why, not one per environment.
  const broken = offline ? [] : envs.filter(e => status[e.id]?.state === 'error')
  const reconnecting = offline ? [] : envs.filter(e => status[e.id]?.state === 'reconnecting')
  const recent = chats.filter(th => th.status !== 'waiting')

  const refresh = async () => {
    setRefreshing(true)
    try { await refreshAll() } finally { setRefreshing(false) }
  }

  const open = (id: string) => router.push({ pathname: '/chat/[id]', params: { id } })

  const header = (
    <Stack.Screen
      options={{
        headerRight: () => (
          <View style={s.headerButtons}>
            {envs.length ? <IconButton icon={SquarePen} label="New chat" onPress={() => setNewChat(true)} /> : null}
            <IconButton icon={Settings} label="Settings" onPress={() => router.push('/settings')} />
          </View>
        ),
      }}
    />
  )

  if (!loaded) {
    return <View style={s.center}>{header}<Spinner size={18} label="Loading" /></View>
  }

  if (!envs.length) {
    return (
      <ScreenScroll>
        {header}
        <EmptyState
          mark={<MangoMark size={44} />}
          title="Open an environment"
          body="In Mango on your computer, share an environment and scan its code here, or paste the link it gives you. Chats then sync both ways."
          style={s.empty}
          action={(
            <View style={s.actions}>
              <Button label="Scan share code" variant="primary" icon={QrCode} block onPress={() => router.push({ pathname: '/join', params: { scan: '1' } })} />
              <Button label="Paste link" icon={ClipboardPaste} block onPress={() => router.push('/join')} />
              <Button label="Add a server" variant="ghost" icon={Server} block onPress={() => router.push('/add-server')} />
            </View>
          )}
        />
      </ScreenScroll>
    )
  }

  return (
    <ScreenScroll refreshing={refreshing} onRefresh={refresh}>
      {header}
      {waiting.length
        ? (
            <ListSection title="Needs you" aside={<Badge label={String(waiting.length)} tone="waiting" />}>
              {waiting.map(th => <ThreadRow key={th.id} thread={th} projectName={projectName(th.projectPath)} now={now} onPress={() => open(th.id)} />)}
            </ListSection>
          )
        : null}

      {offline ? <Banner title={OFFLINE.title} message={OFFLINE.message} /> : null}
      {reconnecting.length ? <Banner message={reconnectingText(reconnecting.map(e => e.name))} /> : null}

      {broken.length
        ? (
            <Banner
              tone="error"
              title={broken.length === 1 ? `Can't reach ${broken[0]!.name}` : `Can't reach ${broken.length} environments`}
              message={broken.length === 1 ? (status[broken[0]!.id]?.message ?? 'It did not answer.') : broken.map(e => e.name).join(', ')}
              action={<Button label="Settings" size="sm" onPress={() => router.push('/settings')} />}
            />
          )
        : null}

      {recent.length
        ? (
            <ListSection title="Chats" aside={backend.real ? undefined : <Badge label="Simulated" dashed />}>
              {recent.map(th => <ThreadRow key={th.id} thread={th} projectName={projectName(th.projectPath)} now={now} onPress={() => open(th.id)} />)}
            </ListSection>
          )
        : null}

      {!waiting.length && !recent.length
        ? (
            <EmptyState
              icon={MessagesSquare}
              title="No chats yet"
              body="Start one in any project of your environments. Chats started on your computer show up here too."
              action={<Button label="New chat" variant="primary" icon={Plus} onPress={() => setNewChat(true)} />}
            />
          )
        : null}

      <NewChatSheet visible={newChat} onClose={() => setNewChat(false)} onCreated={(id) => { setNewChat(false); open(id) }} />
    </ScreenScroll>
  )
}

const useStyles = makeStyles(t => ({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: t.colors.bgCanvas },
  empty: { paddingTop: space[12] },
  actions: { alignSelf: 'stretch', width: 280, gap: space[2] },
  headerButtons: { flexDirection: 'row', alignItems: 'center' },
}))
