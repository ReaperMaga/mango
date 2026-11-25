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

/*
 * ---------- panel tabs (`ui.panelTabs`): `<pluginId>.<id>`
 *
 * One instance each (Mango's own, the Git log, uses the same form: utils/builtIns). It lives in the bottom panel's strip (among the terminals, in `workspace.panelOrder`),
 * as a tab in the main area, or nowhere (closed): `workspace.panelTabPlaces`, by ref (no entry: the panel).
 * Terminal ids (`term-N`) never hold a dot, so a ref and a terminal id never collide in one list.
 */

/** A well-formed panel tab ref (what a saved pref may hold; whether it is registered is another question). */
export const isPanelTabRef = (v: unknown): v is string =>
  typeof v === 'string' && v.length < 200 && /^[a-z0-9][a-z0-9._-]*\.[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(v)

export type PanelTabPlace =
  | { at: 'panel' }
  /** A tab in the main area: the project it belongs to and the pane whose strip holds it. */
  | { at: 'editor'; projectPath: string; paneId: string }
  /** Closed by the user: its button, `panelTabs.open` or a command brings it back, into the panel. */
  | { at: 'closed' }

/** Saved places, dropping anything unreadable (older or newer builds, a hand-edited file). Panel places are implied: not kept. */
export function normalizePanelPlaces(v: unknown): Record<string, PanelTabPlace> {
  const out: Record<string, PanelTabPlace> = {}
  if (!v || typeof v !== 'object' || Array.isArray(v)) return out
  for (const [ref, raw] of Object.entries(v as Record<string, unknown>)) {
    if (!isPanelTabRef(ref) || !raw || typeof raw !== 'object') continue
    const p = raw as Partial<Record<string, unknown>>
    if (p.at === 'closed') out[ref] = { at: 'closed' }
    else if (p.at === 'editor' && typeof p.projectPath === 'string' && p.projectPath) {
      out[ref] = { at: 'editor', projectPath: p.projectPath, paneId: typeof p.paneId === 'string' && p.paneId ? p.paneId : 'pane-a' }
    }
  }
  return out
}

/** A saved strip order: panel tab refs only (terminals do not outlive the app), once each. */
export function normalizePanelOrder(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  return [...new Set(v.filter(isPanelTabRef))]
}

/**
 * The bottom panel's strip: `order` (the hand-made order) kept for what is there now, panel tabs not in
 * it first (one never placed opens at the start) and terminals not in it last (a new shell joins the end).
 */
export function panelStrip(order: readonly string[], terminals: readonly string[], tabs: readonly string[]): string[] {
  const here = new Set([...terminals, ...tabs])
  const placed = order.filter((k, i) => here.has(k) && order.indexOf(k) === i)
  const known = new Set(placed)
  return [...tabs.filter(k => !known.has(k)), ...placed, ...terminals.filter(k => !known.has(k))]
}

/* ---------- a panel tab shown in the main area: `ptab\u0001<projectPath>\u0001<ref>` (not saved with the layout) */

const PANEL_TAB = 'ptab\u0001'

export const panelEditorTabId = (projectPath: string, ref: string) => `${PANEL_TAB}${projectPath}\u0001${ref}`

export const isPanelEditorTab = (id: string | null | undefined): id is string => !!id && id.startsWith(PANEL_TAB)

export function parsePanelEditorTab(id: string | null | undefined): { projectPath: string; ref: string } | null {
  if (!isPanelEditorTab(id)) return null
  const [, projectPath = '', ref = ''] = id.split('\u0001')
  return { projectPath, ref }
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

/*
 * Tabs of a view with `restore` are saved with the layout, apart from the panes (a build that does not know
 * them drops them and shows nothing in their place). They wait for their plugin, which starts later.
 */

/** An open plugin tab. `restore`: it is saved (its view says so, or it was restored and its plugin has not started yet). */
export interface PluginTabEntry { title: string; state: unknown; restore?: boolean; /** the view's icon, when it is a string */ icon?: string }

export interface SavedPluginTab { id: string; title: string; state?: unknown; icon?: string; /** the pane that showed it */ pane?: string }

const MAX_SAVED_TABS = 100
const MAX_SAVED_STATE = 256 * 1024
const MAX_SAVED_ICON = 8 * 1024

/** A copy of a tab's state as JSON keeps it; undefined when it is not JSON or is too large to keep with the layout. */
export function jsonState(v: unknown): unknown {
  try {
    const s = JSON.stringify(v)
    return s === undefined || s.length > MAX_SAVED_STATE ? undefined : JSON.parse(s)
  } catch { return undefined }
}

/** The open tabs to save, in order, with the pane each is shown in. */
export function savedPluginTabs(
  tabs: readonly string[],
  entries: Readonly<Record<string, PluginTabEntry>>,
  panes: ReadonlyArray<{ id: string; threadId: string | null }>,
): SavedPluginTab[] {
  const out: SavedPluginTab[] = []
  for (const id of tabs) {
    const e = entries[id]
    if (!e?.restore || !isPluginTab(id) || out.length >= MAX_SAVED_TABS) continue
    const state = jsonState(e.state)
    const pane = panes.find(p => p.threadId === id)?.id
    out.push({
      id,
      title: e.title,
      ...(state !== undefined ? { state } : {}),
      ...(e.icon && e.icon.length <= MAX_SAVED_ICON ? { icon: e.icon } : {}),
      ...(pane ? { pane } : {}),
    })
  }
  return out
}

/** Saved tabs, dropping anything unreadable (older or newer builds, a hand-edited file). */
export function normalizePluginTabs(v: unknown): SavedPluginTab[] {
  if (!Array.isArray(v)) return []
  const out = new Map<string, SavedPluginTab>()
  for (const raw of v) {
    if (out.size >= MAX_SAVED_TABS) break
    if (!raw || typeof raw !== 'object') continue
    const { id, title, state, icon, pane } = raw as Record<string, unknown>
    const ref = typeof id === 'string' ? parsePluginTab(id) : null
    if (!ref || !ref.projectPath || !ref.key || !PLUGIN_ID.test(ref.pluginId) || !PART_ID.test(ref.viewId) || out.has(id as string)) continue
    out.set(id as string, {
      id: id as string,
      title: typeof title === 'string' && title.trim() ? title : ref.viewId,
      ...(state !== undefined ? { state } : {}),
      ...(typeof icon === 'string' && icon && icon.length <= MAX_SAVED_ICON ? { icon } : {}),
      ...(typeof pane === 'string' && pane ? { pane } : {}),
    })
  }
  return [...out.values()]
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
