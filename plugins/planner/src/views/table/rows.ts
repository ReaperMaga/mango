/** The table as a flat list of lines, all of one height, so only the ones in view are drawn. Pure. */

import { groupsOf, type Group, type QueryResult } from '../../query.ts'
import type { Item } from '../../model.ts'

export const ROW_H = 32

export type Line =
  | { readonly kind: 'group'; readonly key: string; readonly group: Group }
  | { readonly kind: 'item'; readonly key: string; readonly group: Group; readonly item: Item }
  | { readonly kind: 'add'; readonly key: string; readonly group: Group }
export type ItemLine = Extract<Line, { kind: 'item' }>

export const itemKey = (group: string, itemId: string) => `i/${group}/${itemId}`

export function linesOf(result: QueryResult, readonly: boolean): Line[] {
  const out: Line[] = []
  for (const group of result.groups) {
    if (group.hidden && result.groupBy) continue
    if (result.groupBy) {
      out.push({ kind: 'group', key: `g/${group.key}`, group })
      if (group.collapsed) continue
    }
    for (const item of group.items) out.push({ kind: 'item', key: itemKey(group.key, item.id), group, item })
    if (!readonly) out.push({ kind: 'add', key: `a/${group.key}`, group })
  }
  return out
}

/** The lines to draw for a scroll position, with some to spare on both sides. */
export function windowOf(count: number, scrollTop: number, height: number, spare = 8): [number, number] {
  const first = Math.max(0, Math.floor(scrollTop / ROW_H) - spare)
  return [Math.min(first, count), Math.min(count, Math.ceil((scrollTop + height) / ROW_H) + spare)]
}

/** The items of the lines from one to another, either way round. */
export function itemsBetween(lines: readonly Line[], a: number, b: number): string[] {
  const part = lines.slice(Math.min(a, b), Math.max(a, b) + 1)
  return [...new Set(part.flatMap(l => (l.kind === 'item' ? [l.item.id] : [])))]
}

export interface Drop {
  readonly group: Group
  /** Undefined when the order is not the user's (a sorted view), or there is nothing to be placed by. */
  readonly position: { before: string } | { after: string } | undefined
  readonly boundary: number
}

/** Where rows let go at a line boundary (0: above the first line) go; null when that is nowhere. */
export function dropAt(lines: readonly Line[], boundary: number, sorted: boolean): Drop | null {
  const above = lines[boundary - 1]
  const below = lines[boundary]
  const place = (group: Group, position: Drop['position']): Drop => ({ group, position: sorted ? undefined : position, boundary })
  if (above?.kind === 'item') return place(above.group, { after: above.item.id })
  if (below?.kind === 'item') return place(below.group, { before: below.item.id })
  // An empty or folded group, or below a group's last line.
  const group = above?.group ?? below?.group
  if (!group) return null
  const last = group.items.at(-1)
  return place(group, last ? { after: last.id } : undefined)
}

export const allIn = (items: readonly Item[], result: QueryResult, key: string) =>
  !result.groupBy || items.every(i => groupsOf(i, result.groupBy!).includes(key))
