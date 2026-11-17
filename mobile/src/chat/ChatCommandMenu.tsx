import { useEffect, useRef } from 'react'
import { Animated, Pressable, ScrollView, View } from 'react-native'
import { easeOut, fonts, makeStyles, motion, radius, space, touch, useReducedMotion, useTheme } from '@/theme'
import { Text } from '@/ui'
import { nameParts, type CommandMatch } from './commands'

export interface ChatCommandMenuProps {
  matches: readonly CommandMatch[]
  /** What follows the slash, for drawing the matched characters. */
  query: string
  agentName: string
  onPick: (match: CommandMatch) => void
}

/** About four and a half rows: the cut-off row says the list scrolls. */
const MAX_HEIGHT = 236

/**
 * The slash command list over the composer (the desktop's `ChatCommandMenu.vue`, for a thumb):
 * a Raised Layer with the Pop shadow, one 2-line row per command (the name with the typed part in
 * Mango Ink and its argument hint; the description under it), at least 44pt each. The composer
 * owns the text; this shows the matches and reports a tap. Rendered in the flow above the
 * composer, so every row stays inside a view that receives touches.
 */
export function ChatCommandMenu({ matches, query, agentName, onPick }: ChatCommandMenuProps) {
  const s = useStyles()
  const reduced = useReducedMotion()
  const enter = useRef(new Animated.Value(reduced ? 1 : 0)).current
  useEffect(() => {
    if (reduced) return
    Animated.timing(enter, { toValue: 1, duration: motion.fast, easing: easeOut, useNativeDriver: true }).start()
  }, [enter, reduced])

  const lift = { opacity: enter, transform: [{ translateY: enter.interpolate({ inputRange: [0, 1], outputRange: [6, 0] }) }] }
  return (
    <Animated.View style={[s.menu, lift]} accessibilityLabel={`${agentName} commands`}>
      {matches.length
        ? (
            <ScrollView style={{ maxHeight: MAX_HEIGHT }} contentContainerStyle={s.list} keyboardShouldPersistTaps="always" showsVerticalScrollIndicator={matches.length > 4}>
              {matches.map(m => <Row key={m.command.name} match={m} query={query} onPick={onPick} />)}
            </ScrollView>
          )
        : (
            <Text variant="caption" tone="subtle" style={s.empty} accessibilityLiveRegion="polite" maxFontSizeMultiplier={1.3}>
              {`No ${agentName} command matches /${query}. It is sent as written.`}
            </Text>
          )}
    </Animated.View>
  )
}

function Row({ match, query, onPick }: { match: CommandMatch; query: string; onPick: (m: CommandMatch) => void }) {
  const t = useTheme()
  const s = useStyles()
  const c = match.command
  return (
    <Pressable
      onPress={() => onPick(match)}
      accessibilityRole="button"
      accessibilityLabel={`/${c.name}${c.mango ? ', Mango' : ''}`}
      accessibilityHint={c.description}
      style={({ pressed }) => [s.row, pressed && s.rowPressed]}
    >
      <View style={s.head}>
        <Text variant="label" numberOfLines={1} maxFontSizeMultiplier={1.3} style={s.name}>
          /
          {nameParts(match, query).map((p, i) => (
            p.hit
              ? <Text key={i} variant="label" style={{ color: t.colors.accentInk, fontFamily: fonts.semibold }}>{p.text}</Text>
              : p.text
          ))}
        </Text>
        {c.argumentHint
          ? <Text variant="micro" tone="faint" numberOfLines={1} maxFontSizeMultiplier={1.2} style={s.args}>{c.argumentHint}</Text>
          : <View style={s.fill} />}
        {c.mango ? <Text variant="micro" tone="faint" maxFontSizeMultiplier={1.2}>Mango</Text> : null}
      </View>
      {c.description
        ? <Text variant="caption" tone="subtle" numberOfLines={1} maxFontSizeMultiplier={1.3}>{c.description}</Text>
        : null}
    </Pressable>
  )
}

const useStyles = makeStyles(t => ({
  menu: {
    marginBottom: space[2],
    padding: space[1],
    backgroundColor: t.colors.bgRaised,
    borderWidth: 1,
    borderColor: t.colors.line,
    borderRadius: radius.lg,
    borderCurve: 'continuous',
    boxShadow: t.shadow.pop,
    overflow: 'hidden',
  },
  list: { gap: 2 },
  row: {
    minHeight: touch.min,
    justifyContent: 'center',
    gap: 1,
    paddingVertical: 6,
    paddingHorizontal: space[2],
    borderRadius: radius.sm,
    borderCurve: 'continuous',
  },
  rowPressed: { backgroundColor: t.colors.bgActive },
  head: { flexDirection: 'row', alignItems: 'baseline', gap: space[2] },
  name: { flexShrink: 0, maxWidth: '60%' },
  args: { flex: 1, minWidth: 0 },
  fill: { flex: 1 },
  empty: { paddingVertical: space[2], paddingHorizontal: space[2] },
}))
