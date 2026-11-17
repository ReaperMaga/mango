import type { ComponentType, ReactNode } from 'react'
import { View, type StyleProp, type ViewStyle } from 'react-native'
import type { LucideProps } from 'lucide-react-native'
import { makeStyles, space, useTheme } from '@/theme'
import { Text } from './Text'

export interface EmptyStateProps {
  /** A line icon in faint ink, or any small mark (the MangoMark, a ripeness dot). */
  icon?: ComponentType<LucideProps>
  mark?: ReactNode
  title: string
  /** What to do next, in a sentence: an empty state teaches the screen, it never just says "nothing here". */
  body?: string
  /** The one way forward: usually a Button. */
  action?: ReactNode
  style?: StyleProp<ViewStyle>
}

/** A centred column a little above the optical middle, as the desktop's empty pane and welcome hub. */
export function EmptyState({ icon: Icon, mark, title, body, action, style }: EmptyStateProps) {
  const t = useTheme()
  const s = useStyles()
  return (
    <View style={[s.wrap, style]}>
      {mark ?? (Icon ? <Icon size={28} strokeWidth={1.5} color={t.colors.fgFaint} /> : null)}
      <Text variant="title" style={s.title} accessibilityRole="header">{title}</Text>
      {body ? <Text variant="bodySm" tone="subtle" style={s.body}>{body}</Text> : null}
      {action ? <View style={s.action}>{action}</View> : null}
    </View>
  )
}

const useStyles = makeStyles(() => ({
  wrap: { alignItems: 'center', paddingHorizontal: space[8], paddingTop: space[8], paddingBottom: space[12], gap: space[2] },
  title: { textAlign: 'center', marginTop: space[2] },
  body: { textAlign: 'center', maxWidth: 320 },
  action: { marginTop: space[3] },
}))
