import { useState, type ComponentType, type ReactNode } from 'react'
import { Linking, Pressable, StyleSheet, View } from 'react-native'
import { ChevronDown, ChevronUp, CircleCheck, CircleDashed, CircleSlash, CircleX, Download, ExternalLink, FileSignature, Tag, type LucideProps } from 'lucide-react-native'
import type { ForgeProvider, GhRun, GhRunJob } from '~/types/ipc'
import {
  entryState, firstFailure, formatSize, groupAssets, isActive, jobSummary, sortJobs, totalDownloads,
  type EntryMark, type ReleaseEntry, type Tone,
} from '~/utils/releaseRuns'
import type { Colors } from '@/theme'
import { makeStyles, space, touch, useTheme } from '@/theme'
import { Badge, Banner, ListRow, ListSection, Text } from '@/ui'
import type { Release } from '@/remote/releases'
import type { RunRead } from '@/state/releases'
import { ChatMarkdown } from './ChatMarkdown'
import { RUN_ICONS, RUN_MARK } from './PullDetail'
import { CHECK_WORD } from './pulls'
import { byline, entryTitle, githubLink, jobTook, runEta, runTook } from './releases'
import { useNow } from './time'

/** An entry's mark (the desktop's `STATE_ICON`), in the mark grade of its state. */
export const ENTRY_ICONS: Record<EntryMark, ComponentType<LucideProps>> = {
  running: CircleDashed, failed: CircleX, cancelled: CircleSlash, passed: CircleCheck, tag: Tag,
}
export const ENTRY_MARK: Record<EntryMark, keyof Colors> = {
  running: 'ripeRunning', failed: 'ripeError', cancelled: 'fgFaint', passed: 'ripeDone', tag: 'fgSubtle',
}
const TONE_TEXT: Record<Tone | 'queued', 'running' | 'done' | 'error' | 'subtle' | 'queued'> = {
  running: 'running', done: 'done', error: 'error', idle: 'subtle', queued: 'queued',
}
const SUMMARY_ICON: Record<Tone, ComponentType<LucideProps>> = { running: CircleDashed, done: CircleCheck, error: CircleX, idle: CircleSlash }
const SUMMARY_MARK: Record<Tone, keyof Colors> = { running: 'ripeRunning', done: 'ripeDone', error: 'ripeError', idle: 'fgFaint' }

export interface ReleaseDetailProps {
  entry: ReleaseEntry
  /** Its run with jobs, as last read. */
  read: RunRead | undefined
  /** The repository's recent runs, to tell how long a build usually takes. */
  runs: GhRun[]
  latest: boolean
  onOpenJob: (job: GhRunJob, workflow: string) => void
  /** The project's server (files open only from it) and forge (GitLab knows no file sizes). */
  host?: string
  provider?: ForgeProvider
}

/**
 * One release, or a release build that has no release yet (the desktop's `ReleasesItem.vue`): its
 * state, tag and commit, the workflow run that builds it with its jobs (a job opens its log), then
 * its files by platform and its notes. The notes are GitHub's or GitLab's Markdown drawn by
 * `ChatMarkdown`: no HTML, http(s) links only, no pictures fetched from the web. Files open only from
 * the project's own server (github.com, or its GitLab server).
 */
export function ReleaseDetail({ entry, read, runs, latest, onOpenJob, host, provider }: ReleaseDetailProps) {
  const t = useTheme()
  const s = useStyles()
  const now = useNow(1000)
  const release: Release | null = entry.kind === 'release' ? entry.release as Release : null
  const run = read?.detail?.run ?? entry.run
  const jobs = sortJobs(read?.detail?.jobs ?? [])
  const state = entryState({ ...entry, run } as ReleaseEntry)
  const StateIcon = ENTRY_ICONS[state.mark]
  const summary = jobs.length ? jobSummary(jobs) : null
  const active = !!run && isActive(run.state)
  const took = run ? runTook(run, now) : null
  const eta = run ? runEta(run, runs, now) : null
  const failed = active ? null : firstFailure(jobs)
  const who = byline(entry, now)
  const downloads = release ? totalDownloads(release.assets) : 0
  const assets = release ? groupAssets(release.assets) : null

  // The jobs open by themselves while anything is not green; the person's own choice sticks.
  const [listChoice, setListChoice] = useState<boolean | null>(null)
  const listOpen = listChoice ?? (!!summary && summary.tone !== 'done')

  const refName = release ? release.tag : run?.headBranch ?? null
  const refLabel = release || !(entry.kind === 'run' && entry.why === 'trial') ? 'Tag' : 'Branch'

  return (
    <View style={s.root}>
      <View style={s.head}>
        <View style={s.state}>
          <StateIcon size={16} strokeWidth={1.85} color={t.colors[ENTRY_MARK[state.mark]]} />
          <Text variant="captionStrong" tone={TONE_TEXT[state.tone]}>{state.word}</Text>
          {latest ? <Badge label="Latest" tone="done" /> : null}
          {release?.prerelease && state.word !== 'Pre-release' ? <Badge label="Pre-release" tone="queued" /> : null}
          {release?.draft && state.word !== 'Draft' ? <Badge label="Draft" /> : null}
        </View>
        <Text variant="headline" selectable accessibilityRole="header">{entryTitle(entry)}</Text>
        <View style={s.meta}>
          <Text variant="caption" tone="subtle" style={s.flex}>
            <Text variant="captionStrong" tone="muted">{who.who}</Text>
            {' '}{who.what}
          </Text>
          {downloads
            ? (
                <View style={s.downloads} accessibilityLabel={`${downloads} download${downloads === 1 ? '' : 's'}`}>
                  <Download size={14} strokeWidth={1.85} color={t.colors.fgFaint} />
                  <Text variant="caption" tone="subtle" tabular>{downloads}</Text>
                </View>
              )
            : null}
        </View>
      </View>

      {read?.error ? <Banner tone="error" message={`${read.detail ? 'Could not refresh the build: ' : ''}${read.error}`} /> : null}

      {refName || run
        ? (
            <View style={s.facts}>
              {refName
                ? (
                    <Fact label={refLabel} first>
                      <View style={s.line}>
                        <Text variant="mono" numberOfLines={1} ellipsizeMode="middle" style={s.chip} selectable>{refName}</Text>
                        {release?.target ? <Text variant="caption" tone="faint" numberOfLines={1} style={s.flex}>from {release.target}</Text> : null}
                      </View>
                    </Fact>
                  )
                : null}
              {run?.headSha
                ? (
                    <Fact label="Commit" first={!refName}>
                      <View style={s.line}>
                        <Text variant="mono" style={s.chip} selectable>{run.headSha.slice(0, 7)}</Text>
                        {run.title ? <Text variant="caption" tone="faint" numberOfLines={1} style={s.flex}>{run.title}</Text> : null}
                      </View>
                    </Fact>
                  )
                : null}
            </View>
          )
        : null}

      {run
        ? (
            <View style={s.block}>
              <ListSection title={run.workflow || 'Build'} aside={took ? <Text variant="caption" tone="faint" tabular>{active ? took : `took ${took}`}</Text> : undefined}>
                {summary
                  ? (
                      <Pressable
                        key="summary"
                        onPress={() => setListChoice(!listOpen)}
                        accessibilityRole="button"
                        accessibilityLabel={`Jobs: ${capital(summary.text)}`}
                        accessibilityState={{ expanded: listOpen }}
                        style={({ pressed }) => [s.summary, pressed && s.pressed]}
                      >
                        <View style={s.icon}>
                          {(() => { const I = SUMMARY_ICON[summary.tone]; return <I size={18} strokeWidth={1.9} color={t.colors[SUMMARY_MARK[summary.tone]]} /> })()}
                        </View>
                        <Text variant="label" tone={TONE_TEXT[summary.tone]} style={s.flex} numberOfLines={2}>{capital(summary.text)}</Text>
                        {listOpen
                          ? <ChevronUp size={18} strokeWidth={2} color={t.colors.fgFaint} />
                          : <ChevronDown size={18} strokeWidth={2} color={t.colors.fgFaint} />}
                      </Pressable>
                    )
                  : (
                      <View key="summary" style={s.summary}>
                        <View style={s.icon}>{(() => { const I = RUN_ICONS[run.state]; return <I size={18} strokeWidth={1.9} color={t.colors[RUN_MARK[run.state]]} /> })()}</View>
                        <Text variant="label" tone="subtle" style={s.flex}>
                          {read?.loading && !read.detail ? 'Reading the jobs…' : CHECK_WORD[run.state]}
                        </Text>
                      </View>
                    )}
                {listOpen
                  ? jobs.map((j) => {
                      const Icon = RUN_ICONS[j.state]
                      // A waiting or skipped job's word already says it.
                      const time = j.state === 'queued' || j.state === 'skipped' ? null : jobTook(j, now)
                      return (
                        <ListRow
                          key={j.id}
                          title={j.name}
                          subtitle={time ? `${CHECK_WORD[j.state]} · ${time}` : CHECK_WORD[j.state]}
                          subtitleTone={j.state === 'pending' ? 'running' : j.state === 'failure' ? 'error' : 'subtle'}
                          leading={<Icon size={18} strokeWidth={1.9} color={t.colors[RUN_MARK[j.state]]} />}
                          accessibilityHint="Shows its log"
                          onPress={() => onOpenJob(j, run.workflow || 'Release')}
                        />
                      )
                    })
                  : null}
              </ListSection>
              {eta ? <Text variant="caption" tone="subtle" style={s.aside}>{eta}</Text> : null}
            </View>
          )
        : read?.none
          ? <Text variant="bodySm" tone="faint" style={s.aside}>No workflow ran for this tag.</Text>
          : null}

      {failed ? <Banner tone="error" title={`${failed.name} failed`} message="Open the job to read its log, or re-run the failed jobs." /> : null}

      {assets && release
        ? (
            <View style={s.block}>
              <Text variant="captionStrong" tone="subtle" accessibilityRole="header" style={s.aside}>
                {`Files ${assets.files ? assets.files : ''}`.trim()}
              </Text>
              {assets.groups.length
                ? assets.groups.map(g => (
                    <ListSection key={g.platform} title={g.platform}>
                      {g.rows.map(({ asset, signature }) => {
                        const link = githubLink(asset.url, host)
                        const uploading = asset.state !== 'uploaded'
                        return (
                          <ListRow
                            key={asset.name}
                            title={asset.name}
                            mono
                            subtitle={[uploading ? 'Uploading' : provider === 'gitlab' && !asset.size ? null : formatSize(asset.size),
 asset.downloads ? `${asset.downloads} download${asset.downloads === 1 ? '' : 's'}` : null, signature ? 'signed' : null].filter(Boolean).join(' · ')}
                            leading={signature ? <FileSignature size={18} strokeWidth={1.75} color={t.colors.fgFaint} /> : <Download size={18} strokeWidth={1.75} color={t.colors.fgFaint} />}
                            trailing={link && !uploading ? <ExternalLink size={16} strokeWidth={1.75} color={t.colors.fgFaint} /> : undefined}
                            accessory="none"
                            accessibilityHint={link && !uploading ? 'Downloads it in your browser' : undefined}
                            onPress={link && !uploading ? () => Linking.openURL(link).catch(() => {}) : undefined}
                          />
                        )
                      })}
                    </ListSection>
                  ))
                : <Text variant="bodySm" tone="faint" style={s.aside}>{release.draft ? 'No files uploaded yet.' : 'No files.'}</Text>}
            </View>
          )
        : null}

      {release
        ? (
            <View style={s.block}>
              <Text variant="captionStrong" tone="subtle" accessibilityRole="header" style={s.aside}>Notes</Text>
              {release.body.trim()
                ? <View style={s.body}><ChatMarkdown text={release.body} /></View>
                : <Text variant="bodySm" tone="faint" style={s.aside}>No notes.</Text>}
            </View>
          )
        : null}
    </View>
  )
}

/** The desktop's summaries continue a line ("Release · passed"); here they stand alone. */
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

/** One fact: its name at the left, the value beside it. */
function Fact({ label, first, children }: { label: string; first?: boolean; children: ReactNode }) {
  const s = useStyles()
  return (
    <View style={[s.fact, !first && s.rule]} accessible accessibilityRole="text">
      <Text variant="bodySm" tone="subtle" style={s.factLabel}>{label}</Text>
      <View style={s.factValue}>{children}</View>
    </View>
  )
}

const useStyles = makeStyles(t => ({
  root: { gap: space[5] },
  flex: { flex: 1, minWidth: 0 },
  head: { gap: space[2] },
  state: { flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
  meta: { flexDirection: 'row', alignItems: 'center', gap: space[3] },
  downloads: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  block: { gap: space[2] },
  aside: { paddingHorizontal: space[4] },

  facts: {
    backgroundColor: t.colors.bgPanel,
    borderRadius: t.radius.lg,
    borderCurve: 'continuous',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: t.colors.lineSoft,
    paddingLeft: space[4],
  },
  fact: { flexDirection: 'row', alignItems: 'center', minHeight: touch.min, paddingVertical: space[2], paddingRight: space[3], gap: space[3] },
  rule: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: t.colors.line },
  factLabel: { width: 72 },
  factValue: { flex: 1, minWidth: 0 },
  line: { flexDirection: 'row', alignItems: 'center', gap: space[2], minWidth: 0 },
  chip: {
    flexShrink: 1,
    maxWidth: '60%',
    color: t.colors.fgMuted,
    paddingHorizontal: 5,
    borderRadius: t.radius.xs,
    backgroundColor: t.colors.bgHover,
    overflow: 'hidden',
  },

  summary: { flexDirection: 'row', alignItems: 'center', gap: space[3], minHeight: touch.row, paddingLeft: space[4], paddingRight: space[3], paddingVertical: space[2] },
  icon: { width: 28, alignItems: 'center' },
  pressed: { backgroundColor: t.colors.bgActive },

  body: {
    padding: space[4],
    backgroundColor: t.colors.bgPanel,
    borderRadius: t.radius.lg,
    borderCurve: 'continuous',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: t.colors.lineSoft,
  },
}))
