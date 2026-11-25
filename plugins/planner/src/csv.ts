/** Collections as CSV and Markdown, and CSV read back. Pure functions; the store runs them. */

import { OptionSet, parseNumber, parseValue } from './convert.ts'
import {
  hasOptions, newId, parseDate, safeUrl, valueOf, valueText, type Collection, type Item, type Property,
  type People, type PropertyType, type Value,
} from './model.ts'
import { between, spread } from './order.ts'

/* ---------------------------------------------------------------- CSV text */

/** What a spreadsheet would run as a formula. Such a cell gets a leading apostrophe, which reading takes off. */
const FORMULA = /^\s*[=+\-@]|^[\t\r]/
const GUARDED = /^'(?=\s*[=+\-@]|[\t\r'])/

export function csvCell(text: string, isNumber = false): string {
  let t = text
  if (!isNumber && (FORMULA.test(t) || GUARDED.test(t))) t = `'${t}`
  return /[",\r\n;\t]|^\s|\s$/.test(t) ? `"${t.replaceAll('"', '""')}"` : t
}

/** Rows of cells. Quotes, doubled quotes, line breaks in quotes; comma, semicolon or tab, whichever the first line uses. */
export function parseCsv(source: string): string[][] {
  const text = source.replace(/^﻿/, '')
  const delimiter = detectDelimiter(text)
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!
    if (quoted) {
      if (c !== '"') cell += c
      else if (text[i + 1] === '"') {
        cell += '"'
        i++
      } else quoted = false
    } else if (c === '"' && cell === '') quoted = true
    else if (c === delimiter) {
      row.push(cell)
      cell = ''
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
    } else cell += c
  }
  if (cell !== '' || row.length) {
    row.push(cell)
    rows.push(row)
  }
  return rows.filter(r => r.some(c => c.trim() !== '')).map(r => r.map(c => c.replace(GUARDED, '')))
}

function detectDelimiter(text: string): string {
  const counts: Record<string, number> = { ',': 0, ';': 0, '\t': 0 }
  let quoted = false
  for (const c of text) {
    if (c === '"') quoted = !quoted
    else if (!quoted && (c === '\n' || c === '\r')) break
    else if (!quoted && c in counts) counts[c]!++
  }
  return Object.entries(counts).reduce((best, e) => (e[1] > best[1] ? e : best))[0]
}

/* ---------------------------------------------------------------- export */

export interface ExportOptions {
  /** Only these properties, in this order; all when left out. */
  properties?: readonly Property[]
  titleLabel?: string
  bodyLabel?: string
}

/** Title, properties and body, one row per item; a UTF-8 mark in front so spreadsheets read it right. */
export function toCsv(collection: Collection, items: readonly Item[], options: ExportOptions = {}): string {
  const properties = options.properties ?? collection.properties
  const head = [options.titleLabel ?? 'Title', ...properties.map(p => p.name), options.bodyLabel ?? 'Body'].map(c => csvCell(c))
  const rows = items.map(item => [
    csvCell(item.title),
    ...properties.map(p => csvCell(valueText(valueOf(item, p), p), p.type === 'number')),
    csvCell(item.body),
  ])
  return `﻿${[head, ...rows].map(r => r.join(',')).join('\r\n')}\r\n`
}

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim()
/** Text that must not turn into Markdown of its own. */
const escapeInline = (s: string) => oneLine(s).replace(/([\\`*_[\]<>#|])/g, '\\$1')

/** One item as Markdown: a heading, its properties, its body. */
export function itemToMarkdown(collection: Collection, item: Item, level = 1): string {
  const lines = [`${'#'.repeat(level)} ${escapeInline(item.title) || 'Untitled'}`, '']
  const props = collection.properties
    .map((p) => {
      const v = valueText(valueOf(item, p), p)
      const url = p.type === 'url' ? safeUrl(v) : null
      return v ? `- **${escapeInline(p.name)}:** ${url ? `<${url}>` : escapeInline(v)}` : ''
    })
    .filter(Boolean)
  if (props.length) lines.push(...props, '')
  if (item.body.trim()) lines.push(item.body.trim(), '')
  return lines.join('\n')
}

export function toMarkdown(collection: Collection, items: readonly Item[]): string {
  return [`# ${escapeInline(collection.name) || 'Untitled'}\n`, ...items.map(i => itemToMarkdown(collection, i, 2))].join('\n')
}

/* ---------------------------------------------------------------- import */

export interface ImportedItem { title: string; body: string; values: Record<string, Value> }

export interface ImportPlan {
  /** Properties to add, or (with new options) to update. */
  properties: Property[]
  items: ImportedItem[]
}

const TITLE_NAMES = new Set(['title', 'name', 'task', 'summary', 'item'])
const BODY_NAMES = new Set(['body', 'notes', 'description', 'content'])

/** The type a column's texts look like; text when they disagree. */
export function inferType(texts: readonly string[]): PropertyType {
  const filled = texts.map(t => t.trim()).filter(Boolean)
  if (!filled.length) return 'text'
  if (filled.every(t => /^(yes|no|true|false|x)$/i.test(t))) return 'checkbox'
  if (filled.every(t => parseNumber(t) !== null)) return 'number'
  if (filled.every(t => parseDate(t) !== null)) return 'date'
  if (filled.every(t => /^https?:\/\/\S+$/i.test(t))) return 'url'
  const distinct = new Set(filled.map(t => t.toLowerCase()))
  const short = filled.every(t => t.length <= 40 && !t.includes('\n'))
  return short && distinct.size <= 12 && filled.length >= 3 && distinct.size <= filled.length / 2 ? 'select' : 'text'
}

/**
 * How rows (the first is the header) come into a collection: columns go to properties of the same name, others
 * become new ones of the type they look like. Nothing is dropped but values a typed property cannot hold.
 */
export function planImport(rows: readonly (readonly string[])[], existing: readonly Property[] = [], people: People | null = null): ImportPlan {
  const [head, ...body] = rows
  if (!head) return { properties: [], items: [] }
  const names = head.map(h => h.trim())
  const lower = names.map(n => n.toLowerCase())
  const owned = new Set(existing.map(p => p.name.trim().toLowerCase()))
  const titleAt = Math.max(0, lower.findIndex(n => TITLE_NAMES.has(n) && !owned.has(n)))
  const bodyAt = lower.findIndex((n, i) => i !== titleAt && BODY_NAMES.has(n) && !owned.has(n))

  const used = new Set<string>()
  const changed = new Map<string, Property>()
  let lastOrder = existing.at(-1)?.order ?? null
  const fresh = spread(names.length)
  const columns = names.map((name, at) => {
    if (at === titleAt || at === bodyAt) return null
    const texts = body.map(r => r[at] ?? '')
    if (!name && texts.every(t => !t.trim())) return null
    let property = existing.find(p => !used.has(p.id) && p.name.trim().toLowerCase() === lower[at])
    if (!property) {
      lastOrder = between(lastOrder, null) ?? fresh[at]!
      property = { id: newId(), name: name || `Column ${at + 1}`, type: inferType(texts), order: lastOrder, options: [], people: {} }
      changed.set(property.id, property)
    }
    used.add(property.id)
    return { at, property, options: new OptionSet(property.options, people, property.people) }
  }).filter(c => c !== null)

  const items = body.map((row): ImportedItem => {
    const values: Record<string, Value> = {}
    for (const { at, property, options } of columns) {
      const v = parseValue(row[at] ?? '', property.type, options)
      if (v !== null && v !== false) values[property.id] = v
    }
    return { title: oneLine(row[titleAt] ?? ''), body: bodyAt < 0 ? '' : row[bodyAt] ?? '', values }
  })
  for (const { property, options } of columns) {
    if (hasOptions(property) && options.options.length > property.options.length) changed.set(property.id, { ...property, options: options.list() })
  }
  return { properties: [...changed.values()], items }
}
