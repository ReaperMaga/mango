import { useEffect, useRef, useState } from 'react'
import { Animated, Pressable, View } from 'react-native'
import { ChevronRight } from 'lucide-react-native'
import type { Part, ToolKind } from '~/types/chat'
import { easeInOut, makeStyles, radius, space, touch, useReducedMotion, useTheme } from '@/theme'
import { Text } from '@/ui'
import { ChatTool } from './ChatTool'
import { formatDuration } from './time'

export type Step = Extract<Part, { type: 'thinking' } | { type: 'tool' }>

const nouns: Record<ToolKind, [verb: string, one: string, many: string]> = {
  bash: ['ran', 'command', 'commands'],
  read: ['read', 'file', 'files'],
  edit: ['edited', 'file', 'files'],
  write: ['created', 'file', 'files'],
  search: ['ran', 'search', 'searches'],
  web: ['fetched', 'page', 'pages'],
  other: ['used', 'tool', 'tools'],
}

/** "Ran 3 commands, read 2 files, thought for 7s" (the desktop's `ChatSteps.vue`). */
export function stepsSummary(steps: Step[]): string {
  const counts = new Map<ToolKind | 'thinking' | 'browser', number>()
  let seconds = 0
  for (const s of steps) {
    const key = s.type === 'thinking' ? 'thinking' : s.label === 'Browser' ? 'browser' : s.tool
    counts.set(key, (counts.get(key) ?? 0) + 1)
    if (s.type === 'thinking') seconds += s.seconds
  }
  const bits = [...counts].map(([key, n]) => {
    if (key === 'thinking') return seconds > 0 ? `thought for ${formatDuration(seconds * 1000)}` : 'thought'
    if (key === 'browser') return n === 1 ? 'used the browser' : `used the browser ${n} times`
    const [verb, one, many] = nouns[key]
    return `${verb} ${n} ${n === 1 ? one : many}`
  })
  const text = bits.join(', ')
  return text.charAt(0).toUpperCase() + text.slice(1)
}

/**
 * A run of consecutive thinking and tool rows folded under one summary line. While the run is the
 * live end of a turn, the newest step stays visible under the summary.
 */
export function ChatSteps({ steps, live = false, onOpenChild }: { steps: Step[]; live?: boolean; onOpenChild?: (childId: string) => void }) {
  const t = useTheme()
  const s = useStyles()
  const [open, setOpen] = useState(false)
  const failed = steps.filter(x => x.type === 'tool' && x.status === 'error').length
  const latest = steps[steps.length - 1]!
  const visible = open ? steps : live ? [latest] : []
  return (
    <View>
      <Pressable
        onPress={() => setOpen(o => !o)}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        style={({ pressed }) => [s.head, pressed && s.pressed]}
      >
        <View style={open ? s.caretOpen : undefined}><ChevronRight size={15} strokeWidth={2} color={t.colors.fgFaint} /></View>
        <Text variant="bodySm" tone="subtle" numberOfLines={1} style={s.sum}>{stepsSummary(steps)}</Text>
        {failed ? <Text variant="bodySm" tone="error">· {failed} failed</Text> : null}
      </Pressable>
      {visible.length
        ? (
            <View style={s.body}>
              {visible.map((step, i) => step.type === 'thinking'
                ? <ChatThinking key={step.id ?? i} text={step.text} seconds={step.seconds} live={live && step === latest && step.seconds === 0} />
                : <ChatTool key={step.id ?? i} part={step} onOpenChild={onOpenChild} />)}
            </View>
          )
        : null}
    </View>
  )
}

/** A thinking block: "Thought for 6s", opening to the text; "Thinking…" breathes while it runs. */
export function ChatThinking({ text, seconds, live = false }: { text: string; seconds: number; live?: boolean }) {
  const t = useTheme()
  const s = useStyles()
  const reduced = useReducedMotion()
  const [open, setOpen] = useState(false)
  const breathe = useRef(new Animated.Value(1)).current
  useEffect(() => {
    if (!live || reduced) { breathe.setValue(1); return }
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(breathe, { toValue: 0.45, duration: 800, easing: easeInOut, useNativeDriver: true }),
      Animated.timing(breathe, { toValue: 1, duration: 800, easing: easeInOut, useNativeDriver: true }),
    ]))
    loop.start()
    return () => loop.stop()
  }, [live, reduced, breathe])

  return (
    <View>
      <Pressable
        onPress={() => setOpen(o => !o)}
        disabled={!text}
        accessibilityRole="button"
        accessibilityState={{ expanded: open, disabled: !text }}
        style={({ pressed }) => [s.head, pressed && s.pressed]}
      >
        {text ? <View style={open ? s.caretOpen : undefined}><ChevronRight size={15} strokeWidth={2} color={t.colors.fgFaint} /></View> : null}
        {live
          ? <Animated.View style={{ opacity: breathe }}><Text variant="bodySm" tone="muted">Thinking…</Text></Animated.View>
          : <Text variant="bodySm" tone="subtle">Thought for {seconds}s</Text>}
      </Pressable>
      {text && (open || live) ? <Text variant="bodySm" tone="subtle" selectable style={s.thought}>{text}</Text> : null}
    </View>
  )
}

const useStyles = makeStyles(t => ({
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[1],
    minHeight: touch.min - 8,
    alignSelf: 'flex-start',
    maxWidth: '100%',
    paddingHorizontal: space[2],
    marginLeft: -space[2],
    borderRadius: radius.sm,
  },
  pressed: { backgroundColor: t.colors.bgHover },
  caretOpen: { transform: [{ rotate: '90deg' }] },
  sum: { flexShrink: 1 },
  body: { paddingLeft: 0 },
  thought: {
    marginTop: 2,
    marginBottom: space[1],
    marginLeft: 9,
    paddingLeft: space[3],
    borderLeftWidth: 1,
    borderLeftColor: t.colors.line,
    lineHeight: 24,
  },
}))
