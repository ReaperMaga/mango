<script setup lang="ts">
import { computed, nextTick, onBeforeUpdate, onUpdated, ref, shallowRef, useId, watch } from 'vue'
import { usePlanner } from '../../context.ts'
import type { PluginMenuRow } from '../../host.ts'
import { itemMenu } from '../../item/itemMenu.ts'
import { hasOptions, isGroupable, itemWord, type Collection, type Color, type Item, type View } from '../../model.ts'
import type { Position } from '../../order.ts'
import { NO_GROUP, type Group, type QueryResult } from '../../query.ts'
import { strings as shared } from '../../strings.ts'
import ColorPicker from '../../ui/ColorPicker.vue'
import Icon from '../../ui/Icon.vue'
import { captureMoves } from '../../ui/motion.ts'
import OptionTag from '../../ui/OptionTag.vue'
import Popover from '../../ui/Popover.vue'
import PropertyIcon from '../../ui/PropertyIcon.vue'
import DeleteOption from '../../values/DeleteOption.vue'
import { editProperty } from '../../values/editProperty.ts'
import { optionWords } from '../../values/optionWords.ts'
import BoardCard from './BoardCard.vue'
import BoardColumn from './BoardColumn.vue'
import { cardKey, isSamePlace, positionAt, stepIndex, type CardRef } from './cards.ts'
import InlineInput from './InlineInput.vue'
import { strings } from './strings.ts'
import { useBoardDrag, type CardTarget, type Drag } from './useBoardDrag.ts'

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
const { store, mango } = planner
const { Button, IconButton } = mango.ui.components

/* ---------------------------------------------------------------- columns */

const property = computed(() => props.result.groupBy)
/** "No status" only while something is in it, or there is nowhere else. */
const shownGroups = computed(() => {
  const shown = props.result.groups.filter(g => !g.hidden)
  const rest = shown.filter(g => g.key !== NO_GROUP || g.items.length)
  return rest.length ? rest : shown
})
const hiddenGroups = computed(() => props.result.groups.filter(g => g.hidden))
const groupByKey = computed(() => new Map(props.result.groups.map(g => [g.key, g])))
const isOption = (g: Group) => g.key !== NO_GROUP && !!property.value && hasOptions(property.value)
const canAddGroup = computed(() => !props.readonly && !!property.value && hasOptions(property.value))
const manual = computed(() => props.view.sorts.length === 0)

function nameOf(g: Group): string {
  if (isOption(g)) return g.name || shared.untitled
  if (g.key === NO_GROUP) return shared.noGroup(property.value?.name ?? '')
  return g.key === 'true' ? shared.checked : shared.unchecked
}
const groupName = (key: string) => {
  const g = groupByKey.value.get(key)
  return g ? nameOf(g) : ''
}
const titleOf = (id: string) => store.item(props.collection.id, id)?.title || shared.untitled
const wordOf = (n: number) => itemWord(props.collection, n)
const whatOf = (ids: readonly string[]) => (ids.length === 1 ? titleOf(ids[0]!) : `${ids.length} ${wordOf(ids.length)}`)

const without = (list: readonly string[], key: string) => list.filter(k => k !== key)
function setCollapsed(key: string, on: boolean) {
  const rest = without(props.view.collapsedGroups, key)
  store.updateView(props.collection.id, props.view.id, { collapsedGroups: on ? [...rest, key] : rest })
}
function setHidden(key: string, on: boolean) {
  const rest = without(props.view.hiddenGroups, key)
  store.updateView(props.collection.id, props.view.id, { hiddenGroups: on ? [...rest, key] : rest })
}
/* The focus goes on from what was there, after the menu has given it back. */
function collapse(key: string) {
  setCollapsed(key, true)
  setTimeout(() => focusInColumn(key, 0))
}
async function expand(key: string) {
  setCollapsed(key, false)
  await nextTick()
  focusInColumn(key, 0)
}
function hide(key: string) {
  const next = neighbourColumn(key, 1) ?? neighbourColumn(key, -1)
  setHidden(key, true)
  if (next !== null) setTimeout(() => focusInColumn(next, 0))
}

const renaming = ref<string | null>(null)
const addingGroup = ref(false)
const colouring = shallowRef<{ key: string; anchor: HTMLElement } | null>(null)

/** Options a column can be dragged among: the ones on screen, in order. */
const sortable = computed(() => (props.readonly ? [] : shownGroups.value.filter(isOption)))

/** Puts a column at an index among the other ones on screen. */
function moveColumn(key: string, index: number) {
  const p = property.value
  const rest = sortable.value.filter(g => g.key !== key)
  const from = sortable.value.findIndex(g => g.key === key)
  if (!p || from < 0 || from === index) return
  const next = rest[index]
  const last = rest.at(-1)
  if (!last) return
  const play = captureMoves(board.value, '[data-col]', el => el.dataset.col!)
  store.moveOption(props.collection.id, p.id, key, next ? { before: next.key } : { after: last.key })
  void nextTick(play)
  announce(strings.columnMoved(groupName(key), index + 1, rest.length + 1))
}

function columnMenu(g: Group, anchor: HTMLElement) {
  const p = property.value
  if (!p) return
  const at = sortable.value.findIndex(e => e.key === g.key)
  const rows: PluginMenuRow[] = []
  if (isOption(g) && !props.readonly) {
    rows.push(
      { label: strings.rename, icon: 'pencil', onSelect: () => { renaming.value = g.key } },
      // Once the menu has given the focus back.
      { label: strings.colour, icon: 'palette', onSelect: () => void setTimeout(() => { colouring.value = { key: g.key, anchor } }) },
      ...(p.type === 'select' ? [{
        label: strings.setDefault(wordOf(2)),
        icon: 'circle-dot',
        checked: p.defaultOption === g.key,
        onSelect: () => store.updateProperty(props.collection.id, p.id, { defaultOption: p.defaultOption === g.key ? null : g.key }),
      }] : []),
      { label: strings.moveLeft, icon: 'arrow-left', disabled: at <= 0, divider: true, onSelect: () => moveColumn(g.key, at - 1) },
      { label: strings.moveRight, icon: 'arrow-right', disabled: at < 0 || at === sortable.value.length - 1, onSelect: () => moveColumn(g.key, at + 1) },
    )
  }
  // How a view looks is kept like the rest of it, so it needs writing too.
  rows.push(
    { label: strings.collapse, icon: 'chevrons-right-left', divider: rows.length > 0, disabled: props.readonly, onSelect: () => collapse(g.key) },
    { label: strings.hide, icon: 'eye-off', disabled: props.readonly, onSelect: () => hide(g.key) },
  )
  if (!props.readonly && hasOptions(p)) {
    rows.push({ label: strings.editGroups(optionWords(p).many), icon: 'list', divider: true, onSelect: () => void setTimeout(() => editProperty(planner, props.collection.id, p.id)) })
  }
  if (isOption(g) && !props.readonly) {
    rows.push({ label: strings.deleteGroup, icon: 'trash-2', danger: true, onSelect: () => void setTimeout(() => { deleting.value = { key: g.key, anchor } }) })
  }
  void mango.ui.contextMenu(anchor, rows)
}

/** Asks where its items go when it has some. */
const deleting = shallowRef<{ key: string; anchor: HTMLElement } | null>(null)
let goes: string | null = null
function closeDelete() {
  goes = deleting.value?.key ?? null
  deleting.value = null
}
watch(() => props.result.groups, (groups) => {
  if (goes === null || groups.some(g => g.key === goes)) return
  goes = null
  if (document.activeElement === document.body) focus()
}, { flush: 'post' })

function renameGroup(key: string, name: string) {
  if (property.value?.options.some(o => o.id === key) && name !== groupName(key)) store.updateOption(props.collection.id, property.value.id, key, { name })
}
/** While a colour is picked it shows; it is written once that is settled. */
function setColour(color: Color) {
  const key = colouring.value?.key
  if (key && property.value) store.updateOption(props.collection.id, property.value.id, key, { color }, { defer: 'hold' })
}
function closeColours() {
  const at = colouring.value?.anchor
  colouring.value = null
  // The popover opened before the menu had given the focus back.
  void nextTick(() => {
    if (document.activeElement === document.body) at?.focus()
  })
}
async function addGroup(name: string) {
  if (!property.value) return
  const option = store.addOption(props.collection.id, property.value.id, name)
  if (option && props.view.hiddenGroups.includes(option.id)) setHidden(option.id, false)
  await nextTick()
  if (board.value) board.value.scrollLeft = board.value.scrollWidth
  // Its colour next; the one it got stays when that is closed.
  const anchor = option && columnEl(option.id)?.querySelector<HTMLElement>('[data-menu]')
  if (anchor) {
    anchor.focus({ preventScroll: true })
    colouring.value = { key: option.id, anchor }
  }
}

/** Closing an inline field by key gives the focus back to what it stands in for. */
async function stopAddGroup(byKey: boolean) {
  addingGroup.value = false
  await nextTick()
  if (byKey && !colouring.value) board.value?.querySelector<HTMLElement>('[data-add-group]')?.focus()
}
async function stopRename(byKey: boolean) {
  const key = renaming.value
  renaming.value = null
  await nextTick()
  if (byKey && key) columnEl(key)?.querySelector<HTMLElement>('[data-menu]')?.focus()
}

/* ---- without a property to group by */

const groupable = computed(() => props.collection.properties.filter(isGroupable))
function groupBy(propertyId: string) {
  store.updateView(props.collection.id, props.view.id, { groupBy: propertyId })
  void nextTick(focus)
}
function createStatus() {
  const t = shared.template
  const p = store.addProperty(props.collection.id, {
    name: t.status,
    type: 'select',
    options: [{ name: t.toDo, color: 'neutral' }, { name: t.inProgress, color: 'blue' }, { name: t.done, color: 'green' }],
  })
  if (p) groupBy(p.id)
}

/* ---------------------------------------------------------------- elements */

const board = ref<HTMLElement>()
const columnViews = new Map<string, InstanceType<typeof BoardColumn>>()
const setColumn = (key: string, c: unknown) => {
  if (c) columnViews.set(key, c as InstanceType<typeof BoardColumn>)
  else columnViews.delete(key)
}
const columnEl = (key: string) => board.value?.querySelector<HTMLElement>(`[data-col="${CSS.escape(key)}"]`) ?? null
const cardEl = (c: CardRef) => columnEl(c.group)?.querySelector<HTMLElement>(`[data-card="${CSS.escape(c.id)}"]`) ?? null
const cardOf = (target: EventTarget | null): CardRef | null => {
  const el = (target as HTMLElement | null)?.closest<HTMLElement>('[data-card]')
  return el ? { id: el.dataset.card!, group: el.dataset.group! } : null
}

const message = ref('')
function announce(text: string) {
  // The same words again are still news.
  message.value = message.value === text ? `${text} ` : text
}

/* ---------------------------------------------------------------- focus */

/** The card Tab goes to. With its index, for when it is gone. */
const focused = shallowRef<(CardRef & { index: number }) | null>(null)
/** The focus is on that card, as far as anyone told. */
let hasFocus = false

const itemsIn = (group: string): readonly Item[] => groupByKey.value.get(group)?.items ?? []
const indexOf = (c: CardRef) => itemsIn(c.group).findIndex(i => i.id === c.id)
const openGroups = computed(() => shownGroups.value.filter(g => !g.collapsed))
const focusKey = computed(() => {
  const f = focused.value
  if (f && openGroups.value.some(g => g.key === f.group && g.items.some(i => i.id === f.id))) return cardKey(f)
  const first = openGroups.value.find(g => g.items.length)
  return first ? cardKey({ group: first.key, id: first.items[0]!.id }) : null
})

async function focusCard(c: CardRef) {
  const index = indexOf(c)
  if (index < 0) return
  focused.value = { id: c.id, group: c.group, index }
  columnViews.get(c.group)?.reveal(index)
  await nextTick()
  const el = cardEl(c)
  el?.focus({ preventScroll: true })
  el?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
}

/** The card at this index of a column, or the nearest; its "New item" when it has none. */
function focusInColumn(key: string, index: number) {
  const g = groupByKey.value.get(key)
  if (!g) return
  const item = g.collapsed ? undefined : g.items[Math.max(0, Math.min(index, g.items.length - 1))]
  if (item) return void focusCard({ id: item.id, group: key })
  const el = columnEl(key)?.querySelector<HTMLElement>('[data-strip], [data-new]')
  el?.focus({ preventScroll: true })
  columnEl(key)?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
}

function onFocusIn(e: FocusEvent) {
  const c = cardOf(e.target)
  hasFocus = !!c
  if (c) focused.value = { ...c, index: indexOf(c) }
}
function onFocusOut(e: FocusEvent) {
  // Without a place it goes to, the card may have been taken away with it: `onUpdated` looks.
  if (e.relatedTarget) hasFocus = false
}

let restoring: (CardRef & { index: number }) | null = null
onBeforeUpdate(() => {
  restoring = hasFocus && document.activeElement && board.value?.contains(document.activeElement) ? focused.value : null
})
onUpdated(() => {
  const f = restoring
  restoring = null
  if (!f || (document.activeElement && document.activeElement !== document.body)) return
  if (indexOf(f) >= 0) return void focusCard(f)
  // It went to another column, or away.
  const elsewhere = openGroups.value.find(g => g.items.some(i => i.id === f.id))
  if (elsewhere) void focusCard({ id: f.id, group: elsewhere.key })
  else focusInColumn(f.group, f.index)
})

/* ---------------------------------------------------------------- selection */

const selection = shallowRef<ReadonlyMap<string, CardRef>>(new Map())
let anchor: CardRef | null = null

/** What is still there of it, in the order of the board. */
const selectedCards = computed(() => {
  if (!selection.value.size) return []
  return shownGroups.value.flatMap(g => g.items
    .map(i => ({ id: i.id, group: g.key }))
    .filter(c => selection.value.has(cardKey(c))))
})
const selectedKeys = computed(() => new Set(selectedCards.value.map(cardKey)))

function select(cards: readonly CardRef[]) {
  selection.value = new Map(cards.map(c => [cardKey(c), { id: c.id, group: c.group }]))
}
function clearSelection() {
  anchor = null
  if (selection.value.size) select([])
}
function toggle(c: CardRef) {
  anchor = c
  const key = cardKey(c)
  select(selectedKeys.value.has(key) ? selectedCards.value.filter(s => cardKey(s) !== key) : [...selectedCards.value, c])
  announce(strings.selected(selection.value.size, wordOf(selection.value.size)))
}
/** From the anchor to this card; just adds it when they are in different columns. */
function extend(c: CardRef) {
  const items = itemsIn(c.group)
  const from = anchor?.group === c.group ? items.findIndex(i => i.id === anchor!.id) : -1
  const to = indexOf(c)
  if (from < 0) {
    anchor = c
    select([...selectedCards.value, c])
  } else {
    select([
      ...selectedCards.value.filter(s => s.group !== c.group),
      ...items.slice(Math.min(from, to), Math.max(from, to) + 1).map(i => ({ id: i.id, group: c.group })),
    ])
  }
  announce(strings.selected(selection.value.size, wordOf(selection.value.size)))
}
/** What an action on a card is about: the selection when it is part of it. */
const cardsFor = (c: CardRef): readonly CardRef[] => (selectedKeys.value.has(cardKey(c)) ? selectedCards.value : [c])
const idsOf = (cards: readonly CardRef[]) => [...new Set(cards.map(c => c.id))]

watch([() => props.collection.id, () => props.view.id], () => {
  clearSelection()
  focused.value = null
  hasFocus = false
  adding.value = null
  renaming.value = null
  addingGroup.value = false
  colouring.value = null
  deleting.value = null
})

/* ---------------------------------------------------------------- moving */

/** Moves cards into a column, at an index among its other cards (null: without a place of their own). */
function place(cards: readonly CardRef[], group: string, index: number | null): boolean {
  const p = property.value
  if (!p || props.readonly || !cards.length) return false
  const ids = idsOf(cards)
  const items = itemsIn(group)
  const inPlace = cards.every(c => c.group === group)
  const position: Position | undefined = manual.value && index !== null ? positionAt(items, new Set(ids), index) : undefined
  if (inPlace && (position === undefined || isSamePlace(items, ids, index!))) return false
  store.moveItems(props.collection.id, {
    ids,
    group: inPlace ? undefined : { propertyId: p.id, key: group, from: new Map(cards.map(c => [c.id, c.group])) },
    position,
  })
  // The selection goes along with its cards.
  const moved = cards.map(c => ({ id: c.id, group }))
  if (selection.value.size) select(moved)
  const what = whatOf(ids)
  // Once the result is the new one.
  void nextTick(() => {
    const at = indexOf({ id: ids[0]!, group })
    announce(manual.value && index !== null && at >= 0 ? strings.movedTo(what, groupName(group), at + 1, itemsIn(group).length) : strings.moved(what, groupName(group)))
  })
  return true
}

const ghost = ref<HTMLElement>()
/** Cards glide to where a change puts them, within their column. */
const cardMoves = () => captureMoves(board.value, '[data-card]', el => `${el.dataset.group}/${el.dataset.card}`)
const { drag, landing, live, cardTarget, columnTarget, onPointerDown } = useBoardDrag({
  mango,
  board,
  ghost,
  enabled: () => !props.readonly && !!property.value,
  manual: () => manual.value,
  cardsFor,
  onStart: (d) => {
    if (d.kind === 'cards' && !selectedKeys.value.has(cardKey(d.lead))) clearSelection()
    announce(strings.dragging(d.kind === 'cards' ? whatOf(idsOf(d.cards)) : groupName(d.group)))
  },
  onDropCards: (cards, target: CardTarget) => {
    const g = groupByKey.value.get(target.group)
    if (!g) return
    const ids = new Set(cards.map(c => c.id))
    const end = g.items.filter(i => !ids.has(i.id)).length
    // One card with a place of its own: the gap made its room already.
    const play = manual.value && target.index !== null && cards.length === 1 ? null : cardMoves()
    if (!place(cards, target.group, target.index ?? (manual.value ? end : null))) announce(strings.cancelled)
    else if (play) void nextTick(play)
  },
  onDropColumn: moveColumn,
  onCancel: () => announce(strings.cancelled),
  landsOn: (d: Drag, group) => {
    const column = columnEl(d.kind === 'cards' ? group ?? d.lead.group : d.group)
    if (!column) return null
    if (d.kind === 'column') return column.querySelector<HTMLElement>('[data-head]')
    return [...column.querySelectorAll<HTMLElement>('[data-card]')].find(e => e.dataset.card === d.lead.id)
      // Folded: into its strip.
      ?? column.querySelector<HTMLElement>('[data-strip]')
  },
})
const cardDrag = computed(() => (drag.value?.kind === 'cards' ? drag.value : null))
/** What the ghost shows: in hand, or on its way to its place. */
const shown = computed(() => drag.value ?? landing.value?.drag ?? null)
const leadItem = computed(() => (shown.value?.kind === 'cards' ? store.item(props.collection.id, shown.value.lead.id) : null))
const draggedGroup = computed(() => (shown.value?.kind === 'column' ? groupByKey.value.get(shown.value.group) ?? null : null))
const draggedCount = computed(() => (shown.value?.kind === 'cards' ? shown.value.ids.size : 0))
/** Out of its place; not where the sort decides, as nothing opens up elsewhere. */
const heldKey = computed(() => (cardDrag.value && manual.value ? cardKey(cardDrag.value.lead) : null))
const landingKey = computed(() => {
  const l = landing.value
  return l?.drag.kind === 'cards' ? cardKey({ id: l.drag.lead.id, group: l.group ?? l.drag.lead.group }) : null
})
/** Where room is made: under the pointer, or where the card came from while it is nowhere. */
const gap = computed(() => {
  const d = cardDrag.value
  if (!d || !manual.value) return null
  const t = cardTarget.value
  if (t) return t.index === null ? null : { group: t.group, index: t.index, height: d.height }
  const items = itemsIn(d.lead.group)
  const before = items.slice(0, Math.max(0, items.findIndex(i => i.id === d.lead.id)))
  return { group: d.lead.group, index: before.filter(i => !d.ids.has(i.id)).length, height: d.height }
})
/** An empty column shows its own place to drop. */
const gapIn = (g: Group) => (gap.value?.group === g.key && g.items.length ? gap.value : null)

function stepVertical(c: CardRef, step: -1 | 1) {
  if (!manual.value) return announce(strings.cannotOrder)
  const cards = cardsFor(c).filter(s => s.group === c.group)
  const index = stepIndex(itemsIn(c.group), new Set(cards.map(s => s.id)), step)
  if (index === null) return
  const play = cardMoves()
  if (!place(cards, c.group, index)) return
  void nextTick(play)
  void focusCard(c)
}
function stepHorizontal(c: CardRef, step: -1 | 1) {
  const next = shownGroups.value[shownGroups.value.findIndex(g => g.key === c.group) + step]
  if (!next) return
  const cards = cardsFor(c)
  const ids = new Set(cards.map(s => s.id))
  const room = next.items.filter(i => !ids.has(i.id)).length
  const play = cardMoves()
  if (!place(cards, next.key, manual.value ? Math.min(Math.max(0, indexOf(c)), room) : null)) return
  void nextTick(play)
  if (next.collapsed) void nextTick(() => focusInColumn(next.key, 0))
  else void focusCard({ id: c.id, group: next.key })
}

/* ---------------------------------------------------------------- new items */

const adding = shallowRef<{ group: string; at: 'top' | 'end' } | null>(null)

function startAdd(group: string, at: 'top' | 'end') {
  if (props.readonly) return
  const g = groupByKey.value.get(group)
  if (g?.collapsed) setCollapsed(group, false)
  adding.value = { group, at }
  const column = columnViews.get(group)
  void (at === 'top' ? column?.toTop() : column?.toEnd())
}
async function stopAdd(byKey: boolean) {
  const was = adding.value
  adding.value = null
  if (!byKey || !was) return
  await nextTick()
  focusInColumn(was.group, was.at === 'top' ? 0 : Infinity)
}
async function add(title: string, group: string, at: 'top' | 'end') {
  const first = itemsIn(group)[0]
  const last = itemsIn(group).at(-1)
  const collectionId = props.collection.id
  const name = groupName(group)
  const position: Position = at === 'top' ? (first ? { before: first.id } : 'start') : (last ? { after: last.id } : 'end')
  const item = await store.createItem(collectionId, { title, viewId: props.view.id, group, position })
  if (!item || collectionId !== props.collection.id) return
  await nextTick()
  if (props.result.items.some(i => i.id === item.id)) return announce(strings.added(title, name))
  mango.ui.toast({
    title: strings.addedHidden(title),
    body: strings.addedHiddenBody,
    action: { label: strings.open, run: () => planner.go({ collectionId, itemId: item.id }) },
  })
}

/** At the top of the first group with a name, or the first there is. */
function newItem() {
  if (props.readonly) return
  const g = openGroups.value.find(e => e.key !== NO_GROUP) ?? openGroups.value[0] ?? shownGroups.value[0]
  if (!g || !property.value) return
  startAdd(g.key, 'top')
  void nextTick(() => columnEl(g.key)?.scrollIntoView({ block: 'nearest', inline: 'nearest' }))
}

/* ---------------------------------------------------------------- pointer and keys */

function onClick(e: MouseEvent) {
  const c = cardOf(e.target)
  if (!c) {
    if (!(e.target as HTMLElement).closest('button, input, a')) clearSelection()
    return
  }
  if ((e.target as HTMLElement).closest('a, button')) return
  if (e.shiftKey) return extend(c)
  if (e.ctrlKey || e.metaKey) return toggle(c)
  clearSelection()
  anchor = c
  emit('open', c.id)
}

function openMenu(c: CardRef, at: { x: number; y: number } | HTMLElement) {
  if (!selectedKeys.value.has(cardKey(c))) clearSelection()
  const ids = idsOf(cardsFor(c))
  const after = neighbourOf(c, ids)
  void itemMenu(planner, props.collection, ids, at, {
    open: id => emit('open', id),
    propertyId: property.value?.id,
    deleted: () => {
      clearSelection()
      // Once the menu has given the focus back.
      setTimeout(after)
    },
  })
}

/** Focuses what takes the place of a card, when it and the others are gone. */
function neighbourOf(c: CardRef, ids: readonly string[]): () => void {
  const gone = new Set(ids)
  const items = itemsIn(c.group)
  const index = indexOf(c)
  const next = items.slice(index).find(i => !gone.has(i.id)) ?? items.slice(0, index).findLast(i => !gone.has(i.id))
  return () => (next ? void focusCard({ id: next.id, group: c.group }) : focusInColumn(c.group, 0))
}
function onContextMenu(e: MouseEvent) {
  const c = cardOf(e.target)
  const head = (e.target as HTMLElement).closest<HTMLElement>('[data-head]')
  if (c) {
    e.preventDefault()
    // The Menu key comes without a place.
    openMenu(c, e.clientX || e.clientY ? { x: e.clientX, y: e.clientY } : cardEl(c)!)
  } else if (head && !(e.target as HTMLElement).closest('input')) {
    const g = groupByKey.value.get(head.closest<HTMLElement>('[data-col]')?.dataset.col ?? '')
    if (!g || g.collapsed) return
    e.preventDefault()
    columnMenu(g, head.querySelector<HTMLElement>('[data-menu]') ?? head)
  }
}

function neighbourColumn(group: string, step: -1 | 1): string | null {
  return shownGroups.value[shownGroups.value.findIndex(g => g.key === group) + step]?.key ?? null
}

/** Answers whether the key was for the board. */
function onCardKey(e: KeyboardEvent, c: CardRef): boolean {
  const mod = e.ctrlKey || e.metaKey
  const index = indexOf(c)
  const items = itemsIn(c.group)
  if (e.altKey && e.shiftKey && !mod) {
    if (e.key === 'ArrowUp') stepVertical(c, -1)
    else if (e.key === 'ArrowDown') stepVertical(c, 1)
    else if (e.key === 'ArrowLeft') stepHorizontal(c, -1)
    else if (e.key === 'ArrowRight') stepHorizontal(c, 1)
    else return false
    return true
  }
  if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey && !mod && !e.altKey)) {
    const el = cardEl(c)
    if (el) openMenu(c, el)
    return true
  }
  if (e.altKey) return false
  if (mod) {
    if (e.key.toLowerCase() !== 'a' || e.shiftKey) return false
    select(openGroups.value.flatMap(g => g.items.map(i => ({ id: i.id, group: g.key }))))
    announce(strings.selected(selectedCards.value.length, wordOf(selectedCards.value.length)))
    return true
  }
  switch (e.key) {
    case 'ArrowUp':
    case 'ArrowDown': {
      const next = items[index + (e.key === 'ArrowUp' ? -1 : 1)]
      if (!next) {
        if (e.key === 'ArrowDown' && !e.shiftKey) columnEl(c.group)?.querySelector<HTMLElement>('[data-foot]')?.focus()
        return true
      }
      const to = { id: next.id, group: c.group }
      if (e.shiftKey) {
        if (anchor?.group !== c.group || !selectedKeys.value.size) anchor = c
        extend(to)
      }
      void focusCard(to)
      return true
    }
    case 'ArrowLeft':
    case 'ArrowRight': {
      const key = neighbourColumn(c.group, e.key === 'ArrowLeft' ? -1 : 1)
      if (key !== null) focusInColumn(key, index)
      return true
    }
    case 'Home': focusInColumn(c.group, 0); return true
    case 'End': focusInColumn(c.group, Infinity); return true
    case 'Enter': emit('open', c.id); return true
    case ' ': toggle(c); return true
    case 'Escape':
      if (!selection.value.size) return false
      clearSelection()
      return true
    case 'Delete':
      if (!props.readonly) {
        const ids = idsOf(cardsFor(c))
        const after = neighbourOf(c, ids)
        clearSelection()
        // The store offers to undo it.
        store.deleteItems(props.collection.id, ids)
        void nextTick(after)
      }
      return true
    case 'n':
    case 'N':
      startAdd(c.group, 'top')
      return true
    default: return false
  }
}

/** On a column's "New item", or a collapsed column. */
function onEdgeKey(e: KeyboardEvent, group: string): boolean {
  if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return false
  switch (e.key) {
    case 'ArrowUp':
      if (itemsIn(group).length) focusInColumn(group, Infinity)
      else columnEl(group)?.querySelector<HTMLElement>('[data-new]')?.focus()
      return true
    case 'ArrowDown':
      columnEl(group)?.querySelector<HTMLElement>('[data-foot]')?.focus()
      return true
    case 'ArrowLeft':
    case 'ArrowRight': {
      const key = neighbourColumn(group, e.key === 'ArrowLeft' ? -1 : 1)
      if (key !== null) focusInColumn(key, (e.target as HTMLElement).hasAttribute('data-foot') ? Infinity : 0)
      return true
    }
    case 'n':
    case 'N': startAdd(group, 'top'); return true
    default: return false
  }
}

function onKey(e: KeyboardEvent) {
  if (e.defaultPrevented || e.isComposing || drag.value) return
  const c = cardOf(e.target)
  const edge = (e.target as HTMLElement).closest<HTMLElement>('[data-new], [data-strip]')
  // A link on a card has its own Enter.
  const inner = c && e.target !== cardEl(c)
  const handled = inner ? false : c ? onCardKey(e, c) : edge ? onEdgeKey(e, edge.dataset.group!) : false
  if (!handled) return
  e.preventDefault()
  e.stopPropagation()
}

function focus() {
  const el = board.value?.querySelector<HTMLElement>('[data-card][tabindex="0"]') ?? board.value?.querySelector<HTMLElement>('[data-new], [data-strip]') ?? board.value?.querySelector<HTMLElement>('button')
  el?.focus({ preventScroll: true })
}

defineExpose({ newItem, focus })

const pickId = useId()
</script>

<template>
  <div v-if="!property" class="pl-setup">
    <div class="pl-setup__box">
      <h3 :id="pickId" class="pl-setup__title">{{ strings.groupTitle }}</h3>
      <p class="pl-setup__body">{{ strings.groupBody }}</p>
      <div v-if="!readonly" class="pl-setup__list" role="group" :aria-labelledby="pickId">
        <button v-for="p in groupable" :key="p.id" type="button" class="pl-setup__row" @click="groupBy(p.id)"><PropertyIcon :type="p.type" /><span>{{ p.name }}</span></button>
      </div>
      <component :is="Button" v-if="!readonly" :variant="groupable.length ? 'secondary' : 'primary'" @click="createStatus">
        <Icon name="plus" />{{ strings.createStatus }}
      </component>
    </div>
  </div>

  <div v-else class="pl-board">
    <div
      ref="board"
      class="pl-board__scroll"
      role="group"
      :aria-label="strings.board(collection.name)"
      @pointerdown="onPointerDown"
      @click="onClick"
      @contextmenu="onContextMenu"
      @keydown="onKey"
      @focusin="onFocusIn"
      @focusout="onFocusOut"
    >
      <BoardColumn
        v-for="g in shownGroups"
        :key="g.key"
        :ref="c => setColumn(g.key, c)"
        :class="{ 'is-dragged': drag?.kind === 'column' && drag.group === g.key }"
        :collection="collection"
        :view="view"
        :group="g"
        :name="nameOf(g)"
        :sortable="isOption(g) && !readonly"
        :readonly="readonly"
        :open-item-id="openItemId"
        :selected="selectedKeys"
        :moving="cardDrag?.keys ?? null"
        :held-key="heldKey"
        :landing-key="landingKey"
        :moving-ids="cardDrag?.ids ?? null"
        :live="live"
        :gap="gapIn(g)"
        :focus-key="focusKey"
        :adding="adding?.group === g.key ? adding.at : null"
        :renaming="renaming === g.key"
        :over="cardTarget?.group === g.key"
        @add="(title, at) => add(title, g.key, at)"
        @start-add="startAdd(g.key, $event)"
        @stop-add="stopAdd"
        @menu="columnMenu(g, $event)"
        @rename="renameGroup(g.key, $event)"
        @stop-rename="stopRename"
        @expand="expand(g.key)"
      />

      <div v-if="hiddenGroups.length || canAddGroup" class="pl-board__end">
        <div v-if="canAddGroup" class="pl-board__add">
          <InlineInput v-if="addingGroup" single :label="strings.groupName" :placeholder="strings.groupName" @add="addGroup" @close="stopAddGroup" />
          <button v-else type="button" class="pl-board__addbtn" data-add-group @click="addingGroup = true"><Icon name="plus" />{{ strings.addGroup(optionWords(property).one) }}</button>
        </div>
        <template v-if="hiddenGroups.length">
          <h3 class="pl-board__hidden">{{ strings.hidden }}</h3>
          <div v-for="g in hiddenGroups" :key="g.key" class="pl-board__row">
            <span class="pl-board__name" :title="nameOf(g)">
              <OptionTag v-if="isOption(g)" :option="g" />
              <template v-else>{{ nameOf(g) }}</template>
            </span>
            <span class="pl-board__count">{{ g.items.length }}</span>
            <component :is="IconButton" v-if="!readonly" size="sm" :label="strings.showGroup(nameOf(g))" @click="setHidden(g.key, false)"><Icon name="eye" /></component>
          </div>
        </template>
      </div>

      <div v-if="columnTarget" class="pl-board__line" :style="{ transform: `translateX(${columnTarget.x}px)` }" />
    </div>

    <div class="sr-only" role="status" aria-live="polite">{{ message }}</div>

    <Popover v-if="colouring" :anchor="colouring.anchor" :width="240" :label="strings.colourOf(groupName(colouring.key))" placement="bottom-end" @close="closeColours">
      <ColorPicker
        :model-value="groupByKey.get(colouring.key)?.color ?? 'neutral'"
        :label="strings.colourOf(groupName(colouring.key))"
        @update:model-value="setColour"
        @change="store.flush()"
      />
    </Popover>
    <DeleteOption v-if="deleting" :collection-id="collection.id" :property-id="property.id" :option-id="deleting.key" :anchor="deleting.anchor" @close="closeDelete" />

    <Teleport to="body">
      <div v-if="shown" ref="ghost" class="pl-ghost" :style="{ width: `${shown.width}px` }" aria-hidden="true">
        <div v-if="leadItem" class="pl-ghost__card" :class="{ 'is-stack': draggedCount > 1, 'is-up': live }" :style="{ transformOrigin: `${shown.dx}px ${shown.dy}px` }">
          <BoardCard :collection="collection" :view="view" :item="leadItem" />
          <span v-if="draggedCount > 1" class="pl-ghost__count">{{ draggedCount }}</span>
        </div>
        <div v-else-if="draggedGroup" class="pl-ghost__head">
          <OptionTag :option="draggedGroup" /><span class="pl-board__count">{{ draggedGroup.items.length }}</span>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.pl-board { position: relative; height: 100%; min-height: 0; min-width: 0; container-type: size; }
.pl-board__scroll {
  position: relative;
  display: flex;
  align-items: flex-start;
  gap: 8px;
  height: 100%;
  padding: var(--space-2);
  overflow: auto hidden;
}
.pl-board__scroll > .is-dragged { opacity: 0.45; }
.pl-board__line {
  position: absolute;
  top: 8px;
  bottom: 8px;
  left: -1px;
  width: 2px;
  border-radius: 2px;
  background: var(--accent);
  pointer-events: none;
  transition: transform var(--dur-fast) var(--ease-out);
}
.pl-board__end { flex: none; width: min(290px, calc(100cqw - 32px)); max-height: 100%; overflow: hidden auto; }
.pl-board__addbtn {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  height: 40px;
  padding: 0 14px;
  border: 1px dashed var(--line);
  border-radius: 10px;
  font-size: var(--text-sm);
  color: var(--fg-subtle);
  white-space: nowrap;
  transition: border-color var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out);
}
.pl-board__add > .pl-inline { height: 40px; border-radius: 10px; }
.pl-board__addbtn :deep(svg) { width: 14px; height: 14px; }
.pl-board__addbtn:hover { border-color: var(--line-strong); color: var(--fg); }
.pl-board__addbtn:focus-visible { outline-offset: -2px; border-radius: 10px; }
.pl-board__hidden { margin: var(--space-3) 0 2px; padding: 0 8px; font-size: var(--text-xs); font-weight: 600; color: var(--fg-subtle); }
.pl-board__hidden:first-child { margin-top: 5px; }
.pl-board__row { display: flex; align-items: center; gap: 6px; min-height: 28px; padding: 0 4px 0 8px; border-radius: var(--radius-sm); }
.pl-board__row:hover { background: var(--bg-hover); }
.pl-board__name { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--text-xs); color: var(--fg-subtle); }
.pl-board__count { flex: 1; font-size: var(--text-xs); color: var(--fg-faint); font-variant-numeric: tabular-nums; }

.pl-setup { height: 100%; overflow: auto; padding: 12vh var(--space-4) var(--space-4); }
.pl-setup__box { max-width: 320px; margin: 0 auto; display: flex; flex-direction: column; align-items: flex-start; }
.pl-setup__title { margin: 0; font-size: var(--text-lg); font-weight: 620; letter-spacing: -0.01em; }
.pl-setup__body { margin: 4px 0 var(--space-4); font-size: var(--text-sm); color: var(--fg-subtle); }
.pl-setup__list { width: 100%; margin-bottom: var(--space-3); }
.pl-setup__list:empty { display: none; }
.pl-setup__row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-height: 32px;
  margin-left: -8px;
  padding: 0 8px;
  border-radius: var(--radius-sm);
  font-size: var(--text-sm);
  text-align: left;
  color: var(--fg-muted);
}
.pl-setup__row > span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pl-setup__row:hover { background: var(--bg-hover); color: var(--fg); }

/* Lies over the whole window while something is dragged. */
.pl-ghost { position: fixed; left: 0; top: 0; z-index: 60; pointer-events: none; will-change: transform; }
.pl-ghost__card { position: relative; border-radius: var(--radius-md); transition: transform var(--dur-med) var(--ease-out), box-shadow var(--dur-med) var(--ease-out); }
.pl-ghost__card.is-up { transform: rotate(1.2deg) scale(1.02); box-shadow: var(--shadow-pop); }
.pl-ghost__card :deep(.pl-card) { position: relative; background: var(--bg-raised); border-color: var(--line-strong); }
.pl-ghost__card.is-stack::before {
  content: '';
  position: absolute;
  inset: 5px -5px -5px 5px;
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-md);
  background: var(--bg-panel);
}
.pl-ghost__count {
  position: absolute;
  top: -8px;
  right: -10px;
  min-width: 20px;
  padding: 0 6px;
  border-radius: var(--radius-pill);
  background: var(--accent);
  color: var(--accent-fg);
  font-size: var(--text-2xs);
  font-weight: 600;
  line-height: 18px;
  text-align: center;
  font-variant-numeric: tabular-nums;
}
.pl-ghost__head {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 100%;
  height: 32px;
  padding: 0 10px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--bg-raised);
  box-shadow: var(--shadow-pop);
}
</style>
