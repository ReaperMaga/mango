import { Pressable, StyleSheet, View } from 'react-native'
import { ChevronRight, FolderGit2 } from 'lucide-react-native'
import { AGENTS, displayStatus, hasUnreadResult, waitingFor, type Thread } from '~/types/chat'
import { makeStyles, space, touch, useTheme } from '@/theme'
import { RipenessDot, Text, dotStatus, type TextTone } from '@/ui'
import { shortAgo } from './time'

/** The second line of a thread row: its status in words, as the desktop sidebar writes it. */
export function threadSubtitle(t: Thread): string {
  const agent = t.simulated ? `${AGENTS[t.agent].name} · simulated` : AGENTS[t.agent].name
  switch (displayStatus(t)) {
    case 'waiting': return `Needs your ${waitingFor(t)}`
    case 'working': return t.status === 'queued' ? 'Starting…' : t.status === 'running' ? 'Working…' : `Working · ${agent}`
    case 'error': return 'Failed'
    case 'done': return `Settled · ${agent}`
    case 'archived': return `Archived · ${agent}`
  }
}

const subTone: Record<ReturnType<typeof displayStatus>, TextTone> = {
  waiting: 'waiting',
  working: 'subtle',
  error: 'error',
  done: 'faint',
  archived: 'faint',
}

export interface ThreadRowProps {
  thread: Thread
  /** Shown after the status when the list mixes projects. */
  projectName?: string
  /** For the relative time; pass `useNow()` from the list so every row ticks together. */
  now?: number
  /** The chat on screen beside the list (iPad): Active Wash and primary ink. */
  current?: boolean
  onPress?: () => void
  onLongPress?: () => void
  /** The disclosure chevron of a row that opens a screen; on by default. */
  chevron?: boolean
}

/**
 * A chat in a list, ported from the desktop sidebar's thread row: the ripeness dot, the title over
 * a one-line status, the time at the right. A result nobody has looked at rings the dot and lifts
 * the title to primary ink at medium weight.
 */
export function ThreadRow({ thread, projectName, now = Date.now(), current = false, onPress, onLongPress, chevron = true }: ThreadRowProps) {
  const t = useTheme()
  const s = useStyles()
  const status = displayStatus(thread)
  const unseen = hasUnreadResult(thread) || (!thread.archived && !thread.seen && thread.status === 'waiting')
  const sub = threadSubtitle(thread)
  const wt = thread.worktree ? (thread.branch ?? thread.worktree.split(/[\\/]/).pop() ?? '') : ''

  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      accessibilityRole="button"
      accessibilityLabel={`${thread.title}. ${sub}${projectName ? `, ${projectName}` : ''}. ${shortAgo(thread.updatedAt, now)}`}
      accessibilityState={{ selected: current || undefined }}
      style={({ pressed }) => [s.row, current && s.current, pressed && s.pressed]}
    >
      <View style={s.dot}><RipenessDot status={dotStatus(thread)} unseen={unseen} size={14} /></View>
      <View style={s.text}>
        <View style={s.line}>
          <Text
            variant="bodySm"
            numberOfLines={1}
            style={[s.title, (unseen || current) && s.titleOn, thread.archived && s.titleArchived]}
          >
            {thread.title}
          </Text>
          <Text variant="micro" tone="faint" tabular style={s.time}>{shortAgo(thread.updatedAt, now)}</Text>
        </View>
        <View style={s.line}>
          <Text variant="caption" tone={subTone[status]} numberOfLines={1} style={s.sub}>
            {sub}{projectName ? <Text variant="caption" tone="faint">{`  ·  ${projectName}`}</Text> : null}
          </Text>
          {wt
            ? (
                <View style={s.wt}>
                  <FolderGit2 size={12} strokeWidth={1.85} color={t.colors.fgFaint} />
                  <Text variant="monoSm" tone="subtle" numberOfLines={1} ellipsizeMode="middle" style={s.wtName}>{wt}</Text>
                </View>
              )
            : null}
        </View>
      </View>
      {chevron && onPress ? <ChevronRight size={18} strokeWidth={2} color={t.colors.fgFaint} style={s.chev} /> : null}
    </Pressable>
  )
}

const useStyles = makeStyles(t => ({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: touch.row2,
    paddingLeft: space[4],
    paddingRight: space[3],
    paddingVertical: space[2],
    gap: space[3],
  },
  current: { backgroundColor: t.colors.bgActive },
  pressed: { backgroundColor: t.colors.bgActive },
  dot: { width: 18, alignItems: 'center', alignSelf: 'flex-start', paddingTop: 4 },
  text: { flex: 1, minWidth: 0, gap: 2 },
  line: { flexDirection: 'row', alignItems: 'center', gap: space[2] },
  title: { flex: 1, color: t.colors.fgMuted },
  titleOn: { color: t.colors.fg, ...t.fonts.medium },
  titleArchived: { color: t.colors.fgSubtle },
  time: { flexShrink: 0 },
  sub: { flex: 1, minWidth: 0 },
  wt: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    maxWidth: '45%',
    paddingHorizontal: 5,
    minHeight: 18,
    borderRadius: 4,
    backgroundColor: t.colors.bgHover,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: t.colors.lineSoft,
  },
  wtName: { flexShrink: 1 },
  chev: { marginLeft: -space[1] },
}))
