import { defineComponent, h, markRaw, type Component } from 'vue'
import type { PluginIcon as Icon } from './types'
import PluginIcon from './ui/PluginIcon.vue'

/**
 * A plugin's icon as a component, for places that take an icon component (menus, the palette, the
 * tool stripe). One component per icon, kept, so lists do not re-render for nothing.
 */
const cache = new Map<unknown, Component>()

export function iconComponent(icon: Icon | null | undefined): Component | undefined {
  if (!icon) return undefined
  let c = cache.get(icon)
  if (!c) {
    c = markRaw(defineComponent({
      name: 'PluginIconOf',
      setup(_, { attrs }) { return () => h(PluginIcon, { ...attrs, icon }) },
    }))
    cache.set(icon, c)
  }
  return c
}
