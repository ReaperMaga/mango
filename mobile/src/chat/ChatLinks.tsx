import type { ComponentType } from 'react'
import { Linking, Pressable, StyleSheet, View } from 'react-native'
import { ChevronRight, CircleCheck, CircleDot, CircleSlash, ExternalLink, GitMerge, GitPullRequest, GitPullRequestClosed, GitPullRequestDraft, type LucideProps } from 'lucide-react-native'
import type { LinkedItem } from '~/types/chat'
import type { Colors } from '@/theme'
import { makeStyles, space, touch, useTheme } from '@/theme'
import { ListRow, ListSection, Sheet, Spinner, Text } from '@/ui'
import { ghWebUrl, type GhState } from '@/remote/github'
import { linkState, type LinkIcon, type LinkTone } from './linkState'

const ICONS: Record<LinkIcon, ComponentType<LucideProps>> = {
  'pr': GitPullRequest,
  'pr-draft': GitPullRequestDraft,
  'pr-merged': GitMerge,
  'pr-closed': GitPullRequestClosed,
  'issue': CircleDot,
  'issue-done': CircleCheck,
  'issue-skipped': CircleSlash,
}

const TONE_COLORS: Record<LinkTone, keyof Colors> = {
  running: 'ripeRunningFg',
  queued: 'ripeQueuedFg',
  done: 'ripeDoneFg',
  error: 'ripeErrorFg',
  idle: 'fgFaint',
}

/** How many items the bar names before it says "+N". */
const BAR_ITEMS = 2

export interface ChatLinksBarProps {
  links: LinkedItem[]
  onPress: () => void
}

/**
 * A slim bar under the chat's header while it has linked pull requests or issues: each one's
 * state mark and number, in the ripeness colours, so a merged or failed item shows at a glance.
 * Tapping it opens the list (`ChatLinksSheet`).
 */
export function ChatLinksBar({ links, onPress }: ChatLinksBarProps) {
  const t = useTheme()
  const s = useStyles()
  if (!links.length) return null
  const shown = links.slice(0, BAR_ITEMS)
  const more = links.length - shown.length
  const said = links.map((l) => {
    const look = linkState(l.kind, l.state)
    return `${look.noun} ${l.number}${l.state ? `, ${look.word.toLowerCase()}` : ''}`
  }).join('; ')
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`Linked: ${said}`}
      accessibilityHint="Shows the pull requests and issues of this chat"
      style={({ pressed }) => [s.bar, pressed && s.pressed]}
    >
      {shown.map((l) => {
        const look = linkState(l.kind, l.state)
        const Icon = ICONS[look.icon]
        return (
          <View key={l.key} style={s.item}>
            <Icon size={15} strokeWidth={1.75} color={t.colors[TONE_COLORS[look.tone]]} />
            <Text variant="caption" tone="muted" tabular numberOfLines={1}>#{l.number}</Text>
            {l.state ? <Text variant="caption" tone="subtle" numberOfLines={1}>{look.word}</Text> : null}
          </View>
        )
      })}
      {more ? <Text variant="caption" tone="subtle" tabular>+{more}</Text> : null}
      <View style={s.fill} />
      <Text variant="caption" tone="subtle" numberOfLines={1}>{links.length === 1 ? (links[0]!.kind === 'pr' ? 'Pull request' : 'Issue') : 'Linked'}</Text>
      <ChevronRight size={16} strokeWidth={2} color={t.colors.fgFaint} />
    </Pressable>
  )
}

export interface ChatLinksSheetProps {
  visible: boolean
  onClose: () => void
  links: LinkedItem[]
  /** What GitHub said just now, by link key (newer than the title and state saved on the link). */
  live: Record<string, GhState>
  /** Reading the latest from GitHub. */
  loading: boolean
  /** Why the latest could not be read; the saved titles and states still show. */
  error: string | null
}

/**
 * The pull requests and issues linked to the chat (the desktop's Pull requests tool window, in
 * brief): state, title, repository and number. Each opens on github.com in the browser; links to
 * any other host are listed but not opened.
 */
export function ChatLinksSheet({ visible, onClose, links, live, loading, error }: ChatLinksSheetProps) {
  const t = useTheme()
  const footer = error ?? (loading ? 'Reading the latest from GitHub…' : 'Opens on GitHub in your browser.')
  return (
    <Sheet visible={visible} onClose={onClose} title="Pull requests and issues" action={loading ? <Spinner size={16} label="Reading from GitHub" /> : undefined}>
      <ListSection footer={footer}>
        {links.map((l) => {
          const now = live[l.key]
          const look = linkState(now?.kind ?? l.kind, now?.state ?? l.state, now?.stateReason)
          const Icon = ICONS[look.icon]
          const url = ghWebUrl(l)
          const title = now?.title ?? l.title ?? `${look.noun} #${l.number}`
          return (
            <ListRow
              key={l.key}
              title={title}
              subtitle={`${look.word} · ${l.owner}/${l.repo} #${l.number}`}
              leading={<Icon size={20} strokeWidth={1.75} color={t.colors[TONE_COLORS[look.tone]]} />}
              accessory="none"
              trailing={url ? <ExternalLink size={16} strokeWidth={1.75} color={t.colors.fgFaint} /> : undefined}
              accessibilityHint={url ? 'Opens on GitHub in your browser' : 'Only github.com links open from here'}
              onPress={url ? () => { Linking.openURL(url).catch(() => {}) } : undefined}
            />
          )
        })}
      </ListSection>
    </Sheet>
  )
}

const useStyles = makeStyles(t => ({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[3],
    minHeight: touch.min,
    paddingLeft: space[4],
    paddingRight: space[3],
    backgroundColor: t.colors.bgCanvas,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: t.colors.lineSoft,
  },
  pressed: { backgroundColor: t.colors.bgActive },
  item: { flexDirection: 'row', alignItems: 'center', gap: 5, flexShrink: 1 },
  fill: { flex: 1 },
}))
