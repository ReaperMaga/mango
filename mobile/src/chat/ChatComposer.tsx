import { useEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from 'react'
import { Animated, Image, Linking, Platform, Pressable, ScrollView, TextInput, View, type TextInputInstance } from 'react-native'
import { useRouter } from 'expo-router'
import { ArrowUp, ChevronDown, CircleAlert, FilePen, FileText, Info, Map as MapIcon, Mic, Paperclip, ShieldCheck, Square, X, Zap, type LucideProps } from 'lucide-react-native'
import { AGENTS, effortLabel, type AgentId, type AgentModel, type ContextUsage, type PermissionMode } from '~/types/chat'
import { easeInOut, fonts, fontSize, makeStyles, radius, space, useReducedMotion, useTheme } from '@/theme'
import { AgentIcon, Badge, ListRow, ListSection, Sheet, Spinner, Text, haptic } from '@/ui'
import { clock, useDictation } from '@/voice'
import { useAgentCommands } from '@/agents/commands'
import { ChatCommandMenu } from './ChatCommandMenu'
import { ContextButton } from './ChatContext'
import { commandsFor, matchCommands, pickedText, slashQuery, type CommandMatch } from './commands'

/** The four permission modes, as the desktop's composer names them. */
export const PERMISSION_MODES: Record<PermissionMode, { label: string; hint: string; icon: ComponentType<LucideProps> }> = {
  plan: { label: 'Plan', hint: 'Read-only: explores and proposes a plan', icon: MapIcon },
  ask: { label: 'Ask first', hint: 'Asks before edits and commands', icon: ShieldCheck },
  edits: { label: 'Accept edits', hint: 'Edits files freely, asks before commands', icon: FilePen },
  auto: { label: 'Full auto', hint: 'Never asks. Use with care.', icon: Zap },
}

export interface ChatComposerProps {
  /** The draft. The composer never clears it itself: the parent does after `onSend`. */
  value: string
  onChangeText: (text: string) => void
  onSend: (text: string) => void
  /** Stop the run. Shown while `running`. */
  onStop?: () => void
  /** The agent is at work: the send button becomes stop (a message typed meanwhile can still be sent: it queues). */
  running?: boolean
  agent: AgentId
  model: string
  mode: PermissionMode
  /** The chosen reasoning effort; null leaves it to the CLI. */
  effort?: string | null
  /** The agent's models (from the CLI when known); `AGENTS[agent].models` otherwise. */
  models?: AgentModel[]
  onModelChange?: (model: string) => void
  onModeChange?: (mode: PermissionMode) => void
  onEffortChange?: (effort: string | null) => void
  placeholder?: string
  /** Nothing can be sent (no connection, a read-only sub-agent chat). */
  disabled?: boolean
  autoFocus?: boolean
  /** Files going with the next message, shown over the input. */
  attachments?: readonly ComposerAttachment[]
  /** Offer to attach files (the paperclip). */
  onAttach?: () => void
  onRemoveAttachment?: (key: string) => void
  /**
   * The folder the agent runs in (the chat's worktree or project). With it, typing `/` asks the
   * agent's CLI there for its commands; without, the list is Mango's and the built-in stand-ins.
   */
  workdir?: string | null
  /** The chat's context window at its last reading (null: none yet, an empty ring). Left out: no ring. */
  context?: ContextUsage | null
  /** The context window is being read from the CLI. */
  contextPending?: boolean
  /** Open the context window's details (the ring). */
  onContext?: () => void
}

/** An attachment as the composer shows it: still uploading, ready, or failed (with why). */
export interface ComposerAttachment {
  key: string
  name: string
  thumb?: string
  state: 'uploading' | 'ready' | 'error'
  error?: string
}

/**
 * The message composer (the desktop's `ChatComposer.vue`, for a thumb): a Panel Lift box with the
 * Soft shadow and 12pt corners, the input growing with the text, and a bar of quiet chips (model,
 * permissions) that open sheets, with the send button at the right. Ripe Mango when there is
 * something to send; while the agent works it becomes stop, in inverted ink.
 *
 * The microphone dictates into the draft (`@/voice`): the words appear as they are heard, at the
 * caret or after the text. While it listens the chips give way to the recording state (a pulsing
 * dot, the clock, a level meter) and a discard button, as on the desktop.
 */
export function ChatComposer(props: ChatComposerProps) {
  const { value, onChangeText, onSend, onStop, running = false, agent, model, mode, effort = null, onModelChange, onModeChange, onEffortChange, disabled = false, autoFocus } = props
  const t = useTheme()
  const s = useStyles()
  const [focused, setFocused] = useState(false)
  const [sheet, setSheet] = useState<'model' | 'mode' | null>(null)
  const [narrow, setNarrow] = useState(false)
  const router = useRouter()
  const selection = useRef<{ start: number; end: number } | null>(null)
  const dictation = useDictation({ value, onChangeText, onSend, selection: () => selection.current })
  const listening = dictation.phase === 'listening' || dictation.phase === 'starting'
  const input = useRef<TextInputInstance>(null)

  // Slash commands: `/` at the start of the draft lists the agent's commands until a space ends the name.
  const query = disabled || dictation.busy ? null : slashQuery(value)
  const live = useAgentCommands(agent, props.workdir, query !== null)
  const matches = useMemo(() => (query === null ? [] : matchCommands(commandsFor(agent, live), query)), [agent, live, query])
  const pickCommand = (m: CommandMatch) => {
    haptic('select')
    onChangeText(pickedText(m.command))
    input.current?.focus()
  }

  const name = AGENTS[agent].name
  const models = props.models ?? AGENTS[agent].models
  const current = models.find(m => m.id === model)
  const efforts = current?.efforts ?? []
  const files = props.attachments ?? []
  const uploading = files.some(f => f.state === 'uploading')
  const canSend = !disabled && !uploading && (!!value.trim() || files.some(f => f.state === 'ready'))
  const placeholder = dictation.busy ? 'Listening…' : props.placeholder ?? (running ? `Write the next message: it is sent when ${name} is done…` : `Ask ${name} to build, fix or explain, or type / for commands…`)
  const ModeIcon = PERMISSION_MODES[mode].icon
  const effortText = effort ? effortLabel(effort) : null

  const send = () => {
    if (!canSend) return
    // Sending mid-dictation sends what is in the draft now and ends the dictation.
    dictation.settle()
    haptic('light')
    onSend(value)
  }

  const micLabel = dictation.phase === 'stopping' ? 'Finishing dictation' : listening ? 'Stop dictation' : 'Dictate'
  const notice = dictation.notice
  const openFix = () => {
    dictation.clearNotice()
    if (notice?.settings === 'system') void Linking.openSettings().catch(() => {})
    else router.push('/settings')
  }

  return (
    <>
      {query !== null ? <ChatCommandMenu matches={matches} query={query} agentName={AGENTS[agent].name} onPick={pickCommand} /> : null}
      <View style={[s.box, focused && s.focused]} onLayout={e => setNarrow(e.nativeEvent.layout.width < NARROW)}>
      {files.length
        ? (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.tray} keyboardShouldPersistTaps="handled">
              {files.map(f => <FileChip key={f.key} file={f} onRemove={props.onRemoveAttachment} />)}
            </ScrollView>
          )
        : null}
      <TextInput
        ref={input}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={t.colors.fgFaint}
        selectionColor={t.colors.accent}
        cursorColor={t.colors.accent}
        keyboardAppearance={t.dark ? 'dark' : 'light'}
        multiline
        editable={!disabled && !dictation.busy}
        autoFocus={autoFocus}
        maxFontSizeMultiplier={1.4}
        accessibilityLabel={placeholder}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onSelectionChange={(e) => { selection.current = e.nativeEvent.selection }}
        style={[s.input, Platform.OS === 'web' && s.web]}
      />
      {notice
        ? (
            <View style={s.notice} accessibilityRole={notice.tone === 'error' ? 'alert' : undefined} accessibilityLiveRegion="polite">
              {notice.tone === 'error'
                ? <CircleAlert size={14} strokeWidth={2} color={t.colors.ripeError} style={s.noticeIcon} />
                : <Info size={14} strokeWidth={2} color={t.colors.fgSubtle} style={s.noticeIcon} />}
              <Text variant="caption" tone={notice.tone === 'error' ? 'error' : 'subtle'} style={s.noticeText} maxFontSizeMultiplier={1.3}>
                {notice.text}
              </Text>
              {notice.settings
                ? (
                    <Pressable onPress={openFix} hitSlop={{ top: 12, bottom: 12, left: 6, right: 6 }} accessibilityRole="button" style={({ pressed }) => [s.noticeAction, pressed && s.chipPressed]}>
                      <Text variant="captionStrong" tone="accent" maxFontSizeMultiplier={1.3}>{notice.settings === 'system' ? 'Open Settings' : 'Voice settings'}</Text>
                    </Pressable>
                  )
                : null}
              <Pressable onPress={dictation.clearNotice} hitSlop={11} accessibilityRole="button" accessibilityLabel="Dismiss" style={({ pressed }) => [s.fileRemove, pressed && s.chipPressed]}>
                <X size={13} strokeWidth={2.25} color={t.colors.fgSubtle} />
              </Pressable>
            </View>
          )
        : null}
      <View style={s.bar}>
        {dictation.busy
          ? (
              <>
                <Pressable
                  onPress={dictation.discard}
                  hitSlop={{ top: 6, bottom: 6 }}
                  accessibilityRole="button"
                  accessibilityLabel="Discard dictation"
                  accessibilityHint="Puts the message back as it was"
                  style={({ pressed }) => [s.attach, pressed && s.chipPressed]}
                >
                  <X size={17} strokeWidth={1.85} color={t.colors.fgSubtle} />
                </Pressable>
                <Recording phase={dictation.phase} seconds={dictation.seconds} level={dictation.levels ? dictation.level : null} simulated={dictation.kind === 'simulated'} />
              </>
            )
          : null}
        {!dictation.busy && props.onAttach
          ? (
              <Pressable
                onPress={props.onAttach}
                disabled={disabled}
                hitSlop={{ top: 6, bottom: 6 }}
                accessibilityRole="button"
                accessibilityLabel="Attach files"
                style={({ pressed }) => [s.attach, pressed && s.chipPressed]}
              >
                <Paperclip size={17} strokeWidth={1.85} color={disabled ? t.colors.fgFaint : t.colors.fgSubtle} />
              </Pressable>
            )
          : null}
        {dictation.busy
          ? null
          : (
              <>
                <Chip
                  label={`${current?.label ?? model}${effortText ? ` · ${effortText}` : ''}`}
                  lead={<AgentIcon agent={agent} size={13} />}
                  a11y={`Model: ${current?.label ?? model}${effortText ? `, effort ${effortText}` : ''}`}
                  onPress={() => setSheet('model')}
                  disabled={!onModelChange && !onEffortChange}
                />
                <Chip
                  label={narrow ? null : PERMISSION_MODES[mode].label}
                  lead={<ModeIcon size={14} strokeWidth={1.85} color={mode === 'auto' ? t.colors.accentInk : t.colors.fgSubtle} />}
                  a11y={`Permissions: ${PERMISSION_MODES[mode].label}`}
                  onPress={() => setSheet('mode')}
                  disabled={!onModeChange}
                />
              </>
            )}
        <View style={s.spacer} />
        {props.context !== undefined && props.onContext && !dictation.busy
          ? <ContextButton usage={props.context} pending={props.contextPending} agentName={name} onPress={props.onContext} />
          : null}
        {disabled
          ? null
          : (
              <Pressable
                onPress={dictation.toggle}
                disabled={dictation.phase === 'stopping' || dictation.phase === 'starting'}
                hitSlop={6}
                accessibilityRole="button"
                accessibilityLabel={micLabel}
                accessibilityHint={dictation.busy ? undefined : 'Speak to add to the message'}
                accessibilityState={{ selected: listening, busy: dictation.phase === 'stopping' }}
                style={({ pressed }) => [s.mic, (listening || pressed) && s.micOn]}
              >
                {dictation.phase === 'stopping'
                  ? <Spinner size={14} />
                  : listening
                    ? <Square size={10} fill={t.colors.fg} color={t.colors.fg} />
                    : <Mic size={18} strokeWidth={1.85} color={t.colors.fgSubtle} />}
              </Pressable>
            )}
        {running
          ? (
              <Pressable
                onPress={() => { haptic('medium'); onStop?.() }}
                hitSlop={4}
                accessibilityRole="button"
                accessibilityLabel="Stop"
                style={({ pressed }) => [s.send, s.stop, pressed && s.stopPressed]}
              >
                <Square size={12} fill={t.colors.bgCanvas} color={t.colors.bgCanvas} />
              </Pressable>
            )
          : null}
        {!running || canSend
          ? (
              <Pressable
                onPress={send}
                disabled={!canSend}
                hitSlop={4}
                accessibilityRole="button"
                accessibilityLabel={running ? 'Add to the queue' : 'Send'}
                accessibilityState={{ disabled: !canSend }}
                style={({ pressed }) => [s.send, canSend ? s.sendOn : s.sendOff, pressed && canSend && s.sendPressed]}
              >
                <ArrowUp size={19} strokeWidth={2.25} color={canSend ? t.colors.accentFg : t.colors.fgFaint} />
              </Pressable>
            )
          : null}
      </View>

      <Sheet visible={sheet === 'model'} onClose={() => setSheet(null)} title="Model">
        <ListSection>
          {models.map(m => (
            <ListRow
              key={m.id}
              title={m.label}
              subtitle={m.hint}
              accessory={m.id === model ? 'check' : 'none'}
              onPress={() => {
                haptic('select')
                onModelChange?.(m.id)
                if (effort && !(m.efforts ?? []).includes(effort)) onEffortChange?.(null)
              }}
            />
          ))}
        </ListSection>
        {efforts.length && onEffortChange
          ? (
              <ListSection title="Effort" footer={`How hard ${name} thinks before it answers. Default leaves it to ${name}.`} style={s.gap}>
                {[null, ...efforts].map(e => (
                  <ListRow
                    key={e ?? 'default'}
                    title={e ? effortLabel(e) : 'Default'}
                    subtitle={!e && current?.defaultEffort ? effortLabel(current.defaultEffort) : undefined}
                    accessory={e === effort ? 'check' : 'none'}
                    onPress={() => { haptic('select'); onEffortChange(e) }}
                  />
                ))}
              </ListSection>
            )
          : null}
      </Sheet>

      <Sheet visible={sheet === 'mode'} onClose={() => setSheet(null)} title="Permissions">
        <ListSection footer="Applies from the next message.">
          {(Object.keys(PERMISSION_MODES) as PermissionMode[]).map((k) => {
            const m = PERMISSION_MODES[k]
            const Icon = m.icon
            return (
              <ListRow
                key={k}
                title={m.label}
                subtitle={m.hint}
                leading={<Icon size={20} strokeWidth={1.75} color={k === 'auto' ? t.colors.accentInk : t.colors.fgSubtle} />}
                accessory={k === mode ? 'check' : 'none'}
                onPress={() => {
                  haptic('select')
                  onModeChange?.(k)
                  setSheet(null)
                }}
              />
            )
          })}
        </ListSection>
      </Sheet>
      </View>
    </>
  )
}

/**
 * One attached file over the input: its preview (or a file icon), its name, and a remove button.
 * Uploading dims it under a spinner; a failed one shows why in error ink until removed.
 */
function FileChip({ file, onRemove }: { file: ComposerAttachment; onRemove?: (key: string) => void }) {
  const t = useTheme()
  const s = useStyles()
  const failed = file.state === 'error'
  return (
    <View style={[s.file, failed && s.fileFailed]} accessibilityLabel={`${file.name}${failed ? `, not attached: ${file.error ?? ''}` : file.state === 'uploading' ? ', uploading' : ''}`}>
      <View style={s.fileThumb}>
        {file.thumb
          ? <Image source={{ uri: file.thumb }} style={[s.fileImage, file.state === 'uploading' && s.dim]} />
          : <FileText size={18} strokeWidth={1.75} color={t.colors.fgSubtle} />}
        {file.state === 'uploading' ? <View style={s.fileBusy}><Spinner size={14} /></View> : null}
      </View>
      <View style={s.fileText}>
        <Text variant="caption" numberOfLines={1} maxFontSizeMultiplier={1.2}>{file.name}</Text>
        {failed
          ? (
              <View style={s.fileError}>
                <CircleAlert size={11} strokeWidth={2} color={t.colors.ripeErrorFg} />
                <Text variant="micro" tone="error" numberOfLines={1} maxFontSizeMultiplier={1.2} style={{ flexShrink: 1 }}>{file.error ?? 'Not attached'}</Text>
              </View>
            )
          : null}
      </View>
      {onRemove
        ? (
            <Pressable
              onPress={() => onRemove(file.key)}
              hitSlop={10}
              accessibilityRole="button"
              accessibilityLabel={`Remove ${file.name}`}
              style={({ pressed }) => [s.fileRemove, pressed && s.chipPressed]}
            >
              <X size={13} strokeWidth={2.25} color={t.colors.fgSubtle} />
            </Pressable>
          )
        : null}
    </View>
  )
}

/** Five bars, each lit once the level passes its step (the desktop's meter). */
const STEPS = [0.08, 0.2, 0.35, 0.55, 0.75]

/**
 * The recording state in the bar, where the chips were: a dot in Bruise Red pulsing slowly (still
 * under Reduce Motion), the clock, and the input level; "Finishing…" while the last words come in.
 */
function Recording({ phase, seconds, level, simulated }: { phase: string; seconds: number; level: number | null; simulated: boolean }) {
  const t = useTheme()
  const s = useStyles()
  const reduced = useReducedMotion()
  const pulse = useRef(new Animated.Value(1)).current
  useEffect(() => {
    if (reduced) return
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(pulse, { toValue: 0.35, duration: 700, easing: easeInOut, useNativeDriver: true }),
      Animated.timing(pulse, { toValue: 1, duration: 700, easing: easeInOut, useNativeDriver: true }),
    ]))
    loop.start()
    return () => loop.stop()
  }, [reduced, pulse])

  if (phase === 'stopping') {
    return (
      <View style={s.rec} accessibilityLiveRegion="polite">
        <Text variant="caption" tone="subtle" maxFontSizeMultiplier={1.3}>Finishing…</Text>
      </View>
    )
  }
  return (
    <View style={s.rec} accessible accessibilityLabel={phase === 'starting' ? 'Starting dictation' : `Listening, ${seconds} seconds`}>
      <Animated.View style={[s.recDot, { opacity: pulse }]} />
      <Text variant="caption" tone="muted" tabular maxFontSizeMultiplier={1.3}>{clock(seconds)}</Text>
      {level !== null
        ? (
            <View style={s.meter}>
              {STEPS.map((step, i) => (
                <View key={step} style={[s.level, { height: 4 + i * 2, backgroundColor: level > step ? t.colors.fgMuted : t.colors.lineStrong }]} />
              ))}
            </View>
          )
        : null}
      {simulated ? <Badge label="Simulated" dashed /> : null}
    </View>
  )
}

/**
 * Under this width the permissions chip shows its icon only, so the model keeps its name: the
 * desktop composer's container rule (under 400px), for a phone with the microphone in the bar.
 */
const NARROW = 400

/** A picker chip: no fill at rest, subtle ink, a small chevron; pressed adds the Hover Wash. */
function Chip({ label, lead, a11y, onPress, disabled }: { label: string | null; lead?: ReactNode; a11y: string; onPress: () => void; disabled?: boolean }) {
  const t = useTheme()
  const s = useStyles()
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      hitSlop={{ top: 6, bottom: 6 }}
      accessibilityRole="button"
      accessibilityLabel={a11y}
      style={({ pressed }) => [s.chip, pressed && s.chipPressed]}
    >
      {lead}
      {label === null ? null : <Text variant="caption" tone="subtle" numberOfLines={1} maxFontSizeMultiplier={1.3} style={s.chipText}>{label}</Text>}
      {disabled ? null : <ChevronDown size={13} strokeWidth={2} color={t.colors.fgFaint} />}
    </Pressable>
  )
}

const useStyles = makeStyles(t => ({
  box: {
    gap: space[1],
    paddingTop: space[3],
    paddingBottom: space[2],
    paddingLeft: space[3],
    paddingRight: space[2],
    backgroundColor: t.colors.bgPanel,
    borderWidth: 1,
    borderColor: t.colors.line,
    borderRadius: radius.lg,
    borderCurve: 'continuous',
    boxShadow: t.shadow.soft,
  },
  focused: { borderColor: t.colors.lineStrong, boxShadow: `${t.shadow.soft}, 0px 0px 0px 3px ${t.colors.accentSoft}` },
  input: {
    minHeight: 24,
    maxHeight: 160,
    paddingHorizontal: space[1],
    paddingTop: 0,
    paddingBottom: space[1],
    fontFamily: fonts.regular,
    fontSize: fontSize.body,
    lineHeight: Math.round(fontSize.body * 1.45),
    color: t.colors.fg,
    textAlignVertical: 'top',
  },
  /** The browser's own focus outline: the box's border and halo already show focus. */
  web: { outlineStyle: 'solid', outlineWidth: 0 },
  bar: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  spacer: { flex: 1 },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    minHeight: 32,
    paddingLeft: space[2],
    paddingRight: 6,
    borderRadius: radius.sm,
    borderCurve: 'continuous',
    flexShrink: 1,
    minWidth: 0,
  },
  chipPressed: { backgroundColor: t.colors.bgHover },
  chipText: { fontFamily: fonts.medium, flexShrink: 1 },
  send: {
    width: 36,
    height: 36,
    marginLeft: space[1],
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.md,
    borderCurve: 'continuous',
  },
  sendOn: { backgroundColor: t.colors.accent },
  sendPressed: { backgroundColor: t.colors.accentStrong, transform: [{ scale: 0.94 }] },
  sendOff: { backgroundColor: t.colors.bgActive },
  stop: { backgroundColor: t.colors.fg },
  /** The microphone: quiet at rest like the chips, Active Wash while it listens (the desktop's). */
  /** 32pt like the paperclip, 44 with its hit slop. */
  mic: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.md,
    borderCurve: 'continuous',
  },
  micOn: { backgroundColor: t.colors.bgActive },
  rec: { flexDirection: 'row', alignItems: 'center', gap: space[2], paddingLeft: space[1], flexShrink: 1, minWidth: 0 },
  recDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: t.colors.ripeError },
  meter: { flexDirection: 'row', alignItems: 'center', gap: 2, height: 12 },
  level: { width: 2, borderRadius: radius.pill },
  notice: { flexDirection: 'row', alignItems: 'flex-start', gap: space[2], paddingHorizontal: space[1], paddingBottom: space[1] },
  noticeIcon: { marginTop: 2 },
  noticeText: { flex: 1 },
  noticeAction: { paddingHorizontal: 6, paddingVertical: 2, borderRadius: radius.xs, marginTop: -2 },
  stopPressed: { backgroundColor: t.colors.fgMuted, transform: [{ scale: 0.94 }] },
  gap: { marginTop: space[5] },
  attach: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.sm,
    borderCurve: 'continuous',
  },
  tray: { gap: space[2], paddingBottom: space[2], paddingRight: space[1] },
  file: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[2],
    maxWidth: 220,
    padding: 4,
    paddingRight: space[2],
    backgroundColor: t.colors.bgInset,
    borderWidth: 1,
    borderColor: t.colors.lineSoft,
    borderRadius: radius.md,
    borderCurve: 'continuous',
  },
  fileFailed: { borderColor: t.colors.errorLine, backgroundColor: t.colors.errorWash },
  fileThumb: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    backgroundColor: t.colors.bgActive,
    borderRadius: radius.sm,
    borderCurve: 'continuous',
  },
  fileImage: { width: 36, height: 36 },
  dim: { opacity: 0.45 },
  fileBusy: { position: 'absolute', inset: 0, alignItems: 'center', justifyContent: 'center' },
  fileText: { flexShrink: 1, minWidth: 0, gap: 1 },
  fileError: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  fileRemove: {
    width: 22,
    height: 22,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 11,
  },
}))
