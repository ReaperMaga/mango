/**
 * The planner's state, made once per activation: reactive to read, and the only way to change anything.
 *
 * Every change is a list of source operations. It shows at once (an overlay on what the source last said), is
 * written in order, and is taken back with a toast when the write fails. Typed text (`defer`) is written after a
 * pause, and stays on screen when it cannot be saved. Destructive changes and edits can be undone.
 *
 * Models are immutable and replaced on change, so a `computed` over them is enough to follow everything.
 */

import { computed, ref, shallowReactive, shallowRef, type ComputedRef, type Ref, type ShallowRef } from 'vue'
import { convertProperty } from './convert.ts'
import { parseCsv, planImport, toCsv, toMarkdown } from './csv.ts'
import { LocalSource } from './data/local.ts'
import { SourceError, type PlannerSource, type SourceDoc, type SourceOp, type SourceStatus } from './data/source.ts'
import type { MangoPluginApi } from './host.ts'
import {
  colorAt, isGroupable, isInScope, itemWord, newId, normalizeCollection, normalizeItem, ordered, projectKey, propertyOf,
  storedValue, TITLE, viewOf, type Collection, type Color, type Item, type Option, type Property, type PropertyType,
  type ProjectIdentity, type Scope, type Value, type View,
} from './model.ts'
import { between, manyBetween, placeAt, spread, type Position } from './order.ts'
import { applyPatch, entriesById, invertPatch, isObject, readPath, sameJson, type Json, type JsonObject, type Patch, type PatchOp } from './patch.ts'
import { defaultValues, valueForGroup } from './query.ts'
import { strings } from './strings.ts'
import { propertyData, templateData, viewData, type NewProperty, type NewView, type TemplateId } from './templates.ts'

/* ---------------------------------------------------------------- types */

export type LoadStatus = 'idle' | 'loading' | 'ready' | 'error'

/** A collection's items. Reactive: read it in a computed. */
export interface ItemsState {
  readonly status: LoadStatus
  readonly error: string | null
  /** In manual order. */
  readonly items: readonly Item[]
}

export interface NewCollection {
  name?: string
  template?: TemplateId
  /** The active project's when left out (everywhere when there is none). */
  scope?: Scope
  icon?: string
  color?: Color
}
export type CollectionChange = Partial<Pick<Collection, 'name' | 'icon' | 'color' | 'scope' | 'description' | 'itemName'>>
export type PropertyChange = Partial<Pick<Property, 'name' | 'defaultOption'>>

export interface NewItem {
  title?: string
  icon?: string | null
  body?: string
  /** By property id. Over what the view's group and filter ask for. */
  values?: Readonly<Record<string, Value | null>>
  chats?: readonly string[]
  /** Makes the item show up in this view (and group of it). */
  viewId?: string
  group?: string
  /** Default `end`. */
  position?: Position
}
export interface ItemChange {
  title?: string
  icon?: string | null
  body?: string
  /** Only the properties named; null empties one. */
  values?: Readonly<Record<string, Value | null>>
}
export interface ChangeOptions {
  /**
   * For text while it is typed: written after a pause (or `flush`), one undo step per pause. `hold`: only at `flush`
   * or the next other change, for a drag, which may rest anywhere.
   */
  defer?: boolean | 'hold'
}

export interface Move {
  /** Moved together, in this sequence. */
  ids: readonly string[]
  /** Into this group of a property. `from`: the group they were dragged out of, for all or by id (a multi-select keeps its others). */
  group?: { propertyId: string; key: string; from?: string | ReadonlyMap<string, string> }
  /** Left out: the manual order stays (a sorted view). */
  position?: Position
}

export type ViewChange = Partial<Pick<View,
  'name' | 'type' | 'groupBy' | 'hiddenGroups' | 'collapsedGroups' | 'sorts' | 'filter' | 'columns' | 'widths' | 'cardPreview'>>

export interface PlannerStore {
  /* ---- reading */
  /** Of loading the collections. */
  readonly status: Readonly<Ref<LoadStatus>>
  readonly error: Readonly<Ref<string | null>>
  readonly sourceStatus: Readonly<Ref<SourceStatus>>
  readonly projectPath: Readonly<Ref<string | null>>
  /** Every collection there is, other projects' too, in order. */
  readonly allCollections: Readonly<Ref<readonly Collection[]>>
  /** The active project's and the ones shown everywhere, in order. */
  readonly collections: ComputedRef<readonly Collection[]>
  /** This minute, for filters about today. */
  readonly now: Readonly<Ref<number>>
  /** Typed text is waiting to be written, or writes are under way. */
  readonly saving: Readonly<Ref<boolean>>
  collection(id: string | null | undefined): Collection | null
  /** Starts loading them if needed (safe in a computed); see `status`. */
  items(collectionId: string): ItemsState
  item(collectionId: string, itemId: string): Item | null
  /** Loaded items a chat is linked to. */
  itemsForChat(threadId: string): Item[]
  /** Loads the collections (again, after an error). */
  load(): Promise<void>
  /** Loads a collection's items (again, after an error); false when they could not be read. */
  loadItems(collectionId: string): Promise<boolean>

  /* ---- collections */
  createCollection(input?: NewCollection): Collection | null
  updateCollection(id: string, change: CollectionChange, options?: ChangeOptions): void
  moveCollection(id: string, position: Position): void
  duplicateCollection(id: string, options?: { items?: boolean }): Promise<Collection | null>
  deleteCollection(id: string): Promise<boolean>

  /* ---- items */
  createItem(collectionId: string, input?: NewItem): Promise<Item | null>
  updateItem(collectionId: string, itemId: string, change: ItemChange, options?: ChangeOptions): void
  updateItems(collectionId: string, itemIds: readonly string[], change: ItemChange): void
  /** Each item its own change, with options they need (by property), as one step to undo. */
  updateEach(collectionId: string, changes: ReadonlyMap<string, ItemChange>, newOptions?: ReadonlyMap<string, readonly Option[]>): void
  /** Group and position as one change. */
  moveItems(collectionId: string, move: Move): void
  duplicateItems(collectionId: string, itemIds: readonly string[]): Item[]
  /** Shows a toast with Undo. */
  deleteItems(collectionId: string, itemIds: readonly string[]): void
  linkChat(collectionId: string, itemId: string, threadId: string): void
  unlinkChat(collectionId: string, itemId: string, threadId: string): void

  /* ---- properties and options */
  addProperty(collectionId: string, property: NewProperty, position?: Position): Property | null
  renameProperty(collectionId: string, propertyId: string, name: string, options?: ChangeOptions): void
  updateProperty(collectionId: string, propertyId: string, change: PropertyChange, options?: ChangeOptions): void
  moveProperty(collectionId: string, propertyId: string, position: Position): void
  /** Converts every item's value. */
  setPropertyType(collectionId: string, propertyId: string, type: PropertyType): Promise<boolean>
  deleteProperty(collectionId: string, propertyId: string): Promise<boolean>
  /** The option of this name, made when there is none. */
  addOption(collectionId: string, propertyId: string, name: string, color?: Color): Option | null
  updateOption(collectionId: string, propertyId: string, optionId: string, change: Partial<Pick<Option, 'name' | 'color'>>, options?: ChangeOptions): void
  moveOption(collectionId: string, propertyId: string, optionId: string, position: Position): void
  /** Its items get option `moveTo`, or none. One step to undo. */
  deleteOption(collectionId: string, propertyId: string, optionId: string, options?: { moveTo?: string | null }): Promise<boolean>

  /* ---- views */
  addView(collectionId: string, view: NewView, position?: Position): View | null
  updateView(collectionId: string, viewId: string, change: ViewChange, options?: ChangeOptions): void
  duplicateView(collectionId: string, viewId: string): View | null
  moveView(collectionId: string, viewId: string, position: Position): void
  /** Not the last one. */
  deleteView(collectionId: string, viewId: string): boolean

  /* ---- in and out */
  exportCsv(collectionId: string, itemIds?: readonly string[]): Promise<string | null>
  exportMarkdown(collectionId: string, itemIds?: readonly string[]): Promise<string | null>
  /**
   * Into a collection: columns join properties of the same name. Answers how many items came in, once they are
   * written: 0 when they could not be (a toast says why).
   */
  importCsv(collectionId: string, csv: string): Promise<number>
  /** Null when it could not be written. */
  importCsvAsCollection(csv: string, name: string, scope?: Scope): Promise<Collection | null>

  /* ---- undo */
  readonly canUndo: ComputedRef<boolean>
  readonly canRedo: ComputedRef<boolean>
  /** What it would undo or redo, e.g. `delete item`. */
  readonly undoLabel: ComputedRef<string | null>
  readonly redoLabel: ComputedRef<string | null>
  /** What was changed since, by another window or person, is kept (a toast says so). */
  undo(): void
  redo(): void

  /* ---- what was open, per project, kept across restarts */
  lastCollection(): string | null
  rememberCollection(collectionId: string | null): void
  lastView(collectionId: string): string | null
  rememberView(collectionId: string, viewId: string): void

  /** What is known of the open project beside its path: matches collections made on another computer. */
  identifyProject(identity: ProjectIdentity | null): void

  /** Writes what is waiting; resolves when nothing is under way. */
  flush(): Promise<void>
  /**
   * Before the window closes: open editors commit (a `planner:commit` event on `window`, which they handle at once),
   * then everything is written or has failed.
   */
  flushAll(): Promise<void>
  dispose(): void
}

/** What the store needs of Mango. */
export type StoreHost = Pick<MangoPluginApi, 'data' | 'storage'> & {
  workspace: Pick<MangoPluginApi['workspace'], 'activeProject' | 'onProjectChange'>
  ui: Pick<MangoPluginApi['ui'], 'toast'>
  log: Pick<MangoPluginApi['log'], 'error'>
}

export interface StoreOptions {
  /** This computer's when left out. */
  source?: PlannerSource
  deferMs?: number
  copyText?: (text: string) => void
}

/* ---------------------------------------------------------------- internals */

/** One change: its operations, and what takes it back. */
interface Mutation {
  /** The same each time it is tried. */
  id: string
  /** Later changes have higher numbers, however often they are tried. */
  readonly number: number
  /** Whether it was written (or is kept to be, while offline), after the first try. */
  settle?: (ok: boolean) => void
  ops: SourceOp[]
  at: number
  deferred: boolean
  undoEntry: UndoEntry | null
}
interface UndoEntry { label: string; undo: SourceOp[]; redo: SourceOp[] }

/** A document: what the source last said, under what is not written yet. */
interface Entry {
  readonly kind: SourceDoc['kind']
  readonly id: string
  readonly collectionId: string
  base: SourceDoc | null
  pending: Mutation[]
}

interface MutableItems { status: LoadStatus; error: string | null; items: readonly Item[] }
interface UiState { collection?: string; views?: Record<string, string> }

const DEFER_MS = 400
const UNDO_MAX = 100
/** The same message is not shown again for this long. */
const TOAST_REST_MS = 5000
/** View settings that are only how it looks right now: not steps to undo. */
const LAYOUT = new Set<keyof ViewChange>(['collapsedGroups', 'widths'])

const keyOf = (o: Pick<SourceOp, 'kind' | 'id' | 'collectionId'>) => `${o.kind}/${o.collectionId}/${o.id}`
const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e))
const kindOf = (e: unknown) => (e instanceof SourceError ? e.kind : 'unknown')
const covers = (a: readonly string[], b: readonly string[]) => a.length <= b.length && a.every((k, i) => k === b[i])
const json = (v: unknown): Json => JSON.parse(JSON.stringify(v)) as Json
const samePath = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((k, i) => k === b[i])
const collectionTarget = (id: string) => ({ kind: 'collection' as const, id, collectionId: id })
const itemTarget = (collectionId: string, id: string) => ({ kind: 'item' as const, id, collectionId })

function applyOps(data: JsonObject | null, ops: readonly SourceOp[]): JsonObject | null {
  let out = data
  for (const op of ops) {
    if (op.op === 'create') out = op.data
    else if (op.op === 'delete') out = null
    else if (out) out = applyPatch(out, op.patch)
  }
  return out
}

/** Operations by document; found again for the same list, as a large import asks for every one of its documents. */
const grouped = new WeakMap<readonly SourceOp[], Map<string, SourceOp[]>>()
function opsOn(ops: readonly SourceOp[], key: string): readonly SourceOp[] {
  let map = grouped.get(ops)
  if (!map) {
    map = new Map()
    for (const op of ops) {
      const k = keyOf(op)
      const list = map.get(k)
      if (list) list.push(op)
      else map.set(k, [op])
    }
    grouped.set(ops, map)
  }
  return map.get(key) ?? []
}

/** What a change left at a path: its last word there, with what it then did below. */
function writtenAt(ops: readonly SourceOp[], path: readonly string[]): Json | undefined {
  const patch = ops.flatMap(o => (o.op === 'patch' ? o.patch : []))
  const at = patch.findLastIndex(p => samePath(p.path, path))
  let value = patch[at]?.value
  for (const p of patch.slice(at + 1)) {
    if (p.path.length > path.length && covers(path, p.path) && isObject(value)) value = setBelow(value, p.path.slice(path.length), p.value)
  }
  return value
}
function setBelow(doc: JsonObject, path: readonly string[], value: Json | undefined): JsonObject {
  const [key, ...rest] = path as [string, ...string[]]
  const next: JsonObject = { ...doc }
  if (!rest.length && value === undefined) delete next[key]
  else next[key] = rest.length ? setBelow(isObject(next[key]) ? next[key] : {}, rest, value) : value!
  return next
}

/** A document without what is only how it looks right now, which is no edit. */
function withoutLayout(data: JsonObject): JsonObject {
  if (!data.views) return data
  return {
    ...data,
    views: Object.fromEntries(entriesById(data.views).map(([id, v]) => [id, Object.fromEntries(Object.entries(v).filter(([k]) => !LAYOUT.has(k as keyof ViewChange)))])),
  }
}

/* ---------------------------------------------------------------- the store */

export function createStore(mango: StoreHost, options: StoreOptions = {}): PlannerStore {
  const source = options.source ?? new LocalSource(mango.data)
  const deferMs = options.deferMs ?? DEFER_MS

  const status = ref<LoadStatus>('idle')
  const error = ref<string | null>(null)
  const sourceStatus = shallowRef<SourceStatus>(source.status())
  const projectPath = ref<string | null>(mango.workspace.activeProject())
  const now = ref(Date.now())
  const saving = ref(false)
  const allCollections: ShallowRef<readonly Collection[]> = shallowRef([])
  const identity: ShallowRef<ProjectIdentity | null> = shallowRef(null)
  const collections = computed(() => allCollections.value.filter(c => isInScope(c.scope, projectPath.value, identity.value)))
  const undoStack: ShallowRef<readonly UndoEntry[]> = shallowRef([])
  const redoStack: ShallowRef<readonly UndoEntry[]> = shallowRef([])

  const entries = new Map<string, Entry>()
  const itemStates = new Map<string, MutableItems>()
  const itemModels = new Map<string, Map<string, Item>>()
  const loadingItems = new Map<string, Promise<boolean>>()

  let disposed = false
  let deferred: Mutation | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  /** Could not be written: still shown, and written again with the next change, or once online. */
  let unsaved: Mutation[] = []
  /** Of those, the ones that wait for a connection: what came after them on the same documents waits too. */
  const waiting = new Set<Mutation>()
  /** Text that can never be written as it is: shown until the same text is changed and saved. */
  let stuck: Mutation[] = []
  /** Documents whose text the user was told cannot be saved. */
  const told = new Set<string>()
  let made = 0
  let chain: Promise<void> = Promise.resolve()
  let writing = 0
  const lastToasts = new Map<string, number>()

  /* ---- documents to models */

  function entryFor(o: Pick<SourceOp, 'kind' | 'id' | 'collectionId'>): Entry {
    const key = keyOf(o)
    let e = entries.get(key)
    if (!e) entries.set(key, (e = { kind: o.kind, id: o.id, collectionId: o.collectionId, base: null, pending: [] }))
    return e
  }

  /** The stored document as it will be once everything is written. */
  function currentOf(e: Entry | undefined): JsonObject | null {
    if (!e) return null
    const key = keyOf(e)
    return e.pending.reduce<JsonObject | null>((data, m) => applyOps(data, opsOn(m.ops, key)), e.base?.data ?? null)
  }

  const rawCollection = (id: string) => currentOf(entries.get(keyOf(collectionTarget(id))))
  const rawItem = (collectionId: string, id: string) => currentOf(entries.get(keyOf(itemTarget(collectionId, id))))

  /** Rebuilds the models of these documents, and the lists they are in. */
  function publish(keys: Iterable<string>) {
    let collectionsChanged = false
    const changedItems = new Set<string>()
    const list = new Map(allCollections.value.map(c => [c.id, c]))
    for (const key of keys) {
      const e = entries.get(key)
      if (!e) continue
      const data = currentOf(e)
      const at = e.pending.at(-1)?.at
      const meta = { id: e.id, createdAt: e.base?.createdAt ?? at ?? 0, updatedAt: at ?? e.base?.updatedAt ?? 0 }
      if (e.kind === 'collection') {
        collectionsChanged = true
        if (data) list.set(e.id, normalizeCollection(data, meta))
        else list.delete(e.id)
      } else {
        let models = itemModels.get(e.collectionId)
        if (!models) itemModels.set(e.collectionId, (models = new Map()))
        if (data) models.set(e.id, normalizeItem(data, meta, e.collectionId))
        else models.delete(e.id)
        changedItems.add(e.collectionId)
      }
      if (!data && !e.base && !e.pending.length) entries.delete(key)
    }
    if (collectionsChanged) allCollections.value = ordered([...list.values()])
    for (const id of changedItems) {
      const state = itemStates.get(id)
      if (state) state.items = ordered([...(itemModels.get(id)?.values() ?? [])])
    }
  }

  /** Takes documents from the source; a newer one seen before stays. */
  function take(docs: readonly SourceDoc[]): string[] {
    const changed: string[] = []
    for (const doc of docs) {
      // Items nobody looked at yet are read whole when someone does.
      if (doc.kind === 'item' && !itemStates.has(doc.collectionId)) continue
      const e = entryFor(doc)
      if (e.base && e.base.seq > doc.seq) continue
      e.base = doc
      changed.push(keyOf(doc))
    }
    return changed
  }

  /* ---- loading */

  async function load() {
    if (status.value === 'loading') return
    status.value = 'loading'
    error.value = null
    try {
      publish(take(await source.loadCollections()))
      status.value = 'ready'
    } catch (e) {
      status.value = 'error'
      error.value = messageOf(e)
      mango.log.error('Loading collections:', e)
    }
  }

  /** Reads everything loaded again: what is not listed any more is gone, unless it was heard of meanwhile. */
  async function resync() {
    const read = async (kind: SourceDoc['kind'], collectionId: string | null, list: () => Promise<SourceDoc[]>) => {
      const before = [...entries.values()].filter(e => e.kind === kind && (collectionId === null || e.collectionId === collectionId) && e.base?.data)
        .map(e => ({ e, base: e.base! }))
      const docs = await list()
      const listed = new Set(docs.map(keyOf))
      const changed = take(docs)
      for (const { e, base } of before) {
        if (listed.has(keyOf(e)) || e.base !== base) continue
        e.base = { ...base, data: null }
        changed.push(keyOf(e))
      }
      publish(changed)
    }
    const ready = [...itemStates].filter(([, s]) => s.status === 'ready').map(([id]) => id)
    const jobs = [
      ...(status.value === 'ready' ? [read('collection', null, () => source.loadCollections())] : []),
      ...ready.map(id => read('item', id, () => source.loadItems(id))),
    ]
    for (const r of await Promise.allSettled(jobs)) if (r.status === 'rejected') mango.log.error('Reading again:', r.reason)
  }

  function stateOf(collectionId: string): MutableItems {
    let s = itemStates.get(collectionId)
    if (!s) itemStates.set(collectionId, (s = shallowReactive<MutableItems>({ status: 'idle', error: null, items: [] })))
    return s
  }

  function loadItems(collectionId: string): Promise<boolean> {
    const s = stateOf(collectionId)
    if (s.status === 'ready') return Promise.resolve(true)
    let job = loadingItems.get(collectionId)
    if (!job) {
      job = (async () => {
        // Not while a computed that asked for them is still running.
        await Promise.resolve()
        s.status = 'loading'
        s.error = null
        try {
          publish(take(await source.loadItems(collectionId)))
          s.status = 'ready'
          return true
        } catch (e) {
          s.status = 'error'
          s.error = messageOf(e)
          mango.log.error('Loading items:', e)
          return false
        } finally {
          loadingItems.delete(collectionId)
        }
      })()
      loadingItems.set(collectionId, job)
    }
    return job
  }

  function items(collectionId: string): ItemsState {
    const s = stateOf(collectionId)
    if (s.status === 'idle' && !disposed) void loadItems(collectionId)
    return s
  }

  /** Loads the items or says why not. */
  async function withItems(collectionId: string): Promise<readonly Item[] | null> {
    if (await loadItems(collectionId)) return stateOf(collectionId).items
    toast(strings.loadFailed, stateOf(collectionId).error ?? '')
    return null
  }

  const collection = (id: string | null | undefined) => allCollections.value.find(c => c.id === id) ?? null
  function item(collectionId: string, itemId: string): Item | null {
    return items(collectionId).items.find(i => i.id === itemId) ?? null
  }

  /* ---- changing */

  function toast(title: string, body?: string, action?: { label: string; run(): void }) {
    const key = `${title}\n${body ?? ''}`
    if (Date.now() - (lastToasts.get(key) ?? 0) < TOAST_REST_MS) return
    lastToasts.set(key, Date.now())
    mango.ui.toast({ title, body, kind: 'error', action })
  }

  function inverseOf(ops: readonly SourceOp[]): SourceOp[] {
    const inverse: SourceOp[] = []
    const seen = new Map<string, JsonObject | null>()
    for (const op of ops) {
      const key = keyOf(op)
      const before = seen.has(key) ? seen.get(key)! : currentOf(entries.get(key))
      const target = { kind: op.kind, id: op.id, collectionId: op.collectionId }
      if (op.op === 'create') inverse.unshift({ ...target, op: 'delete' })
      else if (op.op === 'delete') {
        if (before) inverse.unshift({ ...target, op: 'create', data: before })
      } else if (before) inverse.unshift({ ...target, op: 'patch', patch: invertPatch(before, op.patch) })
      seen.set(key, applyOps(before, [op]))
    }
    return inverse
  }

  /** Makes a change. False when it may not be made. */
  function mutate(ops: SourceOp[], label: string | null, opts: ChangeOptions = {}, settle?: (ok: boolean) => void): boolean {
    ops = ops.filter(o => o.op !== 'patch' || o.patch.length)
    if (!ops.length) {
      settle?.(true)
      return true
    }
    if (sourceStatus.value.readonly) {
      toast(strings.readonly, sourceStatus.value.message)
      return false
    }
    if (opts.defer) {
      addDeferred(ops, label, opts.defer === 'hold')
      return true
    }
    settleDeferred()
    const m = newMutation(ops, label, false)
    m.settle = settle
    show(m)
    enqueue(m)
    return true
  }

  /** The same, and whether it was written. */
  function mutateAndWait(ops: SourceOp[], label: string): Promise<boolean> {
    return new Promise((resolve) => {
      if (!mutate(ops, label, {}, resolve)) resolve(false)
    })
  }

  function newMutation(ops: SourceOp[], label: string | null, isDeferred: boolean): Mutation {
    const undoEntry = label === null ? null : { label, undo: inverseOf(ops), redo: [...ops] }
    if (undoEntry) record(undoEntry)
    return { id: newId(), number: ++made, ops, at: Date.now(), deferred: isDeferred, undoEntry }
  }

  function record(entry: UndoEntry) {
    undoStack.value = [...undoStack.value, entry].slice(-UNDO_MAX)
    redoStack.value = []
  }

  function show(m: Mutation) {
    const keys = new Set(m.ops.map(keyOf))
    for (const op of m.ops) {
      const e = entryFor(op)
      if (!e.pending.includes(m)) e.pending.push(m)
    }
    publish(keys)
  }

  function hide(m: Mutation) {
    const keys = new Set(m.ops.map(keyOf))
    for (const key of keys) {
      const e = entries.get(key)
      if (e) e.pending = e.pending.filter(p => p !== m)
    }
    publish(keys)
  }

  /** Text as it is typed: joins what is waiting, a newer text of one field replacing the older. */
  function addDeferred(ops: SourceOp[], label: string | null, hold: boolean) {
    if (deferred) {
      const m = deferred
      m.at = Date.now()
      const fresh: SourceOp[] = []
      for (const op of ops) {
        if (op.op !== 'patch' || !replaceIn(m, op)) fresh.push(op)
      }
      if (m.undoEntry) {
        if (fresh.length) m.undoEntry.undo = [...inverseOf(fresh), ...m.undoEntry.undo]
        m.undoEntry.redo = [...m.ops, ...fresh]
      } else if (label !== null && fresh.length) {
        m.undoEntry = { label, undo: inverseOf(fresh), redo: [...fresh] }
        record(m.undoEntry)
      }
      m.ops = [...m.ops, ...fresh]
      show(m)
    } else {
      deferred = newMutation(ops, label, true)
      show(deferred)
    }
    saving.value = true
    clearTimeout(timer)
    if (!hold) timer = setTimeout(settleDeferred, deferMs)
  }

  /** Replaces the values of a patch that is waiting already; false when one of its fields is not in it. */
  function replaceIn(m: Mutation, op: SourceOp & { op: 'patch' }): boolean {
    const at = m.ops.findIndex(o => o.op === 'patch' && keyOf(o) === keyOf(op) && op.patch.every(p => o.patch.some(q => samePath(p.path, q.path))))
    const old = m.ops[at]
    if (old?.op !== 'patch') return false
    m.ops = m.ops.with(at, { ...old, patch: old.patch.map(q => op.patch.findLast(p => samePath(p.path, q.path)) ?? q) })
    return true
  }

  /** Hands what is waiting to the writer. */
  function settleDeferred() {
    clearTimeout(timer)
    const again = unsaved
    unsaved = []
    waiting.clear()
    again.forEach(enqueue)
    const m = deferred
    deferred = null
    if (m) enqueue(m)
  }

  function enqueue(m: Mutation) {
    writing++
    saving.value = true
    chain = chain.then(() => writeOut(m)).finally(() => {
      writing--
      saving.value = writing > 0 || deferred !== null || unsaved.length > 0
    })
  }

  /** Older text waiting to be written loses the fields a newer change has taken over, so it cannot come back over them. */
  function supersede(m: Mutation) {
    const trim = (list: Mutation[]) => list.filter((old) => {
      if (old === m || old.number > m.number) return true
      const ops = old.ops.flatMap((op): SourceOp[] => {
        const newer = opsOn(m.ops, keyOf(op))
        if (!newer.length || op.op !== 'patch') return [op]
        if (newer.some(n => n.op === 'delete')) return []
        const taken = newer.flatMap(n => (n.op === 'patch' ? n.patch : []))
        const patch = op.patch.filter(p => !taken.some(t => covers(t.path, p.path)))
        return patch.length ? [{ ...op, patch }] : []
      })
      if (ops.length === old.ops.length && ops.every((o, i) => o === old.ops[i] || (o.op === 'patch' && o.patch.length === (old.ops[i] as typeof o).patch.length))) return true
      hide(old)
      if (!ops.length) {
        waiting.delete(old)
        return false
      }
      old.ops = ops
      old.id = newId()
      for (const op of ops) {
        const e = entryFor(op)
        // At its place in time: what came later stays over it.
        e.pending = [...e.pending, old].sort((a, b) => a.number - b.number)
      }
      publish(ops.map(keyOf))
      return true
    })
    unsaved = trim(unsaved)
    stuck = trim(stuck)
  }

  /** The text of changes to documents that are gone. */
  function textIn(m: Mutation, keys: ReadonlySet<string>): string {
    return m.ops.flatMap(o => (o.op === 'patch' && keys.has(keyOf(o)) ? o.patch : []))
      .filter(p => p.path[0] === 'title' || p.path[0] === 'body' || (m.deferred && p.path[0] === 'values'))
      .map(p => p.value).filter(v => typeof v === 'string' && v.trim() !== '').join('\n\n')
  }

  function copyText(text: string) {
    if (options.copyText) options.copyText(text)
    else void navigator.clipboard?.writeText(text).catch((e: unknown) => mango.log.error('Copying:', e))
  }

  async function writeOut(m: Mutation) {
    try {
      const keys = new Set(m.ops.map(keyOf))
      if ([...waiting].some(w => w.number < m.number && w.ops.some(o => keys.has(keyOf(o))))) return keepOffline(m)
      const docs = await source.write(m.ops, m.id)
      take(docs)
      hide(m)
      supersede(m)
      for (const key of keys) told.delete(key)
      m.settle?.(true)
      const patched = new Set(m.ops.filter(o => o.op === 'patch').map(keyOf))
      const removed = new Set(m.ops.filter(o => o.op === 'delete').map(keyOf))
      const gone = new Set(docs.filter(d => d.data === null && patched.has(keyOf(d)) && !removed.has(keyOf(d))).map(keyOf))
      if (!gone.size) return
      const text = textIn(m, gone)
      if (text) mango.ui.toast({ title: strings.saveFailed, body: strings.gone, kind: 'error', timeout: 0, action: { label: strings.copyText, run: () => copyText(text) } })
      else toast(strings.saveFailed, strings.gone)
    } catch (e) {
      mango.log.error('Saving:', e)
      const kind = kindOf(e)
      if (kind === 'offline' && !disposed) {
        toast(strings.saveFailed, strings.offline, { label: strings.retry, run: settleDeferred })
        return keepOffline(m)
      }
      m.settle?.(false)
      if (m.deferred && !disposed) {
        if (kind === 'unknown') {
          unsaved.push(m)
          supersede(m)
          return toast(strings.saveFailed, messageOf(e), { label: strings.retry, run: settleDeferred })
        }
        stuck.push(m)
        supersede(m)
        const keys = [...new Set(m.ops.map(keyOf))]
        if (keys.every(k => told.has(k))) return
        keys.forEach(k => told.add(k))
        return mango.ui.toast({ title: strings.saveFailed, body: `${messageOf(e)} ${strings.textKept}`, kind: 'error' })
      }
      hide(m)
      if (m.undoEntry) {
        undoStack.value = undoStack.value.filter(u => u !== m.undoEntry)
        redoStack.value = redoStack.value.filter(u => u !== m.undoEntry)
      }
      toast(strings.saveFailed, messageOf(e))
    }
  }

  function keepOffline(m: Mutation) {
    unsaved.push(m)
    waiting.add(m)
    m.settle?.(true)
  }

  /**
   * An entry's operations without those that would undo what came after it: fields that no longer hold what the
   * change put there, and documents changed since.
   */
  function stillApplies(entry: UndoEntry, which: 'undo' | 'redo'): { ops: SourceOp[]; kept: boolean } {
    const done = entry[which === 'undo' ? 'redo' : 'undo']
    let kept = false
    const keptItems = new Set<string>()
    const ops = entry[which].flatMap((op): SourceOp[] => {
      const key = keyOf(op)
      const current = currentOf(entries.get(key))
      const wrote = opsOn(done, key)
      const drop = () => {
        kept = true
        if (op.kind === 'item') keptItems.add(op.collectionId)
        return []
      }
      // There again, or gone: nothing to make or remove.
      if (op.op === 'create') return current ? drop() : [op]
      if (!current) return op.op === 'delete' ? [] : drop()
      if (op.op === 'delete') {
        const created = applyOps(null, wrote)
        return created && sameJson(withoutLayout(current), withoutLayout(created)) ? [op] : drop()
      }
      const patch = op.patch.filter(p => sameJson(readPath(current, p.path), writtenAt(wrote, p.path)))
      if (patch.length < op.patch.length) kept = true
      return patch.length ? [{ ...op, patch }] : []
    })
    // A collection stays for the items that stay.
    const left = ops.filter(o => !(o.op === 'delete' && o.kind === 'collection' && keptItems.has(o.id)))
    return { ops: left, kept }
  }

  function tellKept(kept: boolean) {
    if (kept) mango.ui.toast({ title: strings.undoKept, body: strings.undoKeptBody, kind: 'info' })
  }

  function step(from: typeof undoStack, to: typeof redoStack, which: 'undo' | 'redo') {
    settleDeferred()
    const entry = from.value.at(-1)
    if (!entry) return
    if (sourceStatus.value.readonly) return toast(strings.readonly, sourceStatus.value.message)
    from.value = from.value.slice(0, -1)
    const { ops, kept } = stillApplies(entry, which)
    tellKept(kept)
    if (!ops.length) return
    to.value = [...to.value, entry]
    const m: Mutation = { ...newMutation(ops, null, false), undoEntry: entry }
    show(m)
    enqueue(m)
  }
  const undo = () => step(undoStack, redoStack, 'undo')
  const redo = () => step(redoStack, undoStack, 'redo')

  /** Undoes this very change, while it is still the last one; otherwise by a change of its own. */
  function undoToast(title: string) {
    const entry = undoStack.value.at(-1)
    if (!entry) return
    mango.ui.toast({
      title,
      kind: 'info',
      action: {
        label: strings.undo,
        run: () => {
          if (undoStack.value.at(-1) === entry) return undo()
          if (!undoStack.value.includes(entry)) return
          undoStack.value = undoStack.value.filter(u => u !== entry)
          const { ops, kept } = stillApplies(entry, 'undo')
          tellKept(kept)
          mutate(ops, null)
        },
      },
    })
  }

  const patchCollection = (id: string, patch: Patch, label: string | null, opts?: ChangeOptions) =>
    mutate([{ ...collectionTarget(id), op: 'patch', patch }], label, opts)

  /* ---- collections */

  function createCollection(input: NewCollection = {}): Collection | null {
    const template = input.template ?? 'empty'
    const data = templateData(template)
    const scope: Scope = input.scope ?? (projectPath.value ? { kind: 'project', path: projectPath.value } : { kind: 'everywhere' })
    const id = newId()
    const place = placeAt(allCollections.value, [id], 'end')
    const ops: SourceOp[] = [{
      ...collectionTarget(id),
      op: 'create',
      data: {
        ...data,
        name: input.name?.trim() || strings.templates[template].name,
        icon: input.icon ?? data.icon,
        color: input.color ?? data.color,
        scope: json(scope),
        order: place.get(id)!,
        createdAt: Date.now(),
      },
    }, ...reorderOps(place, id)]
    startEmpty(id)
    return mutate(ops, strings.did.createCollection) ? collection(id) : null
  }

  /** A new collection has no items to read. */
  function startEmpty(id: string) {
    stateOf(id).status = 'ready'
  }

  /** Patches for collections whose order changed around a new one. */
  function reorderOps(place: ReadonlyMap<string, string>, except?: string): SourceOp[] {
    return [...place].filter(([id]) => id !== except)
      .map(([id, order]) => ({ ...collectionTarget(id), op: 'patch', patch: [{ path: ['order'], value: order }] }))
  }

  function updateCollection(id: string, change: CollectionChange, opts?: ChangeOptions) {
    patchCollection(id, fields(change), strings.did.editCollection, opts)
  }

  function moveCollection(id: string, position: Position) {
    mutate(reorderOps(placeAt(allCollections.value, [id], position)), strings.did.editCollection)
  }

  async function duplicateCollection(id: string, opts: { items?: boolean } = {}): Promise<Collection | null> {
    const list = opts.items ? await withItems(id) : []
    const raw = rawCollection(id)
    const model = collection(id)
    if (!list || !raw || !model) return null
    const copy = newId()
    const at = Date.now()
    const place = placeAt(allCollections.value, [copy], { after: id })
    const ops: SourceOp[] = [
      { ...collectionTarget(copy), op: 'create', data: { ...raw, name: strings.copyOf(model.name), order: place.get(copy)!, createdAt: at } },
      ...reorderOps(place, copy),
      ...list.flatMap((i): SourceOp[] => {
        const data = rawItem(id, i.id)
        return data ? [{ ...itemTarget(copy, newId()), op: 'create', data: { ...data, createdAt: at } }] : []
      }),
    ]
    startEmpty(copy)
    return mutate(ops, strings.did.duplicate) ? collection(copy) : null
  }

  async function deleteCollection(id: string): Promise<boolean> {
    const list = await withItems(id)
    const model = collection(id)
    if (!list || !model) return false
    const ops: SourceOp[] = [
      { ...collectionTarget(id), op: 'delete' },
      ...list.map((i): SourceOp => ({ ...itemTarget(id, i.id), op: 'delete' })),
    ]
    if (!mutate(ops, strings.did.deleteCollection)) return false
    undoToast(strings.deletedCollection(model.name))
    return true
  }

  /* ---- items */

  /** The stored form of values, each checked against its property. */
  function storedValues(c: Collection, values: Readonly<Record<string, Value | null>>): JsonObject {
    const out: JsonObject = {}
    for (const [id, v] of Object.entries(values)) {
      const p = propertyOf(c, id)
      const stored = p ? storedValue(v, p) : undefined
      if (stored !== undefined) out[id] = stored
    }
    return out
  }

  async function createItem(collectionId: string, input: NewItem = {}): Promise<Item | null> {
    if (stateOf(collectionId).status !== 'ready' && !await withItems(collectionId)) return null
    const c = collection(collectionId)
    if (!c) return null
    const id = newId()
    const at = Date.now()
    const view = viewOf(c, input.viewId)
    const values = { ...defaultValues(c, view, input.group, at), ...input.values }
    const place = placeAt(stateOf(collectionId).items, [id], input.position ?? 'end')
    const ok = mutate([
      {
        ...itemTarget(collectionId, id),
        op: 'create',
        data: {
          title: input.title ?? '',
          icon: input.icon ?? null,
          body: input.body ?? '',
          values: storedValues(c, values),
          chats: Object.fromEntries((input.chats ?? []).map((t, i) => [t, at + i])),
          order: place.get(id)!,
          createdAt: at,
        },
      },
      ...itemOrderOps(collectionId, place, new Set([id])),
    ], strings.did.createItem(itemWord(c, 1)))
    return ok ? item(collectionId, id) : null
  }

  function itemOrderOps(collectionId: string, place: ReadonlyMap<string, string>, except: ReadonlySet<string>): SourceOp[] {
    return [...place].filter(([id]) => !except.has(id))
      .map(([id, order]) => ({ ...itemTarget(collectionId, id), op: 'patch', patch: [{ path: ['order'], value: order }] }))
  }

  function itemPatch(c: Collection, change: ItemChange): PatchOp[] {
    const patch: PatchOp[] = []
    if (change.title !== undefined) patch.push({ path: ['title'], value: change.title })
    if (change.icon !== undefined) patch.push({ path: ['icon'], value: change.icon })
    if (change.body !== undefined) patch.push({ path: ['body'], value: change.body })
    for (const [id, v] of Object.entries(change.values ?? {})) {
      const p = propertyOf(c, id)
      if (!p) continue
      const value = storedValue(v, p)
      patch.push(value === undefined ? { path: ['values', id] } : { path: ['values', id], value })
    }
    return patch
  }

  /** Without what is so already: no write, and nothing to undo. */
  function effective(raw: JsonObject | null, patch: readonly PatchOp[]): PatchOp[] {
    return raw ? patch.filter(p => JSON.stringify(readPath(raw, p.path)) !== JSON.stringify(p.value)) : []
  }

  function changeItems(collectionId: string, itemIds: readonly string[], change: ItemChange, opts?: ChangeOptions) {
    const c = collection(collectionId)
    if (!c) return
    const patch = itemPatch(c, change)
    mutate(itemIds.map((id): SourceOp => ({
      ...itemTarget(collectionId, id), op: 'patch', patch: effective(rawItem(collectionId, id), patch),
    })), strings.did.editItem, opts)
  }

  function changeEach(collectionId: string, changes: ReadonlyMap<string, ItemChange>, newOptions?: ReadonlyMap<string, readonly Option[]>) {
    const c = collection(collectionId)
    if (!c) return
    const patch = c.properties.flatMap((p): PatchOp[] => {
      const add = newOptions?.get(p.id)
      if (!add?.length) return []
      const base = ['properties', p.id, 'options']
      const ids = new Set(add.map(o => o.id))
      const place = placeAt(p.options, [...ids], 'end')
      return [
        ...add.map((o): PatchOp => ({ path: [...base, o.id], value: { name: o.name, color: o.color, order: place.get(o.id)! } })),
        ...orderPatch(base, new Map([...place].filter(([id]) => !ids.has(id)))),
      ]
    })
    // The values are checked against the options as they will be.
    const then = { ...c, properties: c.properties.map(p => ({ ...p, options: [...p.options, ...(newOptions?.get(p.id) ?? [])] })) }
    mutate([
      { ...collectionTarget(collectionId), op: 'patch', patch },
      ...[...changes].map(([id, change]): SourceOp => ({
        ...itemTarget(collectionId, id), op: 'patch', patch: effective(rawItem(collectionId, id), itemPatch(then, change)),
      })),
    ], strings.did.editItem)
  }

  function moveItems(collectionId: string, move: Move) {
    const c = collection(collectionId)
    if (!c) return
    const list = stateOf(collectionId).items
    const byId = new Map(list.map(i => [i.id, i]))
    const ids = move.ids.filter(id => byId.has(id))
    const place = move.position === undefined ? new Map<string, string>() : placeAt(list, ids, move.position)
    const property = move.group ? propertyOf(c, move.group.propertyId) : null
    const groupable = property && isGroupable(property) ? property : null
    const from = move.group?.from
    const patches = new Map<string, PatchOp[]>()
    for (const id of ids) {
      const change: ItemChange = groupable
        ? { values: { [groupable.id]: valueForGroup(groupable, move.group!.key, byId.get(id), typeof from === 'object' ? from.get(id) : from) } }
        : {}
      patches.set(id, itemPatch(c, change))
    }
    for (const [id, order] of place) patches.set(id, [...(patches.get(id) ?? []), { path: ['order'], value: order }])
    mutate([...patches].map(([id, patch]): SourceOp => ({
      ...itemTarget(collectionId, id), op: 'patch', patch: effective(rawItem(collectionId, id), patch),
    })), strings.did.moveItem)
  }

  function duplicateItems(collectionId: string, itemIds: readonly string[]): Item[] {
    const list = stateOf(collectionId).items
    const at = Date.now()
    const wanted = new Set(itemIds)
    const copyOf = new Map(list.filter(i => wanted.has(i.id) && rawItem(collectionId, i.id)).map(i => [i.id, newId()]))
    if (!copyOf.size) return []
    // Each right after its original; where that leaves no room, everything is spaced anew.
    const place = new Map<string, string>()
    const fits = list.every((i, n) => {
      const copy = copyOf.get(i.id)
      const key = copy ? between(i.order, list[n + 1]?.order ?? null) : ''
      if (copy && key) place.set(copy, key)
      return key !== null
    })
    if (!fits) {
      const all = list.flatMap(i => [i.id, ...(copyOf.has(i.id) ? [copyOf.get(i.id)!] : [])])
      spread(all.length).forEach((key, n) => place.set(all[n]!, key))
    }
    const copies = new Set(copyOf.values())
    const ops = list.flatMap((i): SourceOp[] => {
      const id = copyOf.get(i.id)
      if (!id) return []
      const data: JsonObject = { ...rawItem(collectionId, i.id)!, title: strings.copyOf(i.title), order: place.get(id)!, chats: {}, createdAt: at }
      return [{ ...itemTarget(collectionId, id), op: 'create', data }]
    })
    if (!mutate([...ops, ...itemOrderOps(collectionId, place, copies)], strings.did.duplicate)) return []
    return stateOf(collectionId).items.filter(i => copies.has(i.id))
  }

  function deleteItems(collectionId: string, itemIds: readonly string[]) {
    const ids = [...new Set(itemIds)].filter(id => rawItem(collectionId, id))
    if (!ids.length) return
    const word = itemWord(collection(collectionId), ids.length)
    const ok = mutate(ids.map((id): SourceOp => ({ ...itemTarget(collectionId, id), op: 'delete' })), strings.did.deleteItems(ids.length, word))
    if (ok) undoToast(strings.deletedItems(ids.length, word))
  }

  function setChat(collectionId: string, itemId: string, threadId: string, linked: boolean) {
    const existing = item(collectionId, itemId)
    if (!existing || existing.chats.includes(threadId) === linked) return
    const patch: Patch = [linked ? { path: ['chats', threadId], value: Date.now() } : { path: ['chats', threadId] }]
    mutate([{ ...itemTarget(collectionId, itemId), op: 'patch', patch }], strings.did.linkChat)
  }

  /* ---- properties */

  function fields(change: object): PatchOp[] {
    return Object.entries(change).filter(([, v]) => v !== undefined).map(([k, v]) => ({ path: [k], value: json(v) }))
  }

  function addProperty(collectionId: string, input: NewProperty, position: Position = 'end'): Property | null {
    const c = collection(collectionId)
    if (!c) return null
    const id = newId()
    const place = placeAt(c.properties, [id], position)
    const patch: PatchOp[] = [
      { path: ['properties', id], value: propertyData({ ...input, order: place.get(id)! }) },
      ...orderPatch(['properties'], place, id),
    ]
    return patchCollection(collectionId, patch, strings.did.editProperty) ? propertyOf(collection(collectionId)!, id) : null
  }

  function orderPatch(prefix: readonly string[], place: ReadonlyMap<string, string>, except?: string): PatchOp[] {
    return [...place].filter(([id]) => id !== except).map(([id, value]) => ({ path: [...prefix, id, 'order'], value }))
  }

  function renameProperty(collectionId: string, propertyId: string, name: string, opts?: ChangeOptions) {
    patchCollection(collectionId, [{ path: ['properties', propertyId, 'name'], value: name }], strings.did.editProperty, opts)
  }

  function updateProperty(collectionId: string, propertyId: string, change: PropertyChange, opts?: ChangeOptions) {
    const c = collection(collectionId)
    if (!c || !propertyOf(c, propertyId)) return
    const patch = fields(change).map(p => ({ ...p, path: ['properties', propertyId, ...p.path] }))
    patchCollection(collectionId, effective(rawCollection(collectionId), patch), strings.did.editProperty, opts)
  }

  function moveProperty(collectionId: string, propertyId: string, position: Position) {
    const c = collection(collectionId)
    if (c && propertyOf(c, propertyId)) patchCollection(collectionId, orderPatch(['properties'], placeAt(c.properties, [propertyId], position)), strings.did.editProperty)
  }

  /** Every stored view with its fields rewritten where `change` answers something else than they are. */
  function viewPatches(collectionId: string, change: (view: JsonObject) => JsonObject): PatchOp[] {
    const raw = rawCollection(collectionId)
    return entriesById(raw?.views).flatMap(([id, view]) => Object.entries(change(view))
      .filter(([k, v]) => JSON.stringify(view[k]) !== JSON.stringify(v))
      .map(([k, value]): PatchOp => ({ path: ['views', id, k], value })))
  }

  const listOf = (v: Json | undefined): Json[] => (Array.isArray(v) ? v : [])
  const without = (v: Json | undefined, propertyId: string): Json[] => listOf(v).filter(e => !(isObject(e) && e.propertyId === propertyId))
  function filterWithout(v: Json | undefined, propertyId: string): JsonObject {
    const f = isObject(v) ? v : {}
    return { ...f, conditions: without(f.conditions, propertyId) }
  }

  async function setPropertyType(collectionId: string, propertyId: string, type: PropertyType): Promise<boolean> {
    const list = await withItems(collectionId)
    const c = collection(collectionId)
    const property = c && propertyOf(c, propertyId)
    if (!list || !property || type === 'unsupported' || propertyId === TITLE) return false
    if (property.type === type) return true
    const conversion = convertProperty(property, type, list)
    const added = conversion.property.options.filter(o => !property.options.some(e => e.id === o.id))
    const patch: PatchOp[] = [
      { path: ['properties', propertyId, 'type'], value: type },
      ...added.map((o): PatchOp => ({ path: ['properties', propertyId, 'options', o.id], value: { name: o.name, color: o.color, order: o.order } })),
      // Conditions were about the old kind of value.
      ...viewPatches(collectionId, (v): JsonObject => ({
        ...(isObject(v.filter) ? { filter: filterWithout(v.filter, propertyId) } : {}),
        ...(v.groupBy === propertyId && !isGroupable(conversion.property) ? { groupBy: null } : {}),
        ...(v.groupBy === propertyId ? { hiddenGroups: [], collapsedGroups: [] } : {}),
      })),
    ]
    const ok = mutate([
      { ...collectionTarget(collectionId), op: 'patch', patch },
      ...[...conversion.values].map(([id, v]): SourceOp => {
        const value = storedValue(v, conversion.property)
        return { ...itemTarget(collectionId, id), op: 'patch', patch: [value === undefined ? { path: ['values', propertyId] } : { path: ['values', propertyId], value }] }
      }),
    ], strings.did.editProperty)
    if (ok && conversion.lost) undoToast(strings.valuesLost(conversion.lost))
    return ok
  }

  async function deleteProperty(collectionId: string, propertyId: string): Promise<boolean> {
    const list = await withItems(collectionId)
    const c = collection(collectionId)
    const property = c && propertyOf(c, propertyId)
    if (!list || !property) return false
    const patch: PatchOp[] = [
      { path: ['properties', propertyId] },
      ...viewPatches(collectionId, v => ({
        sorts: without(v.sorts, propertyId),
        filter: filterWithout(v.filter, propertyId),
        columns: without(v.columns, propertyId),
        ...(isObject(v.widths) ? { widths: Object.fromEntries(Object.entries(v.widths).filter(([k]) => k !== propertyId)) } : {}),
        ...(v.groupBy === propertyId ? { groupBy: null, hiddenGroups: [], collapsedGroups: [] } : {}),
      })),
    ]
    const ok = mutate([
      { ...collectionTarget(collectionId), op: 'patch', patch },
      ...list.filter(i => propertyId in i.values)
        .map((i): SourceOp => ({ ...itemTarget(collectionId, i.id), op: 'patch', patch: [{ path: ['values', propertyId] }] })),
    ], strings.did.deleteProperty)
    if (ok) undoToast(strings.deletedProperty(property.name))
    return ok
  }

  function addOption(collectionId: string, propertyId: string, name: string, color?: Color): Option | null {
    const c = collection(collectionId)
    const property = c && propertyOf(c, propertyId)
    const label = name.trim()
    if (!property || !label) return null
    const same = property.options.find(o => o.name.trim().toLowerCase() === label.toLowerCase())
    if (same) return same
    const id = newId()
    const place = placeAt(property.options, [id], 'end')
    const base = ['properties', propertyId, 'options']
    const ok = patchCollection(collectionId, [
      { path: [...base, id], value: { name: label, color: color ?? colorAt(property.options.length), order: place.get(id)! } },
      ...orderPatch(base, place, id),
    ], strings.did.editOption)
    return ok ? propertyOf(collection(collectionId)!, propertyId)?.options.find(o => o.id === id) ?? null : null
  }

  function updateOption(collectionId: string, propertyId: string, optionId: string, change: Partial<Pick<Option, 'name' | 'color'>>, opts?: ChangeOptions) {
    const patch = fields(change).map(p => ({ ...p, path: ['properties', propertyId, 'options', optionId, ...p.path] }))
    patchCollection(collectionId, patch, strings.did.editOption, opts)
  }

  function moveOption(collectionId: string, propertyId: string, optionId: string, position: Position) {
    const property = propertyOf(collection(collectionId) ?? EMPTY, propertyId)
    if (!property?.options.some(o => o.id === optionId)) return
    patchCollection(collectionId, orderPatch(['properties', propertyId, 'options'], placeAt(property.options, [optionId], position)), strings.did.editOption)
  }

  async function deleteOption(collectionId: string, propertyId: string, optionId: string, opts: { moveTo?: string | null } = {}): Promise<boolean> {
    const list = await withItems(collectionId)
    const c = collection(collectionId)
    const property = c && propertyOf(c, propertyId)
    const option = property?.options.find(o => o.id === optionId)
    if (!list || !property || !option) return false
    const moveTo = property.options.find(o => o.id === opts.moveTo && o.id !== optionId)?.id ?? null
    const drop = (v: Json | undefined) => listOf(v).filter(e => e !== optionId)
    /** Without it, or with the one that takes its place. */
    const swap = (v: Json | undefined) => (moveTo ? [...new Set(listOf(v).map(e => (e === optionId ? moveTo : e)))] : drop(v))
    const patch: PatchOp[] = [
      { path: ['properties', propertyId, 'options', optionId] },
      ...(property.defaultOption === optionId ? [{ path: ['properties', propertyId, 'defaultOption'], value: moveTo }] : []),
      ...viewPatches(collectionId, (v): JsonObject => {
        const f = isObject(v.filter) ? v.filter : {}
        const conditions = listOf(f.conditions).flatMap((e): Json[] => {
          if (!isObject(e) || e.propertyId !== propertyId || !Array.isArray(e.value) || !e.value.includes(optionId)) return [e]
          const value = swap(e.value)
          return value.length ? [{ ...e, value }] : []
        })
        return {
          filter: { ...f, conditions },
          ...(v.groupBy === propertyId ? { hiddenGroups: drop(v.hiddenGroups), collapsedGroups: drop(v.collapsedGroups) } : {}),
        }
      }),
    ]
    const ok = mutate([
      { ...collectionTarget(collectionId), op: 'patch', patch },
      ...list.flatMap((i): SourceOp[] => {
        const v = i.values[propertyId]
        if (v === optionId) return [{ ...itemTarget(collectionId, i.id), op: 'patch', patch: [moveTo ? { path: ['values', propertyId], value: moveTo } : { path: ['values', propertyId] }] }]
        if (!Array.isArray(v) || !v.includes(optionId)) return []
        return [{ ...itemTarget(collectionId, i.id), op: 'patch', patch: [{ path: ['values', propertyId], value: swap(v) }] }]
      }),
    ], strings.did.deleteOption)
    if (ok) undoToast(strings.deletedOption(option.name))
    return ok
  }

  /* ---- views */

  function addView(collectionId: string, input: NewView, position: Position = 'end'): View | null {
    const c = collection(collectionId)
    if (!c) return null
    const id = newId()
    const keep = storeFallbackView(c)
    const place = placeAt(c.views, [id], position)
    const patch: PatchOp[] = [...keep, { path: ['views', id], value: viewData(input, place.get(id)!) }, ...orderPatch(['views'], place, id)]
    return patchCollection(collectionId, patch, strings.did.editView) ? viewOf(collection(collectionId)!, id) : null
  }

  /** The view shown for want of any becomes a real one before it is changed. */
  function storeFallbackView(c: Collection): PatchOp[] {
    if (entriesById(rawCollection(c.id)?.views).length) return []
    return c.views.map(v => ({ path: ['views', v.id], value: viewData({ ...v, filter: { match: 'and', conditions: [] } }, v.order) }))
  }

  function updateView(collectionId: string, viewId: string, change: ViewChange, opts?: ChangeOptions) {
    const c = collection(collectionId)
    if (!c || !viewOf(c, viewId)) return
    const patch = fields(change).map(p => ({ ...p, path: ['views', viewId, ...p.path] }))
    const onlyLayout = (Object.keys(change) as Array<keyof ViewChange>).every(k => LAYOUT.has(k))
    patchCollection(collectionId, [...storeFallbackView(c), ...effective(rawCollection(collectionId), patch)], onlyLayout ? null : strings.did.editView, opts)
  }

  function duplicateView(collectionId: string, viewId: string): View | null {
    const c = collection(collectionId)
    const view = c && viewOf(c, viewId)
    if (!c || !view) return null
    const id = newId()
    const keep = storeFallbackView(c)
    const raw = readPath(rawCollection(collectionId) ?? {}, ['views', viewId])
    const data = isObject(raw) ? raw : (keep[0]?.value as JsonObject)
    const place = placeAt(c.views, [id], { after: viewId })
    const patch: PatchOp[] = [
      ...keep,
      { path: ['views', id], value: { ...data, name: strings.copyOf(view.name), order: place.get(id)! } },
      ...orderPatch(['views'], place, id),
    ]
    return patchCollection(collectionId, patch, strings.did.duplicate) ? viewOf(collection(collectionId)!, id) : null
  }

  function moveView(collectionId: string, viewId: string, position: Position) {
    const c = collection(collectionId)
    if (c && viewOf(c, viewId)) patchCollection(collectionId, [...storeFallbackView(c), ...orderPatch(['views'], placeAt(c.views, [viewId], position))], strings.did.editView)
  }

  function deleteView(collectionId: string, viewId: string): boolean {
    const c = collection(collectionId)
    const view = c && viewOf(c, viewId)
    if (!c || !view || c.views.length < 2) return false
    const ok = patchCollection(collectionId, [{ path: ['views', viewId] }], strings.did.deleteView)
    if (ok) undoToast(strings.deletedView(view.name))
    return ok
  }

  /* ---- in and out */

  async function exported(collectionId: string, itemIds: readonly string[] | undefined, make: (c: Collection, items: readonly Item[]) => string) {
    const list = await withItems(collectionId)
    const c = collection(collectionId)
    if (!list || !c) return null
    const byId = new Map(list.map(i => [i.id, i]))
    return make(c, itemIds ? itemIds.map(id => byId.get(id)).filter(i => i !== undefined) : list)
  }

  function importOps(collectionId: string, csv: string, existing: readonly Property[], items: readonly Item[]) {
    const plan = planImport(parseCsv(csv), existing)
    const at = Date.now()
    const ids = plan.items.map(newId)
    const last = ordered(items).at(-1)?.order ?? null
    const keys = manyBetween(last, null, ids.length)
    const place = keys ? null : placeAt(items, ids, 'end')
    const byId = new Map([...existing, ...plan.properties].map(p => [p.id, p]))
    const creates = plan.items.map((i, n): SourceOp => ({
      ...itemTarget(collectionId, ids[n]!),
      op: 'create',
      data: {
        title: i.title,
        icon: null,
        body: i.body,
        values: Object.fromEntries(Object.entries(i.values).flatMap(([id, v]) => {
          const stored = storedValue(v, byId.get(id)!)
          return stored === undefined ? [] : [[id, stored]]
        })),
        chats: {},
        order: keys?.[n] ?? place!.get(ids[n]!)!,
        createdAt: at,
      },
    }))
    const reorder = place ? itemOrderOps(collectionId, place, new Set(ids)) : []
    return { plan, ops: [...creates, ...reorder] }
  }

  async function importCsv(collectionId: string, csv: string): Promise<number> {
    const list = await withItems(collectionId)
    const c = collection(collectionId)
    if (!list || !c) return 0
    const { plan, ops } = importOps(collectionId, csv, c.properties, list)
    if (!ops.length) {
      toast(strings.importEmpty)
      return 0
    }
    const patch = plan.properties.flatMap((p): PatchOp[] => {
      const old = propertyOf(c, p.id)
      if (!old) return [{ path: ['properties', p.id], value: propertyData(p) }]
      return p.options.filter(o => !old.options.some(e => e.id === o.id))
        .map(o => ({ path: ['properties', p.id, 'options', o.id], value: { name: o.name, color: o.color, order: o.order } }))
    })
    return await mutateAndWait([{ ...collectionTarget(collectionId), op: 'patch', patch }, ...ops], strings.did.import) ? plan.items.length : 0
  }

  async function importCsvAsCollection(csv: string, name: string, scope?: Scope): Promise<Collection | null> {
    const id = newId()
    const { plan, ops } = importOps(id, csv, [], [])
    if (!ops.length) {
      toast(strings.importEmpty)
      return null
    }
    const template = templateData('empty')
    const keys = spread(plan.properties.length)
    const place = placeAt(allCollections.value, [id], 'end')
    startEmpty(id)
    const ok = await mutateAndWait([{
      ...collectionTarget(id),
      op: 'create',
      data: {
        ...template,
        name: name.trim() || strings.newCollection,
        properties: Object.fromEntries(plan.properties.map((p, i) => [p.id, propertyData({ ...p, order: keys[i]! })])),
        scope: json(scope ?? (projectPath.value ? { kind: 'project', path: projectPath.value } : { kind: 'everywhere' })),
        order: place.get(id)!,
        createdAt: Date.now(),
      },
    }, ...reorderOps(place, id), ...ops], strings.did.import)
    return ok ? collection(id) : null
  }

  /* ---- what was open */

  const uiKey = () => `ui:${projectPath.value ? projectKey(projectPath.value) : ''}`
  // Read each time: another window may have written it.
  function ui(): UiState {
    const v = mango.storage.get<unknown>(uiKey())
    return isObject(v) ? (v as UiState) : {}
  }

  /* ---- living */

  const unsubscribe = source.subscribe(docs => publish(take(docs)), () => { void resync() })
  const unsubscribeStatus = source.onStatus((s) => {
    const back = s.online && !sourceStatus.value.online
    sourceStatus.value = s
    if (back && unsaved.length) settleDeferred()
  })
  const project = mango.workspace.onProjectChange((path) => { projectPath.value = path })
  const clock = setInterval(() => { now.value = Date.now() }, 60_000)
  const leave = () => settleDeferred()
  const hasWindow = typeof window !== 'undefined'
  if (hasWindow) {
    window.addEventListener('pagehide', leave)
    window.addEventListener('beforeunload', leave)
    window.addEventListener('blur', leave)
  }

  async function flush() {
    settleDeferred()
    await chain
  }

  async function flushAll() {
    if (hasWindow) window.dispatchEvent(new Event('planner:commit'))
    let before: Promise<void>
    do {
      settleDeferred()
      // A change that waits for items to load is made right after.
      await Promise.allSettled(loadingItems.values())
      await new Promise(resolve => setTimeout(resolve))
      before = chain
      await chain
    } while (deferred || chain !== before)
  }

  function dispose() {
    if (disposed) return
    settleDeferred()
    disposed = true
    clearInterval(clock)
    project.dispose()
    unsubscribeStatus()
    if (hasWindow) {
      window.removeEventListener('pagehide', leave)
      window.removeEventListener('beforeunload', leave)
      window.removeEventListener('blur', leave)
    }
    void chain.finally(() => {
      unsubscribe()
      source.dispose()
    })
  }

  void load()

  return {
    status, error, sourceStatus, projectPath, allCollections, collections, now, saving,
    collection, items, item, load, loadItems,
    itemsForChat: threadId => [...itemStates.values()].flatMap(s => s.items.filter(i => i.chats.includes(threadId))),

    createCollection, updateCollection, moveCollection, duplicateCollection, deleteCollection,
    createItem,
    updateItem: (c, id, change, opts) => changeItems(c, [id], change, opts),
    updateItems: (c, ids, change) => changeItems(c, ids, change),
    updateEach: changeEach,
    moveItems, duplicateItems, deleteItems,
    linkChat: (c, id, threadId) => setChat(c, id, threadId, true),
    unlinkChat: (c, id, threadId) => setChat(c, id, threadId, false),

    addProperty, renameProperty, updateProperty, moveProperty, setPropertyType, deleteProperty,
    addOption, updateOption, moveOption, deleteOption,
    addView, updateView, duplicateView, moveView, deleteView,

    exportCsv: (id, ids) => exported(id, ids, toCsv),
    exportMarkdown: (id, ids) => exported(id, ids, toMarkdown),
    importCsv, importCsvAsCollection,

    canUndo: computed(() => undoStack.value.length > 0),
    canRedo: computed(() => redoStack.value.length > 0),
    undoLabel: computed(() => undoStack.value.at(-1)?.label ?? null),
    redoLabel: computed(() => redoStack.value.at(-1)?.label ?? null),
    undo, redo,

    lastCollection: () => ui().collection ?? null,
    rememberCollection: (id) => { mango.storage.set(uiKey(), { ...ui(), collection: id ?? undefined }) },
    lastView: id => ui().views?.[id] ?? null,
    rememberView: (id, viewId) => { mango.storage.set(uiKey(), { ...ui(), views: { ...ui().views, [id]: viewId } }) },

    identifyProject: (next) => { identity.value = next },
    flush, flushAll, dispose,
  }
}

/** Stands in for a collection that is gone. */
const EMPTY = { properties: [] as readonly Property[] } as Collection
