import type { ComponentType } from 'react'
import { Pressable, type StyleProp, type ViewStyle } from 'react-native'
import type { LucideProps } from 'lucide-react-native'
import { makeStyles, touch, useTheme } from '@/theme'
import { haptic, type HapticKind } from './haptics'

export interface IconButtonProps {
  icon: ComponentType<LucideProps>
  /** Read out and required: an icon alone never names its action. */
  label: string
  onPress?: () => void
  /** md: a 44pt square with a 22pt icon. sm: a 32pt square (hit area still 44) with an 18pt icon. */
  size?: 'sm' | 'md'
  /** Toggled on: Active Wash and primary ink, as the desktop's `IconButton`. */
  active?: boolean
  disabled?: boolean
  /** Icon colour at rest; subtle ink by default. */
  color?: string
  haptic?: HapticKind
  style?: StyleProp<ViewStyle>
}

export function IconButton({ icon: Icon, label, onPress, size = 'md', active = false, disabled = false, color, haptic: kind, style }: IconButtonProps) {
  const t = useTheme()
  const s = useStyles()
  const box = size === 'md' ? touch.min : 32
  return (
    <Pressable
      onPress={() => {
        if (kind) haptic(kind)
        onPress?.()
      }}
      disabled={disabled}
      hitSlop={box < touch.min ? (touch.min - box) / 2 : undefined}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled, selected: active || undefined }}
      style={({ pressed }) => [
        s.base,
        { width: box, height: box, borderRadius: size === 'md' ? t.radius.md : t.radius.sm },
        (pressed || active) && s.active,
        disabled && s.disabled,
        style,
      ]}
    >
      {({ pressed }) => (
        <Icon size={size === 'md' ? 22 : 18} strokeWidth={1.75} color={pressed || active ? t.colors.fg : (color ?? t.colors.fgSubtle)} />
      )}
    </Pressable>
  )
}

const useStyles = makeStyles(t => ({
  base: { alignItems: 'center', justifyContent: 'center', borderCurve: 'continuous' },
  active: { backgroundColor: t.colors.bgActive },
  disabled: { opacity: 0.4 },
}))
