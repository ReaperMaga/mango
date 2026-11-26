import { Pressable, View } from 'react-native'
import { Check } from 'lucide-react-native'
import { makeStyles, paletteFor, SCHEMES, space, useTheme, type ColorScheme } from '@/theme'
import { Text, haptic } from '@/ui'

/**
 * The colour scheme as small previews of the workspace (the desktop's swatches): each tile is painted
 * in its own scheme, in the theme you are using, so you see what you would get before you pick it.
 * Five to a row.
 */
export function SchemePicker({ value, onChange }: { value: ColorScheme; onChange: (scheme: ColorScheme) => void }) {
  const s = useStyles()
  const t = useTheme()
  return (
    <View style={s.grid} accessibilityRole="radiogroup" accessibilityLabel="Color scheme">
      {SCHEMES.map((o) => {
        const c = paletteFor(o.value, t.scheme).colors
        const on = o.value === value
        return (
          <Pressable
            key={o.value}
            onPress={() => { if (!on) { haptic('select'); onChange(o.value) } }}
            accessibilityRole="radio"
            accessibilityLabel={o.label}
            accessibilityState={{ checked: on }}
            style={s.cell}
          >
            <View style={[s.preview, { backgroundColor: c.bgCanvas, borderColor: on ? t.colors.accentInk : t.colors.line }, on && s.previewOn]}>
              <View style={[s.rail, { backgroundColor: c.bgApp, borderRightColor: c.lineSoft }]} />
              <View style={s.lines}>
                <View style={[s.line, { backgroundColor: c.fgFaint, width: '78%' }]} />
                <View style={[s.line, { backgroundColor: c.fgFaint, width: '50%' }]} />
              </View>
              <View style={[s.accent, { backgroundColor: c.accent }]}>
                {on ? <Check size={11} strokeWidth={3} color={c.accentFg} /> : null}
              </View>
            </View>
            <Text variant="micro" tone={on ? 'fg' : 'subtle'} numberOfLines={1} maxFontSizeMultiplier={1.2}>{o.label}</Text>
          </Pressable>
        )
      })}
    </View>
  )
}

const useStyles = makeStyles(t => ({
  grid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', rowGap: space[3] },
  cell: { width: '18.4%', alignItems: 'center', gap: 6 },
  preview: {
    width: '100%',
    aspectRatio: 1.25,
    flexDirection: 'row',
    overflow: 'hidden',
    borderWidth: 1,
    borderRadius: t.radius.md,
    borderCurve: 'continuous',
  },
  previewOn: { borderWidth: 2 },
  rail: { width: '26%', height: '100%', borderRightWidth: 1 },
  lines: { flex: 1, paddingTop: 8, paddingLeft: 6, gap: 4 },
  line: { height: 3, borderRadius: 2, opacity: 0.7 },
  accent: { position: 'absolute', right: 5, bottom: 5, width: 14, height: 14, borderRadius: 7, alignItems: 'center', justifyContent: 'center' },
}))
