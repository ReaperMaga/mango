import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AppState, FlatList, Linking, Platform, Pressable, RefreshControl, Text as RNText, View } from 'react-native'
import { Stack, useFocusEffect, useLocalSearchParams } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { ChevronDown, ChevronRight, ExternalLink, ScrollText } from 'lucide-react-native'
import type { LogLine, LogSpan } from '~/utils/actionsLog'
import type { Colors } from '@/theme'
import { makeStyles, space, touch, useTheme } from '@/theme'
import { Banner, EmptyState, IconButton, Text } from '@/ui'
import { RUN_ICONS, RUN_MARK, RUN_TONE } from '@/chat/PullDetail'
import { CHECK_WORD, JOB_POLL_MS, isJobUrl, jobRunning, jobWantsMore, tookMs } from '@/chat/pulls'
import { firstErrorRow, logRows, parseSteps, type LogRow } from '@/chat/checkLog'
import { formatDuration, useNow } from '@/chat/time'
import { useLinks } from '@/state/links'
import { useThreads } from '@/state/threads'

/**
 * A GitHub Actions job's log (the desktop's `LinksCheckLog.vue`), laid out like GitHub's job page:
 * its steps in order, each opening to its log, where `##[group]` sections fold and errors stand out.
 * A failed step opens by itself and the first error comes into view. While the job runs, and for two
 * minutes after (GitHub hands out the log once the job has finished), it is read every 5s. The log is
 * untrusted text: it only ever becomes Text, with ANSI colours from the terminal palette.
 */
export default function CheckScreen() {
  const t = useTheme()
  const s = useStyles()
  const insets = useSafeAreaInsets()
  const { chat: chatId = '', url = '', name = '', workflow = '' } = useLocalSearchParams<{ chat: string; key: string; url: string; name: string; workflow: string }>()
  const projectPath = useThreads(st => (st.threads[chatId] ? st.rootOf(chatId)?.projectPath ?? null : null))
  const detail = useLinks(st => st.jobs[url])
  const job = detail?.job ?? null
  const valid = isJobUrl(url)
  const now = useNow(1000)
  const [focused, setFocused] = useState(true)
  const [inFront, setInFront] = useState(AppState.currentState === 'active')
  const [stepChoice, setStepChoice] = useState<ReadonlyMap<number, boolean>>(new Map())
  const [groupChoice, setGroupChoice] = useState<ReadonlyMap<string, boolean>>(new Map())
  const list = useRef<FlatList<LogRow>>(null)
  const scrolled = useRef(false)

  const load = useCallback(() => {
    if (valid && projectPath) void useLinks.getState().loadJob(projectPath, url)
  }, [valid, projectPath, url])

  useFocusEffect(useCallback(() => {
    setFocused(true)
    // A finished job's log never changes (a re-run is another job), so what was read stays good.
    const had = useLinks.getState().jobs[url]?.job
    if (!(had?.logReady && !jobRunning(had.state))) load()
    return () => setFocused(false)
  }, [load, url]))

  useEffect(() => {
    const sub = AppState.addEventListener('change', next => setInFront(next === 'active'))
    return () => sub.remove()
  }, [])

  useEffect(() => {
    if (!focused || !inFront || !detail || detail.loading || !jobWantsMore(detail.job)) return
    const id = setTimeout(load, detail.error ? JOB_POLL_MS * 3 : JOB_POLL_MS)
    return () => clearTimeout(id)
  }, [focused, inFront, detail, load])

  const parsed = useMemo(() => parseSteps(job?.steps ?? []), [job?.steps])
  const rows = useMemo(() => logRows(job?.steps ?? [], parsed, stepChoice, groupChoice), [job?.steps, parsed, stepChoice, groupChoice])

  // The first error, in view once the log arrives.
  useEffect(() => {
    if (!job?.logReady || scrolled.current) return
    scrolled.current = true
    const i = firstErrorRow(rows)
    if (i > 0) requestAnimationFrame(() => list.current?.scrollToIndex({ index: i, viewPosition: 0.4, animated: false }))
  }, [job?.logReady, rows])

  const toggleStep = useCallback((n: number, open: boolean) => {
    setStepChoice(m => new Map(m).set(n, !open))
  }, [])
  const toggleGroup = useCallback((g: string, open: boolean) => {
    setGroupChoice(m => new Map(m).set(g, !open))
  }, [])

  const header = (
    <Stack.Screen
      options={{
        headerTitle: () => (
          <View style={s.title} accessibilityRole="header">
            <Text variant="label" numberOfLines={1}>{job?.name || name || 'Check'}</Text>
            {job?.workflow || workflow ? <Text variant="micro" tone="subtle" numberOfLines={1}>{job?.workflow || workflow}</Text> : null}
          </View>
        ),
        headerRight: valid
          ? () => <IconButton icon={ExternalLink} label="Open on GitHub" onPress={() => { Linking.openURL(url).catch(() => {}) }} />
          : undefined,
      }}
    />
  )

  if (!valid || !projectPath) {
    return (
      <View style={s.screen}>
        {header}
        <EmptyState
          icon={ScrollText}
          title={valid ? 'This chat is gone' : 'No log here'}
          body={valid ? 'It was deleted, here or on another computer.' : 'Only GitHub Actions jobs on github.com have a log in the app.'}
        />
      </View>
    )
  }

  const state = job?.state ?? null
  const took = job ? tookMs(job.startedAt, job.completedAt, now) : null
  const finished = !!job && !jobRunning(job.state)
  const StateIcon = state ? RUN_ICONS[state] : null

  const top = (
    <View style={s.top}>
      {state && StateIcon
        ? (
            <View style={s.stateRow}>
              <StateIcon size={16} strokeWidth={1.9} color={t.colors[RUN_MARK[state]]} />
              <Text variant="captionStrong" tone={RUN_TONE[state]}>{CHECK_WORD[state]}</Text>
              {took !== null ? <Text variant="caption" tone="faint" tabular style={s.took}>{formatDuration(took)}</Text> : null}
            </View>
          )
        : null}
      <Text variant="headline" selectable>{job?.name || name}</Text>
      {detail?.error ? <Banner tone="error" message={`${job ? 'Could not refresh: ' : ''}${detail.error}`} /> : null}
      {!job && !detail?.error
        ? (
            <View style={s.skeleton} accessible accessibilityRole="progressbar" accessibilityLabel="Reading from GitHub">
              {[44, 70, 58, 66, 38, 52].map(w => <View key={w} style={[s.bone, { width: `${w}%` }]} />)}
            </View>
          )
        : null}
      {job && !finished
        ? <Text variant="caption" tone="subtle">The job is still running. Its steps update here as they go; the log follows once it finishes.</Text>
        : job?.logError ? <Text variant="caption" tone="subtle">{job.logError}</Text> : null}
    </View>
  )

  return (
    <View style={s.screen}>
      {header}
      <FlatList
        ref={list}
        data={rows}
        keyExtractor={r => r.key}
        renderItem={({ item }) => <Row row={item} now={now} onToggleStep={toggleStep} onToggleGroup={toggleGroup} />}
        ListHeaderComponent={top}
        ListFooterComponent={job?.logTruncated
          ? <Text variant="caption" tone="subtle" style={s.foot}>The log was too long to read whole: its end is missing here. GitHub has all of it.</Text>
          : undefined}
        contentContainerStyle={[s.content, { paddingBottom: (Platform.OS === 'ios' ? 0 : insets.bottom) + space[8] }]}
        contentInsetAdjustmentBehavior="automatic"
        refreshControl={<RefreshControl refreshing={!!(detail?.loading && job)} onRefresh={load} tintColor={t.colors.fgSubtle} colors={[t.colors.accent]} />}
        initialNumToRender={40}
        maxToRenderPerBatch={60}
        windowSize={11}
        onScrollToIndexFailed={({ index, averageItemLength }) => {
          list.current?.scrollToOffset({ offset: index * averageItemLength, animated: false })
          setTimeout(() => list.current?.scrollToIndex({ index, viewPosition: 0.4, animated: false }), 60)
        }}
      />
    </View>
  )
}

const ANSI: Record<string, keyof Colors> = {
  black: 'termBrightBlack',
  gray: 'termBrightBlack',
  red: 'termRed',
  green: 'termGreen',
  yellow: 'termYellow',
  blue: 'termBlue',
  magenta: 'termMagenta',
  cyan: 'termCyan',
  white: 'fg',
}

const Row = memo(function Row({ row, now, onToggleStep, onToggleGroup }: {
  row: LogRow
  now: number
  onToggleStep: (n: number, open: boolean) => void
  onToggleGroup: (g: string, open: boolean) => void
}) {
  const t = useTheme()
  const s = useStyles()
  switch (row.kind) {
    case 'step': {
      const st = row.step
      const Icon = RUN_ICONS[st.state]
      const Chev = row.open ? ChevronDown : ChevronRight
      const took = st.state !== 'skipped' ? tookMs(st.startedAt, st.completedAt, now) : null
      return (
        <Pressable
          onPress={() => onToggleStep(st.number, row.open)}
          disabled={!row.hasLog}
          accessibilityRole="button"
          accessibilityLabel={`${CHECK_WORD[st.state]}: ${st.name}${took !== null ? `, ${formatDuration(took)}` : ''}`}
          accessibilityState={row.hasLog ? { expanded: row.open } : { disabled: true }}
          style={({ pressed }) => [s.step, pressed && s.pressed]}
        >
          <View style={{ opacity: row.hasLog ? 1 : 0 }}><Chev size={14} strokeWidth={2} color={t.colors.fgFaint} /></View>
          <Icon size={16} strokeWidth={1.9} color={t.colors[RUN_MARK[st.state]]} />
          <Text variant="bodySm" tone={row.open ? 'fg' : 'muted'} numberOfLines={1} style={s.stepName}>{st.name}</Text>
          {took !== null ? <Text variant="caption" tone="faint" tabular>{formatDuration(took)}</Text> : null}
        </Pressable>
      )
    }
    case 'start':
      return <View style={[s.well, s.wellStart]} />
    case 'end':
      return <View style={[s.well, s.wellEnd]} />
    case 'omitted':
      return (
        <View style={[s.well, s.omitted]}>
          <Text variant="caption" tone="subtle">{row.count.toLocaleString()} earlier line{row.count === 1 ? ' is' : 's are'} left out. GitHub has the whole log.</Text>
        </View>
      )
    case 'group': {
      const Chev = row.open ? ChevronDown : ChevronRight
      return (
        <Pressable
          onPress={() => onToggleGroup(row.group, row.open)}
          accessibilityRole="button"
          accessibilityState={{ expanded: row.open }}
          style={({ pressed }) => [s.well, s.line, pressed && s.pressed]}
        >
          <RNText maxFontSizeMultiplier={1.4} style={[s.n, { width: (row.gutter + 1) * GLYPH }]}>{row.head.n}</RNText>
          <View style={s.groupChev}><Chev size={12} strokeWidth={2} color={t.colors.fgFaint} /></View>
          <RNText maxFontSizeMultiplier={1.4} style={[s.t, { color: t.colors.fg }]}><Spans spans={row.head.spans} /></RNText>
        </Pressable>
      )
    }
    case 'line':
      return <Line line={row.line} inner={row.inner} gutter={row.gutter} />
  }
})

/** Log text at 11pt mono: about this wide per digit, for the line-number gutter. */
const GLYPH = 7

function Line({ line, inner, gutter }: { line: LogLine; inner: boolean; gutter: number }) {
  const t = useTheme()
  const s = useStyles()
  const level = line.level
  const wash = level === 'error' ? t.colors.errorWash : level === 'warning' ? t.colors.termYellowWash : undefined
  const ink = level === 'error' ? t.colors.ripeErrorFg
    : level === 'warning' ? t.colors.termYellow
      : level === 'notice' || level === 'command' ? t.colors.termBlue
        : level === 'debug' ? t.colors.fgFaint
          : t.colors.fgMuted
  return (
    <View style={[s.well, s.line, wash ? { backgroundColor: wash } : null]}>
      <RNText maxFontSizeMultiplier={1.4} style={[s.n, { width: (gutter + 1) * GLYPH }]}>{line.n}</RNText>
      <RNText maxFontSizeMultiplier={1.4} selectable style={[s.t, inner && s.inner, { color: ink }]}><Spans spans={line.spans} /></RNText>
    </View>
  )
}

function Spans({ spans }: { spans: LogSpan[] }) {
  const t = useTheme()
  return (
    <>
      {spans.map((sp, i) => (
        <RNText
          key={i}
          style={[
            sp.fg ? { color: t.colors[ANSI[sp.fg] ?? 'fgMuted'] } : null,
            sp.bold && t.fonts.monoSemibold,
            sp.dim && { opacity: 0.7 },
            sp.underline && { textDecorationLine: 'underline' },
          ]}
        >
          {sp.text}
        </RNText>
      ))}
    </>
  )
}

const useStyles = makeStyles(t => ({
  screen: { flex: 1, backgroundColor: t.colors.bgCanvas },
  title: { alignItems: 'center', maxWidth: 240 },
  content: { paddingHorizontal: space[4], paddingTop: space[3] },
  top: { gap: space[2], paddingBottom: space[4] },
  stateRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  took: { marginLeft: 'auto' },
  skeleton: { gap: space[3], paddingTop: space[3] },
  bone: { height: 10, borderRadius: t.radius.xs, backgroundColor: t.colors.bgHover },
  foot: { paddingTop: space[3] },

  step: { flexDirection: 'row', alignItems: 'center', gap: space[2], minHeight: touch.min, paddingHorizontal: space[1], borderRadius: t.radius.sm },
  stepName: { flex: 1, minWidth: 0 },
  pressed: { backgroundColor: t.colors.bgActive },

  well: { backgroundColor: t.colors.bgInset },
  wellStart: { height: space[2], borderTopLeftRadius: t.radius.md, borderTopRightRadius: t.radius.md, marginTop: 2 },
  wellEnd: { height: space[2], borderBottomLeftRadius: t.radius.md, borderBottomRightRadius: t.radius.md, marginBottom: space[2] },
  omitted: { paddingHorizontal: space[3], paddingBottom: space[1] },
  line: { flexDirection: 'row', alignItems: 'flex-start', paddingRight: space[2] },
  n: { ...t.type.monoSm, textAlign: 'right', marginRight: space[2], color: t.colors.fgFaint, fontVariant: ['tabular-nums'] },
  t: { ...t.type.monoSm, flex: 1, minWidth: 0 },
  inner: { paddingLeft: 16 },
  groupChev: { paddingTop: 3, marginRight: 4 },
}))
