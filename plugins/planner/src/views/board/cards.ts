/** The board's logic without a DOM: which card is which, and where a drop puts things. */

import type { Position } from '../../order.ts'

/** A card: an item in a column. With a multi-select, one item has several. */
export interface CardRef { readonly id: string; readonly group: string }

export const cardKey = (c: CardRef): string => `${c.group}/${c.id}`

interface WithId { readonly id: string }

/** Where `index` is among `items` once the moving ones are out of it; undefined when there is nothing to be next to. */
export function positionAt(items: readonly WithId[], moving: ReadonlySet<string>, index: number): Position | undefined {
  const rest = items.filter(i => !moving.has(i.id))
  const next = rest[index]
  if (next) return { before: next.id }
  const last = rest.at(-1)
  return last ? { after: last.id } : undefined
}

/** Whether putting `ids` at `index` leaves the column as it is. */
export function isSamePlace(items: readonly WithId[], ids: readonly string[], index: number): boolean {
  const moving = new Set(ids)
  const rest = items.filter(i => !moving.has(i.id)).map(i => i.id)
  const after = [...rest.slice(0, index), ...ids, ...rest.slice(index)]
  return after.length === items.length && after.every((id, i) => id === items[i]!.id)
}

/** The index, among the ones that stay, that moves a block one step up (-1) or down (1); null at the end. */
export function stepIndex(items: readonly WithId[], moving: ReadonlySet<string>, step: -1 | 1): number | null {
  const first = items.findIndex(i => moving.has(i.id))
  if (first < 0) return null
  const rest = items.length - items.filter(i => moving.has(i.id)).length
  const index = first + step
  return index < 0 || index > rest ? null : index
}

/** The first words of a body, without its markdown marks. */
export function previewText(body: string, max = 180): string {
  const text = body.slice(0, max * 4)
    .replace(/`{3}[^\n]*\n?|~{3}[^\n]*\n?/g, ' ')
    // Dividers, and a table's rule and bars.
    .replace(/^[ \t]*(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,}|(?=.*\|)[|:\- \t]+)$/gm, ' ')
    .replace(/^[ \t]*\|(.*)\|[ \t]*$/gm, (_, cells: string) => cells.replaceAll('|', ' '))
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^[ \t]*(?:#{1,6}|>|[-*+]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]+)?/gm, '')
    .replace(/[*`~]+|(?<![\p{L}\p{N}])_+|_+(?![\p{L}\p{N}])/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
  return text.length > max ? `${text.slice(0, max).trimEnd()}…` : text
}

/** How many of a body's tasks are done; null when it has none. */
export function taskCount(body: string): { done: number; all: number } | null {
  let done = 0
  let all = 0
  for (const m of body.matchAll(/^[ \t]*(?:[-*+]|\d+[.)])[ \t]+\[([ xX])\][ \t]/gm)) {
    all++
    if (m[1] !== ' ') done++
  }
  return all ? { done, all } : null
}
