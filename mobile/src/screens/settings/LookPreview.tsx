import { View } from 'react-native'
import { makeStyles, space } from '@/theme'
import { Button, RipenessDot, Text } from '@/ui'

/**
 * A small piece of a chat in the look you have chosen, built from the real components, so a change
 * to the scheme, the fonts, the text size or the corners shows at once, right above its switch.
 */
export function LookPreview() {
  const s = useStyles()
  return (
    <View style={s.card} accessible accessibilityLabel="Preview of the chosen look">
      <View style={s.head}>
        <RipenessDot status="working" size={14} />
        <Text variant="title" numberOfLines={1} style={s.title}>Cart total is off by a cent</Text>
      </View>
      <Text variant="chat" tone="muted">
        Rounded the total to cents before the shipping is added, in <Text variant="mono">roundCents()</Text>.
      </Text>
      <View style={s.buttons}>
        <Button label="Review" variant="primary" size="sm" />
        <Button label="Not now" variant="secondary" size="sm" />
      </View>
    </View>
  )
}

const useStyles = makeStyles(t => ({
  card: {
    gap: space[3],
    padding: space[4],
    backgroundColor: t.colors.bgPanel,
    borderRadius: t.radius.lg,
    borderCurve: 'continuous',
    borderWidth: 1,
    borderColor: t.colors.lineSoft,
  },
  head: { flexDirection: 'row', alignItems: 'center', gap: space[2] },
  title: { flex: 1 },
  buttons: { flexDirection: 'row', gap: space[2] },
}))
