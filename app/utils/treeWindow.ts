/**
 * A long tree drawn a window at a time, like `rowWindow.ts` but for rows of a few different heights
 * (entries, notes, the name being typed): only the rows in view (and a few either side) are in the
 * DOM, with gaps keeping the rest's room so the scrollbar is the whole tree's. Some rows are always
 * drawn wherever they are (the one with the keyboard focus, the name field), so scrolling away never
 * takes the focus or a half-typed name with it. Plain functions, testable in Node.
 */
import type { RowRange } from './rowWindow'

/** Where each row starts, from the top of the list, and at the end where the list ends: `count + 1` numbers. */
export function offsetsOf(count: number, height: (index: number) => number): number[] {
  const tops = new Array<number>(count + 1)
  let at = 0
  for (let i = 0; i < count; i++) {
    tops[i] = at
    at += height(i)
  }
  tops[count] = at
  return tops
}

/** The last row starting at or above `y` (0 above the list). */
function rowAt(tops: readonly number[], y: number): number {
  let lo = 0
  let hi = tops.length - 2
  if (hi < 0) return 0
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (tops[mid]! <= y) lo = mid
    else hi = mid - 1
  }
  return lo
}

/**
 * The rows of a list starting at `listTop` in a scroller scrolled to `scrollTop` and `viewport`
 * pixels tall that are in view, with `overscan` more either side.
 */
export function windowByOffsets(o: { tops: readonly number[]; scrollTop: number; viewport: number; listTop: number; overscan?: number }): RowRange {
  const count = o.tops.length - 1
  if (count <= 0) return { start: 0, end: 0 }
  const overscan = o.overscan ?? 10
  const from = o.scrollTop - o.listTop
  const to = from + Math.max(0, o.viewport)
  if (to < 0) return { start: 0, end: Math.min(count, overscan) }
  if (from >= o.tops[count]!) return { start: Math.max(0, count - overscan), end: count }
  const start = Math.max(0, rowAt(o.tops, from) - overscan)
  const end = Math.min(count, rowAt(o.tops, to) + 1 + overscan)
  return { start, end }
}

/** What to draw: rows by index, and gaps of a height for the rows between them that are not. */
export type TreePiece = { type: 'row'; index: number } | { type: 'gap'; key: string; height: number }

export function piecesOf(tops: readonly number[], range: RowRange, pinned: readonly number[] = []): TreePiece[] {
  const count = tops.length - 1
  const extra = [...new Set(pinned)].filter(i => i >= 0 && i < count && (i < range.start || i >= range.end)).sort((a, b) => a - b)
  const out: TreePiece[] = []
  let at = 0
  let gaps = 0
  const draw = (index: number) => {
    if (index > at) out.push({ type: 'gap', key: `gap:${gaps++}`, height: tops[index]! - tops[at]! })
    out.push({ type: 'row', index })
    at = index + 1
  }
  for (const i of extra) if (i < range.start) draw(i)
  for (let i = range.start; i < range.end; i++) draw(i)
  for (const i of extra) if (i >= range.end) draw(i)
  if (count > at) out.push({ type: 'gap', key: `gap:${gaps++}`, height: tops[count]! - tops[at]! })
  return out
}

/** The scroll position that brings the row at `index` into view, or null when it is in view. */
export function scrollToOffset(o: { tops: readonly number[]; index: number; scrollTop: number; viewport: number; listTop: number }): number | null {
  const top = o.listTop + o.tops[o.index]!
  const bottom = o.listTop + o.tops[o.index + 1]!
  if (top < o.scrollTop) return top
  if (bottom > o.scrollTop + o.viewport) return bottom - o.viewport
  return null
}
