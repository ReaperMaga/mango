import { useCallback, useEffect, useMemo } from 'react'
import { Linking, View } from 'react-native'
import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router'
import { ExternalLink, RefreshCw, Tag } from 'lucide-react-native'
import { entryState, latestRelease, sortReleases, stripeMark, type ReleaseEntry } from '~/utils/releaseRuns'
import { makeStyles, space, useTheme } from '@/theme'
import { Badge, Banner, Button, EmptyState, IconButton, ListRow, ListSection, Text } from '@/ui'
import { shortAgo, useNow } from '@/chat/time'
import { ENTRY_ICONS, ENTRY_MARK } from '@/chat/ReleaseDetail'
import { LIST_BUSY_MS, LIST_IDLE_MS, entryFacts, entryTitle, entryWhen, githubLink } from '@/chat/releases'
import { MAX_RELEASES } from '@/remote/releases'
import { useReleases } from '@/state/releases'
import { ScreenScroll } from '@/screens/Screen'
import { useWatching } from '@/screens/useWatching'
import { projectName } from '@/screens/names'

/**
 * A project's GitHub releases (the desktop's Releases tool window): builds under way first (a
 * release whose workflow runs, a draft whose build failed, a release workflow started by hand),
 * then every release, newest first. Read with gh inside the environment. While on screen it is read
 * again: every 15s while something builds, every two minutes otherwise.
 */
export default function ReleasesScreen() {
  const t = useTheme()
  const s = useStyles()
  const router = useRouter()
  const now = useNow()
  const watching = useWatching()
  const { path = '' } = useLocalSearchParams<{ path: string }>()
  const list = useReleases(st => st.lists[path])
  const data = list?.data ?? null
  const sorted = useMemo(() => (data ? sortReleases(data.releases, data.runs) : null), [data])
  const latestTag = useMemo(() => (data ? latestRelease(data.releases)?.tag ?? null : null), [data])
  const mark = sorted ? stripeMark(sorted) : null

  const load = useCallback((force = false, quiet = false) => {
    if (path) void useReleases.getState().load(path, { force, quiet })
  }, [path])

  useFocusEffect(useCallback(() => { load() }, [load]))

  useEffect(() => {
    if (!watching || !list?.data || list.loading || list.error) return
    const wait = mark === 'running' ? LIST_BUSY_MS : LIST_IDLE_MS
    const id = setTimeout(() => load(true, true), Math.max(0, wait - (Date.now() - list.fetchedAt)))
    return () => clearTimeout(id)
  }, [watching, list, mark, load])

  const web = data ? githubLink(`https://github.com/${data.owner}/${data.repo}/releases`) : null
  const refreshing = !!(list?.loading && !list.quiet && data)
  const open = (e: ReleaseEntry) => router.push({ pathname: '/release', params: { path, key: e.key } })
  const canShowOlder = !!data && data.releases.length >= list!.count && list!.count < MAX_RELEASES

  const header = (
    <Stack.Screen
      options={{
        headerTitle: () => (
          <View style={s.title} accessibilityRole="header">
            <Text variant="label" numberOfLines={1} maxFontSizeMultiplier={1.2}>Releases</Text>
            <Text variant="micro" tone="subtle" numberOfLines={1} maxFontSizeMultiplier={1.2}>
              {data ? `${data.owner}/${data.repo}` : projectName(path)}
            </Text>
          </View>
        ),
        headerRight: web ? () => <IconButton icon={ExternalLink} label="Releases on GitHub" onPress={() => Linking.openURL(web).catch(() => {})} /> : undefined,
      }}
    />
  )

  const row = (e: ReleaseEntry) => {
    const st = entryState(e)
    const Icon = ENTRY_ICONS[st.mark]
    const when = entryWhen(e)
    const building = st.mark === 'running' || st.mark === 'failed' || st.mark === 'cancelled'
    return (
      <ListRow
        key={e.key}
        title={entryTitle(e)}
        subtitle={building ? `${st.word} · ${entryFacts(e)}` : entryFacts(e)}
        subtitleTone={st.mark === 'running' ? 'running' : st.mark === 'failed' ? 'error' : 'subtle'}
        leading={<Icon size={18} strokeWidth={1.9} color={t.colors[ENTRY_MARK[st.mark]]} />}
        trailing={(
          <View style={s.trailing}>
            {e.kind === 'release' && e.release.tag === latestTag ? <Badge label="Latest" tone="done" /> : null}
            {e.kind === 'release' && e.release.prerelease ? <Badge label="Pre-release" tone="queued" /> : null}
            {e.kind === 'release' && e.release.draft ? <Badge label="Draft" /> : null}
            {when ? <Text variant="caption" tone="faint" tabular>{shortAgo(Date.parse(when), now)}</Text> : null}
          </View>
        )}
        onPress={() => open(e)}
      />
    )
  }

  if (!data) {
    return (
      <View style={s.screen}>
        {header}
        {list?.error
          ? (
              <EmptyState
                icon={Tag}
                title="Could not read the releases"
                body={list.error}
                action={<Button label="Try again" icon={RefreshCw} onPress={() => load(true)} />}
              />
            )
          : (
              <View style={s.skeleton} accessible accessibilityLabel="Reading from GitHub" accessibilityRole="progressbar">
                {[70, 52, 84, 46, 76, 60, 68].map(w => <View key={w} style={[s.bone, { width: `${w}%` }]} />)}
              </View>
            )}
      </View>
    )
  }

  return (
    <View style={s.screen}>
      {header}
      <ScreenScroll refreshing={refreshing} onRefresh={() => load(true)}>
        {list?.error ? <Banner tone="error" message={`Could not refresh: ${list.error}`} /> : null}

        {sorted?.inProgress.length
          ? <ListSection title="In progress">{sorted.inProgress.map(row)}</ListSection>
          : null}

        {sorted?.releases.length
          ? (
              <ListSection
                title="Releases"
                aside={<Text variant="caption" tone="faint" tabular>{data.releases.length}</Text>}
              >
                {sorted.releases.map(row)}
              </ListSection>
            )
          : null}

        {!data.releases.length && !sorted?.inProgress.length
          ? <EmptyState icon={Tag} title="No releases yet" body={`${data.owner}/${data.repo} has no releases on GitHub.`} />
          : null}

        {canShowOlder
          ? (
              <View style={s.more}>
                <Button label="Show older" variant="ghost" loading={!!list?.loading && !list.quiet} onPress={() => void useReleases.getState().more(path)} />
              </View>
            )
          : null}
      </ScreenScroll>
    </View>
  )
}

const useStyles = makeStyles(t => ({
  screen: { flex: 1, backgroundColor: t.colors.bgCanvas },
  title: { alignItems: 'center', maxWidth: 240 },
  trailing: { flexDirection: 'row', alignItems: 'center', gap: space[2], flexShrink: 0 },
  more: { alignItems: 'center' },
  skeleton: { gap: space[4], padding: space[5] },
  bone: { height: 12, borderRadius: t.radius.xs, backgroundColor: t.colors.bgHover },
}))
