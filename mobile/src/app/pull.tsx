import { useCallback, useEffect, useState } from 'react'
import { AppState, Linking, StyleSheet, View } from 'react-native'
import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Ellipsis, ExternalLink, GitPullRequest, RefreshCw, Unlink } from 'lucide-react-native'
import type { GhCheck } from '~/types/ipc'
import { makeStyles, space, useTheme } from '@/theme'
import { Button, ButtonRow, EmptyState, IconButton, ListRow, ListSection, Sheet, Text, haptic } from '@/ui'
import { PullDetail } from '@/chat/PullDetail'
import { PullMerge } from '@/chat/PullMerge'
import { pollDelay, pollWait } from '@/chat/pulls'
import { ghWebUrl, validGhRef } from '@/remote/github'
import { useLinks } from '@/state/links'
import { useThreads } from '@/state/threads'
import { ScreenScroll } from '@/screens/Screen'

/**
 * A pull request or issue linked to a chat (the desktop's Pull requests tool window with one item
 * open): what GitHub says about it, its checks (an Actions job opens its log), the description, and
 * for an open pull request, merging. While on screen and the app is in front it is read again:
 * every 10s while checks run or mergeability is unknown, every minute otherwise, never once merged
 * or closed.
 */
export default function PullScreen() {
  const t = useTheme()
  const s = useStyles()
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const { chat: chatId = '', key = '' } = useLocalSearchParams<{ chat: string; key: string }>()
  const chat = useThreads(st => (st.threads[chatId] ? st.rootOf(chatId) : null))
  const link = chat?.links?.find(l => l.key === key) ?? null
  const detail = useLinks(st => st.details[key])
  const [focused, setFocused] = useState(true)
  const [inFront, setInFront] = useState(AppState.currentState === 'active')
  const [menu, setMenu] = useState(false)
  const [armed, setArmed] = useState(false)

  const readable = !!link && validGhRef(link)
  const projectPath = chat?.projectPath ?? null
  const threadId = chat?.id ?? chatId

  const load = useCallback((force = false, quiet = false) => {
    if (!link || !readable || !projectPath) return
    void useLinks.getState().load(threadId, link, projectPath, force, quiet)
    // `link` stands for its key: its title and state change as it is read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, readable, projectPath, threadId])

  useFocusEffect(useCallback(() => {
    setFocused(true)
    load()
    return () => setFocused(false)
  }, [load]))

  useEffect(() => {
    const sub = AppState.addEventListener('change', next => setInFront(next === 'active'))
    return () => sub.remove()
  }, [])

  // Keeping it current: only while someone looks at it.
  const delay = pollDelay(detail?.item)
  useEffect(() => {
    if (!focused || !inFront || !detail || detail.loading || delay === null) return
    const id = setTimeout(() => load(true, true), pollWait(delay, detail.fetchedAt, !!detail.error))
    return () => clearTimeout(id)
  }, [focused, inFront, detail, delay, load])

  const item = detail?.item ?? null
  const web = link ? ghWebUrl(link) : null
  const noun = (item?.kind ?? link?.kind) === 'issue' ? 'Issue' : 'Pull request'
  const refreshing = !!(detail?.loading && !detail.quiet && item)
  const mergeable = item?.kind === 'pr' && (item.state === 'open' || item.state === 'draft') ? item : null

  const openWeb = () => { if (web) Linking.openURL(web).catch(() => {}) }
  const openCheck = (c: GhCheck) => {
    if (!c.url) return
    router.push({ pathname: '/check', params: { chat: threadId, key, url: c.url, name: c.name, workflow: c.workflow ?? '' } })
  }
  const unlink = () => {
    if (!link) return
    setMenu(false)
    haptic('warning')
    useThreads.getState().unlink(threadId, link.key)
    router.back()
  }

  const header = (
    <Stack.Screen
      options={{
        headerTitle: () => (
          <View style={s.title} accessibilityRole="header">
            <Text variant="label" numberOfLines={1} tabular>{link ? `${noun} #${link.number}` : noun}</Text>
            {link ? <Text variant="micro" tone="subtle" numberOfLines={1}>{link.owner}/{link.repo}</Text> : null}
          </View>
        ),
        headerRight: link
          ? () => (
              <View style={s.headerButtons}>
                {web ? <IconButton icon={ExternalLink} label="Open on GitHub" onPress={openWeb} /> : null}
                <IconButton icon={Ellipsis} label="More actions" onPress={() => { setArmed(false); setMenu(true) }} />
              </View>
            )
          : undefined,
      }}
    />
  )

  if (!chat || !link) {
    return (
      <View style={s.screen}>
        {header}
        <EmptyState
          icon={GitPullRequest}
          title="Not linked any more"
          body={chat ? 'It was unlinked from this chat, here or on another computer.' : 'Its chat was deleted, here or on another computer.'}
          action={<Button label="Go back" onPress={() => router.back()} />}
        />
      </View>
    )
  }

  if (!readable) {
    return (
      <View style={s.screen}>
        {header}
        <EmptyState icon={GitPullRequest} title="Not on github.com" body="Only pull requests and issues on github.com can be read here." />
      </View>
    )
  }

  return (
    <View style={s.screen}>
      {header}
      <ScreenScroll refreshing={refreshing} onRefresh={() => load(true)}>
        <PullDetail link={link} detail={detail} onOpenCheck={openCheck} />
      </ScreenScroll>

      {mergeable && projectPath
        ? (
            <View style={[s.bar, { paddingBottom: Math.max(insets.bottom, space[3]) }]}>
              <PullMerge key={link.key} threadId={threadId} link={link} item={mergeable} projectPath={projectPath} />
            </View>
          )
        : null}

      <Sheet visible={menu} onClose={() => setMenu(false)} title={`${noun} #${link.number}`}>
        <View style={s.menu}>
          <ListSection>
            {web
              ? <ListRow title="Open on GitHub" leading={<ExternalLink size={20} strokeWidth={1.75} color={t.colors.fgSubtle} />} accessory="none" onPress={() => { setMenu(false); openWeb() }} />
              : null}
            <ListRow title="Refresh" leading={<RefreshCw size={20} strokeWidth={1.75} color={t.colors.fgSubtle} />} accessory="none" onPress={() => { setMenu(false); load(true) }} />
          </ListSection>
          <ListSection footer="Removes it from this chat; nothing changes on GitHub.">
            <ListRow
              title="Unlink"
              destructive
              leading={<Unlink size={20} strokeWidth={1.75} color={t.colors.ripeErrorFg} />}
              accessory="none"
              onPress={() => { haptic('select'); setArmed(true) }}
            />
          </ListSection>
          {armed
            ? (
                <View style={s.confirm} accessibilityLiveRegion="polite">
                  <Text variant="label" tone="error">Unlink #{link.number} from this chat?</Text>
                  <Text variant="bodySm" tone="muted">It leaves this chat's list on every computer. The {noun.toLowerCase()} stays as it is on GitHub, and can be linked again.</Text>
                  <ButtonRow>
                    <Button label="Keep it" variant="ghost" size="sm" onPress={() => setArmed(false)} />
                    <Button label="Unlink" variant="danger" size="sm" onPress={unlink} />
                  </ButtonRow>
                </View>
              )
            : null}
        </View>
      </Sheet>
    </View>
  )
}

const useStyles = makeStyles(t => ({
  screen: { flex: 1, backgroundColor: t.colors.bgCanvas },
  title: { alignItems: 'center', maxWidth: 220 },
  headerButtons: { flexDirection: 'row', alignItems: 'center' },
  bar: {
    paddingHorizontal: space[4],
    paddingTop: space[3],
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: t.colors.line,
    backgroundColor: t.colors.bgCanvas,
  },
  menu: { gap: space[5] },
  confirm: { gap: space[2], padding: space[3], borderRadius: t.radius.md, borderWidth: 1, borderColor: t.colors.errorLine, backgroundColor: t.colors.errorWash },
}))
