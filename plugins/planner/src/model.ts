/**
 * What the planner works with: collections of items with typed properties, seen through views.
 *
 * Two shapes of everything. The *stored* document is plain JSON that any version or a remote may have written;
 * changes are made to it as patches, so fields this version does not know stay. The *model* below is what the
 * UI reads: normalised from the stored document, complete and safe, and never written back. Treat it as
 * immutable: every change makes new objects and goes through the store.
 */

import { compareOrder, isKey, spread, type Ordered } from './order.ts'
import { strings as words } from './strings.ts'
import { entriesById, isObject, isSafeKey, type Json, type JsonObject } from './patch.ts'

/* ---------------------------------------------------------------- types */

/** Named, so the UI maps them to design tokens. */
export const NAMED_COLORS = ['neutral', 'blue', 'green', 'yellow', 'orange', 'red', 'purple', 'pink'] as const
/** The same; its name before there were custom ones. */
export const COLORS = NAMED_COLORS
export type NamedColor = typeof NAMED_COLORS[number]
/** A named one, or the user's own as `#rrggbb` in lower case. `ui/colors.ts` makes both work in both themes. */
export type Color = NamedColor | `#${string}`
export const isCustomColor = (c: Color): c is `#${string}` => c.startsWith('#')

/** A colour as it may be typed (`#RGB`, `rrggbb`) or stored, or null when it is none. */
export function readColor(v: unknown): Color | null {
  if (typeof v !== 'string') return null
  if (NAMED_COLORS.includes(v as NamedColor)) return v as NamedColor
  const m = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i.exec(v.trim())
  if (!m) return null
  const hex = m[1]!.toLowerCase()
  return `#${hex.length === 3 ? hex.replace(/./g, '$&$&') : hex}`
}

export const PROPERTY_TYPES = [
  'text', 'number', 'select', 'multiSelect', 'date', 'checkbox', 'url', 'createdTime', 'updatedTime',
] as const
/** `unsupported`: a newer version's type. Shown as text, not edited, kept as it is. */
export type PropertyType = typeof PROPERTY_TYPES[number] | 'unsupported'

export interface Option {
  readonly id: string
  readonly name: string
  readonly color: Color
  readonly order: string
}

export interface Property {
  readonly id: string
  readonly name: string
  readonly type: PropertyType
  readonly order: string
  /** Of `select` and `multiSelect`, in order; kept (and empty for the others) when the type changes. */
  readonly options: readonly Option[]
  /** The option a new item gets (`select`), or null. */
  readonly defaultOption?: string | null
}

/** An ISO date (`2026-03-01`) or a local date and time (`2026-03-01T09:30`); `end` makes it a range. */
export interface DateValue { readonly start: string; readonly end?: string }

/** text, url: string. number. select: option id. multiSelect: option ids. date. checkbox: boolean. */
export type Value = string | number | boolean | readonly string[] | DateValue

/** The property id of an item's title, in sorts, filters and column widths. */
export const TITLE = 'title'

export type SortDirection = 'asc' | 'desc'
export interface Sort { readonly propertyId: string; readonly direction: SortDirection }

export type Operator =
  | 'contains' | 'notContains' | 'is' | 'isNot' | 'startsWith' | 'endsWith'
  | 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte'
  | 'before' | 'after' | 'onOrBefore' | 'onOrAfter' | 'today' | 'overdue' | 'nextDays' | 'pastDays'
  | 'isEmpty' | 'isNotEmpty'

export interface Condition {
  readonly id: string
  readonly propertyId: string
  readonly operator: Operator
  /**
   * text: string. number, nextDays, pastDays: number. select, multiSelect: option ids (any of them).
   * date: ISO date. checkbox: boolean. Null while the user has not filled it in; such a condition is ignored.
   */
  readonly value: string | number | boolean | readonly string[] | null
}

export interface Filter { readonly match: 'and' | 'or'; readonly conditions: readonly Condition[] }

export type ViewType = 'board' | 'table'
export interface Column { readonly propertyId: string; readonly visible: boolean }

export interface View {
  readonly id: string
  readonly name: string
  readonly type: ViewType
  readonly order: string
  /** A `select`, `multiSelect` or `checkbox` property. A board always has one when the collection does. */
  readonly groupBy: string | null
  /** Group keys (see `query.ts`) not shown, and shown folded. */
  readonly hiddenGroups: readonly string[]
  readonly collapsedGroups: readonly string[]
  readonly sorts: readonly Sort[]
  readonly filter: Filter
  /** Every property once, in this view's order. */
  readonly columns: readonly Column[]
  /** Column widths in px, by property id (`title` too). */
  readonly widths: Readonly<Record<string, number>>
  /** What a board card shows under its title. */
  readonly cardPreview: 'none' | 'body'
}

export type Scope = { readonly kind: 'everywhere' } | {
  readonly kind: 'project'
  /** The folder on this computer (or the one it was made on). */
  readonly path: string
  /** The portable form, when it is known: `host/owner/name` of its repository. */
  readonly repo?: string
}

export interface ItemName { readonly one: string; readonly many: string }

export interface Collection {
  readonly id: string
  readonly name: string
  /** A lucide icon name. */
  readonly icon: string
  readonly color: Color
  readonly description: string
  /** What its items are called; null: just items. */
  readonly itemName: ItemName | null
  readonly scope: Scope
  readonly order: string
  /** In order. */
  readonly properties: readonly Property[]
  /** In order; a collection always has at least one. */
  readonly views: readonly View[]
  readonly createdAt: number
  readonly updatedAt: number
}

export interface Item {
  readonly id: string
  readonly collectionId: string
  readonly title: string
  /** A lucide icon name. */
  readonly icon: string | null
  /** As stored: read through `valueOf`, which checks them against the property. */
  readonly values: Readonly<Record<string, Json>>
  /** Markdown. */
  readonly body: string
  readonly order: string
  /** Ids of linked chats, oldest link first. */
  readonly chats: readonly string[]
  readonly createdAt: number
  readonly updatedAt: number
}

/** A stored document's own fields, beside its JSON. */
export interface DocMeta { id: string; createdAt: number; updatedAt: number }

/* ---------------------------------------------------------------- small helpers */

export function newId(): string {
  return globalThis.crypto.randomUUID()
}

const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback)
const num = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback)
const oneOf = <T extends string>(all: readonly T[], v: unknown, fallback: T): T => (all.includes(v as T) ? v as T : fallback)
const strings = (v: unknown): string[] =>
  Array.isArray(v) ? [...new Set(v.filter((e): e is string => typeof e === 'string'))] : []

const ICON_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const iconName = (v: unknown): string | null => (typeof v === 'string' && v.length <= 64 && ICON_NAME.test(v) ? v : null)

/** Sorted by `order`; entries without a usable one go last, as they came. */
export function ordered<T extends Ordered>(list: readonly T[]): T[] {
  const bad = list.filter(e => !isKey(e.order))
  const good = list.filter(e => isKey(e.order)).sort(compareOrder)
  if (!bad.length) return good
  // A key after every other, so that what is dropped behind them finds room or re-spaces.
  return [...good, ...bad.map((e, i) => ({ ...e, order: `zzzz${spread(bad.length)[i]}` }))]
}

/** Colours in turn, for new options. */
export const colorAt = (i: number): Color => NAMED_COLORS[1 + (i % (NAMED_COLORS.length - 1))]!

/* ---------------------------------------------------------------- dates */

const DATE = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?$/

export function isDateString(v: unknown): v is string {
  const m = typeof v === 'string' ? DATE.exec(v) : null
  if (!m) return false
  const [y, mo, d] = [+m[1]!, +m[2]!, +m[3]!]
  const date = new Date(Date.UTC(y, mo - 1, d))
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return false
  return m[4] === undefined || (+m[4] < 24 && +m[5]! < 60)
}

const two = (n: number) => String(n).padStart(2, '0')

/** Local date of a moment: `2026-03-01`. */
export function localDate(ms: number): string {
  const d = new Date(ms)
  return `${String(d.getFullYear()).padStart(4, '0')}-${two(d.getMonth() + 1)}-${two(d.getDate())}`
}

/** Local date and time of a moment: `2026-03-01T09:30`. */
export function localDateTime(ms: number): string {
  const d = new Date(ms)
  return `${localDate(ms)}T${two(d.getHours())}:${two(d.getMinutes())}`
}

/** A date some days later, as a date. */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.slice(0, 10).split('-').map(Number) as [number, number, number]
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10)
}

/** Text a person may have written as a date, or null. ISO forms only: anything else is a guess. */
export function parseDate(text: string): DateValue | null {
  const [a, b, more] = text.trim().split(/\s*(?:\/|→|\s+to\s+)\s*/)
  const read = (s: string | undefined) => {
    const t = s?.trim().replace(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?$/, '$1T$2')
    return isDateString(t) ? t : null
  }
  if (more !== undefined) return null
  const start = read(a)
  if (!start) return null
  if (b === undefined) return { start }
  const end = read(b)
  return end && end >= start ? { start, end } : null
}

export const formatDate = (d: DateValue): string => (d.end ? `${d.start} to ${d.end}` : d.start)

/* ---------------------------------------------------------------- normalising stored documents */

const storedColor = (v: unknown): Color => (typeof v === 'string' && (v.length === 7 || !v.startsWith('#')) ? readColor(v) : null) ?? 'neutral'

function normalizeOption(id: string, raw: JsonObject): Option {
  return { id, name: str(raw.name), color: storedColor(raw.color), order: str(raw.order) }
}

function normalizeProperty(id: string, raw: JsonObject): Property {
  const type = oneOf<PropertyType>(PROPERTY_TYPES, raw.type, 'unsupported')
  const options = ordered(entriesById(raw.options).map(([k, v]) => normalizeOption(k, v)))
  return {
    id,
    name: str(raw.name),
    type,
    order: str(raw.order),
    options,
    defaultOption: type === 'select' ? options.find(o => o.id === raw.defaultOption)?.id ?? null : null,
  }
}

export const isGroupable = (p: Property): boolean => p.type === 'select' || p.type === 'multiSelect' || p.type === 'checkbox'
export const hasOptions = (p: Property): boolean => p.type === 'select' || p.type === 'multiSelect'
/** Filled in by the planner, never by the user. */
export const isReadonly = (p: Property): boolean => p.type === 'createdTime' || p.type === 'updatedTime' || p.type === 'unsupported'

const COMMON: readonly Operator[] = ['isEmpty', 'isNotEmpty']
const TEXT_OPERATORS: readonly Operator[] = ['contains', 'notContains', 'is', 'isNot', 'startsWith', 'endsWith', ...COMMON]
const DATE_OPERATORS: readonly Operator[] = ['is', 'before', 'after', 'onOrBefore', 'onOrAfter', 'today', 'overdue', 'nextDays', 'pastDays', ...COMMON]

/** The operators a filter on this property offers, the usual one first. */
export function operatorsFor(type: PropertyType | typeof TITLE): readonly Operator[] {
  switch (type) {
    case 'number': return ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', ...COMMON]
    case 'select': return ['is', 'isNot', ...COMMON]
    case 'multiSelect': return ['contains', 'notContains', ...COMMON]
    case 'date': return DATE_OPERATORS
    case 'createdTime':
    case 'updatedTime': return DATE_OPERATORS.filter(o => o !== 'overdue' && !COMMON.includes(o))
    case 'checkbox': return ['is']
    case 'unsupported': return COMMON
    default: return TEXT_OPERATORS
  }
}

/** Operators that need no value. */
export const isUnary = (op: Operator): boolean => op === 'isEmpty' || op === 'isNotEmpty' || op === 'today' || op === 'overdue'

/** What kind of value a condition takes. */
export function conditionValueKind(type: PropertyType | typeof TITLE, op: Operator): 'none' | 'text' | 'number' | 'options' | 'date' | 'checkbox' {
  if (isUnary(op)) return 'none'
  if (op === 'nextDays' || op === 'pastDays' || type === 'number') return 'number'
  if (type === 'select' || type === 'multiSelect') return 'options'
  if (type === 'date' || type === 'createdTime' || type === 'updatedTime') return 'date'
  return type === 'checkbox' ? 'checkbox' : 'text'
}

function normalizeCondition(raw: unknown, properties: ReadonlyMap<string, Property>): Condition | null {
  if (!isObject(raw)) return null
  const propertyId = str(raw.propertyId)
  const property = properties.get(propertyId)
  if (!property && propertyId !== TITLE) return null
  const type = property?.type ?? TITLE
  const operator = raw.operator as Operator
  if (!operatorsFor(type).includes(operator)) return null
  const v = raw.value
  let value: Condition['value'] = null
  switch (conditionValueKind(type, operator)) {
    case 'text': value = typeof v === 'string' ? v : null; break
    case 'number': value = typeof v === 'number' && Number.isFinite(v) ? v : null; break
    case 'date': value = isDateString(v) ? v : null; break
    case 'checkbox': value = typeof v === 'boolean' ? v : null; break
    case 'options': {
      const known = strings(v).filter(o => property!.options.some(e => e.id === o))
      value = known.length ? known : null
      break
    }
  }
  return { id: str(raw.id) || newId(), propertyId, operator, value }
}

function normalizeView(id: string, raw: JsonObject, properties: readonly Property[]): View {
  const byId = new Map(properties.map(p => [p.id, p]))
  const type = oneOf<ViewType>(['board', 'table'], raw.type, 'table')
  let groupBy: string | null = str(raw.groupBy) || null
  if (groupBy && !(byId.has(groupBy) && isGroupable(byId.get(groupBy)!))) groupBy = null
  if (!groupBy && type === 'board') {
    groupBy = (properties.find(p => p.type === 'select') ?? properties.find(isGroupable))?.id ?? null
  }

  const columns: Column[] = []
  const seen = new Set<string>()
  for (const c of Array.isArray(raw.columns) ? raw.columns : []) {
    if (!isObject(c)) continue
    const propertyId = str(c.propertyId)
    if (!byId.has(propertyId) || seen.has(propertyId)) continue
    seen.add(propertyId)
    columns.push({ propertyId, visible: c.visible !== false })
  }
  // Properties added since: a table shows them, a card stays as it was laid out.
  for (const p of properties) if (!seen.has(p.id)) columns.push({ propertyId: p.id, visible: type === 'table' })

  const sorts: Sort[] = []
  for (const s of Array.isArray(raw.sorts) ? raw.sorts : []) {
    if (!isObject(s)) continue
    const propertyId = str(s.propertyId)
    if ((propertyId !== TITLE && !byId.has(propertyId)) || sorts.some(e => e.propertyId === propertyId)) continue
    sorts.push({ propertyId, direction: s.direction === 'desc' ? 'desc' : 'asc' })
  }

  const filter = isObject(raw.filter) ? raw.filter : {}
  const widths: Record<string, number> = {}
  if (isObject(raw.widths)) {
    for (const [k, v] of Object.entries(raw.widths)) {
      if (isSafeKey(k) && (k === TITLE || byId.has(k))) widths[k] = Math.round(Math.min(1200, Math.max(60, num(v, 160))))
    }
  }

  return {
    id,
    name: str(raw.name),
    type,
    order: str(raw.order),
    groupBy,
    hiddenGroups: strings(raw.hiddenGroups),
    collapsedGroups: strings(raw.collapsedGroups),
    sorts,
    filter: {
      match: filter.match === 'or' ? 'or' : 'and',
      conditions: (Array.isArray(filter.conditions) ? filter.conditions : [])
        .map(c => normalizeCondition(c, byId))
        .filter(c => c !== null),
    },
    columns,
    widths,
    cardPreview: oneOf<View['cardPreview']>(['none', 'body'], raw.cardPreview, 'none'),
  }
}

function normalizeScope(raw: unknown): Scope {
  if (!isObject(raw) || raw.kind !== 'project' || typeof raw.path !== 'string' || !raw.path) return { kind: 'everywhere' }
  const repo = typeof raw.repo === 'string' && /^[^\s/]+(?:\/[^\s/]+){2,}$/.test(raw.repo) ? raw.repo : null
  return { kind: 'project', path: raw.path, ...(repo ? { repo } : {}) }
}

function normalizeItemName(raw: unknown): ItemName | null {
  if (!isObject(raw)) return null
  const one = str(raw.one).trim()
  const many = str(raw.many).trim()
  return one || many ? { one: one || many, many: many || one } : null
}

/** What this many of a collection's items are called: `note`, `notes`. */
export function itemWord(c: Pick<Collection, 'itemName'> | null | undefined, n: number): string {
  const name = c?.itemName
  return n === 1 ? name?.one ?? words.item : name?.many ?? words.items
}

/** The id of the table a collection without any view is shown with. */
export const FALLBACK_VIEW = 'default'

export function normalizeCollection(raw: unknown, meta: DocMeta): Collection {
  const r = isObject(raw) ? raw : {}
  const properties = ordered(entriesById(r.properties).filter(([id]) => id !== TITLE).map(([id, v]) => normalizeProperty(id, v)))
  let views = ordered(entriesById(r.views).map(([id, v]) => normalizeView(id, v, properties)))
  if (!views.length) views = [normalizeView(FALLBACK_VIEW, { name: 'Table', type: 'table', order: 'V' }, properties)]
  return {
    id: meta.id,
    name: str(r.name),
    icon: iconName(r.icon) ?? 'square-kanban',
    color: storedColor(r.color),
    description: str(r.description),
    itemName: normalizeItemName(r.itemName),
    scope: normalizeScope(r.scope),
    order: str(r.order),
    properties,
    views,
    createdAt: num(r.createdAt, meta.createdAt),
    updatedAt: meta.updatedAt,
  }
}

export function normalizeItem(raw: unknown, meta: DocMeta, collectionId: string): Item {
  const r = isObject(raw) ? raw : {}
  const chats = isObject(r.chats)
    ? Object.entries(r.chats)
        .filter(([id]) => isSafeKey(id))
        .sort((a, b) => num(a[1], 0) - num(b[1], 0))
        .map(([id]) => id)
    : strings(r.chats)
  return {
    id: meta.id,
    collectionId,
    title: str(r.title),
    icon: iconName(r.icon),
    values: isObject(r.values) ? Object.fromEntries(Object.entries(r.values).filter(([k]) => isSafeKey(k))) : {},
    body: str(r.body),
    order: str(r.order),
    chats,
    createdAt: num(r.createdAt, meta.createdAt),
    updatedAt: meta.updatedAt,
  }
}

/* ---------------------------------------------------------------- values */

/** A stored value as this property understands it, or null (empty, or not one of its values). */
export function readValue(raw: unknown, property: Property): Value | null {
  switch (property.type) {
    case 'text':
    case 'url':
      return typeof raw === 'string' && raw !== '' ? raw : null
    case 'number':
      return typeof raw === 'number' && Number.isFinite(raw) ? raw : null
    case 'checkbox':
      return raw === true
    case 'select':
      return typeof raw === 'string' && property.options.some(o => o.id === raw) ? raw : null
    case 'multiSelect': {
      const known = strings(raw).filter(id => property.options.some(o => o.id === id))
      return known.length ? known : null
    }
    case 'date': {
      if (!isObject(raw) || !isDateString(raw.start)) return null
      return isDateString(raw.end) && raw.end >= raw.start ? { start: raw.start, end: raw.end } : { start: raw.start }
    }
    default:
      return null
  }
}

/** An item's value of a property, or null when it is empty. A checkbox is never empty. */
export function valueOf(item: Item, property: Property): Value | null {
  if (property.type === 'createdTime') return { start: localDateTime(item.createdAt) }
  if (property.type === 'updatedTime') return { start: localDateTime(item.updatedAt) }
  return readValue(item.values[property.id], property)
}

/** What is stored for a value: checked, and undefined (nothing) when it is empty or not a value of the property. */
export function storedValue(value: Value | null, property: Property): Json | undefined {
  if (value === null || isReadonly(property)) return undefined
  const v = readValue(value, property)
  if (v === null || v === false) return undefined
  return structuredClone(v) as Json
}

/** A value as plain text: option names, dates, `Yes` / `No`. */
export function valueText(value: Value | null, property: Property): string {
  if (value === null) return ''
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
  if (typeof value === 'number') return String(value)
  const name = (id: string) => property.options.find(o => o.id === id)?.name ?? ''
  if (typeof value === 'string') return property.type === 'select' ? name(value) : value
  if (Array.isArray(value)) return (value as readonly string[]).map(name).join(', ')
  return formatDate(value as DateValue)
}

/** A web address that is safe to open (http or https), or null. A missing scheme means https. */
export function safeUrl(text: string): string | null {
  const t = text.trim()
  if (!t) return null
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:(?!\d)/i.test(t) ? t : `https://${t}`)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null
  } catch {
    return null
  }
}

/* ---------------------------------------------------------------- scopes */

/** The same folder however it is written: separators, a trailing one, the case of a Windows path. */
export function projectKey(path: string): string {
  const p = path.replace(/\\/g, '/').replace(/(?<=.)\/+$/, '')
  return /^[a-z]:/i.test(p) || (p.startsWith('//') && path.includes('\\')) ? p.toLowerCase() : p
}

/** What this computer knows about the open project, to place collections made on another one. */
export interface ProjectIdentity {
  /** `host/owner/name` of its repository, or null. */
  readonly repo: string | null
  /** Whether a project folder is one of this computer's. */
  hasPath(path: string): boolean
}

/**
 * Whether a collection shows while this project is open (null: no project). By folder; by repository only when its
 * folder is not on this computer.
 */export function isInScope(scope: Scope, projectPath: string | null, here?: ProjectIdentity | null): boolean {
  if (scope.kind === 'everywhere') return true
  if (projectPath === null) return false
  if (projectKey(scope.path) === projectKey(projectPath)) return true
  return !!scope.repo && !!here?.repo && scope.repo.toLowerCase() === here.repo.toLowerCase() && !here.hasPath(scope.path)
}

export const propertyOf = (c: Collection, id: string): Property | null => c.properties.find(p => p.id === id) ?? null
export const viewOf = (c: Collection, id: string | null | undefined): View | null => c.views.find(v => v.id === id) ?? null
