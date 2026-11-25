/** Motion that shows what moved where. Nothing moves for those who asked for less of it. */

export const EASE = 'cubic-bezier(0.2, 0, 0, 1)'
export const MOVE_MS = 200

export const reducedMotion = (): boolean =>
  document.documentElement.dataset.motion === 'reduced' || matchMedia('(prefers-reduced-motion: reduce)').matches

const FLIP = 'planner-move'

/**
 * Where the elements are now. Call what it answers once the change is in the page: those still there glide from
 * where they were. An element is known again by its key.
 */
export function captureMoves(root: HTMLElement | null | undefined, selector: string, keyOf: (el: HTMLElement) => string): () => void {
  if (!root || reducedMotion()) return () => {}
  const find = () => [...root.querySelectorAll<HTMLElement>(selector)]
  const before = new Map(find().map(el => [keyOf(el), el.getBoundingClientRect()]))
  return () => {
    const all = find()
    // All of them first, then measured in one go.
    for (const el of all) for (const a of el.getAnimations()) if (a.id === FLIP) a.cancel()
    const moved = all.flatMap((el) => {
      const was = before.get(keyOf(el))
      const is = el.getBoundingClientRect()
      const x = was ? was.left - is.left : 0
      const y = was ? was.top - is.top : 0
      return Math.abs(x) > 0.5 || Math.abs(y) > 0.5 ? [{ el, x, y }] : []
    })
    for (const { el, x, y } of moved) {
      el.animate({ transform: [`translate(${x}px, ${y}px)`, 'none'] }, { id: FLIP, duration: MOVE_MS, easing: EASE })
    }
  }
}
