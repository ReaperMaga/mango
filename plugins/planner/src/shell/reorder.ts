/** Rows or tabs put in another order with the pointer. Never HTML5 drag and drop: the desktop webview takes that over. */

import { onBeforeUnmount, ref, type Ref } from 'vue'
import type { Position } from '../order.ts'

export interface ReorderOptions {
  axis: 'x' | 'y'
  /** Holds the elements that carry `data-rid`. */
  container: () => HTMLElement | null
  hold: () => { dispose(): void }
  onDrop: (id: string, position: Position) => void
  disabled?: () => boolean
}

export interface Reorder {
  dragging: Ref<string | null>
  /** Where it would land: before this id, or `null` for the end. Undefined while nothing is dragged. */
  target: Ref<string | null | undefined>
  start: (e: PointerEvent, id: string) => void
}

const START_PX = 4

export function useReorder(o: ReorderOptions): Reorder {
  const dragging = ref<string | null>(null)
  const target = ref<string | null | undefined>(undefined)
  let stop: (() => void) | null = null
  const entries = () => [...(o.container()?.querySelectorAll<HTMLElement>('[data-rid]') ?? [])]

  function start(e: PointerEvent, id: string) {
    if (e.button !== 0 || o.disabled?.()) return
    stop?.()
    const from = { x: e.clientX, y: e.clientY }
    let hold: { dispose(): void } | null = null

    const move = (ev: PointerEvent) => {
      if (!dragging.value) {
        if (Math.hypot(ev.clientX - from.x, ev.clientY - from.y) < START_PX) return
        dragging.value = id
        hold = o.hold()
        document.body.classList.add('is-reordering')
      }
      ev.preventDefault()
      const at = o.axis === 'x' ? ev.clientX : ev.clientY
      const next = entries().find((el) => {
        const r = el.getBoundingClientRect()
        return at < (o.axis === 'x' ? r.left + r.width / 2 : r.top + r.height / 2)
      })
      target.value = next?.dataset.rid ?? null
    }
    const end = (drop: boolean) => {
      stop?.()
      const was = dragging.value
      const t = target.value
      const ids = entries().map(el => el.dataset.rid)
      dragging.value = null
      target.value = undefined
      if (was === null) return
      // The click that follows the drag is not a click.
      const swallow = (ev: Event) => {
        ev.stopPropagation()
        ev.preventDefault()
      }
      window.addEventListener('click', swallow, { capture: true, once: true })
      setTimeout(() => window.removeEventListener('click', swallow, true))
      const same = t === undefined || t === id || ids[ids.indexOf(id) + 1] === t || (t === null && ids.at(-1) === id)
      if (drop && !same) o.onDrop(id, t === null ? 'end' : { before: t! })
    }
    const up = () => end(true)
    const cancel = () => end(false)
    const key = (ev: KeyboardEvent) => {
      if (ev.key !== 'Escape' || !dragging.value) return
      ev.preventDefault()
      ev.stopPropagation()
      end(false)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', cancel)
    window.addEventListener('blur', cancel)
    window.addEventListener('keydown', key, true)
    stop = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', cancel)
      window.removeEventListener('blur', cancel)
      window.removeEventListener('keydown', key, true)
      document.body.classList.remove('is-reordering')
      hold?.dispose()
      stop = null
    }
  }
  onBeforeUnmount(() => stop?.())
  return { dragging, target, start }
}

/** The classes of an entry while something is dragged over the list. */
export function dropClass(r: Reorder, id: string, last: boolean) {
  const t = r.target.value
  return { 'is-dragging': r.dragging.value === id, 'is-before': t === id, 'is-after': last && t === null }
}

/** Where Alt+arrow puts an entry: one step back or on, or null at the ends. */
export function stepPosition(ids: readonly string[], id: string, by: -1 | 1): Position | null {
  const at = ids.indexOf(id)
  const other = ids[at + by]
  if (at < 0 || other === undefined) return null
  return by < 0 ? { before: other } : { after: other }
}

/** A list with one entry put somewhere else. */
export function moved<T>(list: readonly T[], idOf: (e: T) => string, id: string, position: Position): T[] {
  const entry = list.find(e => idOf(e) === id)
  if (!entry) return [...list]
  const rest = list.filter(e => e !== entry)
  if (position === 'start') return [entry, ...rest]
  if (position === 'end') return [...rest, entry]
  const key = 'before' in position ? position.before : position.after
  const at = rest.findIndex(e => idOf(e) === key)
  if (at < 0) return [...rest, entry]
  const i = 'before' in position ? at : at + 1
  return [...rest.slice(0, i), entry, ...rest.slice(i)]
}
