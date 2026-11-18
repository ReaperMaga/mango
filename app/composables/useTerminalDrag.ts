import { useWorkspace } from '~/stores/workspace'
import { useThreads } from '~/stores/threads'
import { holdOverlay } from '~/composables/useOverlay'
import { insertionIndex, isTerminalTab, paneZone, parseTerminalTab } from '~/utils/terminalTabs'

/*
 * Terminals move between the docked panel and the main area without restarting: TerminalPanel keeps
 * one xterm per terminal and teleports it into whichever main-area pane registered a slot for it.
 *
 * Moving one by hand is a pointer drag (never HTML5 drag and drop, which the desktop webview takes over
 * on Windows). Drop targets mark themselves with `data-term-drop`:
 *   "strip"  the main area's tab strip (its tabs carry `data-tab-id`)
 *   "pane"   a main-area pane (`data-pane-id`)
 *   "panel"  the terminal panel (its tabs carry `data-term-id`), or the dock zone shown while it is hidden
 */

/* ---------- where main-area terminals are drawn ---------- */

const slots = shallowReactive(new Map<string, HTMLElement[]>())

/** The element a main-area terminal is drawn in right now (the latest pane to show it), or null. */
export function terminalSlot(terminalId: string): HTMLElement | null {
  const list = slots.get(terminalId)
  return list?.[list.length - 1] ?? null
}

/** A pane shows this terminal in `el` until the returned function is called. */
export function registerTerminalSlot(terminalId: string, el: HTMLElement): () => void {
  slots.set(terminalId, [...(slots.get(terminalId) ?? []), el])
  return () => {
    const rest = (slots.get(terminalId) ?? []).filter(x => x !== el)
    if (rest.length) slots.set(terminalId, rest)
    else slots.delete(terminalId)
  }
}

/* ---------- dragging ---------- */

export interface Box { left: number; top: number; width: number; height: number }

export type TerminalDrop =
  | { kind: 'strip'; before: string | null; line: Box }
  | { kind: 'pane'; paneId: string; split: boolean; box: Box }
  | { kind: 'panel'; before: string | null; line: Box | null; box: Box | null }

export const terminalDrag = reactive({
  /** The terminal being dragged (a TerminalTab id), null when there is no drag. */
  id: null as string | null,
  from: 'panel' as 'panel' | 'editor',
  title: '',
  remote: false,
  x: 0,
  y: 0,
  drop: null as TerminalDrop | null,
})

const SLACK = 6
let start: { id: string; from: 'panel' | 'editor'; x: number; y: number } | null = null
let release = () => {}
let justDragged = false

/** The click that ends a drag is not a click. */
export const dragJustEnded = () => justDragged

/** Press on a terminal's tab (in the panel, or its tab in the main area): a drag starts once the pointer travels a little. */
export function pressTerminalTab(e: PointerEvent, terminalId: string, from: 'panel' | 'editor') {
  if (e.button !== 0 || (e.target as HTMLElement).closest('button')) return
  start = { id: terminalId, from, x: e.clientX, y: e.clientY }
  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', onUp)
  window.addEventListener('pointercancel', finish)
  window.addEventListener('keydown', onKey, true)
}

function onMove(e: PointerEvent) {
  if (!start) return
  if (!terminalDrag.id) {
    if (Math.hypot(e.clientX - start.x, e.clientY - start.y) < SLACK) return
    const tab = useWorkspace().terminalTabs.find(t => t.id === start!.id)
    if (!tab) return finish()
    terminalDrag.id = tab.id
    terminalDrag.from = start.from
    terminalDrag.title = tab.title
    terminalDrag.remote = !!tab.cwd?.startsWith('env://')
    // A browser's page would swallow the pointer once it crosses it: the browsers hide during the drag.
    release = holdOverlay()
    document.body.classList.add('is-moving-terminal')
  }
  terminalDrag.x = e.clientX
  terminalDrag.y = e.clientY
  terminalDrag.drop = dropAt(e.clientX, e.clientY)
}

function onUp() {
  const { id, drop } = terminalDrag
  finish()
  if (!id || !drop) return
  const ws = useWorkspace()
  if (drop.kind === 'panel') ws.moveTerminalToPanel(id, drop.before)
  else if (drop.kind === 'strip') ws.moveTerminalToEditor(id, { before: drop.before })
  else ws.moveTerminalToEditor(id, drop.split ? { split: true } : { paneId: drop.paneId })
}

function onKey(e: KeyboardEvent) {
  if (e.key !== 'Escape' || !terminalDrag.id) return
  e.preventDefault()
  e.stopPropagation()
  finish()
}

function finish() {
  window.removeEventListener('pointermove', onMove)
  window.removeEventListener('pointerup', onUp)
  window.removeEventListener('pointercancel', finish)
  window.removeEventListener('keydown', onKey, true)
  if (terminalDrag.id) {
    justDragged = true
    setTimeout(() => (justDragged = false), 0)
    release()
    release = () => {}
    document.body.classList.remove('is-moving-terminal')
  }
  terminalDrag.id = null
  terminalDrag.drop = null
  start = null
}

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

/** What a drop at (x, y) would do, or null when nothing takes it there. */
function dropAt(x: number, y: number): TerminalDrop | null {
  const id = terminalDrag.id!
  const el = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-term-drop]')
  if (!el) return null
  const kind = el.dataset.termDrop
  const threads = useThreads()
  const ws = useWorkspace()

  if (kind === 'panel') {
    const strip = el.querySelector<HTMLElement>('[data-term-strip]')
    const row = strip ? boxOf(strip) : null
    if (row && y >= row.top && y <= row.top + row.height) {
      const els = [...strip!.querySelectorAll<HTMLElement>('[data-term-id]')].filter(t => t.dataset.termId !== id)
      const tabs = els.map(boxOf)
      const at = insertionIndex(tabs, x)
      return { kind: 'panel', before: els[at]?.dataset.termId ?? null, line: lineAt(row, tabs, at), box: null }
    }
    const body = el.querySelector<HTMLElement>('[data-term-body]') ?? el
    return { kind: 'panel', before: null, line: null, box: boxOf(body) }
  }

  if (!ws.activeProjectPath) return null

  if (kind === 'strip') {
    const els = [...el.querySelectorAll<HTMLElement>('[data-tab-id]')].filter(t => parseTerminalTab(t.dataset.tabId)?.terminalId !== id)
    const tabs = els.map(boxOf)
    const at = insertionIndex(tabs, x)
    return { kind: 'strip', before: els[at]?.dataset.tabId ?? null, line: lineAt(boxOf(el), tabs, at) }
  }

  if (kind === 'pane' && el.dataset.paneId) {
    const box = boxOf(el)
    const shown = threads.panes.find(p => p.id === el.dataset.paneId)?.threadId
    const own = isTerminalTab(shown) && parseTerminalTab(shown)!.terminalId === id
    // Splitting needs something to stay on the left.
    const canSplit = threads.panes.length === 1 && !!shown && !own
    if (paneZone(box, x, canSplit) === 'right') {
      return { kind: 'pane', paneId: el.dataset.paneId, split: true, box: { ...box, left: box.left + box.width / 2, width: box.width / 2 } }
    }
    return { kind: 'pane', paneId: el.dataset.paneId, split: false, box }
  }
  return null
}
