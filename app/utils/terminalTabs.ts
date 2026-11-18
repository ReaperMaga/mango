/**
 * A terminal can live in the docked panel or in the main area as a tab next to chats, diffs and files.
 * In the main area its tab id carries the project it belongs to and the terminal's own id (the
 * `TerminalTab.id` in the workspace store). Not saved: a shell does not survive a restart.
 *
 * Plain functions with no imports, so `tests/` can run them in Node.
 */
const PREFIX = 'term\u0001'

export const terminalTabId = (projectPath: string, terminalId: string) => `${PREFIX}${projectPath}\u0001${terminalId}`

export const isTerminalTab = (id: string | null | undefined): id is string => !!id && id.startsWith(PREFIX)

export function parseTerminalTab(id: string | null | undefined) {
  if (!isTerminalTab(id)) return null
  const [, projectPath = '', terminalId = ''] = id.split('\u0001')
  return { projectPath, terminalId }
}

/** The main-area tab of a terminal, if it has one. */
export const editorTabOf = (tabs: readonly string[], terminalId: string) =>
  tabs.find(id => parseTerminalTab(id)?.terminalId === terminalId) ?? null

/* ---------- dropping a dragged tab ---------- */

export interface Span { left: number; width: number }

/**
 * Where in a row of tabs a drop at `x` lands: the index of the tab it goes before
 * (`spans.length` for the end). A tab's left half means before it, its right half after.
 */
export function insertionIndex(spans: readonly Span[], x: number): number {
  for (let i = 0; i < spans.length; i++) {
    const s = spans[i]!
    if (x < s.left + s.width / 2) return i
  }
  return spans.length
}

/**
 * Move `id` within `list` so it sits before `before` (null: at the end), or insert it there
 * when it is not in the list yet. Returns a new array; `before === id` leaves the order as it is.
 */
export function placeBefore<T>(list: readonly T[], id: T, before: T | null): T[] {
  if (before === id) return list.includes(id) ? [...list] : [...list, id]
  const out = list.filter(x => x !== id)
  const at = before === null ? -1 : out.indexOf(before)
  if (at === -1) out.push(id)
  else out.splice(at, 0, id)
  return out
}

/**
 * Which part of a pane a drop at `x` lands in. With one pane, its right third splits the area
 * (the dragged tab opens in a new right pane); anywhere else the tab shows in that pane.
 */
export function paneZone(rect: Span, x: number, canSplit: boolean): 'center' | 'right' {
  return canSplit && x >= rect.left + rect.width * (2 / 3) ? 'right' : 'center'
}
