import type { MenuItem } from '~/types/ui'
import type { MenuContext, MenuLocation, PluginMenuRow } from './types'
import { guarded, pluginMenus, shown } from './registry'
import { iconComponent } from './icons'

const text = (v: unknown) => (v === undefined || v === null || v === '' ? undefined : String(v))

/** A plugin's own rows (`ui.contextMenu`, the Menu component) as `UiMenu` items; a row that throws is reported. */
export function pluginRowItems(pluginId: string, rows: readonly PluginMenuRow[] | null | undefined): MenuItem[] {
  return (Array.isArray(rows) ? rows as PluginMenuRow[] : []).filter(r => r && typeof r === 'object').map(r => ({
    label: String(r.label ?? ''),
    icon: iconComponent(r.icon),
    hint: text(r.hint),
    aside: text(r.aside),
    kbd: text(r.kbd),
    checked: !!r.checked,
    ...(typeof r.checked === 'boolean' ? { check: 'checkbox' as const } : {}),
    disabled: !!r.disabled,
    danger: !!r.danger,
    divider: !!r.divider,
    group: text(r.group),
    onSelect: () => { void guarded(pluginId, `menu row "${r.label}"`, () => r.onSelect?.()) },
  }))
}

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
