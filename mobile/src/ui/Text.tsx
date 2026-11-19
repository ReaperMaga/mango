import { Text as RNText, type TextProps } from 'react-native'
import { useTheme, type Colors, type TextStyleName } from '@/theme'

export type TextVariant = TextStyleName
export type TextTone = 'fg' | 'muted' | 'subtle' | 'faint' | 'accent' | 'queued' | 'running' | 'waiting' | 'done' | 'error' | 'onAccent'

const tones: Record<TextTone, keyof Colors> = {
  fg: 'fg',
  muted: 'fgMuted',
  subtle: 'fgSubtle',
  faint: 'fgFaint',
  // Words in a status or accent colour always take the text grade (Fill-or-Ink, Two-Grade).
  accent: 'accentInk',
  queued: 'ripeQueuedFg',
  running: 'ripeRunningFg',
  waiting: 'ripeWaitingFg',
  done: 'ripeDoneFg',
  error: 'ripeErrorFg',
  onAccent: 'accentFg',
}

/**
 * Text in Mango's type scale and inks: `<Text variant="caption" tone="subtle">`. Numbers that line
 * up (counts, times) pass `tabular`. Dynamic Type stays on, capped where dense chrome would break.
 */
export function Text({ variant = 'body', tone = 'fg', tabular, style, ...rest }: TextProps & { variant?: TextVariant; tone?: TextTone; tabular?: boolean }) {
  const t = useTheme()
  return (
    <RNText
      maxFontSizeMultiplier={1.6}
      {...rest}
      style={[t.type[variant], { color: t.colors[tones[tone]] }, tabular && { fontVariant: ['tabular-nums'] }, style]}
    />
  )
}
