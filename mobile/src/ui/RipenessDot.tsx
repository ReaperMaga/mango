import { useEffect, useId, useRef } from 'react'
import { Animated, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native'
import Svg, { Circle, Defs, Mask, Path, Rect } from 'react-native-svg'
import type { Thread, ThreadStatus } from '~/types/chat'
import { easeInOut, easeOut, motion, useReducedMotion, useTheme, type Colors } from '@/theme'

/**
 * Mango's signature status mark, ported from the desktop's `ui/RipenessDot.vue`: a small fruit
 * whose colour and fill show how ripe a thread is. Archived and queued are hollow (grey, then
 * unripe leaf green), running is half-filled mango whose level breathes, working is the same
 * half-ripe fruit at rest, waiting is full blush (needs you), error is red. Done leaves the fruit
 * behind: a lime disc with a check cut out of it, so the ground shows through.
 */
export type DotStatus = ThreadStatus | 'archived'

/** What the dot shows for a thread: archived wins, otherwise the run status (as the sidebar passes it). */
export const dotStatus = (t: Pick<Thread, 'status' | 'archived'>): DotStatus => (t.archived ? 'archived' : t.status)

export const DOT_LABELS: Record<DotStatus, string> = {
  archived: 'Archived',
  queued: 'Queued',
  running: 'Working',
  working: 'Working',
  waiting: 'Needs you',
  done: 'Settled',
  error: 'Failed',
}

const BODY = 'M6.6 1.6c2.6.3 4.1 2.6 3.7 5.1-.4 2.4-2.4 3.9-4.6 3.7C3.3 10.2 1.6 8.3 1.8 6c.3-2.6 2.3-4.6 4.8-4.4Z'
const LEAF = 'M6.9 1.9c.3-.9 1.1-1.5 2.2-1.5-.2 1-1 1.6-2.2 1.5Z'

/** Colour and fill line per status: `level` is the y of the fill line on the 12-unit grid (12 empty, 0 full). */
const look: Record<DotStatus, { c: keyof Colors; level: number; leaf: keyof Colors; leafOpacity: number }> = {
  archived: { c: 'ripeIdle', level: 12, leaf: 'ripeIdle', leafOpacity: 0.9 },
  queued: { c: 'ripeQueued', level: 12, leaf: 'ripeQueued', leafOpacity: 0.9 },
  running: { c: 'ripeRunning', level: 6, leaf: 'ripeQueued', leafOpacity: 0.9 },
  working: { c: 'ripeRunning', level: 6, leaf: 'ripeQueued', leafOpacity: 0.9 },
  waiting: { c: 'ripeWaiting', level: 0, leaf: 'ripeQueued', leafOpacity: 0.9 },
  done: { c: 'ripeDone', level: 0, leaf: 'ripeQueued', leafOpacity: 0.9 },
  error: { c: 'ripeError', level: 0, leaf: 'ripeError', leafOpacity: 0.6 },
}

export interface RipenessDotProps {
  status: DotStatus
  /** Points; 12 by default as on the desktop. Rows on the phone use 14. */
  size?: number
  /** A result or request nobody has looked at: a soft halo ring in the status colour. */
  unseen?: boolean
  style?: StyleProp<ViewStyle>
}

export function RipenessDot({ status, size = 12, unseen = false, style }: RipenessDotProps) {
  const t = useTheme()
  const reduced = useReducedMotion()
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, '')
  const l = look[status]
  const color = t.colors[l.c]

  // The fill line, in grid units. Moving it is the ripening: 420ms, or a breathing loop while running.
  const level = useRef(new Animated.Value(l.level)).current
  useEffect(() => {
    level.stopAnimation()
    if (status === 'running' && !reduced) {
      const half = 900
      const loop = Animated.loop(Animated.sequence([
        Animated.timing(level, { toValue: 4, duration: half, easing: easeInOut, useNativeDriver: true }),
        Animated.timing(level, { toValue: 7.5, duration: half, easing: easeInOut, useNativeDriver: true }),
      ]))
      Animated.timing(level, { toValue: 7.5, duration: motion.med, easing: easeOut, useNativeDriver: true }).start(({ finished }) => {
        if (finished) loop.start()
      })
      return () => loop.stop()
    }
    Animated.timing(level, { toValue: l.level, duration: reduced ? 0 : motion.slow, easing: easeOut, useNativeDriver: true }).start()
    return undefined
  }, [status, reduced, l.level, level])

  // Settling swaps the fruit for the lime disc; the disc settles in from 70%.
  const doneIn = useRef(new Animated.Value(status === 'done' ? 1 : 0)).current
  useEffect(() => {
    if (status !== 'done') { doneIn.setValue(0); return }
    Animated.timing(doneIn, { toValue: 1, duration: reduced ? 0 : motion.med, easing: easeOut, useNativeDriver: true }).start()
  }, [status, reduced, doneIn])

  const unit = size / 12
  // Clip by moving a window down to the fill line while moving the fruit back up by the same
  // amount: the flesh shows only below the line, and both moves run on the native driver.
  const windowY = Animated.multiply(level, unit)
  const fruitY = Animated.multiply(level, -unit)

  return (
    <View
      style={[{ width: size, height: size }, styles.box, style]}
      accessible
      accessibilityRole="image"
      accessibilityLabel={DOT_LABELS[status]}
    >
      {status === 'done' ? (
        <Animated.View style={{ opacity: doneIn, transform: [{ scale: doneIn.interpolate({ inputRange: [0, 1], outputRange: [0.7, 1] }) }] }}>
          <Svg width={size} height={size} viewBox="0 0 12 12">
            <Defs>
              <Mask id={`m${id}`} maskUnits="userSpaceOnUse" x="0" y="0" width="12" height="12">
                <Rect width="12" height="12" fill="#fff" />
                <Path d="M3.6 6.2 5.3 7.9 8.5 4.4" fill="none" stroke="#000" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
              </Mask>
            </Defs>
            <Circle cx="6" cy="6" r="5.4" fill={color} mask={`url(#m${id})`} />
          </Svg>
        </Animated.View>
      ) : (
        <>
          <Svg width={size} height={size} viewBox="0 0 12 12" style={StyleSheet.absoluteFill}>
            <Path d={BODY} fill="none" stroke={color} strokeWidth={1.2} />
          </Svg>
          <Animated.View style={[StyleSheet.absoluteFill, styles.clip, { transform: [{ translateY: windowY }] }]}>
            <Animated.View style={{ transform: [{ translateY: fruitY }] }}>
              <Svg width={size} height={size} viewBox="0 0 12 12">
                <Path d={BODY} fill={color} stroke={color} strokeWidth={1.2} />
              </Svg>
            </Animated.View>
          </Animated.View>
          <Svg width={size} height={size} viewBox="0 0 12 12" style={StyleSheet.absoluteFill}>
            <Path d={LEAF} fill={t.colors[l.leaf]} opacity={l.leafOpacity} />
          </Svg>
        </>
      )}
      {unseen ? (
        <View pointerEvents="none" style={[styles.halo, { borderColor: color }]} />
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  box: { position: 'relative', flexShrink: 0 },
  clip: { overflow: 'hidden' },
  halo: {
    position: 'absolute',
    top: -3,
    left: -3,
    right: -3,
    bottom: -3,
    borderRadius: 999,
    borderWidth: 1.5,
    opacity: 0.45,
  },
})
