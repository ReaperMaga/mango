import { h, markRaw, type Component } from 'vue'
import type { Color } from '../model.ts'
import { colorVar } from './colors.ts'

const made = new Map<Color | null, Component>()

/** An option's dot as a menu row's icon; an open ring for no option. The same component for a colour each time. */
export function optionIcon(color: Color | null): Component {
  let icon = made.get(color)
  if (!icon) {
    const style = color === null
      ? { fill: 'none', stroke: 'var(--fg-faint)', strokeWidth: '2', strokeDasharray: '2.6 2.6' }
      : { fill: colorVar(color).dot, stroke: 'none' }
    icon = markRaw(() => h('svg', { viewBox: '0 0 24 24', width: 24, height: 24 }, [h('circle', { cx: 12, cy: 12, r: 6.5, style })]))
    if (made.size > 500) made.clear()
    made.set(color, icon)
  }
  return icon
}
