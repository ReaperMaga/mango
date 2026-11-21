import { useId } from 'react'
import Svg, { Defs, G, Mask, Path, Rect } from 'react-native-svg'
import { useTheme } from '@/theme'

/**
 * The app mark, ported from the desktop's `ui/MangoMark.vue`: a kidney-shaped mango split down its
 * ridge into two halves, the left in the accent, the right a step lighter and warmer, with the leaf
 * in unripe green. Same geometry as `assets/icon.svg`.
 */
export function MangoMark({ size = 18 }: { size?: number }) {
  const t = useTheme()
  const id = `mark${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`
  return (
    <Svg width={size} height={size} viewBox="5 1.2 56.6 56.6" accessibilityRole="image" accessibilityLabel="Mango">
      <Defs>
        <Mask id={id} maskUnits="userSpaceOnUse" x="0" y="0" width="64" height="64">
          <Path fill="#fff" d="M37 10C50.5 9.4 58.6 20.6 57 34.5C55.5 47.8 45.2 57 32.6 57.2C22.8 57.4 13.6 53.6 10.4 46.2C8.4 41.2 12.2 35.6 17.6 30C22.6 24.8 25 13.2 37 10Z" />
          <Path d="M37.4 7C31.6 21 31.2 40 36.4 60" fill="none" stroke="#000" strokeWidth={3.6} strokeLinecap="round" />
        </Mask>
      </Defs>
      <G mask={`url(#${id})`}>
        <Rect x="0" y="0" width="64" height="64" fill={t.colors.accent} />
        <Path fill={t.colors.markLight} d="M37.4 0V7C31.6 21 31.2 40 36.4 60V64H64V0Z" />
      </G>
      <Path fill={t.colors.ripeQueued} d="M36.4 10.6C37 4.6 43 .8 51.8 1.8C50.6 8.2 44.4 12 36.4 10.6Z" />
    </Svg>
  )
}
