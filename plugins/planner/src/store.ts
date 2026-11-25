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
import type { PlannerSource, SourceDoc, SourceOp, SourceStatus } from './data/source.ts'
import type { MangoPluginApi } from './host.ts'
import {
  colorAt, isGroupable, isInScope, newId, normalizeCollection, normalizeItem, ordered, projectKey, propertyOf,
  storedValue, TITLE, viewOf, type Collection, type Color, type Item, type Option, type Property, type PropertyType,
  type Scope, type Value, type View,
} from './model.ts'
import { manyBetween, placeAt, spread, type Position } from './order.ts'
import { applyPatch, entriesById, invertPatch, isObject, readPath, type Json, type JsonObject, type Patch, type PatchOp } from './patch.ts'
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
export type CollectionChange = Partial<Pick<Collection, 'name' | 'icon' | 'color' | 'scope'>>

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
  /** For text while it is typed: written after a pause (or `flush`), one undo step per pause. */
  defer?: boolean
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
  /** Each item its own change, as one step to undo. */
  updateEach(collectionId: string, changes: ReadonlyMap<string, ItemChange>): void
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
  moveProperty(collectionId: string, propertyId: string, position: Position): void
  /** Converts every item's value. */
  setPropertyType(collectionId: string, propertyId: string, type: PropertyType): Promise<boolean>
  deleteProperty(collectionId: string, propertyId: string): Promise<boolean>
  /** The option of this name, made when there is none. */
  addOption(collectionId: string, propertyId: string, name: string, color?: Color): Option | null
  updateOption(collectionId: string, propertyId: string, optionId: string, change: Partial<Pick<Option, 'name' | 'color'>>, options?: ChangeOptions): void
  moveOption(collectionId: string, propertyId: string, optionId: string, position: Position): void
  deleteOption(collectionId: string, propertyId: string, optionId: string): Promise<boolean>

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
  /** Into a collection: columns join properties of the same name. Answers how many items came in. */
  importCsv(collectionId: string, csv: string): Promise<number>
  importCsvAsCollection(csv: string, name: string, scope?: Scope): Promise<Collection | null>

  /* ---- undo */
  readonly canUndo: ComputedRef<boolean>
  readonly canRedo: ComputedRef<boolean>
  /** What it would undo or redo, e.g. `delete item`. */
  readonly undoLabel: ComputedRef<string | null>
  readonly redoLabel: ComputedRef<string | null>
  undo(): void
  redo(): void

  /* ---- what was open, per project, kept across restarts */
  lastCollection(): string | null
  rememberCollection(collectionId: string | null): void
  lastView(collectionId: string): string | null
  rememberView(collectionId: string, viewId: string): void

  /** Writes what is waiting; resolves when nothing is under way. */
  flush(): Promise<void>
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
}

/* ---------------------------------------------------------------- internals */

/** One change: its operations, and what takes it back. */
interface Mutation {
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
  const collections = computed(() => allCollections.value.filter(c => isInScope(c.scope, projectPath.value)))
  const undoStack: ShallowRef<readonly UndoEntry[]> = shallowRef([])
  const redoStack: ShallowRef<readonly UndoEntry[]> = shallowRef([])

  const entries = new Map<string, Entry>()
  const itemStates = new Map<string, MutableItems>()
  const itemModels = new Map<string, Map<string, Item>>()
  const loadingItems = new Map<string, Promise<boolean>>()

  let disposed = false
  let deferred: Mutation | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  /** Text that could not be written: still shown, and written again with the next change. */
  let unsaved: Mutation[] = []
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
    return e.pending.reduce<JsonObject | null>(
      (data, m) => applyOps(data, m.ops.filter(o => o.kind === e.kind && o.id === e.id && o.collectionId === e.collectionId)),
      e.base?.data ?? null,
    )
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
  function mutate(ops: SourceOp[], label: string | null, opts: ChangeOptions = {}): boolean {
    ops = ops.filter(o => o.op !== 'patch' || o.patch.length)
    if (!ops.length) return true
    if (sourceStatus.value.readonly) {
      toast(strings.readonly, sourceStatus.value.message)
      return false
    }
    if (opts.defer) {
      addDeferred(ops, label)
      return true
    }
    settleDeferred()
    const m = newMutation(ops, label, false)
    show(m)
    enqueue(m)
    return true
  }

  function newMutation(ops: SourceOp[], label: string | null, isDeferred: boolean): Mutation {
    const undoEntry = label === null ? null : { label, undo: inverseOf(ops), redo: [...ops] }
    if (undoEntry) record(undoEntry)
    return { ops, at: Date.now(), deferred: isDeferred, undoEntry }
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
  function addDeferred(ops: SourceOp[], label: string | null) {
    if (deferred) {
      const m = deferred
      m.at = Date.now()
      const fresh: SourceOp[] = []
      for (const op of ops) {
        if (op.op !== 'patch' || !replaceIn(m.ops, op)) fresh.push(op)
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
    timer = setTimeout(settleDeferred, deferMs)
  }

  /** Replaces the values of a patch that is waiting already; false when one of its fields is not in it. */
  function replaceIn(ops: SourceOp[], op: SourceOp & { op: 'patch' }): boolean {
    const at = ops.findIndex(o => o.op === 'patch' && keyOf(o) === keyOf(op) && op.patch.every(p => o.patch.some(q => samePath(p.path, q.path))))
    const old = ops[at]
    if (old?.op !== 'patch') return false
    ops[at] = { ...old, patch: old.patch.map(q => op.patch.findLast(p => samePath(p.path, q.path)) ?? q) }
    return true
  }

  /** Hands what is waiting to the writer. */
  function settleDeferred() {
    clearTimeout(timer)
    const again = unsaved
    unsaved = []
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

  async function writeOut(m: Mutation) {
    try {
      const docs = await source.write(m.ops)
      take(docs)
      hide(m)
      const patched = new Set(m.ops.filter(o => o.op === 'patch').map(keyOf))
      const removed = new Set(m.ops.filter(o => o.op === 'delete').map(keyOf))
      if (docs.some(d => d.data === null && patched.has(keyOf(d)) && !removed.has(keyOf(d)))) toast(strings.saveFailed, strings.gone)
    } catch (e) {
      mango.log.error('Saving:', e)
      if (m.deferred && !disposed) {
        unsaved.push(m)
        return toast(strings.saveFailed, messageOf(e), { label: strings.retry, run: settleDeferred })
      }
      hide(m)
      if (m.undoEntry) {
        undoStack.value = undoStack.value.filter(u => u !== m.undoEntry)
        redoStack.value = redoStack.value.filter(u => u !== m.undoEntry)
      }
      toast(strings.saveFailed, messageOf(e))
    }
  }

  function step(from: typeof undoStack, to: typeof redoStack, which: 'undo' | 'redo') {
    settleDeferred()
    const entry = from.value.at(-1)
    if (!entry) return
    const m: Mutation = { ops: [...entry[which]], at: Date.now(), deferred: false, undoEntry: entry }
    if (sourceStatus.value.readonly) return toast(strings.readonly, sourceStatus.value.message)
    from.value = from.value.slice(0, -1)
    to.value = [...to.value, entry]
    if (!m.ops.length) return
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
          mutate([...entry.undo], null)
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
    const values = { ...(view ? defaultValues(c, view, input.group, at) : {}), ...input.values }
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
    ], strings.did.createItem)
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

  function changeEach(collectionId: string, changes: ReadonlyMap<string, ItemChange>) {
    const c = collection(collectionId)
    if (!c) return
    mutate([...changes].map(([id, change]): SourceOp => ({
      ...itemTarget(collectionId, id), op: 'patch', patch: effective(rawItem(collectionId, id), itemPatch(c, change)),
    })), strings.did.editItem)
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
    let list = stateOf(collectionId).items
    const at = Date.now()
    const ops: SourceOp[] = []
    const copies: string[] = []
    for (const original of list.filter(i => itemIds.includes(i.id))) {
      const raw = rawItem(collectionId, original.id)
      if (!raw) continue
      const id = newId()
      const place = placeAt(list, [id], { after: original.id })
      const data: JsonObject = { ...raw, title: strings.copyOf(original.title), order: place.get(id)!, chats: {}, createdAt: at }
      ops.push({ ...itemTarget(collectionId, id), op: 'create', data }, ...itemOrderOps(collectionId, place, new Set([id])))
      // The next copy is placed among these.
      list = [...list.map(i => (place.has(i.id) ? { ...i, order: place.get(i.id)! } : i)), { ...original, id, order: place.get(id)! }]
      copies.push(id)
    }
    if (!mutate(ops, strings.did.duplicate)) return []
    return copies.map(id => item(collectionId, id)).filter(i => i !== null)
  }

  function deleteItems(collectionId: string, itemIds: readonly string[]) {
    const ids = [...new Set(itemIds)].filter(id => rawItem(collectionId, id))
    if (!ids.length) return
    const ok = mutate(ids.map((id): SourceOp => ({ ...itemTarget(collectionId, id), op: 'delete' })), strings.did.deleteItems(ids.length))
    if (ok) undoToast(strings.deletedItems(ids.length))
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

  async function deleteOption(collectionId: string, propertyId: string, optionId: string): Promise<boolean> {
    const list = await withItems(collectionId)
    const c = collection(collectionId)
    const option = c && propertyOf(c, propertyId)?.options.find(o => o.id === optionId)
    if (!list || !option) return false
    const drop = (v: Json | undefined) => listOf(v).filter(e => e !== optionId)
    const patch: PatchOp[] = [
      { path: ['properties', propertyId, 'options', optionId] },
      ...viewPatches(collectionId, (v): JsonObject => {
        const f = isObject(v.filter) ? v.filter : {}
        const conditions = listOf(f.conditions).flatMap((e): Json[] => {
          if (!isObject(e) || e.propertyId !== propertyId || !Array.isArray(e.value) || !e.value.includes(optionId)) return [e]
          const value = drop(e.value)
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
        if (v === optionId) return [{ ...itemTarget(collectionId, i.id), op: 'patch', patch: [{ path: ['values', propertyId] }] }]
        if (!Array.isArray(v) || !v.includes(optionId)) return []
        return [{ ...itemTarget(collectionId, i.id), op: 'patch', patch: [{ path: ['values', propertyId], value: drop(v) }] }]
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
    return mutate([{ ...collectionTarget(collectionId), op: 'patch', patch }, ...ops], strings.did.import) ? plan.items.length : 0
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
    const ok = mutate([{
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

  const unsubscribe = source.subscribe(docs => publish(take(docs)))
  const unsubscribeStatus = source.onStatus((s) => { sourceStatus.value = s })
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

    addProperty, renameProperty, moveProperty, setPropertyType, deleteProperty,
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

    flush, dispose,
  }
}

/** Stands in for a collection that is gone. */
const EMPTY = { properties: [] as readonly Property[] } as Collection
