import { useEffect, useRef } from 'react'
import { Animated, Easing, View } from 'react-native'
import { useReducedMotion, useTheme } from '@/theme'

/**
 * The desktop's ring spinner: a thin circle with one quarter open, turning. Work in progress is
 * the one thing allowed to move on its own. `color` defaults to subtle ink; a running tool passes
 * `ripeRunning`, a button its label colour.
 */
export function Spinner({ size = 14, color, width = 1.75, label }: { size?: number; color?: string; width?: number; label?: string }) {
  const t = useTheme()
  const reduced = useReducedMotion()
  const turn = useRef(new Animated.Value(0)).current
  useEffect(() => {
    if (reduced) return
    const loop = Animated.loop(Animated.timing(turn, { toValue: 1, duration: 750, easing: Easing.linear, useNativeDriver: true }))
    loop.start()
    return () => loop.stop()
  }, [reduced, turn])
  const c = color ?? t.colors.fgSubtle
  return (
    <View accessible={!!label} accessibilityRole={label ? 'progressbar' : undefined} accessibilityLabel={label} style={{ width: size, height: size }}>
      <Animated.View
        style={{
          width: size,
          height: size,
          borderRadius: size / 2,
          borderWidth: width,
          borderColor: c,
          borderRightColor: 'transparent',
          transform: [{ rotate: turn.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] }) }],
        }}
      />
    </View>
  )
}
