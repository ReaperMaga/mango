/**
 * Long lists drawn a window at a time: only the rows in view (and a few either side) are in the DOM,
 * with the rest's height kept as padding. A Unity project can list tens of thousands of changes.
 * Plain functions, testable in Node.
 */
import type { GitFile, GitStatus } from '~/types/ipc'

/** Rows from `start` up to (not including) `end`. */
export interface RowRange { start: number; end: number }

/**
 * The rows of a list of `count` rows, `stride` pixels apart, whose top sits at `listTop` in a scroller
 * scrolled to `scrollTop` and `viewport` pixels tall, that are in view, with `overscan` more either side.
 */
export function rowWindow(o: { scrollTop: number; viewport: number; listTop: number; count: number; stride: number; overscan?: number }): RowRange {
  const { count, stride } = o
  if (count <= 0 || stride <= 0) return { start: 0, end: 0 }
  const overscan = o.overscan ?? 10
  const from = o.scrollTop - o.listTop
  const first = Math.floor(from / stride) - overscan
  const last = Math.ceil((from + Math.max(0, o.viewport)) / stride) + overscan
  const start = Math.min(count, Math.max(0, first))
  const end = Math.min(count, Math.max(start, last))
  return { start, end }
}

/** The scroll position that brings row `index` of a list at `listTop` into a viewport, or null when it is in view. */
export function scrollToRow(o: { scrollTop: number; viewport: number; listTop: number; stride: number; index: number; rowHeight: number }): number | null {
  const top = o.listTop + o.index * o.stride
  const bottom = top + o.rowHeight
  if (top < o.scrollTop) return top
  if (bottom > o.scrollTop + o.viewport) return bottom - o.viewport
  return null
}

const sameFile = (a: GitFile, b: GitFile) =>
  a.path === b.path && a.index === b.index && a.worktree === b.worktree && a.conflicted === b.conflicted && (a.origPath ?? null) === (b.origPath ?? null)

/** Whether two status reads say the same, without turning either into text (a large one is megabytes of it). */
export function sameStatus(a: GitStatus | null | undefined, b: GitStatus | null | undefined): boolean {
  if (a === b) return true
  if (!a || !b) return false
  if (a.vcs !== b.vcs || a.repository !== b.repository || a.isRepo !== b.isRepo || a.root !== b.root || a.mainRoot !== b.mainRoot
    || a.branch !== b.branch || a.head !== b.head || a.upstream !== b.upstream || a.ahead !== b.ahead || a.behind !== b.behind) return false
  if (JSON.stringify(a.operation ?? null) !== JSON.stringify(b.operation ?? null)) return false
  if (a.files.length !== b.files.length) return false
  for (let i = 0; i < a.files.length; i++) if (!sameFile(a.files[i]!, b.files[i]!)) return false
  return true
}
