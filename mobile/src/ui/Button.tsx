import type { ComponentType, ReactNode } from 'react'
import { Pressable, View, type StyleProp, type ViewStyle } from 'react-native'
import type { LucideProps } from 'lucide-react-native'
import { makeStyles, space, touch, useTheme, type Colors } from '@/theme'
import { Text } from './Text'
import { Spinner } from './Spinner'
import { haptic, type HapticKind } from './haptics'

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'
export type ButtonSize = 'sm' | 'md' | 'lg'

export interface ButtonProps {
  label: string
  onPress?: () => void
  /** Ported from the desktop's `UiButton`. Primary: one per view. Ghost: cancel and deny. Danger: destroys work. */
  variant?: ButtonVariant
  /** sm 36pt (its hit area still reaches 44), md 44pt, lg 50pt. */
  size?: ButtonSize
  icon?: ComponentType<LucideProps>
  loading?: boolean
  disabled?: boolean
  /** Full width. */
  block?: boolean
  haptic?: HapticKind
  accessibilityHint?: string
  style?: StyleProp<ViewStyle>
  children?: ReactNode
}

const heights: Record<ButtonSize, number> = { sm: 36, md: touch.min, lg: 50 }

/** Ink per variant: the label, the icon and the spinner share it. */
const ink: Record<ButtonVariant, keyof Colors> = {
  primary: 'accentFg',
  secondary: 'fg',
  ghost: 'fgMuted',
  danger: 'ripeErrorFg',
}

export function Button({ label, onPress, variant = 'secondary', size = 'md', icon: Icon, loading = false, disabled = false, block = false, haptic: kind, accessibilityHint, style }: ButtonProps) {
  const t = useTheme()
  const s = useStyles()
  const off = disabled || loading
  const color = t.colors[ink[variant]]
  const h = heights[size]
  return (
    <Pressable
      onPress={() => {
        if (kind) haptic(kind)
        onPress?.()
      }}
      disabled={off}
      hitSlop={h < touch.min ? (touch.min - h) / 2 : undefined}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: off, busy: loading }}
      style={({ pressed }) => [
        s.base,
        s[variant],
        pressed && !off && s[`${variant}Pressed`],
        { minHeight: h, paddingHorizontal: size === 'lg' ? space[5] : size === 'sm' ? space[3] : space[4] },
        pressed && !off && s.nudge,
        block && s.block,
        disabled && !loading && s.disabled,
        style,
      ]}
    >
      {loading ? <Spinner size={14} color={color} /> : Icon ? <Icon size={17} strokeWidth={1.85} color={color} /> : null}
      <Text
        numberOfLines={1}
        maxFontSizeMultiplier={1.3}
        style={[s.label, { color }, size === 'lg' && { fontSize: t.fontSize.body }]}
      >
        {label}
      </Text>
    </Pressable>
  )
}

/** A row of buttons, 8pt apart, as the desktop's dialog and card footers. */
export function ButtonRow({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[{ flexDirection: 'row', alignItems: 'center', gap: space[2], flexWrap: 'wrap' }, style]}>{children}</View>
}

const useStyles = makeStyles(t => ({
  base: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'flex-start',
    gap: space[2],
    borderRadius: t.radius.sm,
    borderCurve: 'continuous',
    borderWidth: 1,
    borderColor: 'transparent',
  },
  block: { alignSelf: 'stretch' },
  label: { ...t.fonts.medium, fontSize: t.fontSize.bodySm },
  primary: { backgroundColor: t.colors.accent },
  primaryPressed: { backgroundColor: t.colors.accentStrong },
  secondary: { backgroundColor: t.colors.bgPanel, borderColor: t.colors.line },
  secondaryPressed: { backgroundColor: t.colors.bgRaised, borderColor: t.colors.lineStrong },
  ghost: {},
  ghostPressed: { backgroundColor: t.colors.bgHover },
  danger: { borderColor: t.colors.errorLine },
  dangerPressed: { backgroundColor: t.colors.errorWash },
  nudge: { transform: [{ translateY: 0.5 }] },
  disabled: { opacity: 0.55 },
}))
