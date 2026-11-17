import type { ComponentType } from 'react'
import { Pressable, View, type StyleProp, type ViewStyle } from 'react-native'
import type { LucideProps } from 'lucide-react-native'
import { makeStyles, radius, space, useTheme } from '@/theme'
import { Text } from './Text'
import { haptic } from './haptics'

export interface SegmentedOption<V extends string> {
  value: V
  label: string
  icon?: ComponentType<LucideProps>
}

export interface SegmentedProps<V extends string> {
  options: SegmentedOption<V>[]
  value: V
  onChange: (value: V) => void
  /** Read out as the group's name. */
  label: string
  style?: StyleProp<ViewStyle>
}

/**
 * A segmented switch in the desktop's style (the diff layout switch): an Inset Well track with
 * the picked segment lifted to the Raised ground. 36pt tall; each segment's hit area reaches 44.
 */
export function Segmented<V extends string>({ options, value, onChange, label, style }: SegmentedProps<V>) {
  const t = useTheme()
  const s = useStyles()
  return (
    <View style={[s.track, style]} accessibilityRole="radiogroup" accessibilityLabel={label}>
      {options.map((o) => {
        const on = o.value === value
        const Icon = o.icon
        return (
          <Pressable
            key={o.value}
            onPress={() => {
              if (on) return
              haptic('select')
              onChange(o.value)
            }}
            hitSlop={{ top: 4, bottom: 4 }}
            accessibilityRole="radio"
            accessibilityLabel={o.label}
            accessibilityState={{ checked: on }}
            style={({ pressed }) => [s.seg, on && s.on, pressed && !on && s.pressed]}
          >
            {Icon ? <Icon size={15} strokeWidth={1.85} color={on ? t.colors.fg : t.colors.fgSubtle} /> : null}
            <Text variant={on ? 'label' : 'bodySm'} tone={on ? 'fg' : 'subtle'} numberOfLines={1} maxFontSizeMultiplier={1.3}>{o.label}</Text>
          </Pressable>
        )
      })}
    </View>
  )
}

const useStyles = makeStyles(t => ({
  track: {
    flexDirection: 'row',
    padding: 2,
    gap: 2,
    borderRadius: radius.md,
    borderCurve: 'continuous',
    borderWidth: 1,
    borderColor: t.colors.lineSoft,
    backgroundColor: t.colors.bgInset,
  },
  seg: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    minHeight: 32,
    paddingHorizontal: space[3],
    borderRadius: radius.sm,
    borderCurve: 'continuous',
    borderWidth: 1,
    borderColor: 'transparent',
  },
  on: { backgroundColor: t.colors.bgRaised, borderColor: t.colors.line },
  pressed: { backgroundColor: t.colors.bgHover },
}))
