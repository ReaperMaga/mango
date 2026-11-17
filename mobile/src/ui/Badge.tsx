import { View, type StyleProp, type ViewStyle } from 'react-native'
import { fonts, makeStyles, radius, withAlpha, type Colors } from '@/theme'
import { Text } from './Text'

export type BadgeTone = 'neutral' | 'accent' | 'queued' | 'running' | 'waiting' | 'done' | 'error'

export interface BadgeProps {
  label: string
  /**
   * neutral: a quiet tag on the Hover Wash. accent: the counter pill (accent fill with its ink).
   * Status tones: the status's mark colour as a 14% wash, its words in the text grade.
   */
  tone?: BadgeTone
  /** A qualifier such as "Simulated": a dashed strong-line pill with no fill, as on the desktop. */
  dashed?: boolean
  style?: StyleProp<ViewStyle>
}

const marks: Record<Exclude<BadgeTone, 'neutral' | 'accent'>, [mark: keyof Colors, ink: keyof Colors]> = {
  queued: ['ripeQueued', 'ripeQueuedFg'],
  running: ['ripeRunning', 'ripeRunningFg'],
  waiting: ['ripeWaiting', 'ripeWaitingFg'],
  done: ['ripeDone', 'ripeDoneFg'],
  error: ['ripeError', 'ripeErrorFg'],
}

/** Small counters and tags; full pills are kept for exactly these. */
export function Badge({ label, tone = 'neutral', dashed, style }: BadgeProps) {
  const s = useStyles()
  return (
    <View style={[s.pill, dashed ? s.dashed : s[tone], style]}>
      <Text
        variant="micro"
        tabular
        maxFontSizeMultiplier={1.3}
        numberOfLines={1}
        style={[s.text, tone === 'accent' && !dashed ? s.onAccent : s[`${tone}Ink`]]}
      >
        {label}
      </Text>
    </View>
  )
}

const useStyles = makeStyles((t) => {
  const tint = (k: keyof typeof marks) => ({ backgroundColor: withAlpha(t.colors[marks[k][0]], 0.14) })
  const ink = (k: keyof typeof marks) => ({ color: t.colors[marks[k][1]] })
  return {
    pill: { alignSelf: 'flex-start', minHeight: 20, paddingHorizontal: 7, justifyContent: 'center', borderRadius: radius.pill, borderWidth: 1, borderColor: 'transparent' },
    text: { fontFamily: fonts.medium },
    dashed: { borderStyle: 'dashed', borderColor: t.colors.lineStrong },
    neutral: { backgroundColor: t.colors.bgHover, borderColor: t.colors.lineSoft },
    neutralInk: { color: t.colors.fgMuted },
    accent: { backgroundColor: t.colors.accent },
    accentInk: { color: t.colors.accentInk },
    onAccent: { color: t.colors.accentFg },
    queued: tint('queued'),
    queuedInk: ink('queued'),
    running: tint('running'),
    runningInk: ink('running'),
    waiting: tint('waiting'),
    waitingInk: ink('waiting'),
    done: tint('done'),
    doneInk: ink('done'),
    error: tint('error'),
    errorInk: ink('error'),
  }
})
