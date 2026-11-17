import { useCallback, useEffect, useState } from 'react'
import { View } from 'react-native'
import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router'
import { useShallow } from 'zustand/react/shallow'
import { ChevronDown, ChevronRight, GitBranch, MessagesSquare, Plus, SquarePen } from 'lucide-react-native'
import { makeStyles, space, useTheme } from '@/theme'
import { Button, EmptyState, IconButton, ListRow, ListSection, Text } from '@/ui'
import { ThreadRow, useNow } from '@/chat'
import { backend } from '@/remote'
import { envOf, syncEnv } from '@/remote/chatSync'
import type { GitState } from '@/remote/types'
import { onFilesChanged } from '@/agents/run'
import { useEnvs } from '@/state/envs'
import { useThreads } from '@/state/threads'
import { NewChatSheet } from '@/screens/NewChat'
import { ScreenScroll } from '@/screens/Screen'
import { ThreadActions } from '@/screens/ThreadActions'
import { messageOf, placeOf, projectName } from '@/screens/names'

/**
 * A project: its chats in the desktop's list order (archived ones folded away), a new chat with
 * the agents installed in its environment, and the way to its changes with their count.
 */
export default function ProjectScreen() {
  const t = useTheme()
  const s = useStyles()
  const router = useRouter()
  const now = useNow()
  const { path = '' } = useLocalSearchParams<{ path: string }>()
  const at = envOf(path)
  const env = useEnvs(st => (at ? st.envs.find(e => e.id === at.hostId) ?? null : null))
  const chats = useThreads(useShallow(st => st.byProject(path)))
  const archived = useThreads(useShallow(st => st.archivedFor(path)))
  const [showArchived, setShowArchived] = useState(false)
  const [git, setGit] = useState<GitState | null>(null)
  const [gitError, setGitError] = useState<string | null>(null)
  const [newChat, setNewChat] = useState(false)
  const [actionsFor, setActionsFor] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  const readGit = useCallback(async () => {
    try {
      setGit(await backend.gitState(path))
      setGitError(null)
    } catch (e) {
      setGitError(messageOf(e))
    }
  }, [path])

  const load = useCallback(async () => {
    if (!at || !useEnvs.getState().byId(at.hostId)) return
    await Promise.all([readGit(), syncEnv(at).catch(() => {})])
    // `at` is derived from `path`, which is the real dependency.
  }, [path, readGit]) // eslint-disable-line react-hooks/exhaustive-deps

  useFocusEffect(useCallback(() => { void load() }, [load]))
  // A finished turn probably changed files: the count follows.
  useEffect(() => onFilesChanged((p) => { if (p === path || p.startsWith(`${path}/`)) void readGit() }), [path, readGit])

  const refresh = async () => {
    setRefreshing(true)
    try { await load() } finally { setRefreshing(false) }
  }

  const open = (id: string) => router.push({ pathname: '/chat/[id]', params: { id } })
  const name = projectName(path)
  const changeCount = git?.changes.length ?? 0

  return (
    <ScreenScroll refreshing={refreshing} onRefresh={refresh}>
      <Stack.Screen
        options={{
          title: name,
          headerTitle: () => (
            <View style={s.title} accessibilityRole="header">
              <Text variant="label" numberOfLines={1} maxFontSizeMultiplier={1.2}>{name}</Text>
              <Text variant="micro" tone="subtle" numberOfLines={1} maxFontSizeMultiplier={1.2}>{placeOf(path, env)}</Text>
            </View>
          ),
          headerRight: () => <IconButton icon={SquarePen} label="New chat" onPress={() => setNewChat(true)} />,
        }}
      />

      <ListSection>
        <ListRow
          title="Changes"
          subtitle={gitError ? gitError : git ? (git.repo ? (git.branch ?? 'Detached HEAD') : 'Not a git repository') : 'Reading git…'}
          subtitleMono={!!git?.repo && !!git.branch && !gitError}
          subtitleTone={gitError ? 'error' : 'subtle'}
          leading={<GitBranch size={20} strokeWidth={1.75} color={t.colors.fgSubtle} />}
          detail={git?.repo ? (changeCount ? `${changeCount} changed` : 'Clean') : undefined}
          onPress={() => router.push({ pathname: '/changes', params: { path } })}
        />
      </ListSection>

      {chats.length
        ? (
            <ListSection title="Chats">
              {chats.map(th => (
                <ThreadRow key={th.id} thread={th} now={now} onPress={() => open(th.id)} onLongPress={() => setActionsFor(th.id)} />
              ))}
            </ListSection>
          )
        : (
            <EmptyState
              icon={MessagesSquare}
              title="No chats in this project yet"
              body="Start one here, or on your computer: chats in an environment show up on every computer that opens it."
              action={<Button label="New chat" variant="primary" icon={Plus} onPress={() => setNewChat(true)} />}
            />
          )}

      {archived.length
        ? (
            <View style={s.archived}>
              <ListSection>
                <ListRow
                  title="Archived"
                  detail={String(archived.length)}
                  accessory="none"
                  trailing={showArchived
                    ? <ChevronDown size={18} strokeWidth={2} color={t.colors.fgFaint} />
                    : <ChevronRight size={18} strokeWidth={2} color={t.colors.fgFaint} />}
                  onPress={() => setShowArchived(v => !v)}
                />
              </ListSection>
              {showArchived
                ? (
                    <ListSection>
                      {archived.map(th => (
                        <ThreadRow key={th.id} thread={th} now={now} onPress={() => open(th.id)} onLongPress={() => setActionsFor(th.id)} />
                      ))}
                    </ListSection>
                  )
                : null}
            </View>
          )
        : null}

      <NewChatSheet
        visible={newChat}
        path={path}
        onClose={() => setNewChat(false)}
        onCreated={(id) => { setNewChat(false); open(id) }}
      />
      {actionsFor ? <ThreadActions threadId={actionsFor} visible onClose={() => setActionsFor(null)} /> : null}
    </ScreenScroll>
  )
}

const useStyles = makeStyles(() => ({
  archived: { gap: space[2] },
  title: { alignItems: 'center', maxWidth: 240 },
}))
