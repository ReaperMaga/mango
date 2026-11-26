import { useWorkspace } from '~/stores/workspace'
import { useThreads } from '~/stores/threads'
import { useWindows } from '~/stores/windows'
import { holdOverlay } from '~/composables/useOverlay'
import { insertionIndex, isTerminalTab, paneZone, parseTerminalTab } from '~/utils/terminalTabs'
import { dragPlace, tearOffPlace } from '~/utils/windows'
import { parsePanelEditorTab } from '~/plugin-host/ids'
import { findPanelTab } from '~/composables/panelTabs'

/*
 * Dragging a tab: a terminal or a panel tab (between the docked panel and the main area) or a chat (within the tab
 * strip, into a pane, or out of the window into a window of its own). Pointer events only, never
 * HTML5 drag and drop, which the desktop webview takes over on Windows. The pointer is captured once
 * a drag starts, so moves and the release outside the window still arrive.
 *
 * Drop targets mark themselves with `data-tab-drop`:
 *   "strip"  a pane's tab strip in the main area (`data-pane-id`; its tabs carry `data-tab-id`)
 *   "pane"   a main-area pane (`data-pane-id`)
 *   "panel"  the terminal panel (its tabs carry `data-term-id`), or the dock zone shown while it is
 *            hidden: terminals and panel tabs only
 * A chat let go outside the window opens in a new window there (`stores/windows.ts`); terminals stay
 * in their window.
 */

export interface Box { left: number; top: number; width: number; height: number }

export type DragItem =
  /** A terminal (a TerminalTab id), from the panel or its tab in the main area. */
  | { kind: 'terminal'; id: string; from: 'panel' | 'editor' }
  /** A panel tab (its ref), from the panel or its tab in the main area. */
  | { kind: 'panelTab'; id: string; from: 'panel' | 'editor' }
  /** A chat (a thread id), from its tab or its row in the sidebar. */
  | { kind: 'chat'; id: string; from: 'tab' | 'sidebar' }

export type TabDrop =
  | { kind: 'strip'; paneId: string | undefined; before: string | null; line: Box }
  | { kind: 'pane'; paneId: string; split: boolean; box: Box }
  | { kind: 'panel'; before: string | null; line: Box | null; box: Box | null }
  /** Outside the window: the chat opens in a window of its own. */
  | { kind: 'window' }

export const tabDrag = reactive({
  /** What is being dragged; null when there is no drag. */
  item: null as DragItem | null,
  title: '',
  /** A terminal in a remote environment (its icon). */
  remote: false,
  x: 0,
  y: 0,
  /** Where the pointer is against the window: `edge` and `outside` show the new-window hint (chats only). */
  place: 'inside' as 'inside' | 'edge' | 'outside',
  drop: null as TabDrop | null,
})

/** The terminal being dragged, or null: what the terminal panel and its tabs look at. */
export const draggedTerminal = () => (tabDrag.item?.kind === 'terminal' ? tabDrag.item : null)
/** What the panel takes, being dragged: a terminal or a panel tab, or null. */
export const draggedPanelItem = () => (tabDrag.item?.kind === 'terminal' || tabDrag.item?.kind === 'panelTab' ? tabDrag.item : null)
/** The chat being dragged, or null. */
export const draggedChat = () => (tabDrag.item?.kind === 'chat' ? tabDrag.item : null)

const SLACK = 6
let start: { item: DragItem; x: number; y: number; el: HTMLElement | null; pointerId: number } | null = null
let release = () => {}
let justDragged = false

/** The click that ends a drag is not a click. */
export const dragJustEnded = () => justDragged

/** Press on a tab (or a sidebar row): a drag starts once the pointer travels a little. */
export function pressTab(e: PointerEvent, item: DragItem) {
  if (e.button !== 0 || (e.target as HTMLElement).closest('button')) return
  start = { item, x: e.clientX, y: e.clientY, el: e.currentTarget as HTMLElement | null, pointerId: e.pointerId }
  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', onUp)
  window.addEventListener('pointercancel', finish)
  window.addEventListener('keydown', onKey, true)
}

/** Press on a terminal's tab (in the panel, or its tab in the main area). */
export const pressTerminalTab = (e: PointerEvent, terminalId: string, from: 'panel' | 'editor') =>
  pressTab(e, { kind: 'terminal', id: terminalId, from })

/** Press on a panel tab (in the panel, or its tab in the main area). */
export const pressPanelTab = (e: PointerEvent, ref: string, from: 'panel' | 'editor') =>
  pressTab(e, { kind: 'panelTab', id: ref, from })

/** Press on a chat's tab. */
export const pressChatTab = (e: PointerEvent, threadId: string) => pressTab(e, { kind: 'chat', id: threadId, from: 'tab' })

function begin(item: DragItem): boolean {
  if (item.kind === 'terminal') {
    const tab = useWorkspace().terminalTabs.find(t => t.id === item.id)
    if (!tab) return false
    tabDrag.title = tab.title
    tabDrag.remote = !!tab.cwd?.startsWith('env://')
  } else if (item.kind === 'panelTab') {
    const tab = findPanelTab(item.id)
    if (!tab) return false
    tabDrag.title = tab.title
    tabDrag.remote = false
  } else {
    const t = useThreads().byId(item.id)
    if (!t) return false
    tabDrag.title = chatTitle(t.title)
    tabDrag.remote = false
  }
  tabDrag.item = item
  // A browser's page would swallow the pointer once it crosses it: the browsers hide during the drag.
  release = holdOverlay()
  document.body.classList.add('is-moving-tab')
  return true
}

function onMove(e: PointerEvent) {
  if (!start) return
  if (!tabDrag.item) {
    if (Math.hypot(e.clientX - start.x, e.clientY - start.y) < SLACK) return
    if (!begin(start.item)) return finish()
    // Moves (and the release) outside the window keep coming to this page.
    try { start.el?.setPointerCapture(start.pointerId) } catch { /* the tab is gone already */ }
  }
  track(e)
}

/** Follow the pointer: where it is, and what letting go there would do. */
function track(e: PointerEvent) {
  tabDrag.x = e.clientX
  tabDrag.y = e.clientY
  const chat = tabDrag.item?.kind === 'chat'
  tabDrag.place = chat ? dragPlace(e.clientX, e.clientY, window.innerWidth, window.innerHeight) : 'inside'
  tabDrag.drop = tabDrag.place === 'outside' ? { kind: 'window' } : dropAt(e.clientX, e.clientY)
}

function onUp(e: PointerEvent) {
  const { item, drop } = tabDrag
  finish()
  if (!item || !drop) return
  if (item.kind === 'terminal') return dropTerminal(item.id, drop)
  if (item.kind === 'panelTab') return dropPanelTab(item.id, drop)
  dropChat(item.id, drop, e)
}

function dropTerminal(id: string, drop: TabDrop) {
  const ws = useWorkspace()
  if (drop.kind === 'panel') ws.moveTerminalToPanel(id, drop.before)
  else if (drop.kind === 'strip') ws.moveTerminalToEditor(id, { before: drop.before, paneId: drop.paneId })
  else if (drop.kind === 'pane') ws.moveTerminalToEditor(id, drop.split ? { split: true } : { paneId: drop.paneId })
}

function dropPanelTab(ref: string, drop: TabDrop) {
  const ws = useWorkspace()
  if (drop.kind === 'panel') ws.movePanelTabToPanel(ref, drop.before)
  else if (drop.kind === 'strip') ws.movePanelTabToEditor(ref, { before: drop.before, paneId: drop.paneId })
  else if (drop.kind === 'pane') ws.movePanelTabToEditor(ref, drop.split ? { split: true } : { paneId: drop.paneId })
}

function dropChat(id: string, drop: TabDrop, e: PointerEvent) {
  const threads = useThreads()
  if (drop.kind === 'window') {
    void useWindows().tearOff(id, tearOffPlace(e.screenX, e.screenY), { x: e.screenX, y: e.screenY })
    return
  }
  // From the sidebar: the chat's project comes into view with it.
  const t = threads.byId(id)
  const ws = useWorkspace()
  if (t && t.projectPath !== ws.activeProjectPath) ws.setActiveProject(t.projectPath)
  if (drop.kind === 'strip') {
    threads.placeTab(id, drop.before, drop.paneId)
    threads.show(id, drop.paneId)
  } else if (drop.kind === 'pane') {
    threads.showOnly(id, drop.split ? 'split' : drop.paneId)
  }
}

function onKey(e: KeyboardEvent) {
  if (e.key !== 'Escape' || !tabDrag.item) return
  e.preventDefault()
  e.stopPropagation()
  finish()
}

function finish() {
  window.removeEventListener('pointermove', onMove)
  window.removeEventListener('pointerup', onUp)
  window.removeEventListener('pointercancel', finish)
  window.removeEventListener('keydown', onKey, true)
  if (start?.el?.hasPointerCapture?.(start.pointerId)) start.el.releasePointerCapture(start.pointerId)
  if (tabDrag.item) {
    justDragged = true
    setTimeout(() => (justDragged = false), 0)
    release()
    release = () => {}
    document.body.classList.remove('is-moving-tab')
  }
  tabDrag.item = null
  tabDrag.drop = null
  tabDrag.place = 'inside'
  start = null
}

/*
 * A chat's row dragged in the sidebar reorders the list while the pointer is over the sidebar;
 * past it, the drag becomes this one (onto the tab strip, a pane, or out of the window).
 */

/** The sidebar's drag of chat `id` is at `e`, outside the sidebar (`outside`) or back over it. */
export function sidebarChatAt(e: PointerEvent, id: string, outside: boolean) {
  if (!outside) {
    if (draggedChat()?.from === 'sidebar') endSidebarDrag()
    return
  }
  if (!tabDrag.item && !begin({ kind: 'chat', id, from: 'sidebar' })) return
  track(e)
}

/** The sidebar's drag ended at `e`: did this drag take it (true), or is it the sidebar's (a reorder)? */
export function sidebarChatDrop(e: PointerEvent): boolean {
  const item = draggedChat()
  if (!item || item.from !== 'sidebar') return false
  const drop = tabDrag.drop
  endSidebarDrag()
  if (drop) dropChat(item.id, drop, e)
  return true
}

/** The sidebar's drag was cancelled (Escape, a lost pointer): nothing drops. */
export function cancelSidebarChat() {
  if (draggedChat()?.from === 'sidebar') endSidebarDrag()
}

function endSidebarDrag() {
  release()
  release = () => {}
  document.body.classList.remove('is-moving-tab')
  tabDrag.item = null
  tabDrag.drop = null
  tabDrag.place = 'inside'
}

/* ---------- drop targets ---------- */

const boxOf = (el: Element): Box => {
  const r = el.getBoundingClientRect()
  return { left: r.left, top: r.top, width: r.width, height: r.height }
}

/** A thin vertical line in `row` before the tab at `index` of `tabs` (after the last one when index is past the end). */
function lineAt(row: Box, tabs: Box[], index: number): Box {
  const x = index < tabs.length ? tabs[index]!.left - 2 : tabs.length ? tabs[tabs.length - 1]!.left + tabs[tabs.length - 1]!.width + 1 : row.left + 6
  const inset = Math.min(6, row.height / 4)
  return { left: x - 1, top: row.top + inset, width: 2, height: row.height - inset * 2 }
}

/** Whether a tab of the main area's strip is the dragged item's own (left out of the gaps). */
function isDraggedTab(item: DragItem, tabId: string | undefined): boolean {
  if (item.kind === 'chat') return tabId === item.id
  if (item.kind === 'panelTab') return parsePanelEditorTab(tabId)?.ref === item.id
  return parseTerminalTab(tabId)?.terminalId === item.id
}

/** What a drop at (x, y) would do, or null when nothing takes it there. */
function dropAt(x: number, y: number): TabDrop | null {
  const item = tabDrag.item!
  const el = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-tab-drop]')
  if (!el) return null
  const kind = el.dataset.tabDrop
  const threads = useThreads()
  const ws = useWorkspace()

  if (kind === 'panel') {
    if (item.kind !== 'terminal' && item.kind !== 'panelTab') return null
    const strip = el.querySelector<HTMLElement>('[data-term-strip]')
    const row = strip ? boxOf(strip) : null
    if (row && y >= row.top && y <= row.top + row.height) {
      const els = [...strip!.querySelectorAll<HTMLElement>('[data-term-id]')].filter(t => t.dataset.termId !== item.id)
      const tabs = els.map(boxOf)
      const at = insertionIndex(tabs, x)
      return { kind: 'panel', before: els[at]?.dataset.termId ?? null, line: lineAt(row, tabs, at), box: null }
    }
    const body = el.querySelector<HTMLElement>('[data-term-body]') ?? el
    return { kind: 'panel', before: null, line: null, box: boxOf(body) }
  }

  if (!ws.activeProjectPath) return null

  if (kind === 'strip') {
    const els = [...el.querySelectorAll<HTMLElement>('[data-tab-id]')].filter(t => !isDraggedTab(item, t.dataset.tabId))
    const tabs = els.map(boxOf)
    const at = insertionIndex(tabs, x)
    return { kind: 'strip', paneId: el.dataset.paneId, before: els[at]?.dataset.tabId ?? null, line: lineAt(boxOf(el), tabs, at) }
  }

  if (kind === 'pane' && el.dataset.paneId) {
    const box = boxOf(el)
    const shown = threads.panes.find(p => p.id === el.dataset.paneId)?.threadId
    const own = item.kind === 'chat' ? shown === item.id
      : item.kind === 'panelTab' ? parsePanelEditorTab(shown)?.ref === item.id
      : isTerminalTab(shown) && parseTerminalTab(shown)!.terminalId === item.id
    // Splitting needs something to stay on the left.
    const canSplit = threads.panes.length === 1 && !!shown && !own
    if (paneZone(box, x, canSplit) === 'right') {
      return { kind: 'pane', paneId: el.dataset.paneId, split: true, box: { ...box, left: box.left + box.width / 2, width: box.width / 2 } }
    }
    return { kind: 'pane', paneId: el.dataset.paneId, split: false, box }
  }
  return null
}
