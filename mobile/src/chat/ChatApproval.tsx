import { ScrollView, View } from 'react-native'
import { Ban, Check, ShieldQuestionMark } from 'lucide-react-native'
import type { Part } from '~/types/chat'
import { makeStyles, space, useTheme } from '@/theme'
import { Button, ButtonRow, Text } from '@/ui'

export type ApprovalPart = Extract<Part, { type: 'approval' }>

export interface ChatApprovalProps {
  part: ApprovalPart
  /** "Claude Code", "Codex": who asks, when the part has no title of its own. */
  agentName: string
  /** Allow once (true) or deny (false). The haptic is played here. */
  onResolve: (allow: boolean) => void
}

/**
 * An approval the agent waits on (the desktop's `ChatApproval.vue`). Pending: a card in the Blush
 * Coral border and wash with the command in an Inset Well, holding the view's one primary button.
 * Settled: one quiet line; the tool row above tells the rest.
 */
export function ChatApproval({ part, agentName, onResolve }: ChatApprovalProps) {
  const t = useTheme()
  const s = useStyles()

  if (part.state !== 'pending') {
    const allowed = part.state === 'allowed'
    return (
      <View style={s.done}>
        {allowed
          ? <Check size={13} strokeWidth={2} color={t.colors.ripeQueuedFg} />
          : <Ban size={13} strokeWidth={2} color={t.colors.fgFaint} />}
        <Text variant="caption" tone={part.state === 'denied' ? 'subtle' : 'faint'}>
          {allowed ? 'You allowed this' : part.state === 'denied' ? 'You denied this' : 'Not answered'}
        </Text>
      </View>
    )
  }

  const title = part.title ?? `${agentName} wants to run a command`
  return (
    <View style={s.card} accessibilityRole="summary" accessibilityLabel={title}>
      <View style={s.head}>
        <ShieldQuestionMark size={17} strokeWidth={1.85} color={t.colors.ripeWaiting} />
        <Text variant="bodySm" style={s.title}>{title}</Text>
      </View>
      {part.command
        ? (
            <ScrollView style={s.cmd} contentContainerStyle={s.cmdPad} nestedScrollEnabled>
              <Text variant="mono" selectable>{part.command}</Text>
            </ScrollView>
          )
        : null}
      {part.reason ? <Text variant="caption" tone="subtle" selectable style={s.reason}>{part.reason}</Text> : null}
      <ButtonRow style={s.actions}>
        <Button label="Allow once" variant="primary" haptic="success" onPress={() => onResolve(true)} />
        <Button label="Deny" variant="ghost" haptic="warning" onPress={() => onResolve(false)} />
      </ButtonRow>
    </View>
  )
}

const useStyles = makeStyles(t => ({
  card: {
    marginVertical: 6,
    padding: space[3],
    borderRadius: t.radius.md,
    borderCurve: 'continuous',
    borderWidth: 1,
    borderColor: t.colors.waitingLine,
    backgroundColor: t.colors.waitingWash,
    boxShadow: t.shadow.soft,
  },
  head: { flexDirection: 'row', alignItems: 'center', gap: space[2] },
  title: { flex: 1, ...t.fonts.semibold },
  cmd: {
    marginTop: space[2],
    maxHeight: 200,
    borderRadius: t.radius.sm,
    borderCurve: 'continuous',
    borderWidth: 1,
    borderColor: t.colors.lineSoft,
    backgroundColor: t.colors.bgInset,
  },
  cmdPad: { paddingVertical: space[2], paddingHorizontal: 10 },
  reason: { marginTop: space[2] },
  actions: { marginTop: space[3] },
  done: { flexDirection: 'row', alignItems: 'center', gap: 6, marginLeft: 26, marginBottom: 2, minHeight: 24 },
}))
