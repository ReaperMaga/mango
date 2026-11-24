import { GitGraph } from 'lucide-vue-next'
import { markRaw } from 'vue'
import { t } from '~/i18n'
import type { PluginIcon, PluginPanelTab } from '~/plugin-host/types'
import { pluginNames, read, reg, shown, type Owned } from '~/plugin-host/registry'
import { GIT_LOG_TAB } from '~/utils/builtIns'

/*
 * The bottom panel's tabs besides the terminals: Mango's own (the Git log) and those plugins registered
 * (`ui.panelTabs`). Both move, dock and close alike; whatever places or lists them reads them here.
 */

export interface BuiltInPanelTab {
  fullId: string
  pluginId: null
  title: string
  icon: PluginIcon
  /** The action whose key opens it (utils/shortcuts). */
  shortcut: string
}

export type PanelTab = BuiltInPanelTab | Owned<PluginPanelTab>

const BUILT_IN: readonly BuiltInPanelTab[] = [
  { fullId: GIT_LOG_TAB, pluginId: null, get title() { return t('shell.tools.gitLog') }, icon: markRaw(GitGraph), shortcut: 'git-log' },
]

export const allPanelTabs = (): PanelTab[] => [...BUILT_IN, ...reg.panelTabs]

export const findPanelTab = (ref: string | null | undefined): PanelTab | null =>
  (ref ? allPanelTabs().find(tab => tab.fullId === ref) ?? null : null)

/** Offered now: one of Mango's always is, a plugin's while its `when()` holds. */
export const panelTabOffered = (t: PanelTab) => t.pluginId === null || shown(t)

/** The count on a tab and its button; 0 for none. */
export function panelTabBadge(t: PanelTab): number {
  if (t.pluginId === null) return 0
  const n = read(t.badge, t.pluginId, null, 'badge')
  return typeof n === 'number' && n > 0 ? Math.floor(n) : 0
}

/** The plugin a tab comes from, by name; null for Mango's own. */
export const panelTabPlugin = (t: PanelTab | null) =>
  (t?.pluginId ? pluginNames[t.pluginId] ?? t.pluginId : null)
