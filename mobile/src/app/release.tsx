import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Linking, StyleSheet, View } from 'react-native'
import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { CircleStop, ExternalLink, RotateCcw, Tag } from 'lucide-react-native'
import type { GhRunAction, GhRunJob } from '~/types/ipc'
import { isActive, latestRelease, sortReleases, type ReleaseEntry } from '~/utils/releaseRuns'
import { makeStyles, space } from '@/theme'
import { Banner, Button, ButtonRow, EmptyState, IconButton, Text, haptic } from '@/ui'
import { ReleaseDetail } from '@/chat/ReleaseDetail'
import { RUN_BUSY_MS, githubLink, rerunAction } from '@/chat/releases'
import { readKey, useReleases } from '@/state/releases'
import { ScreenScroll } from '@/screens/Screen'
import { useWatching } from '@/screens/useWatching'

/** How long the armed "Cancel the run?" waits for its second tap. */
const ARM_MS = 4000

/**
 * One release, or a release build without a release yet (the desktop's Releases tool window with one
 * entry open): its build with its jobs (a job opens its log), files and notes. At the bottom, what can
 * be done to its run: re-run what failed, or cancel it (asked twice: it stops work on GitHub). While
 * its build runs and the screen is in front, the run is read every 10s; when it ends, the list too.
 */
export default function ReleaseScreen() {
  const s = useStyles()
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const watching = useWatching()
  const { path = '', key = '' } = useLocalSearchParams<{ path: string; key: string }>()
  const list = useReleases(st => st.lists[path])
  const read = useReleases(st => st.runs[readKey(path, key)])
  const data = list?.data ?? null
  const sorted = useMemo(() => (data ? sortReleases(data.releases, data.runs) : null), [data])
  const listed = sorted ? [...sorted.inProgress, ...sorted.releases].find(e => e.key === key) ?? null : null
  // A build without a release leaves the list once it ends; what was read of it still shows.
  const entry: ReleaseEntry | null = listed ?? (key.startsWith('run:') && read?.detail
    ? { kind: 'run', key, run: read.detail.run, why: read.detail.run.event === 'workflow_dispatch' ? 'trial' : 'tag' }
    : null)
  const latestTag = useMemo(() => (data ? latestRelease(data.releases)?.tag ?? null : null), [data])
  const run = read?.detail?.run ?? entry?.run ?? null
  const acting = useReleases(st => (run ? st.acting[run.id] ?? null : null))
  const [actionError, setActionError] = useState<string | null>(null)
  const [armed, setArmed] = useState(false)
  const valid = key.startsWith('tag:') || /^run:\d+$/.test(key)

  const loadRun = useCallback(() => {
    if (path && valid) void useReleases.getState().loadRun(path, key)
  }, [path, key, valid])

  useFocusEffect(useCallback(() => {
    loadRun()
    // Opened from a notification or after a restart: the list too.
    if (path) void useReleases.getState().load(path)
  }, [loadRun, path]))

  // While it builds: read again every 10s.
  const active = !!run && isActive(run.state)
  useEffect(() => {
    if (!watching || !read || read.loading || !read.detail || !isActive(read.detail.run.state)) return
    const id = setTimeout(loadRun, Math.max(0, RUN_BUSY_MS - (Date.now() - read.fetchedAt)))
    return () => clearTimeout(id)
  }, [watching, read, loadRun])

  // When it ends, the list follows (files, published).
  const was = useRef(read?.detail?.run.state)
  useEffect(() => {
    const now = read?.detail?.run.state
    if (was.current && isActive(was.current) && now && !isActive(now)) void useReleases.getState().load(path, { force: true, quiet: true })
    was.current = now
  }, [read?.detail?.run.state, path])

  useEffect(() => {
    if (!armed) return
    const id = setTimeout(() => setArmed(false), ARM_MS)
    return () => clearTimeout(id)
  }, [armed])

  const act = async (action: GhRunAction) => {
    if (!run) return
    setActionError(null)
    setArmed(false)
    haptic(action === 'cancel' ? 'warning' : 'select')
    try {
      await useReleases.getState().act(path, key, run.id, action)
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e))
    }
  }
  const cancel = () => {
    if (!armed) { haptic('select'); setArmed(true); return }
    void act('cancel')
  }
  const openJob = (j: GhRunJob, workflow: string) => {
    router.push({ pathname: '/check', params: { path, url: j.url, name: j.name, workflow } })
  }

  const page = githubLink(entry?.kind === 'release' ? entry.release.url : run?.url)
  const rerun = active ? null : rerunAction(run)
  const refreshing = !!(read?.loading && read.detail)
  const title = entry?.kind === 'release' ? entry.release.tag : run ? `Run #${run.number}` : 'Release'

  const header = (
    <Stack.Screen
      options={{
        headerTitle: () => (
          <View style={s.title} accessibilityRole="header">
            <Text variant="label" numberOfLines={1} tabular>{title}</Text>
            {data ? <Text variant="micro" tone="subtle" numberOfLines={1}>{data.owner}/{data.repo}</Text> : null}
          </View>
        ),
        headerRight: page ? () => <IconButton icon={ExternalLink} label="Open on GitHub" onPress={() => Linking.openURL(page).catch(() => {})} /> : undefined,
      }}
    />
  )

  if (!entry) {
    return (
      <View style={s.screen}>
        {header}
        {(!data && !list?.error) || read?.loading
          ? <View style={s.skeleton}>{[62, 88, 74, 40].map(w => <View key={w} style={[s.bone, { width: `${w}%` }]} />)}</View>
          : (
              <EmptyState
                icon={Tag}
                title={list?.error ? 'Could not read the releases' : 'Not in the list any more'}
                body={list?.error ?? 'The release was deleted on GitHub, or its build finished without one.'}
                action={<Button label="Go back" onPress={() => router.back()} />}
              />
            )}
      </View>
    )
  }

  return (
    <View style={s.screen}>
      {header}
      <ScreenScroll refreshing={refreshing} onRefresh={() => { loadRun(); void useReleases.getState().load(path, { force: true, quiet: true }) }}>
        <ReleaseDetail
          key={entry.key}
          entry={entry}
          read={read}
          runs={data?.runs ?? []}
          latest={entry.kind === 'release' && entry.release.tag === latestTag}
          onOpenJob={openJob}
        />
      </ScreenScroll>

      {run && (active || rerun)
        ? (
            <View style={[s.bar, { paddingBottom: Math.max(insets.bottom, space[3]) }]}>
              {actionError ? <Banner tone="error" message={actionError} onDismiss={() => setActionError(null)} /> : null}
              {armed ? <Text variant="caption" tone="error" accessibilityLiveRegion="polite">Tap again to stop the run on GitHub.</Text> : null}
              <ButtonRow>
                {rerun
                  ? (
                      <Button
                        label={rerun === 'rerun-failed' ? 'Re-run failed jobs' : 'Re-run'}
                        icon={RotateCcw}
                        variant="primary"
                        block
                        loading={acting === 'rerun-failed' || acting === 'rerun'}
                        disabled={!!acting}
                        onPress={() => void act(rerun)}
                      />
                    )
                  : null}
                {active
                  ? (
                      <Button
                        label={armed ? 'Cancel the run?' : 'Cancel run'}
                        icon={CircleStop}
                        variant={armed ? 'danger' : 'secondary'}
                        block
                        loading={acting === 'cancel'}
                        disabled={!!acting}
                        onPress={cancel}
                      />
                    )
                  : null}
              </ButtonRow>
            </View>
          )
        : null}
    </View>
  )
}

const useStyles = makeStyles(t => ({
  screen: { flex: 1, backgroundColor: t.colors.bgCanvas },
  title: { alignItems: 'center', maxWidth: 220 },
  bar: {
    gap: space[2],
    paddingHorizontal: space[4],
    paddingTop: space[3],
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: t.colors.line,
    backgroundColor: t.colors.bgCanvas,
  },
  skeleton: { gap: space[4], padding: space[5] },
  bone: { height: 12, borderRadius: t.radius.xs, backgroundColor: t.colors.bgHover },
}))
