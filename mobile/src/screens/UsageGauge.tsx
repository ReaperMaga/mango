import { View } from 'react-native'
import { makeStyles } from '@/theme'
import { Text } from '@/ui'
import { usageLevel } from './usageText'

/** A usage window's gauge: a thin track with the used part filled, warm from 80% and red when used up, and the number. */
export function UsageGauge({ percent }: { percent: number }) {
  const s = useStyles()
  const level = usageLevel(percent)
  const shown = Math.max(0, Math.min(100, percent))
  return (
    <View
      style={s.wrap}
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel="Used"
      accessibilityValue={{ min: 0, max: 100, now: Math.round(shown) }}
    >
      <View style={s.track}>
        <View style={[s.fill, level === 'high' && s.high, level === 'full' && s.full, { width: `${shown}%` }]} />
      </View>
      <Text variant="bodySm" tone={level === 'ok' ? 'fg' : level === 'high' ? 'waiting' : 'error'} tabular style={s.pct}>{Math.round(percent)}%</Text>
    </View>
  )
}

const useStyles = makeStyles(t => ({
  wrap: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  track: { width: 64, height: 6, borderRadius: 999, overflow: 'hidden', backgroundColor: t.colors.bgActive },
  fill: { height: '100%', borderRadius: 999, backgroundColor: t.colors.accent },
  high: { backgroundColor: t.colors.ripeWaiting },
  full: { backgroundColor: t.colors.ripeError },
  pct: { width: 40, textAlign: 'right' },
}))
