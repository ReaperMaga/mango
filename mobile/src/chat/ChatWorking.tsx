import { useEffect, useRef, useState } from 'react'
import { Animated, View } from 'react-native'
import { AGENTS, waitingFor, type Thread } from '~/types/chat'
import { easeInOut, makeStyles, space, touch, useReducedMotion } from '@/theme'
import type { ElsewhereRun } from '@/state/threadModel'
import { RipenessDot, Text } from '@/ui'
import { elsewhereCaption } from './elsewhere'
import { formatDuration } from './time'

export interface ChatWorkingProps {
  thread: Thread
  /** Background tasks still running once the answer is written (the run is open only for them). */
  waitingOnTasks?: number
  /**
   * The run lost its connection and is being attached again: the environment's name. The agent
   * keeps working there meanwhile, so this is said calmly, in place of what it is doing.
   */
  reconnectingTo?: string | null
  /**
   * Another computer is running this chat (the desktop, usually): this phone only watches. The
   * thread's own status is Working either way, so the run says what it is.
   */
  elsewhere?: ElsewhereRun | null
}

/** What the agent is doing right now, in words (the desktop's `ChatWorking.vue`). */
export function workingActivity(t: Thread, waitingOnTasks = 0, reconnectingTo: string | null = null): string {
  const agent = AGENTS[t.agent].name
  if (t.status === 'queued' && t.awaitingWorktree) return 'Making a worktree'
  if (t.status === 'queued') return `Starting ${agent}`
  if (t.status === 'waiting') return `Waiting for your ${waitingFor(t)}`
  if (reconnectingTo) return `Reconnecting to ${reconnectingTo}…`
  if (waitingOnTasks) return `Waiting for ${waitingOnTasks} background task${waitingOnTasks === 1 ? '' : 's'}`
  const last = t.messages[t.messages.length - 1]
  const part = last?.role === 'agent' ? last.parts[last.parts.length - 1] : undefined
  if (!part) return `${agent} is starting up`
  if (part.type === 'thinking' && part.seconds === 0) return 'Thinking'
  if (part.type === 'text') return 'Writing'
  if (part.type === 'tool' && part.status === 'running') {
    switch (part.tool) {
      case 'read': return 'Reading files'
      case 'edit': return 'Editing a file'
      case 'write': return 'Creating a file'
      case 'bash': return 'Running a command'
      case 'search': return 'Searching the project'
      case 'web': return 'Looking something up online'
      default: return part.label ? `${part.label} ${part.target}`.trim() : 'Using a tool'
    }
  }
  return 'Working'
}

/**
 * The live "the agent is at work" row under the conversation: the thread's ripeness dot, what it
 * is doing, three dots taking turns, and how long the turn has run. Present from the moment a
 * message is sent until the turn ends, so the chat never looks idle while something runs.
 */
export function ChatWorking({ thread: saved, waitingOnTasks = 0, reconnectingTo = null, elsewhere = null }: ChatWorkingProps) {
  const s = useStyles()
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])

  const thread = elsewhere ? { ...saved, status: elsewhere.status } : saved
  // The turn started when the person's message was sent.
  let startedAt = thread.updatedAt
  for (let i = thread.messages.length - 1; i >= 0; i--) {
    if (thread.messages[i]!.role === 'user') { startedAt = thread.messages[i]!.createdAt; break }
  }
  const waiting = thread.status === 'waiting'
  // The open approval or question is on the other computer's screen, so the words are not "your approval".
  const activity = elsewhere && waiting ? 'Waiting for you' : workingActivity(thread, waitingOnTasks, reconnectingTo)
  const caption = elsewhere ? elsewhereCaption(elsewhere, now) : null
  const elapsed = formatDuration(Math.max(0, now - startedAt))

  return (
    <View style={s.row} accessibilityRole="progressbar" accessibilityLiveRegion="polite" accessibilityLabel={`${activity}${caption ? `, ${caption}` : ''}, ${elapsed}`}>
      <RipenessDot status={thread.status} size={14} />
      <View style={s.words}>
        <Text variant="bodySm" tone={waiting ? 'waiting' : reconnectingTo ? 'muted' : 'fg'} style={s.label} numberOfLines={1}>{activity}</Text>
        {caption ? <Text variant="caption" tone="subtle" numberOfLines={1}>{caption}</Text> : null}
      </View>
      {waiting ? null : <Dots />}
      <Text variant="bodySm" tone="subtle" tabular numberOfLines={1} style={s.elapsed}>{elapsed}</Text>
    </View>
  )
}

/** Three dots that take turns: unmistakably "in progress" without shouting. */
function Dots() {
  const s = useStyles()
  const reduced = useReducedMotion()
  const dots = useRef([0, 1, 2].map(() => new Animated.Value(0))).current
  useEffect(() => {
    if (reduced) return
    const loops = dots.map((v, i) => Animated.loop(Animated.sequence([
      Animated.delay(i * 150),
      Animated.timing(v, { toValue: 1, duration: 360, easing: easeInOut, useNativeDriver: true }),
      Animated.timing(v, { toValue: 0, duration: 360, easing: easeInOut, useNativeDriver: true }),
      Animated.delay(480 - i * 150),
    ])))
    loops.forEach(l => l.start())
    return () => loops.forEach(l => l.stop())
  }, [reduced, dots])
  return (
    <View style={s.dots} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {dots.map((v, i) => (
        <Animated.View
          key={i}
          style={[s.dot, {
            opacity: v.interpolate({ inputRange: [0, 1], outputRange: [0.25, 1] }),
            transform: [{ translateY: v.interpolate({ inputRange: [0, 1], outputRange: [0, -2] }) }],
          }]}
        />
      ))}
    </View>
  )
}

const useStyles = makeStyles(t => ({
  row: { flexDirection: 'row', alignItems: 'center', gap: space[2], minHeight: touch.min - 8 },
  words: { flexShrink: 1 },
  elapsed: { flexShrink: 0 },
  label: t.fonts.medium,
  dots: { flexDirection: 'row', gap: 3, marginLeft: -3, marginRight: space[1] },
  dot: { width: 3.5, height: 3.5, borderRadius: 2, backgroundColor: t.colors.fg },
}))
