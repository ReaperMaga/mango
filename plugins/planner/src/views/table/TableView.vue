<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, shallowRef, useId, watch } from 'vue'
import { usePlanner } from '../../context.ts'
import { parseNumber } from '../../convert.ts'
import type { PluginMenuRow } from '../../host.ts'
import { itemMenu } from '../../item/itemMenu.ts'
import {
  isReadonly, itemWord, newId, operatorsFor, propertyOf, TITLE, valueOf, valueText,
  type Collection, type Item, type Property, type SortDirection, type Value, type View,
} from '../../model.ts'
import type { Group, QueryResult } from '../../query.ts'
import { keyLabel } from '../../shell/keys.ts'
import { strings as shared } from '../../strings.ts'
import Icon from '../../ui/Icon.vue'
import OptionTag from '../../ui/OptionTag.vue'
import PropertyIcon from '../../ui/PropertyIcon.vue'
import AddProperty from '../../values/AddProperty.vue'
import { propertyMenu } from '../../values/PropertyMenu.ts'
import ValuePopover from '../../values/ValuePopover.vue'
import ValueView from '../../values/ValueView.vue'
import BulkBar from './BulkBar.vue'
import CellInput from './CellInput.vue'
import { cellText, parseTsv, planPaste, toTsv, type Field } from './clipboard.ts'
import { startDrag } from './drag.ts'
import { allIn, dropAt, itemKey, itemsBetween, linesOf, ROW_H, windowOf, type Drop, type ItemLine, type Line } from './rows.ts'
import { strings } from './strings.ts'

const props = defineProps<{
  collection: Collection
  view: View
  result: QueryResult
  search: string
  readonly: boolean
  openItemId: string | null
}>()
const emit = defineEmits<{ open: [itemId: string] }>()

const planner = usePlanner()
const { mango, store } = planner
const { ThreadDot } = mango.ui.components
const uid = useId()
const wordOf = (n: number) => itemWord(props.collection, n)

const openKey = keyLabel(mango, 'Enter')
const GUTTER = 46
const ADD_W = 36
const HEAD_H = 32
const FOOT_H = 32
/** The key of the header in `active`. */
const HEAD = 'head'

/* ---------------------------------------------------------------- columns */

interface Col { id: string; field: Field; name: string; width: number; left: number }

const WIDTHS: Record<Property['type'], number> = {
  text: 200, number: 110, select: 140, multiSelect: 180, date: 150, checkbox: 96, url: 180, createdTime: 150, updatedTime: 150, unsupported: 140,
}
const viewport = reactive({ width: 800, height: 600 })
const draftWidths = ref<Record<string, number>>({})

const cols = computed<Col[]>(() => {
  const out: Col[] = []
  let left = 0
  const add = (id: string, field: Field, name: string, fallback: number) => {
    let width = draftWidths.value[id] ?? props.view.widths[id] ?? fallback
    // The title stays in view: it leaves room for the others in a narrow pane.
    if (!field) width = Math.min(width, Math.max(130, Math.round(viewport.width * 0.55) - GUTTER))
    out.push({ id, field, name, width, left })
    left += width
  }
  add(TITLE, null, strings.title, 300)
  for (const c of props.view.columns) {
    const p = c.visible ? propertyOf(props.collection, c.propertyId) : null
    if (p) add(p.id, p, p.name || shared.untitled, WIDTHS[p.type])
  }
  return out
})
const colIndex = computed(() => new Map(cols.value.map((c, i) => [c.id, i])))
const rowWidth = computed(() => GUTTER + cols.value.reduce((n, c) => n + c.width, 0) + ADD_W)
const sortOf = (id: string) => props.view.sorts.find(s => s.propertyId === id)?.direction ?? null
const sorted = computed(() => props.view.sorts.length > 0)

/* ---------------------------------------------------------------- lines, windowed */

const grid = ref<HTMLElement | null>(null)
const scrollTop = ref(0)
const lines = computed(() => linesOf(props.result, props.readonly))
const lineIndex = computed(() => new Map(lines.value.map((l, i) => [l.key, i])))
const bodyHeight = computed(() => Math.max(0, viewport.height - HEAD_H - FOOT_H))

const shown = computed<Array<{ line: Line; index: number }>>(() => {
  const [from, to] = windowOf(lines.value.length, scrollTop.value, bodyHeight.value)
  const out: Array<{ line: Line; index: number }> = []
  for (let i = from; i < to; i++) out.push({ line: lines.value[i]!, index: i })
  // The active line is always there: focus, an editor and a popover hang on it.
  const at = lineIndex.value.get(active.value?.key ?? '')
  if (at !== undefined && at < from) out.unshift({ line: lines.value[at]!, index: at })
  else if (at !== undefined && at >= to) out.push({ line: lines.value[at]!, index: at })
  return out
})

let observer: ResizeObserver | undefined
onMounted(() => {
  observer = new ResizeObserver(() => {
    if (!grid.value) return
    viewport.width = grid.value.clientWidth
    viewport.height = grid.value.clientHeight
  })
  observer.observe(grid.value!)
})
let stopDrag: (() => void) | undefined
onBeforeUnmount(() => {
  observer?.disconnect()
  stopDrag?.()
})

const groupName = (g: Group): string => {
  const p = props.result.groupBy
  if (!p || g.name) return g.name
  if (p.type === 'checkbox') return g.key === 'true' ? strings.checked : strings.unchecked
  return strings.noGroup(p.name)
}

/* ---------------------------------------------------------------- the active cell */

interface Cell { key: string; col: string }
const active = shallowRef<Cell | null>(null)
const cellId = (key: string, col: string) => `${uid}-${key}-${col}`
const activeLine = computed<Line | null>(() => lines.value[lineIndex.value.get(active.value?.key ?? '') ?? -1] ?? null)
const activeCol = computed<Col>(() => cols.value[colIndex.value.get(active.value?.col ?? TITLE) ?? 0]!)
const activeId = computed(() => {
  if (!active.value) return undefined
  if (active.value.key === HEAD) return cellId(HEAD, activeCol.value.id)
  const line = activeLine.value
  return line ? cellId(line.key, line.kind === 'item' ? activeCol.value.id : 'line') : undefined
})
const isActive = (key: string, col: string) => active.value?.key === key && activeCol.value.id === col

// The active line may move to another group, or go.
let lastIndex = 0
watch(lines, (list) => {
  const now = active.value
  if (!now || now.key === HEAD) return
  const at = lineIndex.value.get(now.key)
  if (at !== undefined) return void (lastIndex = at)
  const id = now.key.startsWith('i/') ? now.key.slice(now.key.lastIndexOf('/') + 1) : null
  const moved = id ? list.find(l => l.kind === 'item' && l.item.id === id) : undefined
  const next = moved ?? list[Math.min(lastIndex, list.length - 1)]
  // What is typed so far counts, wherever its row went.
  cellInput?.commit('blur')
  active.value = next ? { key: next.key, col: now.col } : null
})

function elementOf(cell = activeId.value): HTMLElement | null {
  return cell ? document.getElementById(cell) : null
}

function activate(index: number, col = active.value?.col ?? TITLE, reveal = true) {
  const max = lines.value.length - 1
  const i = Math.max(-1, Math.min(index, max))
  if (i < 0) active.value = { key: HEAD, col }
  else {
    lastIndex = i
    active.value = { key: lines.value[i]!.key, col }
  }
  if (reveal) scrollTo(i, col)
}

function scrollTo(index: number, col: string) {
  const el = grid.value
  if (!el) return
  if (index >= 0) {
    const top = index * ROW_H
    if (top < el.scrollTop) el.scrollTop = top
    else if (top + ROW_H > el.scrollTop + bodyHeight.value) el.scrollTop = top + ROW_H - bodyHeight.value
  }
  const c = cols.value[colIndex.value.get(col) ?? 0]!
  if (!c.field) {
    el.scrollLeft = 0
    return
  }
  const pinned = GUTTER + cols.value[0]!.width
  const left = GUTTER + c.left
  if (left - pinned < el.scrollLeft) el.scrollLeft = left - pinned
  else if (left + c.width > el.scrollLeft + viewport.width) el.scrollLeft = left + c.width - viewport.width
}

function focus() {
  if (!active.value && lines.value.length) activate(0, TITLE, false)
  grid.value?.focus({ preventScroll: true })
}

const currentIndex = () => (active.value?.key === HEAD ? -1 : lineIndex.value.get(active.value?.key ?? '') ?? 0)

/* ---------------------------------------------------------------- selection */

const selection = shallowRef<ReadonlySet<string>>(new Set())
/** Where Shift extends from. */
let anchor: string | null = null
/** What was selected before the range being extended. */
let anchorBase: ReadonlySet<string> = new Set()

watch(() => props.result.items, (items) => {
  if (!selection.value.size) return
  const there = new Set(items.map(i => i.id))
  const kept = [...selection.value].filter(id => there.has(id))
  if (kept.length !== selection.value.size) selection.value = new Set(kept)
})
watch(() => props.view.id, () => {
  selection.value = new Set()
  active.value = null
  cellInput?.commit('blur')
  popover.value = null
  if (grid.value) grid.value.scrollTop = grid.value.scrollLeft = 0
})

const selectedItems = computed(() => props.result.items.filter(i => selection.value.has(i.id)))
const allSelected = computed(() => props.result.items.length > 0 && selection.value.size === props.result.items.length)

function toggleSelected(line: ItemLine, range = false) {
  if (range && anchor) return selectTo(line.key)
  const next = new Set(selection.value)
  if (!next.delete(line.item.id)) next.add(line.item.id)
  setAnchor(line.key, next)
  selection.value = next
}
function setAnchor(key: string, base: ReadonlySet<string>) {
  anchor = key
  anchorBase = base
}
function selectTo(key: string) {
  if (!anchor || !lineIndex.value.has(anchor)) setAnchor(active.value?.key ?? key, new Set())
  const [a, b] = [lineIndex.value.get(anchor!), lineIndex.value.get(key)]
  if (a === undefined || b === undefined) return
  selection.value = new Set([...anchorBase, ...itemsBetween(lines.value, a, b)])
}
function clearSelection() {
  selection.value = new Set()
  anchor = null
  focus()
}
function selectAll() {
  selection.value = allSelected.value ? new Set() : new Set(props.result.items.map(i => i.id))
}

/* ---------------------------------------------------------------- editing */

const editing = shallowRef<{ key: string; itemId: string; col: string; text: string; selectAll: boolean } | null>(null)
let cellInput: { commit(then: 'blur' | 'keep'): void } | null = null
function setCellInput(el: unknown) {
  cellInput = el as typeof cellInput
}
type Popover =
  | { kind: 'value'; property: Property; itemIds: string[]; anchor: HTMLElement }
  | { kind: 'add'; anchor: HTMLElement }
const popover = shallowRef<Popover | null>(null)
const liveProperty = computed(() => (popover.value?.kind === 'value' ? propertyOf(props.collection, popover.value.property.id) : null))

const isEditing = (key: string, col: string) => editing.value?.key === key && editing.value.col === col
const inPlace = (f: Field) => !f || f.type === 'text' || f.type === 'number' || f.type === 'url'
const canEdit = (f: Field) => !props.readonly && !(f && isReadonly(f))

/** `typed`: what was typed to start it, in place of what is there. */
async function edit(typed?: string) {
  const line = activeLine.value
  const { id, field } = activeCol.value
  if (line?.kind !== 'item' || !canEdit(field)) return
  if (field?.type === 'checkbox') return toggleCheckbox(line.item, field)
  scrollTo(currentIndex(), id)
  if (inPlace(field)) {
    editing.value = { key: line.key, itemId: line.item.id, col: id, text: typed ?? cellText(line.item, field), selectAll: typed === undefined && field?.type !== 'text' }
    return
  }
  await nextTick()
  const el = elementOf()
  if (el && field) popover.value = { kind: 'value', property: field, itemIds: [line.item.id], anchor: el }
}

function commitEdit(text: string, then: 'down' | 'right' | 'left' | 'stay' | 'blur' | 'keep') {
  const was = editing.value
  if (then !== 'keep') editing.value = null
  const index = currentIndex()
  // The item it was begun on, also when the view does not show it any more.
  const item = was && store.item(props.collection.id, was.itemId)
  const field = was && was.col !== TITLE ? propertyOf(props.collection, was.col) : null
  if (item && (field || was.col === TITLE) && text !== cellText(item, field)) {
    if (!field) store.updateItem(props.collection.id, item.id, { title: text.trim() })
    else {
      const value: Value | null = field.type === 'number' ? parseNumber(text) : text.trim() ? (field.type === 'url' ? text.trim() : text) : null
      if (field.type === 'number' && value === null && text.trim()) mango.ui.toast({ title: strings.notPasted(1), kind: 'warning' })
      else store.updateItem(props.collection.id, item.id, { values: { [field.id]: value } })
    }
  }
  if (then === 'blur' || then === 'keep') return
  grid.value?.focus({ preventScroll: true })
  // Where the neighbours were before the edit sorted or grouped the item elsewhere.
  if (then === 'down') activate(index + 1, was?.col)
  else if (then !== 'stay') step(then === 'right' ? 1 : -1, index, was?.col)
}
function cancelEdit() {
  editing.value = null
  grid.value?.focus({ preventScroll: true })
}

/** One cell on or back, over the row's end. */
function step(by: 1 | -1, index: number, col = TITLE) {
  const c = (colIndex.value.get(col) ?? 0) + by
  if (c >= 0 && c < cols.value.length) return activate(index, cols.value[c]!.id)
  const next = lines.value.findIndex((l, i) => l.kind === 'item' && i > index)
  if (by > 0 && next >= 0) return activate(next, TITLE)
  if (by < 0) {
    for (let i = index - 1; i >= 0; i--) if (lines.value[i]!.kind === 'item') return activate(i, cols.value.at(-1)!.id)
  }
}

function toggleCheckbox(item: Item, p: Property) {
  if (!canEdit(p)) return
  store.updateItem(props.collection.id, item.id, { values: { [p.id]: valueOf(item, p) !== true } })
}

function closePopover() {
  popover.value = null
  void nextTick(() => {
    if (!document.activeElement || document.activeElement === document.body) grid.value?.focus({ preventScroll: true })
  })
}
async function addedProperty(p: Property) {
  popover.value = null
  await nextTick()
  if (colIndex.value.has(p.id)) activate(-1, p.id)
  grid.value?.focus({ preventScroll: true })
}

/** The cells these keys are about: the selected rows, or the active one. */
function clearCells() {
  const line = activeLine.value
  const { field } = activeCol.value
  if (line?.kind !== 'item' || !canEdit(field)) return
  store.updateItem(props.collection.id, line.item.id, field ? { values: { [field.id]: field.type === 'checkbox' ? false : null } } : { title: '' })
}
function deleteSelected() {
  if (props.readonly) return
  store.deleteItems(props.collection.id, [...selection.value])
  clearSelection()
}

/* ---------------------------------------------------------------- new items */

async function addItem(group: Group, atTop = false) {
  if (props.readonly) return
  if (group.collapsed) toggleGroup(group)
  const edge = atTop ? group.items[0] : group.items.at(-1)
  const item = await store.createItem(props.collection.id, {
    viewId: props.view.id,
    group: props.result.groupBy ? group.key : undefined,
    position: edge ? (atTop ? { before: edge.id } : { after: edge.id }) : atTop ? 'start' : 'end',
  })
  if (!item) return
  await nextTick()
  let at = lineIndex.value.get(itemKey(group.key, item.id))
  at ??= lines.value.findIndex(l => l.kind === 'item' && l.item.id === item.id)
  // The search or the filter keeps it out of sight here.
  if (at < 0) return emit('open', item.id)
  activate(at, TITLE)
  await nextTick()
  grid.value?.focus({ preventScroll: true })
  await edit()
}
function newItem() {
  const group = props.result.groups.find(g => !(g.hidden && props.result.groupBy))
  if (group) void addItem(group, true)
}

function toggleGroup(g: Group) {
  const list = props.view.collapsedGroups
  store.updateView(props.collection.id, props.view.id, {
    collapsedGroups: g.collapsed ? list.filter(k => k !== g.key) : [...list, g.key],
  })
}

/* ---------------------------------------------------------------- headers */

function updateView(change: Parameters<typeof store.updateView>[2]) {
  store.updateView(props.collection.id, props.view.id, change)
}

function sortBy(id: string, direction: SortDirection) {
  updateView({ sorts: sortOf(id) === direction ? [] : [{ propertyId: id, direction }] })
}
function filterOn(id: string, field: Field) {
  updateView({
    filter: {
      ...props.view.filter,
      conditions: [...props.view.filter.conditions, { id: newId(), propertyId: id, operator: operatorsFor(field?.type ?? TITLE)[0]!, value: null }],
    },
  })
}
function setWidth(id: string, width: number | null) {
  const { [id]: _, ...rest } = props.view.widths
  updateView({ widths: width === null ? rest : { ...rest, [id]: Math.round(Math.min(1200, Math.max(60, width))) } })
}
/** Before the column of another property, or last (null). */
function moveColumn(id: string, before: string | null) {
  if (id === before) return
  const moving = props.view.columns.find(c => c.propertyId === id)
  if (!moving) return
  const rest = props.view.columns.filter(c => c !== moving)
  const at = before ? rest.findIndex(c => c.propertyId === before) : rest.length
  const next = [...rest.slice(0, at), moving, ...rest.slice(at)]
  if (next.some((c, i) => c !== props.view.columns[i])) updateView({ columns: next })
}
function shiftColumn(id: string, by: -1 | 1) {
  const i = colIndex.value.get(id)
  if (i === undefined || i < 1) return
  const to = by < 0 ? i - 1 : i + 2
  if (to >= 1 && to <= cols.value.length) moveColumn(id, cols.value[to]?.id ?? null)
}

async function headerMenu(col: Col, at: HTMLElement | { x: number; y: number }) {
  active.value = { key: HEAD, col: col.id }
  if (props.readonly) return
  const { field, id } = col
  const i = colIndex.value.get(id)!
  const rows: PluginMenuRow[] = [
    { label: strings.sortAscending, icon: 'arrow-up', checked: sortOf(id) === 'asc', onSelect: () => sortBy(id, 'asc') },
    { label: strings.sortDescending, icon: 'arrow-down', checked: sortOf(id) === 'desc', onSelect: () => sortBy(id, 'desc') },
  ]
  if (sortOf(id)) rows.push({ label: strings.removeSort, icon: 'x', onSelect: () => updateView({ sorts: props.view.sorts.filter(s => s.propertyId !== id) }) })
  rows.push({ label: strings.filter, icon: 'list-filter', onSelect: () => filterOn(id, field) })
  if (field) rows.push(
    { label: strings.moveLeft, icon: 'arrow-left', divider: true, disabled: i < 2, onSelect: () => shiftColumn(id, -1) },
    { label: strings.moveRight, icon: 'arrow-right', disabled: i === cols.value.length - 1, onSelect: () => shiftColumn(id, 1) },
  )
  if (props.view.widths[id]) rows.push({ label: strings.resetWidth, icon: 'move-horizontal', divider: !field, onSelect: () => setWidth(id, null) })
  if (field) await propertyMenu(planner, props.collection, field, at, props.view, rows)
  else await mango.ui.contextMenu(at, rows)
  // Unless the choice opened something that has it now.
  if (!document.activeElement || document.activeElement === document.body) grid.value?.focus({ preventScroll: true })
}

/* resizing */

function resize(e: PointerEvent, col: Col) {
  if (e.button !== 0 || props.readonly) return
  const from = col.width
  stopDrag = startDrag(e, {
    threshold: 2,
    cursor: 'col-resize',
    hold: () => mango.ui.holdOverlay(),
    move: x => (draftWidths.value = { [col.id]: Math.round(Math.min(1200, Math.max(60, from + x - e.clientX))) }),
    end: (done) => {
      const width = draftWidths.value[col.id]
      if (done && width !== undefined) setWidth(col.id, width)
      draftWidths.value = {}
    },
  })
}

/* reordering */

const colDrag = shallowRef<{ id: string; before: string | null; x: number } | null>(null)

function dragColumn(e: PointerEvent, col: Col) {
  if (e.button !== 0 || !col.field || props.readonly || e.pointerType === 'touch') return
  stopDrag = startDrag(e, {
    hold: () => mango.ui.holdOverlay(),
    scroll: { el: grid.value!, axis: 'x', inset: [GUTTER + cols.value[0]!.width, 0] },
    move: (x) => {
      const el = grid.value!
      const at = x - el.getBoundingClientRect().left + el.scrollLeft - GUTTER
      const before = cols.value.slice(1).find(c => at < c.left + c.width / 2)
      const last = cols.value.at(-1)!
      colDrag.value = { id: col.id, before: before?.id ?? null, x: GUTTER + (before ? before.left : last.left + last.width) }
    },
    end: (done) => {
      const drag = colDrag.value
      colDrag.value = null
      if (done && drag) moveColumn(drag.id, drag.before)
    },
  })
}

/* ---------------------------------------------------------------- moving rows */

const rowDrag = shallowRef<{ ids: ReadonlySet<string>; drop: Drop | null } | null>(null)
/** In a sorted view the order is not the user's; rows can still go to another group. */
const canDrag = computed(() => !props.readonly && (!sorted.value || props.result.groupBy !== null))

function dragRow(e: PointerEvent, line: ItemLine) {
  if (e.button !== 0 || !canDrag.value) return
  const ids = selection.value.has(line.item.id) ? selectedItems.value.map(i => i.id) : [line.item.id]
  stopDrag = startDrag(e, {
    hold: () => mango.ui.holdOverlay(),
    scroll: { el: grid.value!, axis: 'y', inset: [HEAD_H, FOOT_H] },
    start: () => (rowDrag.value = { ids: new Set(ids), drop: null }),
    move: (_, y) => {
      const el = grid.value!
      const at = y - el.getBoundingClientRect().top - HEAD_H + el.scrollTop
      const boundary = Math.max(0, Math.min(lines.value.length, Math.round(at / ROW_H)))
      rowDrag.value = { ids: new Set(ids), drop: dropAt(lines.value, boundary, sorted.value) }
    },
    end: (done) => {
      const drop = rowDrag.value?.drop
      rowDrag.value = null
      if (done && drop) moveTo(ids, drop, line.group.key)
    },
  })
}

function moveTo(ids: string[], drop: Drop, from: string) {
  const { groupBy } = props.result
  const items = props.result.items.filter(i => ids.includes(i.id))
  const regroup = groupBy && !(drop.group.key === from && allIn(items, props.result, from))
  // Beside one of those that move: nothing to place by but its neighbours.
  let position = drop.position
  const beside = position && ('after' in position ? position.after : position.before)
  if (beside && ids.includes(beside)) {
    const list = drop.group.items
    const at = list.findIndex(i => i.id === beside)
    const after = list.slice(0, at).findLast(i => !ids.includes(i.id))
    const before = list.slice(at).find(i => !ids.includes(i.id))
    position = after ? { after: after.id } : before ? { before: before.id } : undefined
  }
  if (!regroup && !position) return
  const key = active.value?.key
  store.moveItems(props.collection.id, {
    ids,
    ...(regroup ? { group: { propertyId: groupBy.id, key: drop.group.key, ...(drop.group.key === from ? {} : { from }) } } : {}),
    ...(position ? { position } : {}),
  })
  if (key && regroup) void nextTick(() => {
    const at = lineIndex.value.get(itemKey(drop.group.key, ids[0]!))
    if (at !== undefined && ids.some(id => key.endsWith(id))) activate(at)
  })
}

/** Alt+Shift+Up/Down: past the neighbour, and out of the group at its end. */
function nudge(by: -1 | 1) {
  const line = activeLine.value
  if (line?.kind !== 'item' || !canDrag.value) return
  const list = line.group.items
  const at = list.findIndex(i => i.id === line.item.id)
  const neighbour = list[at + by]
  if (neighbour) {
    if (sorted.value) return
    store.moveItems(props.collection.id, { ids: [line.item.id], position: by < 0 ? { before: neighbour.id } : { after: neighbour.id } })
  } else if (props.result.groupBy) {
    const groups = props.result.groups.filter(g => !g.hidden)
    const target = groups[groups.findIndex(g => g.key === line.group.key) + by]
    if (!target) return
    if (target.collapsed) toggleGroup(target)
    const edge = by < 0 ? target.items.at(-1) : target.items[0]
    const position = sorted.value || !edge ? undefined : by < 0 ? { after: edge.id } : { before: edge.id }
    moveTo([line.item.id], { group: target, position, boundary: 0 }, line.group.key)
  }
  void nextTick(() => scrollTo(currentIndex(), active.value?.col ?? TITLE))
}

/* ---------------------------------------------------------------- copy and paste */

function copyText(): string | null {
  if (selection.value.size) return toTsv(selectedItems.value, cols.value.map(c => c.field))
  const line = activeLine.value
  if (line?.kind !== 'item') return null
  const text = cellText(line.item, activeCol.value.field)
  return text.includes('\n') ? toTsv([line.item], [activeCol.value.field]) : text
}
function onCopy(e: ClipboardEvent) {
  if (!ownKey(e)) return
  const text = copyText()
  if (text === null) return
  e.preventDefault()
  e.clipboardData?.setData('text/plain', text)
}
function onPaste(e: ClipboardEvent) {
  if (!ownKey(e) || props.readonly) return
  const text = e.clipboardData?.getData('text/plain')
  const line = activeLine.value
  if (!text || line?.kind !== 'item') return
  e.preventDefault()
  const cells = parseTsv(text)
  const at = currentIndex()
  // One row goes into every selected one; more go into the rows from here on.
  const items = cells.length === 1
    ? selection.value.has(line.item.id) ? selectedItems.value : [line.item]
    : lines.value.slice(at).flatMap(l => (l.kind === 'item' ? [l.item] : [])).slice(0, cells.length)
  const { changes, options, skipped } = planPaste(cells, items, cols.value.slice(colIndex.value.get(activeCol.value.id)).map(c => c.field))
  store.updateEach(props.collection.id, changes, options)
  if (skipped) mango.ui.toast({ title: strings.notPasted(skipped), kind: 'warning' })
}

/* ---------------------------------------------------------------- menus */

function rowMenu(e: MouseEvent, line: ItemLine, col?: string) {
  if (!selection.value.has(line.item.id)) active.value = { key: line.key, col: col ?? active.value?.col ?? TITLE }
  openMenu(line.item, { x: e.clientX, y: e.clientY })
}
function openMenu(item: Item, at: { x: number; y: number } | HTMLElement) {
  const ids = selection.value.has(item.id) ? selectedItems.value.map(i => i.id) : [item.id]
  void itemMenu(planner, props.collection, ids, at, { open: id => emit('open', id), openKey })
}

async function setForSelected(p: Property, el: HTMLElement) {
  await nextTick()
  popover.value = { kind: 'value', property: p, itemIds: [...selection.value], anchor: el }
}
function duplicateSelected() {
  const copies = store.duplicateItems(props.collection.id, [...selection.value])
  if (copies.length) selection.value = new Set(copies.map(i => i.id))
}

/* ---------------------------------------------------------------- pointer and keys */

/** Not in an editor of ours. */
function ownKey(e: Event) {
  return !editing.value && !popover.value && !(e.target instanceof HTMLElement && e.target.closest('input, textarea, [contenteditable]'))
}

/** Buttons in the grid work without taking the focus: the grid keeps it, and the active cell with it. */
function onMouseDown(e: MouseEvent) {
  if (!(e.target as HTMLElement).closest('button, .pl-th')) return
  e.preventDefault()
  grid.value?.focus({ preventScroll: true })
}
function onCellDown(e: MouseEvent, line: ItemLine, col: string) {
  if (e.button !== 0) return
  if (e.shiftKey) {
    e.preventDefault()
    grid.value?.focus({ preventScroll: true })
    selectTo(line.key)
  } else if (e.ctrlKey || e.metaKey) {
    toggleSelected(line)
  } else {
    setAnchor(line.key, new Set())
    if (selection.value.size) selection.value = new Set()
  }
  lastIndex = lineIndex.value.get(line.key) ?? 0
  active.value = { key: line.key, col }
}
function onCellDouble(e: MouseEvent) {
  if (!(e.target as HTMLElement).closest('button, a')) void edit()
}

function onFocus() {
  if (!active.value && lines.value.length) activate(0, TITLE, false)
}

function onKey(e: KeyboardEvent) {
  if (e.isComposing || !ownKey(e)) return
  const mod = e.ctrlKey || e.metaKey
  const line = activeLine.value
  const onHead = active.value?.key === HEAD
  const index = currentIndex()
  const col = activeCol.value
  const done = () => {
    e.preventDefault()
    e.stopPropagation()
  }
  const move = (to: number, column?: string) => {
    done()
    const from = active.value?.key
    activate(to, column ?? col.id)
    if (e.shiftKey && from && from !== HEAD && active.value && active.value.key !== HEAD) {
      if (!anchor || !lineIndex.value.has(anchor)) setAnchor(from, new Set())
      selectTo(active.value.key)
    } else if (active.value) setAnchor(active.value.key, new Set())
  }
  const page = Math.max(1, Math.floor(bodyHeight.value / ROW_H) - 1)

  if (e.altKey) {
    if (e.shiftKey && !mod && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      done()
      nudge(e.key === 'ArrowUp' ? -1 : 1)
    } else if (onHead && (e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !mod && !props.readonly) {
      done()
      const by = e.key === 'ArrowLeft' ? -1 : 1
      if (e.shiftKey) shiftColumn(col.id, by)
      else setWidth(col.id, col.width + by * 16)
    }
    return
  }

  switch (e.key) {
    case 'ArrowUp': return mod ? move(0) : move(index - 1)
    case 'ArrowDown': return mod ? move(lines.value.length - 1) : move(index + 1)
    case 'PageUp': return move(Math.max(0, index - page))
    case 'PageDown': return move(index + page)
    case 'ArrowLeft':
    case 'ArrowRight': {
      if (mod) return
      const by = e.key === 'ArrowLeft' ? -1 : 1
      if (line?.kind === 'group') {
        done()
        if (line.group.collapsed === by > 0) toggleGroup(line.group)
        return
      }
      const next = cols.value[(colIndex.value.get(col.id) ?? 0) + by]
      return next ? move(index, next.id) : done()
    }
    case 'Home': return mod ? move(0, TITLE) : move(index, TITLE)
    case 'End': return mod ? move(lines.value.length - 1, cols.value.at(-1)!.id) : move(index, cols.value.at(-1)!.id)
    case 'Enter':
    case 'F2':
      if (e.key === 'Enter' && mod) {
        if (line?.kind !== 'item') return
        done()
        return emit('open', line.item.id)
      }
      done()
      if (onHead) {
        const el = elementOf()
        if (el) headerMenu(col, el)
      } else if (line?.kind === 'group') toggleGroup(line.group)
      else if (line?.kind === 'add') void addItem(line.group)
      else void edit()
      return
    case ' ':
      if (mod) return
      done()
      if (line?.kind === 'group') toggleGroup(line.group)
      else if (line?.kind === 'add') void addItem(line.group)
      else if (line?.kind === 'item') {
        if (e.shiftKey) toggleSelected(line)
        else if (col.field?.type === 'checkbox') toggleCheckbox(line.item, col.field)
        else void edit()
      }
      return
    case 'Escape':
      if (!selection.value.size) return
      done()
      return clearSelection()
    case 'Delete':
    case 'Backspace':
      done()
      return selection.value.size ? deleteSelected() : clearCells()
    case 'ContextMenu':
    case 'F10': {
      if (e.key === 'F10' && !e.shiftKey) return
      done()
      const el = elementOf()
      if (!el) return
      if (onHead) headerMenu(col, el)
      else if (line?.kind === 'item') openMenu(line.item, el)
      return
    }
  }
  if (mod) {
    if (e.key.toLowerCase() === 'a' && !e.shiftKey) {
      done()
      selection.value = new Set(props.result.items.map(i => i.id))
    } else if (e.key.toLowerCase() === 'd' && !e.shiftKey && selection.value.size && !props.readonly) {
      done()
      duplicateSelected()
    }
    return
  }
  if (e.key.length === 1 && line?.kind === 'item') {
    done()
    if (col.field?.type !== 'checkbox') void edit(e.key)
  }
}

/* ---------------------------------------------------------------- the footer */

const number = new Intl.NumberFormat(undefined, { maximumFractionDigits: 6 })
const footer = computed(() => new Map(cols.value.map((c): [string, string] => {
  const { items, total } = props.result
  if (!c.field) return [c.id, items.length === total ? strings.count(total, wordOf(total)) : strings.countOf(items.length, total, wordOf(total))]
  const p = c.field
  if (p.type === 'number') {
    const values = items.map(i => valueOf(i, p)).filter(v => typeof v === 'number')
    return [c.id, values.length ? strings.sum(number.format(values.reduce((a, b) => a + b, 0))) : '']
  }
  if (p.type === 'checkbox' && items.length) return [c.id, strings.checkedOf(items.filter(i => valueOf(i, p) === true).length, items.length)]
  return [c.id, '']
})))

const groupPreview = (g: Group) => (g.name ? { name: g.name, color: g.color } : null)
/** Nothing to find is said above the view. */
const isEmpty = computed(() => !props.result.total && !props.result.groupBy)

defineExpose({ newItem, focus })
</script>

<template>
  <div class="pl-table">
    <div
      ref="grid"
      class="pl-grid"
      :class="{ 'is-dragging': rowDrag || colDrag }"
      role="grid"
      tabindex="0"
      :aria-label="strings.grid(collection.name)"
      :aria-rowcount="lines.length + 2"
      :aria-colcount="cols.length + 1"
      :aria-activedescendant="activeId"
      :aria-readonly="readonly || undefined"
      aria-multiselectable="true"
      @scroll.passive="scrollTop = ($event.target as HTMLElement).scrollTop"
      @keydown="onKey"
      @focus="onFocus"
      @mousedown="onMouseDown"
      @copy="onCopy"
      @paste="onPaste"
    >
      <div class="pl-grid__inner" :style="{ minWidth: `${rowWidth}px` }" role="presentation">
        <div class="pl-tr pl-tr--head" role="row" aria-rowindex="1">
          <div class="pl-gutter" :class="{ 'is-on': selection.size }" role="columnheader" aria-colindex="1" :aria-label="strings.selectAll">
            <button
              v-if="result.items.length"
              type="button"
              class="pl-check"
              role="checkbox"
              tabindex="-1"
              :aria-checked="allSelected ? 'true' : selection.size ? 'mixed' : 'false'"
              :aria-label="strings.selectAll"
              @click="selectAll"
            >
              <span class="pl-box" :class="{ 'is-on': selection.size }"><Icon v-if="allSelected" name="check" /><Icon v-else-if="selection.size" name="minus" /></span>
            </button>
          </div>
          <div
            v-for="(c, i) in cols"
            :id="cellId(HEAD, c.id)"
            :key="c.id"
            class="pl-th"
            :class="{ 'is-title': !c.field, 'is-active': isActive(HEAD, c.id), 'is-moving': colDrag?.id === c.id, 'is-numeric': c.field?.type === 'number' }"
            :style="{ width: `${c.width}px` }"
            role="columnheader"
            :aria-colindex="i + 2"
            :aria-sort="sortOf(c.id) ? (sortOf(c.id) === 'asc' ? 'ascending' : 'descending') : undefined"
            aria-haspopup="menu"
            :title="c.name"
            @pointerdown="dragColumn($event, c)"
            @click="headerMenu(c, $event.currentTarget as HTMLElement)"
            @contextmenu.prevent="headerMenu(c, { x: $event.clientX, y: $event.clientY })"
          >
            <PropertyIcon :type="c.field?.type ?? 'text'" class="pl-th__icon" />
            <span class="pl-th__name">{{ c.name }}</span>
            <Icon v-if="sortOf(c.id)" class="pl-th__sort" :name="sortOf(c.id) === 'asc' ? 'arrow-up' : 'arrow-down'" />
            <span
              v-if="!readonly"
              class="pl-th__resize"
              :class="{ 'is-on': c.id in draftWidths }"
              aria-hidden="true"
              @pointerdown.stop.prevent="resize($event, c)"
              @click.stop
              @dblclick.stop="setWidth(c.id, null)"
            />
          </div>
          <button
            v-if="!readonly"
            type="button"
            class="pl-th-add"
            :class="{ 'is-open': popover?.kind === 'add' }"
            :aria-label="strings.addProperty"
            :title="strings.addProperty"
            aria-haspopup="dialog"
            @click="popover = { kind: 'add', anchor: $event.currentTarget as HTMLElement }"
          >
            <Icon name="plus" />
          </button>
        </div>

        <div class="pl-body" role="rowgroup" :style="{ height: `${lines.length * ROW_H + (selection.size ? 52 : 0)}px` }">
          <template v-for="{ line, index } in shown" :key="line.key">
            <div
              v-if="line.kind === 'item'"
              class="pl-tr"
              :class="{
                'is-selected': selection.has(line.item.id),
                'is-open': openItemId === line.item.id,
                'is-moving': rowDrag?.ids.has(line.item.id),
                'is-editing': editing?.key === line.key,
              }"
              :style="{ top: `${index * ROW_H}px` }"
              role="row"
              :aria-rowindex="index + 2"
              :aria-selected="selection.has(line.item.id)"
              @contextmenu.prevent="rowMenu($event, line, ($event.target as HTMLElement).closest<HTMLElement>('[data-col]')?.dataset.col)"
            >
              <div class="pl-gutter" :class="{ 'is-on': selection.size }" role="gridcell" aria-colindex="1">
                <span v-if="canDrag" class="pl-handle" :title="strings.reorder" aria-hidden="true" @pointerdown.prevent="dragRow($event, line)">
                  <Icon name="grip-vertical" />
                </span>
                <button
                  type="button"
                  class="pl-check"
                  role="checkbox"
                  tabindex="-1"
                  :aria-checked="selection.has(line.item.id)"
                  :aria-label="strings.selectRow(line.item.title)"
                  @click="toggleSelected(line, $event.shiftKey)"
                >
                  <span class="pl-box" :class="{ 'is-on': selection.has(line.item.id) }"><Icon v-if="selection.has(line.item.id)" name="check" /></span>
                </button>
              </div>
              <div
                v-for="(c, i) in cols"
                :id="cellId(line.key, c.id)"
                :key="c.id"
                class="pl-td"
                :class="{ 'is-title': !c.field, 'is-active': isActive(line.key, c.id), 'is-numeric': c.field?.type === 'number', 'is-editing': isEditing(line.key, c.id) }"
                :style="{ width: `${c.width}px` }"
                role="gridcell"
                :aria-colindex="i + 2"
                :aria-readonly="!canEdit(c.field) || undefined"
                :data-col="c.id"
                @mousedown="onCellDown($event, line, c.id)"
                @dblclick="onCellDouble"
              >
                <CellInput
                  v-if="isEditing(line.key, c.id)"
                  :key="cellId(line.key, c.id)"
                  :ref="setCellInput"
                  :text="editing!.text"
                  :select-all="editing!.selectAll"
                  :multiline="c.field?.type === 'text'"
                  :numeric="c.field?.type === 'number'"
                  :label="strings.edit(c.name)"
                  @commit="commitEdit"
                  @cancel="cancelEdit"
                />
                <template v-else-if="!c.field">
                  <Icon v-if="line.item.icon" :name="line.item.icon" class="pl-title__icon" />
                  <span class="pl-title__text" :class="{ 'is-untitled': !line.item.title }" :title="line.item.title || undefined">{{ line.item.title || strings.untitled }}</span>
                  <component :is="ThreadDot" v-if="line.item.chats.length" :thread-id="line.item.chats.at(-1)!" :size="11" class="pl-title__dot" />
                  <button
                    type="button"
                    class="pl-open"
                    tabindex="-1"
                    :aria-label="strings.openItem(line.item.title)"
                    :title="`${strings.open} (${openKey})`"
                    @mousedown.stop.prevent
                    @click.stop="emit('open', line.item.id)"
                  >
                    <Icon name="panel-right-open" /><span>{{ strings.open }}</span>
                  </button>
                </template>
                <button
                  v-else-if="c.field.type === 'checkbox'"
                  type="button"
                  class="pl-check is-value"
                  role="checkbox"
                  tabindex="-1"
                  :disabled="readonly"
                  :aria-checked="valueOf(line.item, c.field) === true"
                  :aria-label="c.name"
                  @click="toggleCheckbox(line.item, c.field)"
                >
                  <span class="pl-box" :class="{ 'is-on': valueOf(line.item, c.field) === true }"><Icon v-if="valueOf(line.item, c.field) === true" name="check" /></span>
                </button>
                <span v-else-if="c.field.type === 'unsupported'" class="pl-td__text">{{ valueText(valueOf(line.item, c.field), c.field) }}</span>
                <div v-else class="pl-td__value"><ValueView :property="c.field" :item="line.item" /></div>
              </div>
            </div>

            <div
              v-else
              class="pl-tr"
              :class="line.kind === 'group' ? 'pl-tr--group' : 'pl-tr--add'"
              :style="{ top: `${index * ROW_H}px` }"
              role="row"
              :aria-rowindex="index + 2"
            >
              <div
                :id="cellId(line.key, 'line')"
                class="pl-line"
                :class="{ 'is-active': active?.key === line.key }"
                role="gridcell"
                aria-colindex="1"
                :aria-colspan="cols.length + 1"
                :aria-expanded="line.kind === 'group' ? !line.group.collapsed : undefined"
                @mousedown="active = { key: line.key, col: activeCol.id }"
                @click="line.kind === 'group' ? toggleGroup(line.group) : addItem(line.group)"
              >
                <template v-if="line.kind === 'group'">
                  <Icon name="chevron-right" class="pl-line__chevron" :class="{ 'is-open': !line.group.collapsed }" />
                  <OptionTag v-if="groupPreview(line.group)" :option="groupPreview(line.group)!" />
                  <span v-else class="pl-line__name">{{ groupName(line.group) }}</span>
                  <span class="pl-line__count">{{ line.group.items.length }}</span>
                  <button
                    v-if="!readonly"
                    type="button"
                    class="pl-line__add"
                    tabindex="-1"
                    :aria-label="strings.newItemIn(wordOf(1), groupName(line.group))"
                    :title="strings.newItemIn(wordOf(1), groupName(line.group))"
                    @click.stop="addItem(line.group, true)"
                  >
                    <Icon name="plus" />
                  </button>
                </template>
                <template v-else>
                  <Icon name="plus" class="pl-line__plus" />
                  <span>{{ strings.newItem(wordOf(1)) }}</span>
                  <span v-if="isEmpty" class="pl-line__note">{{ strings.empty(wordOf(2)) }}</span>
                </template>
              </div>
            </div>
          </template>

          <div v-if="rowDrag?.drop" class="pl-dropline" :style="{ top: `${rowDrag.drop.boundary * ROW_H - 1}px` }" aria-hidden="true" />
        </div>
        <p v-if="readonly && isEmpty" class="pl-none">{{ strings.empty(wordOf(2)) }}</p>

        <div class="pl-tr pl-tr--foot" role="row" :aria-rowindex="lines.length + 2">
          <div class="pl-gutter" role="gridcell" aria-colindex="1" />
          <div
            v-for="(c, i) in cols"
            :key="c.id"
            class="pl-tf"
            :class="{ 'is-title': !c.field, 'is-numeric': c.field?.type === 'number' }"
            :style="{ width: `${c.width}px` }"
            role="gridcell"
            :aria-colindex="i + 2"
            :title="footer.get(c.id) || undefined"
          >
            {{ footer.get(c.id) }}
          </div>
        </div>

        <div v-if="colDrag" class="pl-colline" :style="{ left: `${colDrag.x - 1}px` }" aria-hidden="true" />
      </div>
    </div>

    <BulkBar
      v-if="selection.size && !readonly"
      :collection="collection"
      :count="selection.size"
      @set="setForSelected"
      @duplicate="duplicateSelected"
      @delete="deleteSelected"
      @clear="clearSelection"
    />

    <ValuePopover
      v-if="popover?.kind === 'value' && liveProperty"
      :collection-id="collection.id"
      :property="liveProperty"
      :item-ids="popover.itemIds"
      :anchor="popover.anchor"
      @close="closePopover"
    />
    <AddProperty v-if="popover?.kind === 'add'" :collection-id="collection.id" :anchor="popover.anchor" @close="closePopover" @added="addedProperty" />
  </div>
</template>

<style scoped>
.pl-table { position: relative; container: pl-table / inline-size; height: 100%; min-width: 0; min-height: 0; }
.pl-grid { position: relative; height: 100%; overflow: auto; overscroll-behavior: contain; background: var(--bg-canvas); font-size: var(--text-sm); }
.pl-grid:focus-visible { outline: none; }
/* At least as high as the grid, so the footer sits at the bottom of a short table too. */
.pl-grid__inner { position: relative; display: flex; flex-direction: column; min-height: 100%; }
.pl-body { position: relative; flex: 1 0 auto; }

/* ---------- rows ---------- */
.pl-tr {
  --pl-ground: var(--bg-canvas);
  position: absolute;
  left: 0;
  right: 0;
  display: flex;
  height: 32px;
  border-bottom: 1px solid var(--line-soft);
  background: var(--pl-ground);
}
.pl-tr:hover { --pl-ground: color-mix(in oklab, var(--bg-panel) 55%, var(--bg-canvas)); }
.pl-tr.is-open { --pl-ground: var(--bg-panel); }
.pl-tr.is-selected { --pl-ground: color-mix(in oklab, var(--accent) 9%, var(--bg-canvas)); }
.pl-tr.is-moving { opacity: 0.45; }
.pl-tr.is-editing { z-index: 2; }
.pl-tr--head, .pl-tr--foot { position: sticky; z-index: 3; flex: none; }
.pl-tr--head { top: 0; }
.pl-tr--foot { bottom: 0; height: 32px; border-top: 1px solid var(--line-soft); border-bottom: 0; }
.pl-tr--head, .pl-tr--foot, .pl-tr--head:hover, .pl-tr--foot:hover { --pl-ground: var(--bg-canvas); }

/* The gutter and the title stay while the rest scrolls under them. */
.pl-gutter, .is-title { position: sticky; z-index: 1; flex: none; background: var(--pl-ground); }
.pl-gutter { left: 0; width: 46px; display: flex; align-items: center; justify-content: flex-end; padding-right: 2px; }
.is-title { left: 46px; border-right: 1px solid var(--line-soft); }

.pl-handle { display: grid; place-items: center; width: 18px; height: 24px; border-radius: var(--radius-xs); color: var(--fg-faint); cursor: grab; touch-action: none; opacity: 0; }
.pl-handle :deep(svg) { width: 13px; height: 13px; }
.pl-handle:hover { background: var(--bg-hover); color: var(--fg); }
.pl-tr:hover .pl-handle { opacity: 1; }

.pl-check { flex: none; display: grid; place-items: center; width: 24px; height: 24px; border-radius: var(--radius-xs); }
.pl-gutter .pl-check { opacity: 0; }
.pl-tr:hover .pl-gutter .pl-check, .pl-gutter.is-on .pl-check { opacity: 1; }
.pl-check.is-value { margin-left: -5px; }
.pl-box { display: grid; place-items: center; width: 14px; height: 14px; border: 1px solid var(--line-strong); border-radius: var(--radius-xs); background: var(--bg-inset); }
.pl-check:hover .pl-box { border-color: var(--fg-faint); }
.pl-box.is-on, .pl-check:hover .pl-box.is-on { border-color: var(--accent); background: var(--accent); color: var(--accent-fg); }
.pl-box :deep(svg) { width: 11px; height: 11px; stroke-width: 3; }

/* ---------- cells ---------- */
.pl-th, .pl-td, .pl-tf { flex: none; display: flex; align-items: center; min-width: 0; padding: 0 var(--space-2); }
.pl-td { position: relative; overflow: hidden; border-right: 1px solid transparent; color: var(--fg-muted); }
.pl-td.is-title { position: sticky; gap: 6px; border-right-color: var(--line-soft); color: var(--fg); }
.pl-td.is-editing { overflow: visible; z-index: 2; }
.pl-td.is-numeric { justify-content: flex-end; font-variant-numeric: tabular-nums; }
.pl-td__value { display: flex; align-items: center; min-width: 0; max-width: 100%; overflow: hidden; white-space: nowrap; }
.pl-td__text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* The active cell: clear while the grid has the focus, a trace of it otherwise. */
.pl-td.is-active::after, .pl-th.is-active::after, .pl-line.is-active::after {
  content: '';
  position: absolute;
  inset: 0;
  border: 1px solid transparent;
  border-radius: var(--radius-xs);
  pointer-events: none;
}
.pl-td.is-active::after { border-color: var(--line-strong); }
.pl-grid:focus-within .is-active::after { border: 2px solid var(--focus-ring); }
.pl-td.is-editing::after { content: none; }

.pl-title__icon { flex: none; width: 14px; height: 14px; color: var(--fg-subtle); }
.pl-title__text { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500; }
.pl-title__text.is-untitled { color: var(--fg-faint); font-weight: 400; }
.pl-title__dot { flex: none; }
.pl-open {
  display: none;
  flex: none;
  align-items: center;
  gap: 4px;
  height: 22px;
  margin: 0 -3px 0 auto;
  padding: 0 6px;
  border: 1px solid var(--line);
  border-radius: var(--radius-xs);
  background: var(--bg-raised);
  color: var(--fg-muted);
  font-size: var(--text-xs);
  font-weight: 560;
}
.pl-open :deep(svg) { width: 12px; height: 12px; stroke-width: 1.85; }
.pl-open:hover { border-color: var(--line-strong); color: var(--fg); }
.pl-tr:hover .pl-open { display: inline-flex; }

/* ---------- header and footer ---------- */
.pl-th {
  position: relative;
  gap: 6px;
  color: var(--fg-subtle);
  font-size: var(--text-xs);
  font-weight: 560;
  cursor: pointer;
  transition: color var(--dur-fast) var(--ease-out);
}
.pl-th.is-title { position: sticky; z-index: 2; }
.pl-th:hover { color: var(--fg); }
.pl-th.is-moving { color: var(--accent-ink); }
.pl-th__icon { flex: none; width: 13px; height: 13px; }
.pl-th__name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pl-th__sort { flex: none; width: 12px; height: 12px; color: var(--accent-ink); }
.pl-th__resize { position: absolute; z-index: 1; top: 0; right: -4px; bottom: 0; width: 8px; cursor: col-resize; touch-action: none; }
.pl-th.is-title .pl-th__resize { right: 0; }
.pl-th__resize::after { content: ''; position: absolute; top: 6px; bottom: 6px; left: 3px; width: 2px; background: transparent; transition: background var(--dur-fast) var(--ease-out); }
.pl-th__resize:hover::after, .pl-th__resize.is-on::after { background: var(--accent-line); }
.pl-th-add { flex: none; display: grid; place-items: center; width: 28px; height: 24px; margin: 3px 4px; border-radius: var(--radius-xs); color: var(--fg-subtle); }
.pl-th-add :deep(svg) { width: 14px; height: 14px; stroke-width: 1.75; }
.pl-th-add:hover, .pl-th-add.is-open { background: var(--bg-hover); color: var(--fg); }
.pl-tf { color: var(--fg-subtle); font-size: var(--text-xs); font-variant-numeric: tabular-nums; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pl-tf.is-numeric, .pl-th.is-numeric { justify-content: flex-end; }

/* ---------- group and new item lines ---------- */
.pl-tr--group:hover, .pl-tr--add:hover { --pl-ground: var(--bg-canvas); }
.pl-tr--add { border-bottom-color: transparent; }
.pl-line { position: sticky; left: 0; display: flex; align-items: center; gap: var(--space-2); width: calc(100cqi - 14px); padding: 0 var(--space-3); color: var(--fg-subtle); cursor: pointer; transition: color var(--dur-fast) var(--ease-out); }
.pl-tr--group .pl-line { padding-left: 20px; }
.pl-tr--add .pl-line { gap: 15px; padding-left: 25px; }
.pl-line:hover { color: var(--fg); }
.pl-line__chevron, .pl-line__plus { flex: none; width: 14px; height: 14px; stroke-width: 1.75; }
.pl-line__chevron { color: var(--fg-faint); transition: transform var(--dur-fast) var(--ease-out); }
.pl-line__chevron.is-open { transform: rotate(90deg); }
.pl-line__name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--fg-muted); font-weight: 560; }
.pl-line__count { color: var(--fg-faint); font-size: var(--text-xs); font-variant-numeric: tabular-nums; }
.pl-line__note { color: var(--fg-faint); }
.pl-line__add { display: grid; place-items: center; width: 22px; height: 22px; border-radius: var(--radius-xs); color: var(--fg-subtle); opacity: 0; }
.pl-line__add :deep(svg) { width: 14px; height: 14px; stroke-width: 1.75; }
.pl-tr--group:hover .pl-line__add, .pl-line.is-active .pl-line__add { opacity: 1; }
.pl-line__add:hover { background: var(--bg-hover); color: var(--fg); }
.pl-none { position: sticky; left: 0; width: calc(100cqi - 14px); margin: 0; padding: var(--space-6); text-align: center; color: var(--fg-subtle); }

/* ---------- dragging ---------- */
.pl-dropline { position: absolute; z-index: 3; left: 0; right: 0; height: 2px; background: var(--accent); pointer-events: none; transition: top var(--dur-fast) var(--ease-out); }
.pl-colline { position: absolute; z-index: 4; top: 0; bottom: 0; width: 2px; background: var(--accent); pointer-events: none; transition: left var(--dur-fast) var(--ease-out); }
.is-dragging .pl-tr { pointer-events: none; }
@media (prefers-reduced-motion: reduce) {
  .pl-line__chevron, .pl-th, .pl-line, .pl-dropline, .pl-colline { transition: none; }
}
</style>
