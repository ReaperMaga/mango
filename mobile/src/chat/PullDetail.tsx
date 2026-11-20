import { useState, type ComponentType, type ReactNode } from 'react'
import { Linking, Pressable, StyleSheet, View } from 'react-native'
import { ArrowRight, ChevronDown, ChevronUp, Circle, CircleCheck, CircleDashed, CircleMinus, CircleSlash, CircleX, ExternalLink, MessageSquare, type LucideProps } from 'lucide-react-native'
import type { LinkedItem } from '~/types/chat'
import type { GhCheck, GhRunState } from '~/types/ipc'
import type { Colors } from '@/theme'
import { makeStyles, space, touch, useTheme } from '@/theme'
import { Badge, Banner, ListRow, ListSection, Text } from '@/ui'
import type { LinkDetail } from '@/state/links'
import { ChatMarkdown } from './ChatMarkdown'
import { LINK_ICONS, LINK_TONE_COLORS } from './ChatLinks'
import { linkState } from './linkState'
import { CHECK_WORD, REVIEW_WORD, checkLink, checkSummary, isJobUrl, labelColor, sortChecks } from './pulls'
import { shortAgo, useNow } from './time'

/** A check's or job's state mark. */
export const RUN_ICONS: Record<GhRunState, ComponentType<LucideProps>> = {
  failure: CircleX,
  cancelled: CircleSlash,
  pending: CircleDashed,
  queued: Circle,
  success: CircleCheck,
  neutral: CircleMinus,
  skipped: CircleSlash,
}

/** Marks take the mark grade; anything that did not run, quiet ink. */
export const RUN_MARK: Record<GhRunState, keyof Colors> = {
  failure: 'ripeError',
  cancelled: 'fgFaint',
  pending: 'ripeRunning',
  queued: 'fgFaint',
  success: 'ripeDone',
  neutral: 'fgFaint',
  skipped: 'fgFaint',
}

/** Words take the text grade. */
export const RUN_TONE: Record<GhRunState, 'error' | 'running' | 'done' | 'subtle'> = {
  failure: 'error',
  cancelled: 'subtle',
  pending: 'running',
  queued: 'subtle',
  success: 'done',
  neutral: 'subtle',
  skipped: 'subtle',
}

const REVIEW_TONE = { approved: 'done', changes_requested: 'error', review_required: 'subtle' } as const

export interface PullDetailProps {
  link: LinkedItem
  detail: LinkDetail | undefined
  /** A GitHub Actions job: its log opens in the app. */
  onOpenCheck: (check: GhCheck) => void
}

/**
 * One pull request or issue (the desktop's `LinksItem.vue`): its state, title, who opened it,
 * branches, changes, review, checks and labels, then the description. The description is GitHub's
 * Markdown drawn by `ChatMarkdown`: no HTML, http(s) links only, no pictures fetched from the web.
 */
export function PullDetail({ link, detail, onOpenCheck }: PullDetailProps) {
  const t = useTheme()
  const s = useStyles()
  const now = useNow()
  const item = detail?.item ?? null
  const look = linkState(item?.kind ?? link.kind, item?.state ?? link.state, item?.stateReason)
  const StateIcon = LINK_ICONS[look.icon]
  const title = item?.title ?? link.title ?? `#${link.number}`
  const opened = item?.createdAt ? shortAgo(Date.parse(item.createdAt), now) : null

  const runs = item ? sortChecks(item.checkRuns) : []
  const summary = item ? checkSummary(item) : null
  // The list opens by itself while anything is not green; the person's own choice sticks.
  const [listChoice, setListChoice] = useState<boolean | null>(null)
  const listOpen = listChoice ?? summary?.tone !== 'success'

  const openCheck = (c: GhCheck) => {
    if (isJobUrl(c.url)) return onOpenCheck(c)
    const url = checkLink(c.url)
    if (url) Linking.openURL(url).catch(() => {})
  }

  return (
    <View style={s.root}>
      <View style={s.head}>
        <View style={s.state}>
          <StateIcon size={16} strokeWidth={1.85} color={t.colors[LINK_TONE_COLORS[look.tone]]} />
          <Text variant="captionStrong" style={{ color: t.colors[LINK_TONE_COLORS[look.tone]] }}>{look.word}</Text>
        </View>
        <Text variant="headline" selectable accessibilityRole="header">{title}</Text>
        {item
          ? (
              <View style={s.meta}>
                <Text variant="caption" tone="subtle" style={s.flex}>
                  <Text variant="captionStrong" tone="muted">{item.author?.login ?? 'Someone'}</Text>
                  {' '}opened {opened === 'now' ? 'just now' : `${opened} ago`}
                </Text>
                {item.comments
                  ? (
                      <View style={s.comments} accessibilityLabel={`${item.comments} comment${item.comments === 1 ? '' : 's'}`}>
                        <MessageSquare size={14} strokeWidth={1.85} color={t.colors.fgFaint} />
                        <Text variant="caption" tone="subtle" tabular>{item.comments}</Text>
                      </View>
                    )
                  : null}
              </View>
            )
          : null}
      </View>

      {detail?.error
        ? <Banner tone="error" message={`${item ? 'Could not refresh: ' : ''}${detail.error}`} />
        : null}

      {!item && detail?.loading
        ? (
            <View style={s.skeleton} accessible accessibilityLabel="Reading from GitHub" accessibilityRole="progressbar">
              {[62, 88, 74, 40, 81, 56].map(w => <View key={w} style={[s.bone, { width: `${w}%` }]} />)}
            </View>
          )
        : null}

      {item?.kind === 'pr' && ((item.headRef && item.baseRef) || item.changedFiles !== null || item.reviewDecision)
        ? (
            <View style={s.facts}>
              {item.headRef && item.baseRef
                ? (
                    <Fact label="Branch" first>
                      <View style={s.branches} accessibilityLabel={`${item.headRef} into ${item.baseRef}`}>
                        <Text variant="mono" numberOfLines={1} ellipsizeMode="middle" style={s.branch} selectable>{item.headRef}</Text>
                        <ArrowRight size={14} strokeWidth={2} color={t.colors.fgFaint} />
                        <Text variant="mono" numberOfLines={1} ellipsizeMode="middle" style={s.branch} selectable>{item.baseRef}</Text>
                      </View>
                    </Fact>
                  )
                : null}
              {item.changedFiles !== null
                ? (
                    <Fact label="Changes" first={!(item.headRef && item.baseRef)}>
                      <Text variant="bodySm" tabular>
                        <Text variant="bodySm" style={{ color: t.colors.diffAddFg }}>+{item.additions}</Text>
                        {' '}
                        <Text variant="bodySm" style={{ color: t.colors.diffDelFg }}>−{item.deletions}</Text>
                        <Text variant="bodySm" tone="subtle">{` in ${item.changedFiles} file${item.changedFiles === 1 ? '' : 's'}`}</Text>
                      </Text>
                    </Fact>
                  )
                : null}
              {item.reviewDecision
                ? (
                    <Fact label="Review" first={!(item.headRef && item.baseRef) && item.changedFiles === null}>
                      <Text variant="bodySm" tone={REVIEW_TONE[item.reviewDecision]}>{REVIEW_WORD[item.reviewDecision]}</Text>
                    </Fact>
                  )
                : null}
            </View>
          )
        : null}

      {summary
        ? (
            <ListSection title="Checks">
              {runs.length
                ? (
                    <Pressable
                      key="summary"
                      onPress={() => setListChoice(!listOpen)}
                      accessibilityRole="button"
                      accessibilityLabel={`Checks: ${summary.text}`}
                      accessibilityState={{ expanded: listOpen }}
                      style={({ pressed }) => [s.summary, pressed && s.pressed]}
                    >
                      <SummaryIcon tone={summary.tone} />
                      <Text variant="label" tone={RUN_TONE[summary.tone]} style={s.flex} numberOfLines={2}>{summary.text}</Text>
                      {listOpen
                        ? <ChevronUp size={18} strokeWidth={2} color={t.colors.fgFaint} />
                        : <ChevronDown size={18} strokeWidth={2} color={t.colors.fgFaint} />}
                    </Pressable>
                  )
                : (
                    <View key="summary" style={s.summary}>
                      <SummaryIcon tone={summary.tone} />
                      <Text variant="label" tone={RUN_TONE[summary.tone]} style={s.flex}>{summary.text}</Text>
                    </View>
                  )}
              {listOpen
                ? runs.map((c, i) => {
                    const Icon = RUN_ICONS[c.state]
                    const job = isJobUrl(c.url)
                    const away = !job ? checkLink(c.url) : null
                    const sub = c.workflow ?? c.description
                    return (
                      <ListRow
                        key={`${c.workflow}/${c.name}/${i}`}
                        title={c.name}
                        subtitle={sub ? `${CHECK_WORD[c.state]} · ${sub}` : CHECK_WORD[c.state]}
                        leading={<Icon size={18} strokeWidth={1.9} color={t.colors[RUN_MARK[c.state]]} />}
                        trailing={(
                          <>
                            {c.required ? <Badge label="Required" /> : null}
                            {away ? <ExternalLink size={16} strokeWidth={1.75} color={t.colors.fgFaint} /> : null}
                          </>
                        )}
                        accessory={job ? 'chevron' : 'none'}
                        accessibilityHint={job ? 'Shows its log' : away ? 'Opens its details in your browser' : undefined}
                        onPress={job || away ? () => openCheck(c) : undefined}
                      />
                    )
                  })
                : null}
            </ListSection>
          )
        : null}

      {item?.labels.length
        ? (
            <View style={s.labels} accessibilityLabel={`Labels: ${item.labels.map(l => l.name).join(', ')}`}>
              {item.labels.map((l) => {
                const color = labelColor(l.color)
                return (
                  <View key={l.name} style={s.label}>
                    <View style={[s.swatch, color ? { backgroundColor: color } : s.swatchNone]} />
                    <Text variant="caption" tone="muted" numberOfLines={1}>{l.name}</Text>
                  </View>
                )
              })}
            </View>
          )
        : null}

      {item
        ? (
            <View style={s.description}>
              <Text variant="captionStrong" tone="subtle" accessibilityRole="header" style={s.descHead}>Description</Text>
              {item.body.trim()
                ? <View style={s.body}><ChatMarkdown text={item.body} /></View>
                : <Text variant="bodySm" tone="faint" style={s.descHead}>No description.</Text>}
            </View>
          )
        : null}
    </View>
  )
}

function SummaryIcon({ tone }: { tone: 'success' | 'failure' | 'pending' }) {
  const t = useTheme()
  const Icon = RUN_ICONS[tone]
  return <View style={{ width: 28, alignItems: 'center' }}><Icon size={18} strokeWidth={1.9} color={t.colors[RUN_MARK[tone]]} /></View>
}

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
  state: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  meta: { flexDirection: 'row', alignItems: 'center', gap: space[3] },
  comments: { flexDirection: 'row', alignItems: 'center', gap: 4 },

  skeleton: { gap: space[3], paddingTop: space[1] },
  bone: { height: 10, borderRadius: t.radius.xs, backgroundColor: t.colors.bgHover },

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
  factValue: { flex: 1, minWidth: 0, alignItems: 'flex-start' },
  branches: { flexDirection: 'row', alignItems: 'center', gap: 6, maxWidth: '100%' },
  branch: { flexShrink: 1, color: t.colors.fg },

  summary: { flexDirection: 'row', alignItems: 'center', gap: space[3], minHeight: touch.row, paddingLeft: space[4], paddingRight: space[3], paddingVertical: space[2] },
  pressed: { backgroundColor: t.colors.bgActive },

  labels: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  label: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    minHeight: 26,
    maxWidth: '100%',
    paddingHorizontal: space[2],
    borderRadius: t.radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: t.colors.line,
    backgroundColor: t.colors.bgPanel,
  },
  swatch: { width: 8, height: 8, borderRadius: 4, borderWidth: StyleSheet.hairlineWidth, borderColor: t.colors.lineStrong },
  swatchNone: { borderWidth: 1, borderColor: t.colors.fgFaint },

  description: { gap: 6 },
  descHead: { paddingHorizontal: space[4] },
  body: {
    padding: space[4],
    backgroundColor: t.colors.bgPanel,
    borderRadius: t.radius.lg,
    borderCurve: 'continuous',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: t.colors.lineSoft,
  },
}))
