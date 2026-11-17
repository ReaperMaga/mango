import { useState } from 'react'
import { Pressable, TextInput, View } from 'react-native'
import { Ban, Check, MessageCircleQuestionMark } from 'lucide-react-native'
import type { AgentQuestion, Part, QuestionAnswers } from '~/types/chat'
import { fonts, fontSize, makeStyles, radius, space, touch, useTheme } from '@/theme'
import { Button, ButtonRow, Text, haptic } from '@/ui'

export type QuestionPart = Extract<Part, { type: 'question' }>

export interface ChatQuestionProps {
  part: QuestionPart
  agentName: string
  /** One answer per question (picked labels, then any typed text); null when dismissed. */
  onAnswer: (answers: QuestionAnswers | null) => void
}

interface Picked { labels: string[]; other: boolean; text: string }

const typed = (q: AgentQuestion) => q.freeText === true || !q.options.length
const isOption = (q: AgentQuestion, v: string) => q.options.some(o => o.label === v)

/**
 * Questions for the person (the desktop's `ChatQuestion.vue`): Claude Code's AskUserQuestion,
 * Codex's request_user_input, an MCP server's form. While pending: each question with its options
 * (one, or several when it allows), an "Other" field where an answer may be typed (or only a field,
 * without options); then Answer or Dismiss. Secret answers are hidden as typed and never kept.
 * Settled: what was answered, in one quiet block.
 */
export function ChatQuestion({ part, agentName, onAnswer }: ChatQuestionProps) {
  const t = useTheme()
  const s = useStyles()
  const [picked, setPicked] = useState<Picked[]>(() => part.questions.map((q) => {
    const preset = q.preset ?? []
    const text = preset.find(v => !isOption(q, v)) ?? ''
    return { labels: preset.filter(v => isOption(q, v)), other: !!text && q.options.length > 0, text }
  }))

  const update = (qi: number, f: (p: Picked) => Picked) => setPicked(all => all.map((p, i) => (i === qi ? f(p) : p)))
  const toggle = (qi: number, label: string) => {
    const q = part.questions[qi]!
    haptic('select')
    update(qi, p => q.multiSelect
      ? { ...p, labels: p.labels.includes(label) ? p.labels.filter(l => l !== label) : [...p.labels, label] }
      : { ...p, labels: [label], other: false })
  }
  const pickOther = (qi: number, on: boolean) => {
    const q = part.questions[qi]!
    update(qi, p => ({ ...p, other: on, labels: on && !q.multiSelect ? [] : p.labels }))
  }
  const typeOther = (qi: number, text: string) => {
    const q = part.questions[qi]!
    update(qi, p => (text.trim() && q.options.length
      ? { ...p, text, other: true, labels: q.multiSelect ? p.labels : [] }
      : { ...p, text }))
  }

  const answerOf = (qi: number): string[] => {
    const q = part.questions[qi]!
    const p = picked[qi]!
    const own = (p.other || !q.options.length) ? p.text.trim() : ''
    return [...p.labels, ...(own ? [own] : [])]
  }
  const problemOf = (qi: number): string => {
    const q = part.questions[qi]!
    if (!answerOf(qi).length) return q.optional ? '' : 'needed'
    const own = (picked[qi]!.other || !q.options.length) ? picked[qi]!.text.trim() : ''
    if (own && q.format) {
      const n = Number(own)
      if (!Number.isFinite(n)) return 'Enter a number.'
      if (q.format === 'integer' && !Number.isInteger(n)) return 'Enter a whole number.'
    }
    return ''
  }
  const ready = part.questions.every((_, i) => !problemOf(i))
  const submit = () => {
    if (!ready) return
    haptic('success')
    onAnswer(part.questions.map((_, i) => answerOf(i)))
  }

  const title = part.title ?? (part.questions.length === 1 ? `${agentName} has a question` : `${agentName} has ${part.questions.length} questions`)

  if (part.state === 'answered' && part.answers) {
    return (
      <View style={s.done} accessibilityLabel="Your answers">
        <View style={s.doneHead}>
          <Check size={13} strokeWidth={2} color={t.colors.ripeQueuedFg} />
          <Text variant="caption" tone="faint">{part.title ? `You answered ${part.title.replace(/ asks$/, '')}` : 'You answered'}</Text>
        </View>
        <View style={s.doneList}>
          {part.questions.map((q, qi) => {
            const a = part.answers?.[qi] ?? []
            return (
              <View key={qi} style={s.doneRow}>
                <Text variant="caption" tone="subtle" style={s.doneQ}>{q.header || q.question}</Text>
                <Text variant="caption" tone="muted" selectable style={s.doneA}>{a.length ? a.join(', ') : 'No answer'}</Text>
              </View>
            )
          })}
        </View>
      </View>
    )
  }
  if (part.state !== 'pending') {
    return (
      <View style={[s.done, s.doneHead]}>
        <Ban size={13} strokeWidth={2} color={t.colors.fgFaint} />
        <Text variant="caption" tone="faint">{part.state === 'dismissed' ? 'You dismissed the question' : 'Not answered'}</Text>
      </View>
    )
  }

  return (
    <View style={s.card} accessibilityLabel={title}>
      <View style={s.head}>
        <MessageCircleQuestionMark size={17} strokeWidth={1.85} color={t.colors.ripeWaiting} />
        <Text variant="bodySm" style={s.title}>{title}</Text>
      </View>
      {part.message ? <Text variant="bodySm" tone="muted" selectable style={s.message}>{part.message}</Text> : null}

      {part.questions.map((q, qi) => {
        const p = picked[qi]!
        const problem = p.text.trim() ? problemOf(qi) : ''
        return (
          <View key={qi} style={s.q}>
            <View style={s.legend}>
              {q.header ? <View style={s.tag}><Text variant="micro" tone="muted" style={s.tagText}>{q.header}</Text></View> : null}
              <Text variant="bodySm" selectable style={s.qText}>{q.question}</Text>
              {q.multiSelect ? <Text variant="caption" tone="faint">Pick any</Text> : q.optional ? <Text variant="caption" tone="faint">Optional</Text> : null}
            </View>
            {q.detail ? <Text variant="caption" tone="subtle" selectable style={s.detail}>{q.detail}</Text> : null}

            <View style={s.options} accessibilityRole={q.multiSelect ? undefined : 'radiogroup'}>
              {q.options.map((o, oi) => {
                const on = p.labels.includes(o.label)
                return (
                  <Pressable
                    key={oi}
                    onPress={() => toggle(qi, o.label)}
                    accessibilityRole={q.multiSelect ? 'checkbox' : 'radio'}
                    accessibilityState={{ checked: on }}
                    accessibilityLabel={o.description ? `${o.label}, ${o.description}` : o.label}
                    style={({ pressed }) => [s.opt, on && s.optOn, pressed && !on && s.optPressed]}
                  >
                    <Mark multi={!!q.multiSelect} on={on} />
                    <View style={s.copy}>
                      <Text variant="bodySm" style={s.label}>{o.label}</Text>
                      {o.description ? <Text variant="caption" tone="subtle">{o.description}</Text> : null}
                    </View>
                  </Pressable>
                )
              })}
              {typed(q) && q.options.length
                ? (
                    <View style={[s.opt, s.otherRow, p.other && s.optOn]}>
                      <Pressable
                        onPress={() => pickOther(qi, q.multiSelect ? !p.other : true)}
                        hitSlop={12}
                        accessibilityRole={q.multiSelect ? 'checkbox' : 'radio'}
                        accessibilityState={{ checked: p.other }}
                        accessibilityLabel="Other"
                      >
                        <Mark multi={!!q.multiSelect} on={p.other} />
                      </Pressable>
                      <TextInput
                        value={p.text}
                        onChangeText={v => typeOther(qi, v)}
                        onFocus={() => { if (p.text.trim()) pickOther(qi, true) }}
                        placeholder={q.placeholder ?? 'Other: answer in your own words'}
                        placeholderTextColor={t.colors.fgFaint}
                        selectionColor={t.colors.accent}
                        cursorColor={t.colors.accent}
                        keyboardAppearance={t.dark ? 'dark' : 'light'}
                        secureTextEntry={q.secret}
                        autoCapitalize="none"
                        autoCorrect={!q.secret}
                        accessibilityLabel={`Your own answer to: ${q.question}`}
                        returnKeyType="done"
                        onSubmitEditing={submit}
                        style={s.otherField}
                      />
                    </View>
                  )
                : typed(q)
                  ? (
                      <TextInput
                        value={p.text}
                        onChangeText={v => typeOther(qi, v)}
                        placeholder={q.placeholder ?? (q.format ? 'A number' : 'Your answer')}
                        placeholderTextColor={t.colors.fgFaint}
                        selectionColor={t.colors.accent}
                        cursorColor={t.colors.accent}
                        keyboardAppearance={t.dark ? 'dark' : 'light'}
                        keyboardType={q.format ? (q.format === 'integer' ? 'number-pad' : 'decimal-pad') : 'default'}
                        secureTextEntry={q.secret}
                        autoCapitalize="none"
                        autoCorrect={!q.secret}
                        accessibilityLabel={q.question}
                        returnKeyType="done"
                        onSubmitEditing={submit}
                        style={[s.field, !!problem && s.fieldBad]}
                      />
                    )
                  : null}
            </View>
            {problem && problem !== 'needed' ? <Text variant="caption" tone="error" accessibilityRole="alert" style={s.note}>{problem}</Text> : null}
            {q.secret ? <Text variant="caption" tone="faint" style={s.note}>Hidden as you type, and not kept in the chat.</Text> : null}
          </View>
        )
      })}

      <ButtonRow style={s.actions}>
        <Button label="Answer" variant="primary" disabled={!ready} onPress={submit} />
        <Button label="Dismiss" variant="ghost" haptic="light" onPress={() => onAnswer(null)} />
      </ButtonRow>
    </View>
  )
}

/** The radio dot or checkbox: Inset Well at rest, Ripe Mango filled when picked. */
function Mark({ multi, on }: { multi: boolean; on: boolean }) {
  const t = useTheme()
  const s = useStyles()
  return (
    <View style={[s.mark, multi ? s.box : s.dot, on && s.markOn]}>
      {on && multi ? <Check size={12} strokeWidth={3} color={t.colors.accentFg} /> : null}
      {on && !multi ? <View style={s.dotCore} /> : null}
    </View>
  )
}

const useStyles = makeStyles(t => ({
  card: {
    marginVertical: 6,
    padding: space[3],
    borderRadius: radius.md,
    borderCurve: 'continuous',
    borderWidth: 1,
    borderColor: t.colors.waitingLine,
    backgroundColor: t.colors.waitingWash,
    boxShadow: t.shadow.soft,
  },
  head: { flexDirection: 'row', alignItems: 'center', gap: space[2] },
  title: { flex: 1, fontFamily: fonts.semibold },
  message: { marginTop: space[2] },
  q: { marginTop: space[4] },
  legend: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6, marginBottom: space[2] },
  tag: {
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: radius.xs,
    backgroundColor: t.colors.bgHover,
    borderWidth: 1,
    borderColor: t.colors.lineSoft,
  },
  tagText: { fontFamily: fonts.medium },
  qText: { fontFamily: fonts.medium, color: t.colors.fg, flexShrink: 1 },
  detail: { marginTop: -4, marginBottom: space[2] },
  options: { gap: 6 },
  opt: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space[3],
    minHeight: touch.min,
    paddingVertical: 11,
    paddingHorizontal: space[3],
    borderRadius: radius.sm,
    borderCurve: 'continuous',
    borderWidth: 1,
    borderColor: t.colors.lineSoft,
    backgroundColor: t.colors.bgPanel,
  },
  optOn: { borderColor: t.colors.accentLine, backgroundColor: t.colors.accentWash },
  optPressed: { backgroundColor: t.colors.bgRaised, borderColor: t.colors.lineStrong },
  copy: { flex: 1, minWidth: 0, gap: 1 },
  label: { fontFamily: fonts.medium, color: t.colors.fg },
  mark: {
    width: 18,
    height: 18,
    marginTop: 1,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1.5,
    borderColor: t.colors.lineStrong,
    backgroundColor: t.colors.bgInset,
  },
  dot: { borderRadius: radius.pill },
  box: { borderRadius: radius.xs },
  markOn: { borderColor: t.colors.accent, backgroundColor: t.colors.accent },
  dotCore: { width: 6, height: 6, borderRadius: radius.pill, backgroundColor: t.colors.accentFg },
  otherRow: { alignItems: 'center', paddingVertical: 0 },
  otherField: { flex: 1, minHeight: touch.min - 2, paddingVertical: 0, color: t.colors.fg, fontFamily: fonts.regular, fontSize: fontSize.bodySm },
  field: {
    minHeight: touch.min,
    paddingHorizontal: space[3],
    borderRadius: radius.sm,
    borderCurve: 'continuous',
    borderWidth: 1,
    borderColor: t.colors.line,
    backgroundColor: t.colors.bgInset,
    color: t.colors.fg,
    fontFamily: fonts.regular,
    fontSize: fontSize.body,
  },
  fieldBad: { borderColor: t.colors.errorLineStrong },
  note: { marginTop: space[1] },
  actions: { marginTop: space[4] },
  done: { marginLeft: 26, marginBottom: space[1] },
  doneHead: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 24 },
  doneList: { marginLeft: 19, marginTop: 2, gap: 2 },
  doneRow: { flexDirection: 'row', gap: space[3] },
  doneQ: { flexShrink: 0, maxWidth: '45%' },
  doneA: { flex: 1 },
}))
