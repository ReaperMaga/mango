/** Changing a property's type: what becomes of its values, and the options that have to exist for them. */

import {
  colorAt, formatDate, newId, parseDate, valueOf, valueText, type DateValue, type Item, type Option, type Property,
  type PropertyType, type Value,
} from './model.ts'
import { between, spread } from './order.ts'

export interface Conversion {
  /** The property as it will be: new type, and options added for values that had none. */
  readonly property: Property
  /** The new value of every item that had one (null: it could not be carried over). */
  readonly values: ReadonlyMap<string, Value | null>
  /** How many values could not be carried over. */
  readonly lost: number
}

const TRUE = new Set(['yes', 'true', '1', 'x', 'done', 'on', 'checked', '✓'])

/** Numbers as people write them: `1,200.5`, `1 200`, `12%`, `$5`. Null when it is not one. */
export function parseNumber(text: string): number | null {
  let t = text.trim().replace(/^[$€£]\s*|\s*[%$€£]$/g, '').replace(/[\s ']/g, '')
  if (/^[+-]?\d{1,3}(,\d{3})+(\.\d+)?$/.test(t)) t = t.replaceAll(',', '')
  else if (/^[+-]?\d+,\d+$/.test(t)) t = t.replace(',', '.')
  if (!/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(t)) return null
  const n = Number(t)
  return Number.isFinite(n) ? n : null
}

/** Finds or adds options by name, whatever its case. */
export class OptionSet {
  readonly options: Option[]
  private readonly byName: Map<string, string>

  constructor(existing: readonly Option[]) {
    this.options = [...existing]
    this.byName = new Map(existing.map(o => [o.name.trim().toLowerCase(), o.id]))
  }

  idOf(name: string): string {
    const key = name.trim().toLowerCase()
    let id = this.byName.get(key)
    if (!id) {
      id = newId()
      this.byName.set(key, id)
      const order = between(this.options.at(-1)?.order ?? null, null)
      this.options.push({ id, name: name.trim(), color: colorAt(this.options.length), order: order ?? '' })
    }
    return id
  }

  /** The options, the added ones after those there were; all re-spaced if an order was unusable. */
  list(): Option[] {
    if (this.options.every(o => o.order)) return this.options
    const keys = spread(this.options.length)
    return this.options.map((o, i) => ({ ...o, order: keys[i]! }))
  }
}

/** Text read as a value of a property's type, with options made as needed; null when it is not one. */
export function parseValue(text: string, type: PropertyType, options: OptionSet): Value | null {
  const t = text.trim()
  if (type === 'checkbox') return TRUE.has(t.toLowerCase())
  if (!t) return null
  switch (type) {
    case 'text': return text
    case 'url': return t
    case 'number': return parseNumber(t)
    case 'date': return parseDate(t)
    case 'select': return options.idOf(t)
    case 'multiSelect': {
      const names = t.split(/[,;\n]/).map(s => s.trim()).filter(Boolean)
      return names.length ? [...new Set(names.map(n => options.idOf(n)))] : null
    }
    default: return null
  }
}

export function convertProperty(property: Property, type: PropertyType, items: readonly Item[]): Conversion {
  const options = new OptionSet(property.options)
  const values = new Map<string, Value | null>()
  let lost = 0
  for (const item of items) {
    const value = valueOf(item, property)
    if (value === null || value === false) {
      // Whatever is stored there means nothing for the new type either.
      if (property.id in item.values) values.set(item.id, null)
      continue
    }
    const next = convertValue(value, property, type, options)
    if (next === null || next === false) lost++
    values.set(item.id, next)
  }
  return { property: { ...property, type, options: options.list() }, values, lost }
}

function convertValue(value: Value, from: Property, type: PropertyType, options: OptionSet): Value | null {
  if (type === 'multiSelect' && from.type === 'select') return [value as string]
  if (type === 'select' && from.type === 'multiSelect') return (value as readonly string[])[0] ?? null
  if (type === 'checkbox') return typeof value === 'number' ? value !== 0 : parseValue(valueText(value, from), type, options)
  if (type === 'number' && typeof value === 'boolean') return 1
  // A date and time of the planner's own becomes a plain date value, not text in between.
  if (type === 'date' && typeof value === 'object' && !Array.isArray(value)) return value as DateValue
  const text = typeof value === 'object' && !Array.isArray(value) ? formatDate(value as DateValue) : valueText(value, from)
  return parseValue(text, type, options)
}
