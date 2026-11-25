/** Dragging on the board: cards within and between columns, and columns by their header. Pointer events only. */

import { nextTick, onBeforeUnmount, shallowRef, type Ref, type ShallowRef } from 'vue'
import type { Disposable, MangoPluginApi } from '../../host.ts'
import { EASE, MOVE_MS, reducedMotion } from '../../ui/motion.ts'
import { cardKey, type CardRef } from './cards.ts'

interface Held {
  readonly width: number
  readonly height: number
  /** Where in it the pointer took it. */
  readonly dx: number
  readonly dy: number
}
export type Drag =
  | Held & { readonly kind: 'cards'; readonly cards: readonly CardRef[]; readonly keys: ReadonlySet<string>; readonly ids: ReadonlySet<string>; readonly lead: CardRef }
  | Held & { readonly kind: 'column'; readonly group: string }

/** `index` is among what is not moving; null: at the end, or wherever the sort puts it. */
export interface CardTarget { readonly group: string; readonly index: number | null }
export interface ColumnTarget { readonly index: number; readonly x: number }

const THRESHOLD = 4
const EDGE = 44
const SPEED = 16
/** A column's ghost is only its name: it stays near the pointer. */
const COLUMN_DX = 40
/** How far beside a column still counts as it. */
const NEAR = 24

export interface BoardDragOptions {
  mango: MangoPluginApi
  /** The horizontal scroller, with the columns in it. */
  board: Ref<HTMLElement | undefined>
  ghost: Ref<HTMLElement | undefined>
  enabled(): boolean
  /** Cards can be put at a place (not in a sorted view). */
  manual(): boolean
  /** What is dragged when the drag starts on this card. */
  cardsFor(card: CardRef): readonly CardRef[]
  onStart(drag: Drag): void
  onDropCards(cards: readonly CardRef[], target: CardTarget): void
  onDropColumn(group: string, index: number): void
  onCancel(): void
  /** What the thing let go of is now, in the page; null when it does not show. `group`: the column it went to. */
  landsOn(drag: Drag, group: string | null): HTMLElement | null
}

/** Let go of, on its way to its place. */
export interface Landing { readonly drag: Drag; readonly group: string | null }

export interface BoardDrag {
  readonly drag: Readonly<ShallowRef<Drag | null>>
  readonly landing: Readonly<ShallowRef<Landing | null>>
  /** The first frame of a drag is past: what makes room may move now. */
  readonly live: Readonly<ShallowRef<boolean>>
  readonly cardTarget: Readonly<ShallowRef<CardTarget | null>>
  readonly columnTarget: Readonly<ShallowRef<ColumnTarget | null>>
  onPointerDown(e: PointerEvent): void
}

/** The click that ends a drag is not a click on what is under it. */
function swallowClick() {
  const swallow = (e: MouseEvent) => {
    e.stopPropagation()
    e.preventDefault()
  }
  window.addEventListener('click', swallow, { capture: true, once: true })
  setTimeout(() => window.removeEventListener('click', swallow, true), 0)
}

const same = <T extends object | null>(a: T, b: T): T => (JSON.stringify(a) === JSON.stringify(b) ? a : b)

const speedAt = (pos: number, from: number, to: number): number => {
  if (pos < from + EDGE) return -SPEED * Math.min(1, (from + EDGE - pos) / EDGE)
  if (pos > to - EDGE) return SPEED * Math.min(1, (pos - to + EDGE) / EDGE)
  return 0
}

export function useBoardDrag(o: BoardDragOptions): BoardDrag {
  const drag = shallowRef<Drag | null>(null)
  const landing = shallowRef<Landing | null>(null)
  const live = shallowRef(false)
  const cardTarget = shallowRef<CardTarget | null>(null)
  const columnTarget = shallowRef<ColumnTarget | null>(null)

  let start: { pointerId: number; x: number; y: number; card: CardRef | null; column: string; held: Held } | null = null
  let flight: Animation | null = null
  let gone = false
  let at = { x: 0, y: 0 }
  let frame = 0
  let hold: Disposable | null = null

  function onPointerDown(e: PointerEvent) {
    // A finger scrolls; only a mouse or a pen drags.
    if (start || e.button !== 0 || e.pointerType === 'touch' || !o.enabled() || e.ctrlKey || e.metaKey || e.shiftKey) return
    const el = e.target as HTMLElement
    const column = el.closest<HTMLElement>('[data-col]')
    const card = el.closest<HTMLElement>('[data-card]')
    const head = card ? null : el.closest<HTMLElement>('[data-head]')
    const control = el.closest('input, textarea, button, a, [contenteditable]')
    if (!column || (control && control !== head)) return
    if (!card && !(head && column.dataset.sortable !== undefined)) return
    settle()
    const box = (card ?? head!).getBoundingClientRect()
    const dx = e.clientX - box.left
    start = {
      pointerId: e.pointerId,
      x: e.clientX,
      y: e.clientY,
      card: card ? { id: card.dataset.card!, group: card.dataset.group! } : null,
      column: column.dataset.col!,
      held: { width: box.width, height: box.height, dx: card ? dx : Math.min(dx, COLUMN_DX), dy: e.clientY - box.top },
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', cancel)
    window.addEventListener('blur', cancel)
    window.addEventListener('keydown', onKey, true)
  }

  function begin() {
    if (!start) return
    try { o.board.value?.setPointerCapture(start.pointerId) } catch { /* the pointer is gone */ }
    hold = o.mango.ui.holdOverlay()
    document.documentElement.style.cursor = 'grabbing'
    if (start.card) {
      const cards = o.cardsFor(start.card)
      drag.value = { kind: 'cards', cards, keys: new Set(cards.map(cardKey)), ids: new Set(cards.map(c => c.id)), lead: start.card, ...start.held }
    } else {
      drag.value = { kind: 'column', group: start.column, ...start.held }
    }
    o.onStart(drag.value)
    void nextTick(() => {
      if (!drag.value) return
      moveGhost()
      // The card has left its place and the gap stands there: from here on it may move.
      void o.ghost.value?.offsetWidth
      frame = requestAnimationFrame(() => {
        live.value = true
        tick()
      })
    })
  }

  function onMove(e: PointerEvent) {
    if (!start || e.pointerId !== start.pointerId) return
    at = { x: e.clientX, y: e.clientY }
    if (!drag.value) {
      if (Math.hypot(at.x - start.x, at.y - start.y) < THRESHOLD) return
      begin()
    }
    moveGhost()
  }

  function moveGhost() {
    const el = o.ghost.value
    const d = drag.value
    if (el && d) el.style.transform = `translate(${at.x - d.dx}px, ${at.y - d.dy}px)`
  }

  /** Every frame, as columns scroll under a pointer that rests at an edge. */
  function tick() {
    const d = drag.value
    if (!d) return
    autoscroll()
    if (d.kind === 'cards') cardTarget.value = same(cardTarget.value, findCardTarget(d.ids))
    else columnTarget.value = same(columnTarget.value, findColumnTarget(d.group))
    frame = requestAnimationFrame(tick)
  }

  const columns = (): HTMLElement[] => [...(o.board.value?.querySelectorAll<HTMLElement>('[data-col]') ?? [])]

  /** The column under the pointer, or the nearest one when it is in a gap; null off the board. */
  function columnAt(): HTMLElement | null {
    const box = o.board.value?.getBoundingClientRect()
    if (!box || at.x < box.left || at.x > box.right || at.y < box.top || at.y > box.bottom) return null
    let best: HTMLElement | null = null
    let nearest = NEAR
    for (const c of columns()) {
      const r = c.getBoundingClientRect()
      const d = at.x < r.left ? r.left - at.x : at.x > r.right ? at.x - r.right : 0
      if (d < nearest) [best, nearest] = [c, d]
    }
    return best
  }

  function autoscroll() {
    const board = o.board.value
    if (!board) return
    const box = board.getBoundingClientRect()
    if (at.y >= box.top - EDGE && at.y <= box.bottom + EDGE) board.scrollLeft += speedAt(at.x, box.left, box.right)
    if (drag.value?.kind !== 'cards') return
    const body = columnAt()?.querySelector<HTMLElement>('[data-body]')
    const r = body?.getBoundingClientRect()
    if (body && r && r.height > EDGE * 2) body.scrollTop += speedAt(at.y, r.top, r.bottom)
  }

  function findCardTarget(ids: ReadonlySet<string>): CardTarget | null {
    const column = columnAt()
    if (!column) return null
    const group = column.dataset.col!
    const list = column.querySelector<HTMLElement>('[data-list]')
    if (!list || !o.manual()) return { group, index: null }
    const cards = [...list.querySelectorAll<HTMLElement>('[data-card]')].filter(c => !ids.has(c.dataset.card!))
    let low = 0
    let high = cards.length
    while (low < high) {
      const mid = (low + high) >> 1
      const r = cards[mid]!.getBoundingClientRect()
      if (at.y < r.top + r.height / 2) high = mid
      else low = mid + 1
    }
    return { group, index: low }
  }

  function findColumnTarget(group: string): ColumnTarget | null {
    const board = o.board.value
    const rest = columns().filter(c => c.dataset.sortable !== undefined && c.dataset.col !== group)
    if (!board || !rest.length) return null
    const box = board.getBoundingClientRect()
    if (at.y < box.top - NEAR || at.y > box.bottom + NEAR) return null
    const rects = rest.map(c => c.getBoundingClientRect())
    const index = rects.filter(r => at.x > r.left + r.width / 2).length
    const edge = index < rects.length ? rects[index]!.left - 4 : rects.at(-1)!.right + 4
    return { index, x: edge - box.left + board.scrollLeft }
  }

  function end() {
    const board = o.board.value
    if (start && board?.hasPointerCapture(start.pointerId)) board.releasePointerCapture(start.pointerId)
    start = null
    cancelAnimationFrame(frame)
    hold?.dispose()
    hold = null
    if (drag.value) document.documentElement.style.cursor = ''
    drag.value = null
    live.value = false
    cardTarget.value = null
    columnTarget.value = null
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
    window.removeEventListener('pointercancel', cancel)
    window.removeEventListener('blur', cancel)
    window.removeEventListener('keydown', onKey, true)
  }

  function onUp(e: PointerEvent) {
    if (!start || e.pointerId !== start.pointerId) return
    const d = drag.value
    if (!d) return end()
    at = { x: e.clientX, y: e.clientY }
    const cards = d.kind === 'cards' ? findCardTarget(d.ids) : null
    const column = d.kind === 'column' ? findColumnTarget(d.group) : null
    void land(d, cards?.group ?? null)
    end()
    swallowClick()
    if (d.kind === 'cards' && cards) o.onDropCards(d.cards, cards)
    else if (d.kind === 'column' && column) o.onDropColumn(d.group, column.index)
    else o.onCancel()
  }

  function cancel() {
    const was = drag.value
    if (was && !gone) void land(was, null)
    end()
    if (was) o.onCancel()
  }

  /** The thing let go of glides to where it is now, or back; it fades where that is out of sight. */
  async function land(d: Drag, group: string | null) {
    const el = o.ghost.value
    if (!el || reducedMotion()) return
    const mine: Landing = { drag: d, group }
    landing.value = mine
    const from = el.style.transform
    await nextTick()
    const ghost = o.ghost.value
    if (landing.value !== mine) return
    if (!ghost) return settle()
    const target = o.landsOn(d, group)
    const box = o.board.value?.getBoundingClientRect()
    const r = target?.getBoundingClientRect()
    const body = target?.closest('[data-body]')?.getBoundingClientRect() ?? box
    const seen = box && r && body && r.width > 0 && r.right > box.left && r.left < box.right && r.bottom > body.top && r.top < body.bottom
    flight = ghost.animate(
      seen
        ? { transform: [from, `translate(${r.left}px, ${r.top}px)`] }
        : { transform: [from, from], opacity: [1, 0] },
      { duration: seen ? MOVE_MS : MOVE_MS / 2, easing: EASE, fill: 'forwards' },
    )
    flight.onfinish = () => {
      if (landing.value === mine) settle()
    }
  }
  function settle() {
    landing.value = null
    flight?.cancel()
    flight = null
  }

  function onKey(e: KeyboardEvent) {
    if (!drag.value) return
    // Nothing else hears keys while something hangs on the pointer.
    e.preventDefault()
    e.stopImmediatePropagation()
    if (e.key !== 'Escape') return
    cancel()
    // The button is still down.
    window.addEventListener('pointerup', swallowClick, { capture: true, once: true })
  }

  onBeforeUnmount(() => {
    gone = true
    cancel()
    settle()
  })
  return { drag, landing, live, cardTarget, columnTarget, onPointerDown }
}
