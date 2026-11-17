import { useId } from 'react'
import Svg, { Defs, G, Mask, Path, Rect } from 'react-native-svg'
import { useTheme } from '@/theme'

/**
 * The app mark, ported from the desktop's `ui/MangoMark.vue`: the ripeness-dot mango, ripe, with a
 * Roman inscription M cut out of its flesh so the ground shows through. Same geometry as
 * `assets/icon.svg`.
 */
export function MangoMark({ size = 18 }: { size?: number }) {
  const t = useTheme()
  const id = `mark${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`
  return (
    <Svg width={size} height={size} viewBox="0.6 0 11 11" accessibilityRole="image" accessibilityLabel="Mango">
      <Defs>
        <Mask id={id} maskUnits="userSpaceOnUse" x="0" y="0" width="12" height="12">
          <Path fill="#fff" d="M6.6 1.6c2.6.3 4.1 2.6 3.7 5.1-.4 2.4-2.4 3.9-4.6 3.7C3.3 10.2 1.6 8.3 1.8 6c.3-2.6 2.3-4.6 4.8-4.4Z" />
          <G fill="#000" transform="translate(6.05 6.25) scale(.071) translate(-51.5 -50)">
            <Path d="M19 80H27L31 22H23Z" />
            <Path d="M23 22H39L54.1 57L68 22H76L53 80H48Z" />
            <Path d="M66 22H80L84 80H69Z" />
            <Path d="M12 80H34V77.5C30.5 77.3 28 75.5 27.4 72H19.6C19 75.5 16 77.3 12 77.5Z" />
            <Path d="M62 80H91V77.5C87 77.3 84 75.5 83.4 72H68.6C68 75.5 65.5 77.3 62 77.5Z" />
            <Path d="M15 20H39V24H23L22.4 30C22 25.5 20 23.4 15 23Z" />
            <Path d="M66 20H90V23C85 23.4 81 25.5 80.6 30L80 24H66Z" />
          </G>
        </Mask>
      </Defs>
      <Rect x="0" y="0" width="12" height="12" fill={t.colors.accent} mask={`url(#${id})`} />
      <Path fill={t.colors.ripeQueued} d="M6.7 2c.3-1.1 1.4-1.9 2.9-1.8-.3 1.3-1.4 2-2.9 1.8Z" />
    </Svg>
  )
}
