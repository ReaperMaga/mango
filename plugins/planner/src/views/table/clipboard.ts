/** Cells as text and back: tab separated, as spreadsheets write it. Pure. */

import { OptionSet, parseValue } from '../../convert.ts'
import { isReadonly, valueOf, valueText, type Item, type Option, type Property, type Value } from '../../model.ts'
import type { ItemChange } from '../../store.ts'

/** A column: a property, or null for the title. */
export type Field = Property | null

export const cellText = (item: Item, field: Field) => (field ? valueText(valueOf(item, field), field) : item.title)

const quote = (t: string) => (/[\t\r\n"]/.test(t) ? `"${t.replaceAll('"', '""')}"` : t)

export function toTsv(items: readonly Item[], fields: readonly Field[]): string {
  return items.map(i => fields.map(f => quote(cellText(i, f))).join('\t')).join('\n')
}

export function parseTsv(source: string): string[][] {
  const text = source.replace(/\r\n?/g, '\n').replace(/\n$/, '')
  const rows: string[][] = [[]]
  const quoted = /"((?:[^"]|"")*)"(?=[\t\n]|$)/y
  const plain = /[^\t\n]*/y
  for (let at = 0; ;) {
    quoted.lastIndex = plain.lastIndex = at
    const q = quoted.exec(text)
    const cell = q ? q[1]!.replaceAll('""', '"') : plain.exec(text)![0]
    at += q ? q[0].length : cell.length
    rows.at(-1)!.push(cell)
    if (at >= text.length) return rows
    if (text[at] === '\n') rows.push([])
    at++
  }
}

export interface Paste {
  readonly changes: ReadonlyMap<string, ItemChange>
  /** The options it needs, by property. */
  readonly options: ReadonlyMap<string, readonly Option[]>
  /** How many cells held text that is not a value of their column. */
  readonly skipped: number
}

/**
 * What pasting into these items and fields does, from their first on. A single row goes into every item given.
 */
export function planPaste(
  cells: readonly (readonly string[])[], items: readonly Item[], fields: readonly Field[],
): Paste {
  const changes = new Map<string, ItemChange>()
  const sets = new Map<string, OptionSet>()
  let skipped = 0

  const read = (cell: string, p: Property): Value | null | undefined => {
    if (isReadonly(p)) return undefined
    if (!cell.trim()) return p.type === 'checkbox' ? false : null
    let set = sets.get(p.id)
    if (!set) sets.set(p.id, (set = new OptionSet(p.options)))
    const value = parseValue(cell, p.type, set)
    return value === null ? undefined : value
  }

  for (const [y, item] of items.entries()) {
    const row = cells.length === 1 ? cells[0] : cells[y]
    if (!row) break
    const values: Record<string, Value | null> = {}
    const change: { title?: string; values: typeof values } = { values }
    for (const [x, cell] of row.entries()) {
      const field = fields[x]
      if (field === undefined) break
      if (field === null) {
        change.title = cell.replace(/\s*\n\s*/g, ' ').trim()
        continue
      }
      const value = read(cell, field)
      if (value === undefined) skipped++
      else values[field.id] = value
    }
    if (change.title !== undefined || Object.keys(values).length) changes.set(item.id, change)
  }
  const options = new Map([...sets].flatMap(([id, set]): Array<[string, readonly Option[]]> => {
    const old = fields.find(f => f?.id === id)!.options.length
    return set.options.length > old ? [[id, set.options.slice(old)]] : []
  }))
  return { changes, options, skipped }
}
