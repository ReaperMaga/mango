import { Image, Pressable, View } from 'react-native'
import { CircleAlert, Ellipsis, FileText, Pin } from 'lucide-react-native'
import { AGENTS, type Message, type Part, type QuestionAnswers, type Thread } from '~/types/chat'
import { makeStyles, space, useTheme } from '@/theme'
import { Text } from '@/ui'
import { ChatApproval } from './ChatApproval'
import { ChatChanges } from './ChatChanges'
import { ChatMarkdown } from './ChatMarkdown'
import { ChatQuestion } from './ChatQuestion'
import { ChatSteps, ChatThinking, type Step } from './ChatSteps'
import { ChatTool } from './ChatTool'
import { formatCost, formatTokens } from '~/agents/context'
import { formatDuration } from './time'
import { useThreads } from '@/state/threads'
import type { ToolCalls } from '@/state/prefsModel'

/** Which tool rows show, as the desktop's Settings > Behaviour. Approvals, questions and errors always show. */
export type ToolCallsMode = ToolCalls

export interface ChatMessageProps {
  message: Message
  thread: Thread
  /** The chat's last message: while a run is active it is still being written. */
  last?: boolean
  toolCalls?: ToolCallsMode
  /** `index` is the part's position in `message.parts`. */
  onResolveApproval?: (index: number, allow: boolean) => void
  onAnswerQuestion?: (index: number, answers: QuestionAnswers | null) => void
  /** Open a sub-agent's chat from the tool row that started it. */
  onOpenChild?: (childId: string) => void
  /** Open the message's actions (copy, pin, edit, ask again, branch). Without it the message has no menu. */
  onActions?: (message: Message) => void
}

type Segment =
  | { kind: 'part'; key: string; part: Part; i: number }
  | { kind: 'steps'; key: string; steps: Step[]; end: number }

/** A delegated task keeps its own row, so its way into the sub-agent's chat is never folded away. */
const isStep = (p: Part): p is Step => p.type === 'thinking' || (p.type === 'tool' && !p.childId)

/** Runs of two or more thinking/tool rows fold into one ChatSteps; everything else stands alone. */
function segmentsOf(parts: Part[], mode: ToolCallsMode): Segment[] {
  const lastText = parts.map(p => p.type).lastIndexOf('text')
  const shown = parts.map((_, i) => i).filter((i) => {
    const p = parts[i]!
    if (mode === 'zen') return p.type === 'approval' || p.type === 'question' || p.type === 'notice' || i === lastText
    if (p.type === 'tool' && !p.childId) {
      if (mode === 'hide') return false
      if (mode === 'hide-ok') return p.status !== 'ok'
    }
    return true
  })
  const out: Segment[] = []
  for (let n = 0; n < shown.length;) {
    let last = n
    while (isStep(parts[shown[n]!]!) && last + 1 < shown.length && isStep(parts[shown[last + 1]!]!)) last++
    const i = shown[n]!
    if (last > n) {
      const steps = shown.slice(n, last + 1).map(k => parts[k]) as Step[]
      out.push({ kind: 'steps', key: `s:${steps[0]!.id ?? i}`, steps, end: shown[last]! })
    } else {
      const part = parts[i]!
      out.push({ kind: 'part', key: `p:${('id' in part && part.id) || i}`, part, i })
    }
    n = last + 1
  }
  return out
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/**
 * One message, as the desktop's `ChatMessage.vue`. The person's: a Panel Lift bubble at the right
 * with one squared corner, so it reads as spoken from the right. The agent's: no container at all,
 * prose on the canvas with its tool rows, approvals and questions in order, and a quiet
 * "Worked for" line once the turn is over.
 */
export function ChatMessage({ message, thread, last = false, toolCalls = 'all', onResolveApproval, onAnswerQuestion, onOpenChild, onActions }: ChatMessageProps) {
  // Pictures in replies are read where the chat works: its worktree, else the project.
  const pictureBase = useThreads(st => st.workdirFor(thread.id)) ?? thread.projectPath
  const t = useTheme()
  const s = useStyles()
  const agentName = AGENTS[thread.agent].name

  const clock = new Date(message.createdAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  const meta = (live: boolean) => (live
    ? null
    : (
        <View style={[s.meta, message.role === 'user' && s.metaUser]}>
          <Text variant="micro" tone="faint" tabular>{clock}</Text>
          {message.pinned ? <Pin size={12} strokeWidth={2} color={t.colors.accentInk} accessibilityLabel="Pinned" /> : null}
          {onActions
            ? (
                <Pressable
                  onPress={() => onActions(message)}
                  hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
                  accessibilityRole="button"
                  accessibilityLabel="Message actions"
                  style={({ pressed }) => [s.more, pressed && s.morePressed]}
                >
                  <Ellipsis size={16} strokeWidth={1.85} color={t.colors.fgFaint} />
                </Pressable>
              )
            : null}
        </View>
      ))

  if (message.role === 'user') {
    const text = message.parts.filter(p => p.type === 'text').map(p => (p as { text: string }).text).join('\n\n')
    return (
      <View style={s.user}>
        {message.fromAgent ? <Text variant="caption" tone="faint" style={s.from}>Task from {agentName}</Text> : null}
        {message.attachments?.length
          ? (
              <View style={s.files} accessibilityLabel="Attachments">
                {message.attachments.map(a => (
                  // A thumbnail is the desktop's own small data-URL preview: shown, never fetched.
                  a.thumb?.startsWith('data:image/')
                    ? <Image key={a.id} source={{ uri: a.thumb }} style={s.thumb} accessibilityLabel={a.name} resizeMode="cover" />
                    : (
                        <View key={a.id} style={s.file}>
                          <FileText size={18} strokeWidth={1.75} color={t.colors.fgSubtle} />
                          <View style={s.fileMeta}>
                            <Text variant="caption" numberOfLines={1} style={s.fileName}>{a.name}</Text>
                            <Text variant="micro" tone="subtle" tabular>{formatSize(a.size)}</Text>
                          </View>
                        </View>
                      )
                ))}
              </View>
            )
          : null}
        {text ? <View style={s.bubble}><Text variant="chat" selectable>{text}</Text></View> : null}
        {text ? meta(false) : null}
      </View>
    )
  }

  const live = last && (thread.status === 'running' || thread.status === 'queued' || thread.status === 'waiting')
  const parts = message.parts
  let lastTextIndex = -1
  for (let i = parts.length - 1; i >= 0; i--) if (parts[i]!.type === 'text') { lastTextIndex = i; break }

  return (
    <View style={s.agent}>
      {segmentsOf(parts, toolCalls).map((seg) => {
        if (seg.kind === 'steps') {
          return <ChatSteps key={seg.key} steps={seg.steps} live={live && seg.end === parts.length - 1} onOpenChild={onOpenChild} />
        }
        const p = seg.part
        switch (p.type) {
          case 'thinking':
            return <ChatThinking key={seg.key} text={p.text} seconds={p.seconds} live={live && p.seconds === 0} />
          case 'tool':
            return <ChatTool key={seg.key} part={p} onOpenChild={onOpenChild} />
          case 'approval':
            return <ChatApproval key={seg.key} part={p} agentName={agentName} onResolve={allow => onResolveApproval?.(seg.i, allow)} />
          case 'question':
            return <ChatQuestion key={seg.key} part={p} agentName={agentName} onAnswer={a => onAnswerQuestion?.(seg.i, a)} />
          case 'notice':
            return (
              <View key={seg.key} style={s.notice} accessibilityRole={p.level === 'error' ? 'alert' : undefined}>
                {p.level === 'error' ? <CircleAlert size={16} strokeWidth={1.85} color={t.colors.ripeErrorFg} style={s.noticeIcon} /> : null}
                <Text variant="bodySm" tone={p.level === 'error' ? 'error' : 'subtle'} selectable style={s.noticeText}>{p.text}</Text>
              </View>
            )
          case 'text':
            return (
              <View key={seg.key} style={s.text}>
                <ChatMarkdown text={p.text} base={pictureBase} streaming={live && seg.i === lastTextIndex && seg.i === parts.length - 1} />
              </View>
            )
        }
        return null
      })}
      {!live ? <ChatChanges message={message} thread={thread} /> : null}
      {message.elapsedMs !== undefined && !live
        ? (
            <Text variant="caption" tone="faint" tabular style={s.ran}>
              {message.outcome === 'stopped' ? 'Stopped after' : message.outcome === 'error' ? 'Failed after' : 'Worked for'} {formatDuration(message.elapsedMs)}
              {message.usage
                ? ` · ${[`${formatTokens(message.usage.input)} in`, `${formatTokens(message.usage.output)} out`, ...(message.usage.costUsd !== undefined ? [formatCost(message.usage.costUsd)] : [])].join(' · ')}`
                : ''}
            </Text>
          )
        : null}
      {meta(live)}
    </View>
  )
}

const useStyles = makeStyles(t => ({
  user: { alignItems: 'flex-end', gap: 2 },
  from: { marginBottom: 2 },
  bubble: {
    maxWidth: '88%',
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: t.radius.lg,
    borderBottomRightRadius: t.radius.xs,
    borderCurve: 'continuous',
    backgroundColor: t.colors.bgPanel,
    borderWidth: 1,
    borderColor: t.colors.lineSoft,
  },
  files: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-end', gap: space[2], maxWidth: '88%', marginBottom: space[1] },
  file: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[2],
    minHeight: 48,
    maxWidth: 240,
    paddingLeft: 10,
    paddingRight: space[3],
    borderWidth: 1,
    borderColor: t.colors.lineSoft,
    borderRadius: t.radius.md,
    backgroundColor: t.colors.bgPanel,
  },
  fileMeta: { minWidth: 0, flexShrink: 1 },
  fileName: { ...t.fonts.medium, color: t.colors.fg },
  thumb: { width: 140, height: 100, borderRadius: t.radius.md, borderWidth: 1, borderColor: t.colors.lineSoft, backgroundColor: t.colors.bgInset },
  agent: { gap: 2 },
  text: { marginTop: 6, marginBottom: 2 },
  notice: { flexDirection: 'row', alignItems: 'flex-start', gap: space[2], marginTop: 6 },
  noticeIcon: { marginTop: 3 },
  noticeText: { flex: 1 },
  ran: { marginTop: space[2] },
  meta: { flexDirection: 'row', alignItems: 'center', gap: space[2], marginTop: 2, minHeight: 20 },
  metaUser: { justifyContent: 'flex-end' },
  more: { width: 28, height: 20, alignItems: 'center', justifyContent: 'center', borderRadius: t.radius.sm },
  morePressed: { backgroundColor: t.colors.bgActive },
}))
