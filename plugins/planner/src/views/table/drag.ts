/** A pointer drag: starts after a few pixels, ends once, and Escape takes it back. */

export interface DragOptions {
  /** Before it counts as a drag; 0 starts at once. */
  threshold?: number
  cursor?: string
  start?(): void
  move(x: number, y: number): void
  /** After a drag: whether it ended well. Not called for a press that never became one. */
  end(done: boolean): void
  /** Over the workspace while it lasts. */
  hold(): { dispose(): void }
  /** Scrolls this while the pointer is near its edges. */
  scroll?: { el: HTMLElement; axis: 'x' | 'y'; inset?: [number, number] }
}

const EDGE = 36

/** Answers a function that ends the drag without a result (for unmounting). */
export function startDrag(e: PointerEvent, o: DragOptions): () => void {
  const from = { x: e.clientX, y: e.clientY }
  let at = from
  let hold: { dispose(): void } | null = null
  let frame = 0

  function begin() {
    hold = o.hold()
    document.documentElement.style.cursor = o.cursor ?? 'grabbing'
    o.start?.()
    if (o.scroll) frame = requestAnimationFrame(tick)
  }
  function tick() {
    frame = requestAnimationFrame(tick)
    const { el, axis, inset = [0, 0] } = o.scroll!
    const r = el.getBoundingClientRect()
    const [p, start, end] = axis === 'y' ? [at.y, r.top + inset[0], r.bottom - inset[1]] : [at.x, r.left + inset[0], r.right - inset[1]]
    const speed = p < start + EDGE ? (p - start - EDGE) / 3 : p > end - EDGE ? (p - end + EDGE) / 3 : 0
    if (!speed) return
    const by = Math.max(-16, Math.min(16, speed))
    if (axis === 'y') el.scrollTop += by
    else el.scrollLeft += by
    o.move(at.x, at.y)
  }
  function onMove(ev: PointerEvent) {
    if (ev.pointerId !== e.pointerId) return
    at = { x: ev.clientX, y: ev.clientY }
    if (!hold) {
      if (Math.hypot(at.x - from.x, at.y - from.y) < (o.threshold ?? 4)) return
      begin()
    }
    o.move(at.x, at.y)
  }
  function onKey(ev: KeyboardEvent) {
    if (ev.key !== 'Escape') return
    ev.preventDefault()
    ev.stopImmediatePropagation()
    finish(false)
  }
  const onUp = (ev: PointerEvent) => { if (ev.pointerId === e.pointerId) finish(true) }
  const onCancel = () => finish(false)
  function finish(done: boolean) {
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
    window.removeEventListener('pointercancel', onCancel)
    window.removeEventListener('blur', onCancel)
    window.removeEventListener('keydown', onKey, true)
    cancelAnimationFrame(frame)
    if (!hold) return
    hold.dispose()
    hold = null
    document.documentElement.style.cursor = ''
    // The click that follows is the drag's, not one on what is under it.
    const swallow = (ev: Event) => ev.stopPropagation()
    window.addEventListener('click', swallow, { capture: true, once: true })
    setTimeout(() => window.removeEventListener('click', swallow, true))
    o.end(done)
  }
  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', onUp)
  window.addEventListener('pointercancel', onCancel)
  window.addEventListener('blur', onCancel)
  window.addEventListener('keydown', onKey, true)
  if (o.threshold === 0) begin()
  return () => finish(false)
}
