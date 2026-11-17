import { useEffect, useRef, useState } from 'react'
import { Pressable, ScrollView, StyleSheet, View, type ScrollViewInstance } from 'react-native'
import { ArrowUpRight, Bot, ChevronRight, CircleAlert, CircleCheck, CircleSlash, CircleStop, ScrollText, SquareTerminal, Activity, type LucideProps } from 'lucide-react-native'
import type { ComponentType } from 'react'
import type { BackgroundTask } from '~/types/chat'
import { fonts, makeStyles, radius, space, touch, useTheme } from '@/theme'
import { IconButton, Sheet, Spinner, Text } from '@/ui'
import { useNow } from './time'
import { plainOutput, taskDetail, taskElapsed, tasksSummary } from './tasks'

const KIND_ICONS: Record<BackgroundTask['kind'], ComponentType<LucideProps>> = { command: SquareTerminal, agent: Bot, other: Activity }
const KIND_WORDS: Record<BackgroundTask['kind'], string> = { command: 'Command', agent: 'Sub-agent', other: 'Task' }

export interface ChatTasksProps {
  tasks: BackgroundTask[]
  onPress: () => void
}

/**
 * The line under the working row while the run keeps something going in the background: how many
 * still run. Tapping it opens the list (`ChatTasksSheet`).
 */
export function ChatTasks({ tasks, onPress }: ChatTasksProps) {
  const t = useTheme()
  const s = useStyles()
  if (!tasks.length) return null
  const { running, text } = tasksSummary(tasks)
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`Background tasks, ${text}`}
      accessibilityHint="Shows what runs in the background"
      style={({ pressed }) => [s.bar, pressed && s.pressed]}
    >
      {running ? <Spinner size={13} color={t.colors.ripeRunning} /> : <CircleCheck size={15} strokeWidth={1.75} color={t.colors.ripeDoneFg} />}
      <Text variant="bodySm" style={s.barTitle}>Background</Text>
      <Text variant="caption" tone="subtle" tabular numberOfLines={1} style={s.barCount}>{text}</Text>
      <ChevronRight size={16} strokeWidth={2} color={t.colors.fgFaint} />
    </Pressable>
  )
}

export interface ChatTasksSheetProps {
  visible: boolean
  onClose: () => void
  tasks: BackgroundTask[]
  onStop: (taskId: string) => void
  /** The end of a command's output; null when it has none to show. */
  readOutput: (taskId: string) => Promise<string | null>
  /** The chat a background sub-agent writes, when it has one. */
  childOf: (task: BackgroundTask) => string | null
  onOpenChild: (childId: string) => void
}

/**
 * What the chat's run keeps going in the background (the desktop's `ChatTasks.vue`): commands
 * started with "run in background", commands that outlived their timeout, sub-agents nobody waits
 * for. One row each with how long it has run, a peek at a command's output, and a stop button.
 * Finished ones stay until the run ends, so a glance says what happened.
 */
export function ChatTasksSheet({ visible, onClose, tasks, onStop, readOutput, childOf, onOpenChild }: ChatTasksSheetProps) {
  const s = useStyles()
  const now = useNow(1000)
  const [peeking, setPeeking] = useState<string | null>(null)
  // A task gone with its run takes its output with it.
  useEffect(() => { if (peeking && !tasks.some(x => x.id === peeking)) setPeeking(null) }, [tasks, peeking])
  useEffect(() => { if (!visible) setPeeking(null) }, [visible])
  const { text } = tasksSummary(tasks)

  return (
    <Sheet visible={visible} onClose={onClose} title="Background">
      {tasks.length
        ? (
            <View style={s.list}>
              <Text variant="caption" tone="subtle" style={s.summary}>{text}</Text>
              <View style={s.group}>
                {tasks.map((task, i) => (
                  <TaskRow
                    key={task.id}
                    task={task}
                    first={i === 0}
                    now={now}
                    peeking={peeking === task.id}
                    onPeek={() => setPeeking(p => (p === task.id ? null : task.id))}
                    onStop={() => onStop(task.id)}
                    readOutput={readOutput}
                    child={childOf(task)}
                    onOpenChild={(id) => { onClose(); onOpenChild(id) }}
                  />
                ))}
              </View>
              <Text variant="caption" tone="faint" style={s.summary}>Finished tasks stay here until the run ends.</Text>
            </View>
          )
        : <Text variant="bodySm" tone="subtle" style={s.empty}>Nothing runs in the background now.</Text>}
    </Sheet>
  )
}

function TaskRow({ task, first, now, peeking, onPeek, onStop, readOutput, child, onOpenChild }: {
  task: BackgroundTask
  first: boolean
  now: number
  peeking: boolean
  onPeek: () => void
  onStop: () => void
  readOutput: (taskId: string) => Promise<string | null>
  child: string | null
  onOpenChild: (id: string) => void
}) {
  const t = useTheme()
  const s = useStyles()
  const running = task.status === 'running'
  const Kind = KIND_ICONS[task.kind]
  const detail = taskDetail(task)
  const elapsed = taskElapsed(task, now)
  const hasOutput = task.kind === 'command' || task.kind === 'other'
  const endColor = task.status === 'done' ? t.colors.ripeDoneFg : task.status === 'error' ? t.colors.ripeErrorFg : t.colors.fgFaint
  const EndIcon = task.status === 'done' ? CircleCheck : task.status === 'error' ? CircleAlert : CircleSlash

  return (
    <View style={[s.item, !first && s.rule]}>
      <View style={s.line}>
        <View style={s.row} accessible accessibilityLabel={`${KIND_WORDS[task.kind]}: ${task.title}. ${detail ?? 'Running'}, ${elapsed}`}>
          <View style={s.status}>
            {running ? <Spinner size={14} color={t.colors.ripeRunning} /> : <EndIcon size={16} strokeWidth={1.75} color={endColor} />}
          </View>
          <View style={s.text}>
            <View style={s.titleLine}>
              <Kind size={14} strokeWidth={1.75} color={t.colors.fgFaint} />
              <Text variant="bodySm" tone={running ? 'fg' : 'subtle'} numberOfLines={1} style={s.title}>{task.title}</Text>
            </View>
            <Text variant="caption" tone="subtle" numberOfLines={2}>
              <Text variant="caption" tone="subtle" tabular>{elapsed}</Text>
              {detail ? ` · ${detail}` : ''}
            </Text>
          </View>
        </View>
        <View style={s.actions}>
          {hasOutput
            ? <IconButton icon={ScrollText} size="sm" label={peeking ? 'Hide output' : 'Show output'} active={peeking} onPress={onPeek} />
            : child
              ? <IconButton icon={ArrowUpRight} size="sm" label="Open the sub-agent's chat" onPress={() => onOpenChild(child)} />
              : null}
          {running ? <IconButton icon={CircleStop} size="sm" label={`Stop ${task.title}`} haptic="warning" onPress={onStop} /> : null}
        </View>
      </View>
      {peeking ? <TaskOutput taskId={task.id} running={running} readOutput={readOutput} /> : null}
    </View>
  )
}

/** The end of a command's output, read again every 1.5 s while it runs. */
function TaskOutput({ taskId, running, readOutput }: { taskId: string; running: boolean; readOutput: (id: string) => Promise<string | null> }) {
  const s = useStyles()
  const [state, setState] = useState<'loading' | 'ready' | 'none'>('loading')
  const [output, setOutput] = useState('')
  const scroller = useRef<ScrollViewInstance>(null)

  useEffect(() => {
    let alive = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const read = async () => {
      const text = await readOutput(taskId).catch(() => null)
      if (!alive) return
      if (text === null) setState(st => (st === 'loading' ? 'none' : st))
      else { setOutput(plainOutput(text)); setState('ready') }
      if (running) timer = setTimeout(read, 1500)
    }
    void read()
    return () => { alive = false; clearTimeout(timer) }
  }, [taskId, running, readOutput])

  const note = state === 'loading' ? 'Reading output…' : state === 'none' ? 'This task has no output to show.' : 'No output yet.'
  return (
    <View style={s.outWrap}>
      <View style={s.out}>
        {state === 'ready' && output
          ? (
              <ScrollView
                ref={scroller}
                style={s.outScroll}
                contentContainerStyle={s.outBody}
                nestedScrollEnabled
                onContentSizeChange={() => scroller.current?.scrollToEnd({ animated: false })}
              >
                <Text variant="monoSm" tone="muted" selectable>{output}</Text>
              </ScrollView>
            )
          : <Text variant="caption" tone="faint" style={s.outBody}>{note}</Text>}
      </View>
    </View>
  )
}

const useStyles = makeStyles(t => ({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[2],
    minHeight: touch.min,
    paddingHorizontal: space[3],
    borderRadius: radius.md,
    borderCurve: 'continuous',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: t.colors.lineSoft,
    backgroundColor: t.colors.bgPanel,
  },
  pressed: { backgroundColor: t.colors.bgActive },
  barTitle: { fontFamily: fonts.semibold },
  barCount: { flex: 1 },
  list: { gap: space[2] },
  summary: { paddingHorizontal: space[1] },
  group: { borderRadius: radius.lg, borderCurve: 'continuous', borderWidth: 1, borderColor: t.colors.line, overflow: 'hidden' },
  item: { paddingLeft: space[3], paddingRight: space[1], paddingVertical: space[2] },
  line: { flexDirection: 'row', alignItems: 'center' },
  rule: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: t.colors.line },
  row: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: space[3], minHeight: touch.min - 4 },
  status: { width: 18, alignItems: 'center' },
  text: { flex: 1, minWidth: 0, gap: 2 },
  titleLine: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  title: { flexShrink: 1, fontFamily: fonts.medium },
  actions: { flexDirection: 'row', alignItems: 'center', gap: space[1], paddingLeft: space[1] },
  // Padding, not margins, keeps the box inside the row (a stretched child's margins overflow on the web).
  outWrap: { paddingTop: space[2], paddingRight: space[2], paddingLeft: 18 + space[3] },
  out: {
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: t.colors.lineSoft,
    backgroundColor: t.colors.bgInset,
    overflow: 'hidden',
  },
  outScroll: { maxHeight: 200 },
  outBody: { paddingVertical: space[2], paddingHorizontal: space[3] },
  empty: { paddingVertical: space[4] },
}))
