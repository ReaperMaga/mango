/** Cells as text and back: tab separated, as spreadsheets write it. Pure. */

import { OptionSet, parseValue } from '../../convert.ts'
import { hasOptions, isReadonly, valueOf, valueText, type Item, type Option, type Property, type Value } from '../../model.ts'
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
  /** How many cells held text that is not a value of their column. */
  readonly skipped: number
}

/**
 * What pasting into these items and fields does, from their first on. A single row goes into every item given.
 * `addOption` makes an option that is missing, and answers it.
 */
export function planPaste(
  cells: readonly (readonly string[])[], items: readonly Item[], fields: readonly Field[],
  addOption: (property: Property, name: string) => Option | null,
): Paste {
  const changes = new Map<string, ItemChange>()
  const sets = new Map<string, OptionSet>()
  /** The options made, by the id `parseValue` gave them. */
  const made = new Map<string, string>()
  let skipped = 0

  const read = (cell: string, p: Property): Value | null | undefined => {
    if (isReadonly(p)) return undefined
    if (!cell.trim()) return p.type === 'checkbox' ? false : null
    let set = sets.get(p.id)
    if (!set) sets.set(p.id, (set = new OptionSet(p.options)))
    const value = parseValue(cell, p.type, set)
    if (value === null) return undefined
    if (!hasOptions(p)) return value
    const ids = (Array.isArray(value) ? value as readonly string[] : [value as string]).flatMap((id) => {
      if (p.options.some(o => o.id === id)) return [id]
      const real = made.get(id) ?? addOption(p, set.options.find(o => o.id === id)!.name)?.id
      if (!real) return []
      made.set(id, real)
      return [real]
    })
    if (!ids.length) return undefined
    return p.type === 'select' ? ids[0]! : ids
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
  return { changes, skipped }
}
