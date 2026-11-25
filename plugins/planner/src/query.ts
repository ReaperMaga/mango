/** What a view shows: search, filter, sort, group and counts. Pure; `now` decides what "today" means. */

import { compareOrder } from './order.ts'
import {
  addDays, conditionValueKind, hasOptions, isReadonly, isUnary, localDate, propertyOf, TITLE, valueOf, valueText,
  type Collection, type Color, type Condition, type DateValue, type Filter, type Item, type Property, type Sort,
  type Value, type View,
} from './model.ts'

/** The group of items without a value of the property. Other keys are option ids, or `true` / `false`. */
export const NO_GROUP = ''

export interface Group {
  readonly key: string
  /** The option's name; '' for `NO_GROUP` and checkbox groups, which the UI names. */
  readonly name: string
  readonly color: Color
  readonly items: readonly Item[]
  readonly hidden: boolean
  readonly collapsed: boolean
}

export interface QueryResult {
  /** Every match, sorted. */
  readonly items: readonly Item[]
  /** Every group in order, empty and hidden ones too. One `NO_GROUP` when the view is not grouped. */
  readonly groups: readonly Group[]
  /** The property the groups are of, or null. */
  readonly groupBy: Property | null
  /** Items before search and filter. */
  readonly total: number
}

export interface QueryOptions { search?: string; now?: number }

/* ---------------------------------------------------------------- search */

/** Every word of the search is somewhere in the title, the values as text, or the body. */
export function matchesSearch(collection: Collection, item: Item, search: string): boolean {
  const words = search.toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return true
  const parts = [item.title]
  for (const p of collection.properties) if (p.type !== 'checkbox') parts.push(valueText(valueOf(item, p), p))
  parts.push(item.body)
  const text = parts.join('\n').toLowerCase()
  return words.every(w => text.includes(w))
}

/* ---------------------------------------------------------------- filter */

const isDate = (v: Value): v is DateValue => typeof v === 'object' && !Array.isArray(v)

function matchesText(text: string, c: Condition): boolean {
  if (c.operator === 'isEmpty') return text === ''
  if (c.operator === 'isNotEmpty') return text !== ''
  const a = text.trim().toLowerCase()
  const b = String(c.value).trim().toLowerCase()
  if (b === '') return true
  switch (c.operator) {
    case 'contains': return a.includes(b)
    case 'notContains': return !a.includes(b)
    case 'is': return a === b
    case 'isNot': return a !== b
    case 'startsWith': return a.startsWith(b)
    case 'endsWith': return a.endsWith(b)
    default: return true
  }
}

function matchesNumber(v: number, c: Condition): boolean {
  const n = c.value as number
  switch (c.operator) {
    case 'eq': return v === n
    case 'neq': return v !== n
    case 'gt': return v > n
    case 'gte': return v >= n
    case 'lt': return v < n
    case 'lte': return v <= n
    default: return true
  }
}

/** By whole days: a range is in all the days it covers. */
function matchesDate(v: DateValue, c: Condition, today: string): boolean {
  const start = v.start.slice(0, 10)
  const end = (v.end ?? v.start).slice(0, 10)
  const within = (from: string, to: string) => start <= to && end >= from
  const day = typeof c.value === 'string' ? c.value.slice(0, 10) : ''
  switch (c.operator) {
    case 'is': return within(day, day)
    case 'before': return start < day
    case 'after': return end > day
    case 'onOrBefore': return start <= day
    case 'onOrAfter': return end >= day
    case 'today': return within(today, today)
    case 'overdue': return end < today
    case 'nextDays': return within(today, addDays(today, c.value as number))
    case 'pastDays': return within(addDays(today, -(c.value as number)), today)
    default: return true
  }
}

/** An unfinished condition (no value yet, or about a property that is gone) matches everything. */
export function matchesCondition(collection: Collection, item: Item, c: Condition, now: number): boolean {
  if (!isActive(c)) return true
  if (c.propertyId === TITLE) return matchesText(item.title, c)
  const p = propertyOf(collection, c.propertyId)
  if (!p) return true
  const v = valueOf(item, p)
  if (conditionValueKind(p.type, c.operator) === 'text') return matchesText(typeof v === 'string' ? v : '', c)
  if (c.operator === 'isEmpty') return v === null
  if (c.operator === 'isNotEmpty') return v !== null
  if (v === null) return c.operator === 'isNot' || c.operator === 'notContains' || c.operator === 'neq'
  if (typeof v === 'boolean') return v === c.value
  if (typeof v === 'number') return matchesNumber(v, c)
  if (isDate(v)) return matchesDate(v, c, localDate(now))
  const wanted = Array.isArray(c.value) ? (c.value as readonly string[]) : []
  const has = (Array.isArray(v) ? (v as readonly string[]) : [v as string]).some(id => wanted.includes(id))
  return c.operator === 'is' || c.operator === 'contains' ? has : !has
}

/** Whether a condition has all it needs to filter anything. */
export function isActive(c: Condition): boolean {
  if (isUnary(c.operator)) return true
  return c.value !== null && c.value !== '' && !(Array.isArray(c.value) && !c.value.length)
}

export function matchesFilter(collection: Collection, item: Item, filter: Filter, now: number): boolean {
  const active = filter.conditions.filter(c => isActive(c) && (c.propertyId === TITLE || propertyOf(collection, c.propertyId)))
  if (!active.length) return true
  const test = (c: Condition) => matchesCondition(collection, item, c, now)
  return filter.match === 'or' ? active.some(test) : active.every(test)
}

/* ---------------------------------------------------------------- sort */

const text = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

function compareValues(a: Value, b: Value, p: Property): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b
  if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b)
  if (isDate(a) && isDate(b)) {
    if (a.start !== b.start) return a.start < b.start ? -1 : 1
    const [x, y] = [a.end ?? a.start, b.end ?? b.start]
    return x === y ? 0 : x < y ? -1 : 1
  }
  if (hasOptions(p)) {
    // By the order of the options, as the user arranged them.
    const rank = (v: Value) => (Array.isArray(v) ? (v as readonly string[]) : [v as string]).map(id => p.options.findIndex(o => o.id === id)).sort((x, y) => x - y)
    const [x, y] = [rank(a), rank(b)]
    for (let i = 0; i < Math.max(x.length, y.length); i++) {
      const d = (x[i] ?? -1) - (y[i] ?? -1)
      if (d) return d
    }
    return 0
  }
  return text.compare(String(a), String(b))
}

/** Sorted copy. Empty values are last either way; the manual order decides ties, and everything without sorts. */
export function sortItems(collection: Collection, items: readonly Item[], sorts: readonly Sort[]): Item[] {
  const out = [...items].sort(compareOrder)
  const keys = sorts.flatMap((s): Array<{ sort: Sort; property: Property | null; values: Map<Item, Value | null> }> => {
    if (s.propertyId === TITLE) return [{ sort: s, property: null, values: new Map(out.map(i => [i, i.title.trim() || null])) }]
    const property = propertyOf(collection, s.propertyId)
    return property ? [{ sort: s, property, values: new Map(out.map(i => [i, valueOf(i, property)])) }] : []
  })
  if (!keys.length) return out
  return out.sort((a, b) => {
    for (const { sort, property, values } of keys) {
      const x = values.get(a) ?? null
      const y = values.get(b) ?? null
      if (x === null || y === null) {
        if (x === y) continue
        return x === null ? 1 : -1
      }
      const d = property ? compareValues(x, y, property) : text.compare(String(x), String(y))
      if (d) return sort.direction === 'desc' ? -d : d
    }
    return 0
  })
}

/* ---------------------------------------------------------------- group */

/** The groups of a property, in order. "No …" comes first, as a place for what is not sorted out yet. */
export function groupKeys(p: Property): string[] {
  return p.type === 'checkbox' ? ['false', 'true'] : [NO_GROUP, ...p.options.map(o => o.id)]
}

/** The groups an item is in (several for a multi-select). */
export function groupsOf(item: Item, p: Property): string[] {
  const v = valueOf(item, p)
  if (p.type === 'checkbox') return [String(v === true)]
  if (Array.isArray(v)) return [...(v as readonly string[])]
  return [typeof v === 'string' ? v : NO_GROUP]
}

/** The value that puts an item into a group; for a multi-select, in place of group `from` when given. */
export function valueForGroup(p: Property, key: string, item?: Item | null, from?: string): Value | null {
  if (p.type === 'checkbox') return key === 'true'
  if (p.type !== 'multiSelect') return key === NO_GROUP ? null : key
  if (key === NO_GROUP) return null
  const value = item ? valueOf(item, p) : null
  const now = Array.isArray(value) ? (value as readonly string[]) : []
  return from !== undefined && now.includes(from)
    ? [...new Set(now.map(id => (id === from ? key : id)))]
    : [...now.filter(id => id !== key), key]
}

export function groupItems(items: readonly Item[], p: Property | null, view: View): Group[] {
  if (!p) return [{ key: NO_GROUP, name: '', color: 'neutral', items, hidden: false, collapsed: false }]
  const lists = new Map<string, Item[]>(groupKeys(p).map(k => [k, []]))
  for (const item of items) for (const key of groupsOf(item, p)) lists.get(key)?.push(item)
  return [...lists].map(([key, list]) => {
    const option = p.options.find(o => o.id === key)
    return {
      key,
      name: option?.name ?? '',
      color: option?.color ?? 'neutral',
      items: list,
      hidden: view.hiddenGroups.includes(key),
      collapsed: view.collapsedGroups.includes(key),
    }
  })
}

/* ---------------------------------------------------------------- all of it */

export function runQuery(collection: Collection, items: readonly Item[], view: View, options: QueryOptions = {}): QueryResult {
  const now = options.now ?? Date.now()
  const search = options.search?.trim() ?? ''
  const matched = items.filter(i => matchesFilter(collection, i, view.filter, now) && matchesSearch(collection, i, search))
  const sorted = sortItems(collection, matched, view.sorts)
  const groupBy = view.groupBy ? propertyOf(collection, view.groupBy) : null
  return { items: sorted, groups: groupItems(sorted, groupBy, view), groupBy, total: items.length }
}

/**
 * What a new item starts with: the properties' defaults, and in a view what makes it show up there: the group it
 * is added to, and what the filter plainly asks for (conditions that all must hold and name one value). A default
 * the filter would hide is left out.
 */
export function defaultValues(collection: Collection, view: View | null, group?: string | null, now = Date.now()): Record<string, Value> {
  const out: Record<string, Value> = {}
  for (const p of collection.properties) {
    if (p.type !== 'select' || !p.defaultOption) continue
    const conditions = view?.filter.match === 'and' ? view.filter.conditions.filter(c => c.propertyId === p.id) : []
    const probe: Item = {
      id: '', collectionId: collection.id, title: '', icon: null, values: { [p.id]: p.defaultOption }, body: '', order: '', chats: [], createdAt: now, updatedAt: now,
    }
    if (conditions.every(c => matchesCondition(collection, probe, c, now))) out[p.id] = p.defaultOption
  }
  if (!view) return out
  if (view.filter.match === 'and' || view.filter.conditions.filter(isActive).length === 1) {
    for (const c of view.filter.conditions) {
      const p = propertyOf(collection, c.propertyId)
      if (!p || !isActive(c) || isReadonly(p) || p.id in out) continue
      if (c.operator === 'today') out[p.id] = { start: localDate(now) }
      else if (c.operator === 'is' && p.type === 'select') out[p.id] = (c.value as readonly string[])[0]!
      else if (c.operator === 'contains' && p.type === 'multiSelect') out[p.id] = [(c.value as readonly string[])[0]!]
      else if (c.operator === 'is' && p.type === 'checkbox') out[p.id] = c.value as boolean
      else if (c.operator === 'is' && p.type === 'date') out[p.id] = { start: c.value as string }
      else if (c.operator === 'is' && p.type === 'text') out[p.id] = c.value as string
      else if (c.operator === 'eq') out[p.id] = c.value as number
    }
  }
  const groupBy = view.groupBy ? propertyOf(collection, view.groupBy) : null
  if (groupBy && group !== undefined && group !== null) {
    const v = valueForGroup(groupBy, group)
    if (v === null) delete out[groupBy.id]
    else out[groupBy.id] = v
  }
  return out
}

/** How many of `items` have a value of each property, for a table's footer. */
export function countFilled(collection: Collection, items: readonly Item[]): Record<string, number> {
  return Object.fromEntries(collection.properties.map(p => [p.id, items.filter((i) => {
    const v = valueOf(i, p)
    return v !== null && v !== false
  }).length]))
}
