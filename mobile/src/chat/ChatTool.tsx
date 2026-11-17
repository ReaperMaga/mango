import { useState } from 'react'
import { Pressable, ScrollView, View } from 'react-native'
import { ArrowUpRight, ChevronRight, CircleAlert, FilePen, FilePlus, FileText, Globe, Search, SquareTerminal, Wrench, type LucideProps } from 'lucide-react-native'
import type { ComponentType } from 'react'
import type { Part, ToolKind } from '~/types/chat'
import { fonts, fontSize, makeStyles, radius, space, touch, useTheme } from '@/theme'
import { Spinner, Text } from '@/ui'
import { ChatDiff } from './ChatDiff'

export type ToolPart = Extract<Part, { type: 'tool' }>

const meta: Record<ToolKind, { icon: ComponentType<LucideProps>; done: string; doing: string }> = {
  read: { icon: FileText, done: 'Read', doing: 'Reading' },
  edit: { icon: FilePen, done: 'Edited', doing: 'Editing' },
  write: { icon: FilePlus, done: 'Created', doing: 'Creating' },
  search: { icon: Search, done: 'Searched', doing: 'Searching' },
  bash: { icon: SquareTerminal, done: 'Ran', doing: 'Running' },
  web: { icon: Globe, done: 'Fetched', doing: 'Fetching' },
  other: { icon: Wrench, done: 'Used', doing: 'Using' },
}

/** Output lines shown before "Show all": a chat stays scrollable past a long log. */
const OUTPUT_LINES = 40

export interface ChatToolProps {
  part: ToolPart
  /** A delegated task has a chat of its own (the sub-agent's): "Open" goes there. */
  onOpenChild?: (childId: string) => void
}

/**
 * One tool call, ported from the desktop's `ChatTool.vue`: kind icon (a ring spinner while it
 * runs, an alert when it failed), verb, mono target, a quiet summary at the right. Rows with a
 * diff or output expand into an Inset Well below; failed ones start open.
 */
export function ChatTool({ part, onOpenChild }: ChatToolProps) {
  const t = useTheme()
  const s = useStyles()
  const m = meta[part.tool]
  const expandable = !!(part.output || part.diff?.length)
  const [open, setOpen] = useState(part.status === 'error')
  const [all, setAll] = useState(false)
  const verb = part.label ?? (part.status === 'running' ? m.doing : m.done)
  const Icon = m.icon
  const failed = part.status === 'error'

  const outLines = part.output ? part.output.replace(/\n+$/, '').split('\n') : []
  const outShown = all ? outLines : outLines.slice(0, OUTPUT_LINES)

  const row = (pressed: boolean) => (
    <>
      <View style={s.icon}>
        {part.status === 'running'
          ? <Spinner size={12} color={t.colors.ripeRunning} />
          : failed
            ? <CircleAlert size={16} strokeWidth={1.75} color={t.colors.ripeError} />
            : <Icon size={16} strokeWidth={1.75} color={pressed ? t.colors.fgMuted : t.colors.fgSubtle} />}
      </View>
      <Text variant="bodySm" style={[s.verb, part.status === 'running' && s.verbLive, failed && s.verbError]} numberOfLines={1}>{verb}</Text>
      <Text style={s.target} numberOfLines={1} ellipsizeMode="middle">{part.target}</Text>
      {part.summary ? <Text variant="caption" tone={failed ? 'error' : 'faint'} tabular numberOfLines={1} style={s.sum}>{part.summary}</Text> : <View style={s.grow} />}
      {expandable
        ? <View style={open ? s.caretOpen : undefined}><ChevronRight size={15} strokeWidth={2} color={t.colors.fgFaint} /></View>
        : null}
    </>
  )

  return (
    <View>
      <View style={s.line}>
        {expandable
          ? (
              <Pressable
                onPress={() => setOpen(o => !o)}
                accessibilityRole="button"
                accessibilityState={{ expanded: open }}
                accessibilityLabel={`${verb} ${part.target}${part.summary ? `, ${part.summary}` : ''}`}
                style={({ pressed }) => [s.row, pressed && s.pressed]}
              >
                {({ pressed }) => row(pressed)}
              </Pressable>
            )
          : <View style={s.row} accessible accessibilityLabel={`${verb} ${part.target}${part.summary ? `, ${part.summary}` : ''}`}>{row(false)}</View>}
        {part.childId && onOpenChild
          ? (
              <Pressable
                onPress={() => onOpenChild(part.childId!)}
                hitSlop={8}
                accessibilityRole="link"
                accessibilityLabel="Open the sub-agent's chat"
                style={({ pressed }) => [s.open, pressed && s.pressed]}
              >
                <Text variant="captionStrong" tone="accent">Open</Text>
                <ArrowUpRight size={14} strokeWidth={1.85} color={t.colors.accentInk} />
              </Pressable>
            )
          : null}
      </View>

      {open && expandable
        ? part.diff?.length
          ? <ChatDiff lines={part.diff} style={s.detail} />
          : (
              <View style={[s.detail, s.outBox]}>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} bounces={false} contentContainerStyle={s.outScroll}>
                  <Text selectable style={s.out}>{outShown.join('\n')}</Text>
                </ScrollView>
                {outLines.length > OUTPUT_LINES && !all
                  ? (
                      <Pressable onPress={() => setAll(true)} accessibilityRole="button" style={({ pressed }) => [s.more, pressed && s.pressed]}>
                        <Text variant="caption" tone="subtle" tabular>Show all {outLines.length} lines</Text>
                      </Pressable>
                    )
                  : null}
              </View>
            )
        : null}
    </View>
  )
}

const useStyles = makeStyles(t => ({
  line: { flexDirection: 'row', alignItems: 'center', gap: space[1] },
  row: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[2],
    minHeight: touch.min - 4,
    paddingHorizontal: space[2],
    marginLeft: -space[2],
    borderRadius: radius.sm,
    borderCurve: 'continuous',
  },
  pressed: { backgroundColor: t.colors.bgHover },
  icon: { width: 18, height: 18, alignItems: 'center', justifyContent: 'center' },
  verb: { fontFamily: fonts.medium, color: t.colors.fgMuted, flexShrink: 0 },
  verbLive: { color: t.colors.fg },
  verbError: { color: t.colors.ripeErrorFg },
  target: { flexShrink: 1, minWidth: 0, fontFamily: fonts.mono, fontSize: fontSize.mono, color: t.colors.fgMuted },
  sum: { marginLeft: 'auto', flexShrink: 0, paddingLeft: space[1] },
  grow: { flex: 1 },
  caretOpen: { transform: [{ rotate: '90deg' }] },
  open: { flexDirection: 'row', alignItems: 'center', gap: 3, minHeight: 32, paddingHorizontal: space[2], borderRadius: radius.xs },
  detail: { marginTop: 2, marginBottom: 6, marginLeft: 26 },
  outBox: {
    borderWidth: 1,
    borderColor: t.colors.lineSoft,
    borderRadius: radius.md,
    borderCurve: 'continuous',
    backgroundColor: t.colors.bgInset,
    overflow: 'hidden',
  },
  outScroll: { padding: space[3] },
  out: { fontFamily: fonts.mono, fontSize: fontSize.mono - 1, lineHeight: Math.round((fontSize.mono - 1) * 1.6), color: t.colors.fgMuted, fontVariant: ['no-common-ligatures', 'no-contextual'] },
  more: { minHeight: 44, alignItems: 'center', justifyContent: 'center', borderTopWidth: 1, borderTopColor: t.colors.lineSoft },
}))
