import { Pressable, View } from 'react-native'
import Svg, { Circle } from 'react-native-svg'
import { Minimize2 } from 'lucide-react-native'
import type { ContextUsage } from '~/types/chat'
import { contextLevel, contextPercent, formatTokens } from '~/agents/context'
import { makeStyles, space, useTheme, type Colors } from '@/theme'
import { Button, Sheet, Spinner, Text, haptic, type TextTone } from '@/ui'

/**
 * How full a chat's context window is (the desktop's `ChatContext.vue`): a ring in the composer,
 * and a sheet with what takes the room (when the CLI says) and a way to compact the conversation.
 * Before the first reading the ring is empty and says so.
 */

const LEVEL_TONE: Record<ReturnType<typeof contextLevel>, TextTone> = { ok: 'subtle', high: 'running', full: 'error' }
const levelColor = (c: Colors, level: ReturnType<typeof contextLevel>) =>
  level === 'full' ? c.ripeError : level === 'high' ? c.ripeRunning : c.fgMuted

/** What there is to say before the first reading. */
const waiting = (agentName: string, pending?: boolean) => (pending
  ? `Reading how full this conversation is from ${agentName}…`
  : `No reading yet. It shows after ${agentName}'s next reply.`)

const label = (u: ContextUsage | null, agentName: string, pending?: boolean) => {
  if (!u) return `Context window: ${waiting(agentName, pending)}`
  const pct = contextPercent(u)
  return pct === null
    ? `Context: ${formatTokens(u.used)} tokens in use`
    : `Context: ${pct}% full, ${formatTokens(u.used)} of ${formatTokens(u.max)} tokens`
}

/** The ring as drawn: a track, and an arc as long as the window is full (a sliver at 0%; none without a reading). */
export function ContextRing({ usage, size = 16 }: { usage: ContextUsage | null; size?: number }) {
  const t = useTheme()
  const pct = contextPercent(usage)
  const stroke = size / 7
  const r = (size - stroke) / 2
  const length = 2 * Math.PI * r
  return (
    <Svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ transform: [{ rotate: '-90deg' }] }}>
      <Circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={t.colors.lineStrong} strokeWidth={stroke} />
      {usage && pct !== null
        ? (
            <Circle
              cx={size / 2}
              cy={size / 2}
              r={r}
              fill="none"
              stroke={levelColor(t.colors, contextLevel(usage))}
              strokeWidth={stroke}
              strokeLinecap="round"
              strokeDasharray={`${(length * Math.max(pct, 2)) / 100} ${length}`}
            />
          )
        : null}
    </Svg>
  )
}

/** The composer's button: the ring, and the percentage unless the bar is tight. */
export function ContextButton({ usage, pending, agentName, onPress, compact }: {
  /** Null: no reading yet. */
  usage: ContextUsage | null
  /** The reading is being asked from the CLI. */
  pending?: boolean
  agentName: string
  onPress: () => void
  compact?: boolean
}) {
  const s = useStyles()
  const pct = contextPercent(usage)
  return (
    <Pressable
      onPress={() => { haptic('select'); onPress() }}
      hitSlop={{ top: 8, bottom: 8 }}
      accessibilityRole="button"
      accessibilityLabel={label(usage, agentName, pending)}
      accessibilityHint="Shows what fills the context window"
      accessibilityState={{ busy: !!pending }}
      style={({ pressed }) => [s.button, pressed && s.pressed]}
    >
      {pending && !usage ? <Spinner size={14} /> : <ContextRing usage={usage} />}
      {compact
        ? null
        : !usage
            ? <Text variant="caption" tone="faint" maxFontSizeMultiplier={1.3}>–</Text>
            : (
                <Text variant="caption" tone={LEVEL_TONE[contextLevel(usage)]} tabular maxFontSizeMultiplier={1.3}>
                  {pct === null ? formatTokens(usage.used) : `${pct}%`}
                </Text>
              )}
    </Pressable>
  )
}

interface Row { id: string; label: string; tokens: number; kind: 'used' | 'buffer' | 'free'; color: string }

export function ChatContextSheet({ visible, onClose, usage, pending, agentName, running, onCompact }: {
  visible: boolean
  onClose: () => void
  usage: ContextUsage | null
  /** The reading is being asked from the CLI. */
  pending?: boolean
  agentName: string
  /** A turn runs: compacting waits until it is done. */
  running: boolean
  onCompact: () => void
}) {
  const t = useTheme()
  const s = useStyles()
  if (!usage) {
    return (
      <Sheet visible={visible} onClose={onClose} title="Context window">
        <View style={[s.body, s.emptyBody]}>
          {pending ? <Spinner size={16} /> : <ContextRing usage={null} size={20} />}
          <Text variant="bodySm" tone="muted" style={s.emptyText}>{waiting(agentName, pending)}</Text>
        </View>
      </Sheet>
    )
  }

  const swatch: Record<string, string> = {
    messages: t.colors.accent,
    system_prompt: t.colors.fileBlue,
    system_tools: t.colors.filePurple,
    mcp_tools: t.colors.fileRed,
    custom_agents: t.colors.fileOrange,
    memory_files: t.colors.fileGreen,
    skills: t.colors.fileYellow,
  }
  const rows: Row[] = usage.parts?.length
    ? usage.parts.map(p => ({ ...p, color: p.kind === 'used' ? swatch[p.id] ?? t.colors.fgSubtle : p.kind === 'buffer' ? t.colors.lineStrong : t.colors.bgActive }))
    : [
        { id: 'used', label: 'In use', tokens: usage.used, kind: 'used', color: t.colors.accent },
        ...(usage.max ? [{ id: 'free', label: 'Free space', tokens: Math.max(0, usage.max - usage.used), kind: 'free' as const, color: t.colors.bgActive }] : []),
      ]
  const share = (tokens: number) => (usage.max ? (tokens / usage.max) * 100 : 0)
  const partPct = (tokens: number) => {
    if (!usage.max) return ''
    const p = share(tokens)
    return p > 0 && p < 1 ? '<1%' : `${Math.round(p)}%`
  }
  const pct = contextPercent(usage)
  const level = contextLevel(usage)
  const firstFree = rows.findIndex(r => r.kind !== 'used')

  return (
    <Sheet visible={visible} onClose={onClose} title="Context window">
      <View style={s.body}>
        <View style={s.summary}>
          {pct !== null ? <Text variant="headline" tone={level === 'ok' ? 'fg' : LEVEL_TONE[level]} tabular>{pct}%</Text> : null}
          <Text variant="bodySm" tone="muted" tabular>
            {usage.max ? `${formatTokens(usage.used)} of ${formatTokens(usage.max)} tokens` : `${formatTokens(usage.used)} tokens`}
          </Text>
        </View>
        {usage.max
          ? (
              <View style={s.bar} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
                {rows.filter(r => r.kind !== 'free' && r.tokens > 0).map(r => (
                  <View key={r.id} style={{ width: `${Math.max(0.5, share(r.tokens))}%`, backgroundColor: r.color }} />
                ))}
              </View>
            )
          : null}
        <View style={s.group}>
          {rows.map((r, i) => (
            <View
              key={r.id}
              style={[s.row, i > 0 && s.rowLine, i === firstFree && i > 0 && s.rowBreak]}
              accessible
              accessibilityLabel={`${r.label}: ${formatTokens(r.tokens)} tokens${usage.max ? `, ${partPct(r.tokens)}` : ''}`}
            >
              <View style={[s.swatch, { backgroundColor: r.color }, r.kind === 'free' && s.swatchFree]} />
              <Text variant="bodySm" tone={r.kind === 'used' ? 'fg' : 'subtle'} numberOfLines={1} style={s.rowLabel}>{r.label}</Text>
              <Text variant="bodySm" tone={r.kind === 'used' ? 'fg' : 'muted'} tabular>{formatTokens(r.tokens)}</Text>
              <Text variant="caption" tone="subtle" tabular style={s.rowPct}>{partPct(r.tokens)}</Text>
            </View>
          ))}
        </View>
        <Text variant="caption" tone="subtle" style={s.note}>
          {usage.compactAt
            ? `${agentName} compacts the conversation by itself at ${formatTokens(usage.compactAt)} tokens.`
            : `${agentName} compacts the conversation by itself when the window fills up.`}
          {running && !usage.parts?.length && usage.max ? ' Measured during this turn; the breakdown comes when it is done.' : ''}
        </Text>
        <Button
          label="Compact now"
          icon={Minimize2}
          block
          disabled={running}
          accessibilityHint="Summarizes the conversation so far to free up room"
          onPress={() => { onClose(); onCompact() }}
        />
        {running ? <Text variant="caption" tone="faint" style={s.note}>Compacting waits until {agentName} is done with this turn.</Text> : null}
      </View>
    </Sheet>
  )
}

const useStyles = makeStyles(t => ({
  button: { flexDirection: 'row', alignItems: 'center', gap: 6, height: 32, paddingHorizontal: space[2], borderRadius: t.radius.sm },
  pressed: { backgroundColor: t.colors.bgHover },
  body: { gap: space[3], paddingBottom: space[2] },
  summary: { flexDirection: 'row', alignItems: 'baseline', gap: space[2], paddingHorizontal: space[1] },
  bar: { flexDirection: 'row', gap: 1, height: 10, borderRadius: t.radius.pill, overflow: 'hidden', backgroundColor: t.colors.bgActive },
  group: { backgroundColor: t.colors.bgPanel, borderRadius: t.radius.md, borderCurve: 'continuous', paddingHorizontal: space[4] },
  row: { flexDirection: 'row', alignItems: 'center', gap: space[3], minHeight: 40 },
  rowLine: { borderTopWidth: 1, borderTopColor: t.colors.lineSoft },
  rowBreak: { borderTopColor: t.colors.lineStrong },
  swatch: { width: 10, height: 10, borderRadius: 3 },
  swatchFree: { borderWidth: 1, borderColor: t.colors.lineStrong },
  rowLabel: { flex: 1 },
  rowPct: { width: 40, textAlign: 'right' },
  note: { paddingHorizontal: space[1] },
  emptyBody: { flexDirection: 'row', alignItems: 'center', gap: space[3], paddingHorizontal: space[1], paddingBottom: space[4] },
  emptyText: { flex: 1 },
}))
