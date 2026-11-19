import type { ReactNode } from 'react'
import { View, type StyleProp, type ViewStyle } from 'react-native'
import { CircleAlert, Info, ShieldQuestionMark, X } from 'lucide-react-native'
import { makeStyles, space, useTheme } from '@/theme'
import { Text } from './Text'
import { IconButton } from './IconButton'

export interface BannerProps {
  /** error: a 12% Bruise Red wash with a tinted border. waiting: something needs the person. info: a plain panel. */
  tone?: 'error' | 'info' | 'waiting'
  /** Short, bold-ish first line. Optional: a message alone is fine. */
  title?: string
  /** Names the problem and the way out. Selectable: people copy errors. */
  message: string
  /** One action under the text (a ghost or secondary Button). */
  action?: ReactNode
  onDismiss?: () => void
  style?: StyleProp<ViewStyle>
}

/**
 * An inline message, in the flow (not floating, so no shadow). The tone shows as an icon in the
 * mark grade and a tinted border and wash, never as a side stripe.
 */
export function Banner({ tone = 'info', title, message, action, onDismiss, style }: BannerProps) {
  const t = useTheme()
  const s = useStyles()
  const Icon = tone === 'error' ? CircleAlert : tone === 'waiting' ? ShieldQuestionMark : Info
  const iconColor = tone === 'error' ? t.colors.ripeError : tone === 'waiting' ? t.colors.ripeWaiting : t.colors.fgSubtle
  return (
    <View
      style={[s.box, s[tone], style]}
      accessibilityRole={tone === 'error' ? 'alert' : undefined}
      accessibilityLiveRegion={tone === 'error' ? 'assertive' : 'polite'}
    >
      <View style={s.icon}><Icon size={18} strokeWidth={1.85} color={iconColor} /></View>
      <View style={s.text}>
        {title ? <Text variant="label" tone={tone === 'error' ? 'error' : tone === 'waiting' ? 'waiting' : 'fg'}>{title}</Text> : null}
        <Text variant="bodySm" tone={title ? 'muted' : 'fg'} selectable>{message}</Text>
        {action ? <View style={s.action}>{action}</View> : null}
      </View>
      {onDismiss ? <IconButton icon={X} label="Dismiss" size="sm" onPress={onDismiss} style={s.dismiss} /> : null}
    </View>
  )
}

const useStyles = makeStyles(t => ({
  box: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space[3],
    paddingVertical: space[3],
    paddingLeft: space[3],
    paddingRight: space[2],
    borderRadius: t.radius.md,
    borderCurve: 'continuous',
    borderWidth: 1,
  },
  error: { backgroundColor: t.colors.errorWash, borderColor: t.colors.errorLine },
  waiting: { backgroundColor: t.colors.waitingWash, borderColor: t.colors.waitingLine },
  info: { backgroundColor: t.colors.bgPanel, borderColor: t.colors.line },
  icon: { paddingTop: 2 },
  text: { flex: 1, minWidth: 0, gap: 2 },
  action: { marginTop: space[2] },
  dismiss: { marginTop: -6 },
}))
