import { useCallback, useEffect, useState } from 'react'
import { Linking, View } from 'react-native'
import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { ArrowDown, ArrowUp, Check, GitCommitHorizontal, GitPullRequestArrow, Upload } from 'lucide-react-native'
import { makeStyles, space, useTheme } from '@/theme'
import { Banner, Button, ButtonRow, EmptyState, ListRow, ListSection, Sheet, Spinner, Text, TextField, haptic } from '@/ui'
import { ChangeRow } from '@/chat'
import { backend } from '@/remote'
import type { GitState } from '@/remote/types'
import { ghWebUrl } from '@/remote/github'
import type { LinkedItem } from '~/types/chat'
import { useLinks } from '@/state/links'
import { useThreads } from '@/state/threads'
import { onFilesChanged } from '@/agents/run'
import { ScreenScroll } from '@/screens/Screen'
import { messageOf, projectName } from '@/screens/names'

/**
 * A project's changes, as the desktop's Changes view on a phone: the branch with how far it is
 * ahead or behind, the changed files (tap one for its diff), and the two actions a phone needs:
 * commit everything with a message, and push. From a branch it also opens a pull request (the
 * desktop's `openPullRequest`): push, then `gh pr create` in the environment, linked to the chat the
 * screen was opened from (`chat`), or to the chats working in this worktree. Git is read again after
 * each action and on focus.
 */
export default function ChangesScreen() {
  const t = useTheme()
  const s = useStyles()
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const { path = '', chat: chatId = '' } = useLocalSearchParams<{ path: string; chat?: string }>()
  const [git, setGit] = useState<GitState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [composing, setComposing] = useState(false)
  const [message, setMessage] = useState('')
  const [committing, setCommitting] = useState(false)
  const [commitError, setCommitError] = useState<string | null>(null)
  const [pushing, setPushing] = useState(false)
  const [opening, setOpening] = useState(false)
  /** The pull request just opened: where it was linked (null: no chat), to show it from the result. */
  const [opened, setOpened] = useState<{ link: LinkedItem; chat: string | null; web: string | null } | null>(null)
  /** What the last action did, in a sentence. */
  const [result, setResult] = useState<{ tone: 'info' | 'error'; text: string } | null>(null)

  const read = useCallback(async () => {
    try {
      setGit(await backend.gitState(path))
      setError(null)
    } catch (e) {
      setError(messageOf(e))
    }
  }, [path])

  useFocusEffect(useCallback(() => { void read() }, [read]))
  useEffect(() => onFilesChanged((p) => { if (p === path || p.startsWith(`${path}/`)) void read() }), [path, read])

  const refresh = async () => {
    setRefreshing(true)
    try { await read() } finally { setRefreshing(false) }
  }

  const commit = async () => {
    setCommitting(true)
    setCommitError(null)
    try {
      const hash = await backend.gitCommit(path, message.trim())
      haptic('success')
      setComposing(false)
      setMessage('')
      setResult({ tone: 'info', text: `Committed ${hash}: ${message.trim().split('\n')[0]}` })
    } catch (e) {
      setCommitError(messageOf(e))
    } finally {
      setCommitting(false)
      void read()
    }
  }

  const push = async () => {
    setPushing(true)
    setResult(null)
    try {
      const summary = await backend.gitPush(path)
      haptic('success')
      setResult({ tone: 'info', text: summary })
    } catch (e) {
      haptic('warning')
      setResult({ tone: 'error', text: messageOf(e) })
    } finally {
      setPushing(false)
      void read()
    }
  }

  /** Push the branch, open its pull request on GitHub (or find the one already open), and link it. */
  const openPullRequest = async () => {
    setOpening(true)
    setResult(null)
    setOpened(null)
    try {
      await backend.gitPush(path)
      const item = await backend.ghPrCreate(path, null)
      const threads = useThreads.getState()
      const root = chatId ? threads.rootOf(chatId) : null
      const users = root
        ? [root]
        : Object.values(threads.threads).filter(t => !t.parentId && t.worktree === path)
      const links = useLinks.getState()
      const link = links.adopt(users[0]?.id ?? null, item)
      for (const t of users.slice(1)) threads.link(t.id, link)
      haptic('success')
      setOpened({ link, chat: users[0]?.id ?? null, web: ghWebUrl(link) })
      setResult({ tone: 'info', text: `Pull request #${item.number} is open: ${item.title}${users.length ? (users.length === 1 && root ? '. It is linked to this chat.' : '. It is linked to the chats working here.') : ''}` })
    } catch (e) {
      haptic('warning')
      setResult({ tone: 'error', text: messageOf(e) })
    } finally {
      setOpening(false)
      void read()
    }
  }

  const header = <Stack.Screen options={{ title: 'Changes', headerBackTitle: projectName(path) }} />

  if (!git) {
    return (
      <ScreenScroll refreshing={refreshing} onRefresh={refresh}>
        {header}
        {error
          ? <Banner tone="error" title="Could not read git" message={error} action={<Button label="Try again" size="sm" onPress={refresh} />} />
          : <View style={s.loading}><Spinner size={18} label="Reading git" /></View>}
      </ScreenScroll>
    )
  }

  if (!git.repo) {
    return (
      <ScreenScroll>
        {header}
        <EmptyState icon={GitCommitHorizontal} title="Not a git repository" body={`${projectName(path)} isn't tracked by git, so there are no changes to show.`} />
      </ScreenScroll>
    )
  }

  const n = git.changes.length
  const canPush = !!git.branch && (git.ahead > 0 || !git.upstream)

  return (
    <View style={s.screen}>
      {header}
      <ScreenScroll refreshing={refreshing} onRefresh={refresh}>
        <View style={s.branch}>
          <Text variant="mono" numberOfLines={1} ellipsizeMode="middle" style={s.branchName} selectable>{git.branch ?? 'Detached HEAD'}</Text>
          {git.upstream
            ? (
                <View style={s.counts} accessibilityLabel={`${git.ahead} to push, ${git.behind} to pull`}>
                  <ArrowUp size={14} strokeWidth={2} color={git.ahead ? t.colors.accentInk : t.colors.fgFaint} />
                  <Text variant="caption" tone={git.ahead ? 'accent' : 'faint'} tabular>{git.ahead}</Text>
                  <ArrowDown size={14} strokeWidth={2} color={git.behind ? t.colors.fgMuted : t.colors.fgFaint} />
                  <Text variant="caption" tone={git.behind ? 'muted' : 'faint'} tabular>{git.behind}</Text>
                </View>
              )
            : git.branch ? <Text variant="caption" tone="subtle">Not published yet</Text> : null}
        </View>

        {error ? <Banner tone="error" message={`Not refreshed: ${error}`} /> : null}
        {result
          ? (
              <Banner
                tone={result.tone}
                message={result.text}
                onDismiss={() => { setResult(null); setOpened(null) }}
                action={opened && result.tone === 'info'
                  ? (
                      <ButtonRow>
                        {opened.chat
                          ? <Button label="Show it" size="sm" icon={GitPullRequestArrow} onPress={() => router.push({ pathname: '/pull', params: { chat: opened.chat!, key: opened.link.key } })} />
                          : null}
                        {opened.web
                          ? <Button label="Open on GitHub" size="sm" variant={opened.chat ? 'ghost' : 'secondary'} onPress={() => { Linking.openURL(opened.web!).catch(() => {}) }} />
                          : null}
                      </ButtonRow>
                    )
                  : undefined}
              />
            )
          : null}

        {git.branch
          ? (
              <ListSection footer={`Pushes ${git.branch} and opens a pull request into the repository's default branch on GitHub, or finds the one already open.`}>
                <ListRow
                  title="Open a pull request"
                  leading={opening ? <Spinner size={16} label="Opening the pull request" /> : <GitPullRequestArrow size={20} strokeWidth={1.75} color={t.colors.accentInk} />}
                  accessory="none"
                  disabled={opening || pushing}
                  onPress={openPullRequest}
                />
              </ListSection>
            )
          : null}

        {n
          ? (
              <ListSection title={`${n} changed file${n === 1 ? '' : 's'}`}>
                {git.changes.map(c => (
                  <ChangeRow
                    key={`${c.path}:${c.staged ? 's' : 'w'}`}
                    change={c}
                    onPress={() => router.push({ pathname: '/diff', params: { path, file: c.path } })}
                  />
                ))}
              </ListSection>
            )
          : <EmptyState icon={Check} title="Nothing to commit" body={git.ahead ? `${git.ahead} commit${git.ahead === 1 ? '' : 's'} waiting to be pushed.` : 'The working tree matches the last commit.'} />}
      </ScreenScroll>

      <View style={[s.bar, { paddingBottom: Math.max(insets.bottom, space[3]) }]}>
        <Button label={n ? `Commit ${n} file${n === 1 ? '' : 's'}` : 'Commit'} variant="primary" icon={GitCommitHorizontal} disabled={!n} onPress={() => { setCommitError(null); setComposing(true) }} style={s.flex} />
        <Button label={git.upstream ? 'Push' : 'Publish'} icon={Upload} loading={pushing} disabled={!canPush || opening} onPress={push} style={s.flex} />
      </View>

      <Sheet
        visible={composing}
        onClose={() => setComposing(false)}
        title="Commit"
      >
        <View style={s.sheet}>
          <Text variant="bodySm" tone="muted">Every change is staged and committed on <Text variant="mono" tone="fg">{git.branch ?? 'HEAD'}</Text>.</Text>
          <TextField
            label="Message"
            value={message}
            onChangeText={setMessage}
            placeholder="Describe what changed"
            multiline
            autoFocus
            error={commitError}
          />
          <Button label="Commit" variant="primary" size="lg" block loading={committing} disabled={!message.trim()} onPress={commit} />
        </View>
      </Sheet>
    </View>
  )
}

const useStyles = makeStyles(t => ({
  screen: { flex: 1, backgroundColor: t.colors.bgCanvas },
  loading: { paddingVertical: space[8], alignItems: 'center' },
  branch: { flexDirection: 'row', alignItems: 'center', gap: space[3], paddingHorizontal: space[1] },
  branchName: { flexShrink: 1, color: t.colors.fg },
  counts: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  bar: {
    flexDirection: 'row',
    gap: space[2],
    paddingHorizontal: space[4],
    paddingTop: space[3],
    borderTopWidth: 1,
    borderTopColor: t.colors.lineSoft,
    backgroundColor: t.colors.bgCanvas,
  },
  flex: { flex: 1 },
  sheet: { gap: space[4] },
}))
