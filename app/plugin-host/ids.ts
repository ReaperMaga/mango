/**
 * Ids the plugin system puts into Mango's own state: tool windows (`ToolView`), main-area tabs and
 * colour schemes; and the CSS built from what plugins hand in. Plain TypeScript (tests/).
 *
 * Plugin ids may hold dots (`[a-z0-9][a-z0-9._-]*`), so the parts a plugin registers are joined with
 * a dot for display (`<pluginId>.<id>`) but looked up whole, never split.
 */

export const PLUGIN_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/

/** A plugin's own id for something it registers: letters, digits, `.`, `_`, `-`, `:`; up to 64. */
export const PART_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/

export const fullId = (pluginId: string, id: string) => `${pluginId}.${id}`

/* ---------- tool windows and colour schemes: `plugin:<pluginId>.<id>` (workspace.toolPanel, workspace.scheme) */

export const PLUGIN_PREFIX = 'plugin:'
export type PluginRef = `plugin:${string}`

export const pluginRef = (pluginId: string, id: string) => `${PLUGIN_PREFIX}${fullId(pluginId, id)}` as PluginRef

/** A well-formed `plugin:…` value (what a saved pref may hold; whether it is registered is another question). */
export const isPluginRef = (v: unknown): v is PluginRef =>
  typeof v === 'string' && v.length < 200 && /^plugin:[a-z0-9][\w.:-]*$/.test(v)

/** The scheme to apply: a plugin's while it is registered, else Mango's own. */
export function effectiveScheme(wanted: string, registered: (id: string) => boolean, fallback = 'mango'): string {
  if (!isPluginRef(wanted)) return wanted
  return registered(wanted) ? wanted : fallback
}

/* ---------- main-area tabs */

const TAB = 'plugin\u0001'

export interface PluginTabRef { projectPath: string; pluginId: string; viewId: string; key: string }

export const pluginTabId = (r: PluginTabRef) => `${TAB}${r.projectPath}\u0001${r.pluginId}\u0001${r.viewId}\u0001${r.key}`

export const isPluginTab = (id: string | null | undefined): id is string => !!id && id.startsWith(TAB)

export function parsePluginTab(id: string | null | undefined): PluginTabRef | null {
  if (!isPluginTab(id)) return null
  const [, projectPath = '', pluginId = '', viewId = '', ...rest] = id.split('\u0001')
  return { projectPath, pluginId, viewId, key: rest.join('\u0001') }
}

/* ---------- design tokens a plugin hands in */

const TOKEN_NAME = /^--[A-Za-z0-9_-]{1,64}$/

/** `{ '--accent': '#f60' }` as declarations, dropping names that are not custom properties and values that could leave the rule. */
export function tokenDeclarations(tokens: Record<string, unknown> | null | undefined): string {
  const out: string[] = []
  for (const [k, v] of Object.entries(tokens ?? {})) {
    if (!TOKEN_NAME.test(k) || (typeof v !== 'string' && typeof v !== 'number')) continue
    const value = String(v).trim()
    if (!value || /[;{}<>]|\/\*|\\/.test(value) || value.length > 400) continue
    out.push(`  ${k}: ${value};`)
  }
  return out.join('\n')
}

/** The rules for a plugin colour scheme, written the way tokens.css writes the built-in ones. */
export function schemeCss(schemeId: string, dark: Record<string, unknown>, light: Record<string, unknown>): string {
  const sel = JSON.stringify(schemeId)
  return [
    `:root[data-scheme=${sel}],\n[data-scheme=${sel}] {\n${tokenDeclarations(dark)}\n}`,
    `:root[data-theme='light'][data-scheme=${sel}],\n[data-theme='light'] [data-scheme=${sel}] {\n${tokenDeclarations(light)}\n}`,
  ].join('\n')
}
