import type { MenuItem } from '~/types/ui'
import type { MenuContext, MenuLocation } from './types'
import { guarded, pluginMenus, shown } from './registry'
import { iconComponent } from './icons'

/**
 * Plugins' items for one of Mango's menus (`ui.menus`), as `UiMenu` items: after the menu's own,
 * the first set off by a divider. Each item's `when` and `run` get the menu's context.
 */
export function pluginMenuItems<L extends MenuLocation>(location: L, ctx: MenuContext[L]): MenuItem[] {
  return pluginMenus(location)
    .filter(m => shown(m, ctx))
    .map((m, i) => ({
      label: m.label,
      icon: iconComponent(m.icon),
      divider: i === 0,
      onSelect: () => { void guarded(m.pluginId, `menu item ${m.id}`, () => m.run({ ...ctx })) },
    }))
}
