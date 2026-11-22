import type { PanelTabPlace } from '~/plugin-host/ids'

/*
 * Features that are part of Mango and live where plugins' do. Plain TypeScript (tests/gitLog.test.ts).
 */

/**
 * The Git log's tab in the bottom panel. The ref is the one it had as the `git-log` plugin, so where
 * the user had put that tab still holds.
 */
export const GIT_LOG_TAB = 'git-log.log'

/** The built-in panel tabs, by ref. */
export const BUILT_IN_TABS: readonly string[] = [GIT_LOG_TAB]

/**
 * Saved places, with each built-in tab this window has not known before (`known`) starting closed: its
 * button opens it, and until then the panel holds the terminals alone. One that is in the saved layout
 * already (`chosen`, `order`, a place of its own) stays where it was.
 */
export function seedBuiltInTabs(
  places: Record<string, PanelTabPlace>,
  saved: { known: unknown; chosen: unknown; order: readonly string[] },
): Record<string, PanelTabPlace> {
  const known = new Set<unknown>(Array.isArray(saved.known) ? saved.known : [])
  const out = { ...places }
  for (const ref of BUILT_IN_TABS) {
    if (known.has(ref) || out[ref] || saved.chosen === ref || saved.order.includes(ref)) continue
    out[ref] = { at: 'closed' }
  }
  return out
}

/** Plugins that became part of Mango, by id, with what their page says. They never run, and the catalog leaves them out. */
const BUILT_IN_PLUGINS = new Map([
  ['git-log', 'Git log is part of Mango now, so this plugin no longer runs. You can remove it.'],
])

/** Why a plugin no longer runs because Mango has it built in, or null. */
export const builtInPluginNote = (id: string): string | null => BUILT_IN_PLUGINS.get(id) ?? null
