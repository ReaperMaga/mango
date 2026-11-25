/**
 * The planner's store and local source against a stand-in for `mango.data`: optimistic changes, taking them back,
 * two windows editing at once, undo, references of deleted things.
 *
 *   node --test tests/plannerStore.test.ts     (or: pnpm test)
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LocalSource } from '../plugins/planner/src/data/local.ts'
import type { PluginDataApi, PluginDataChange, PluginDataOp, PluginDoc } from '../plugins/planner/src/host.ts'
import { createStore, type PlannerStore, type StoreHost } from '../plugins/planner/src/store.ts'
import { runQuery } from '../plugins/planner/src/query.ts'

/** The database several windows share. */
class Db {
  docs = new Map<string, PluginDoc>()
  seq = 0
  listeners = new Set<(c: PluginDataChange, from: PluginDataApi) => void>()
  writes = 0
  fail: string | null = null
  /** Runs once, just before the next write lands. */
  before: (() => void) | null = null

  apply(ops: PluginDataOp[], from: PluginDataApi): PluginDoc[] {
    this.writes++
    if (this.fail) throw new Error(this.fail)
    assert.ok(ops.length <= 2000)
    const next = new Map(this.docs)
    const conflicts: PluginDoc[] = []
    const out: PluginDoc[] = []
    for (const op of ops) {
      const key = `${op.collection}/${op.id}`
      const now = next.get(key) ?? { collection: op.collection, id: op.id, rev: 0, seq: 0, createdAt: 0, updatedAt: 0, deleted: true, data: null }
      if (op.expectedRev !== undefined && op.expectedRev !== now.rev && !(op.expectedRev === 0 && now.deleted)) {
        conflicts.push(now)
        continue
      }
      const doc: PluginDoc = {
        ...now, rev: now.rev + 1, seq: ++this.seq, createdAt: now.deleted ? 5 : now.createdAt, updatedAt: 6,
        deleted: op.op === 'delete', data: op.op === 'put' ? JSON.parse(JSON.stringify(op.data)) : null,
      }
      next.set(key, doc)
      out.push(doc)
    }
    if (conflicts.length) throw Object.assign(new Error('conflict'), { conflicts })
    this.docs = next
    for (const l of [...this.listeners]) l({ seq: this.seq, docs: out, local: false }, from)
    return out
  }

  window(): PluginDataApi {
    const api: PluginDataApi = {
      list: async <T>(c: string) => structuredClone([...this.docs.values()].filter(d => d.collection === c && !d.deleted)) as PluginDoc<T>[],
      get: async <T>(c: string, id: string) => structuredClone(this.docs.get(`${c}/${id}`) ?? null) as PluginDoc<T> | null,
      write: async (ops) => {
        const before = this.before
        this.before = null
        before?.()
        return this.apply(ops, api)
      },
      changes: async () => ({ seq: this.seq, docs: [...this.docs.values()] }),
      onChange: (handler) => {
        const l = (c: PluginDataChange, from: PluginDataApi) => handler({ ...c, local: from === api })
        this.listeners.add(l)
        return { dispose: () => { this.listeners.delete(l) } }
      },
    }
    return api
  }
}

interface Toast { title: string; body?: string; action?: { label: string; run(): void } }
const stores: PlannerStore[] = []

function open(db: Db, project: string | null = '/p') {
  const toasts: Toast[] = []
  const kept = new Map<string, unknown>()
  let onProject: (p: string | null) => void = () => {}
  const host: StoreHost = {
    data: db.window(),
    storage: {
      get: <T>(k: string) => kept.get(k) as T | undefined, set: (k, v) => { kept.set(k, v) },
      delete: (k) => { kept.delete(k) }, keys: () => [...kept.keys()],
    },
    workspace: { activeProject: () => project, onProjectChange: (h) => { onProject = h; return { dispose() {} } } },
    ui: { toast: (t) => { toasts.push(t) } },
    log: { error() {} },
  }
  const store = createStore(host, { deferMs: 5 })
  stores.push(store)
  return { store, toasts, switchTo: (p: string | null) => onProject(p) }
}
const settle = () => new Promise(r => setTimeout(r, 2))
async function ready(store: PlannerStore) {
  while (store.status.value === 'loading') await settle()
}
test.afterEach(() => { for (const s of stores.splice(0)) s.dispose() })

async function withTasks() {
  const db = new Db()
  const a = open(db)
  await ready(a.store)
  const c = a.store.createCollection({ template: 'tasks' })!
  const [x, y] = [(await a.store.createItem(c.id, { title: 'X' }))!, (await a.store.createItem(c.id, { title: 'Y' }))!]
  await a.store.flush()
  const status = c.properties[0]!
  return { db, ...a, c, x, y, status, option: (name: string) => status.options.find(o => o.name === name)!.id }
}

test('nothing is written until the user makes something', async () => {
  const db = new Db()
  const { store } = open(db)
  await ready(store)
  assert.equal(store.status.value, 'ready')
  assert.equal(db.writes, 0)
})

test('changes show at once, are written, and reach other windows', async () => {
  const { db, store, c, x } = await withTasks()
  const other = open(db)
  await ready(other.store)
  assert.ok(await other.store.loadItems(c.id))
  store.updateItem(c.id, x.id, { title: 'X2' })
  assert.equal(store.item(c.id, x.id)!.title, 'X2')
  await store.flush()
  assert.equal(other.store.item(c.id, x.id)!.title, 'X2')
  assert.equal(store.saving.value, false)
})

test('two windows editing different fields both win', async () => {
  const { db, store, c, x, option, status } = await withTasks()
  const other = open(db)
  await ready(other.store)
  await other.store.loadItems(c.id)
  store.updateItem(c.id, x.id, { title: 'mine' })
  other.store.updateItem(c.id, x.id, { values: { [status.id]: option('Done') } })
  store.renameProperty(c.id, status.id, 'State')
  other.store.addOption(c.id, status.id, 'Later')
  await Promise.all([store.flush(), other.store.flush()])
  for (const s of [store, other.store]) {
    assert.equal(s.item(c.id, x.id)!.title, 'mine')
    assert.equal(s.item(c.id, x.id)!.values[status.id], option('Done'))
    const p = s.collection(c.id)!.properties[0]!
    assert.deepEqual([p.name, p.options.length], ['State', 4])
  }
})

test('the source retries a patch on what is there now, and keeps fields it does not know', async () => {
  const db = new Db()
  const [one, two] = [db.window(), db.window()]
  const source = new LocalSource(one)
  const at = { kind: 'item', id: 'i', collectionId: 'c' } as const
  await source.write([{ ...at, op: 'create', data: { title: 'a' } }])
  // Another window writes unheard, right before.
  db.listeners.clear()
  db.before = () => db.apply([{ op: 'put', collection: 'items_c', id: 'i', data: { title: 'a', future: [1] } }], two)
  const [doc] = await source.write([{ ...at, op: 'patch', patch: [{ path: ['title'], value: 'b' }] }])
  assert.deepEqual(doc!.data, { title: 'b', future: [1] })
  // Gone meanwhile: a tombstone, not an error.
  db.before = () => db.apply([{ op: 'delete', collection: 'items_c', id: 'i' }], two)
  const [gone] = await source.write([{ ...at, op: 'patch', patch: [{ path: ['title'], value: 'c' }] }])
  assert.equal(gone!.data, null)
  await assert.rejects(async () => {
    await source.write([{ ...at, op: 'create', data: {} }])
    await source.write([{ ...at, op: 'create', data: {} }])
  })
  source.dispose()
})

test('a large write is made in several', async () => {
  const db = new Db()
  const source = new LocalSource(db.window())
  await source.write(Array.from({ length: 3200 }, (_, i) => ({ kind: 'item' as const, id: `i${i}`, collectionId: 'c', op: 'create' as const, data: {} })))
  assert.equal(db.docs.size, 3200)
  source.dispose()
})

test('a failed write is taken back with a toast, a failed text stays', async () => {
  const { db, store, toasts, c, x } = await withTasks()
  db.fail = 'disk full'
  store.updateItem(c.id, x.id, { icon: 'bug' })
  const made = await store.createItem(c.id, { title: 'Z' })
  assert.ok(store.item(c.id, made!.id))
  await store.flush()
  assert.equal(store.item(c.id, x.id)!.icon, null)
  assert.equal(store.item(c.id, made!.id), null)
  assert.equal(toasts.length, 1)
  assert.equal(toasts[0]!.body, 'disk full')

  store.updateItem(c.id, x.id, { body: 'long text' }, { defer: true })
  await store.flush()
  assert.equal(store.item(c.id, x.id)!.body, 'long text')
  assert.equal(store.saving.value, true)
  db.fail = null
  await store.flush()
  assert.equal((db.docs.get(`items_${c.id}/${x.id}`)!.data as { body: string }).body, 'long text')
  assert.equal(store.saving.value, false)
})

test('typed text is written once per pause and undone as one step', async () => {
  const { db, store, c, x } = await withTasks()
  const writes = db.writes
  for (const t of ['H', 'He', 'Hey']) store.updateItem(c.id, x.id, { title: t }, { defer: true })
  store.updateItem(c.id, x.id, { body: 'b' }, { defer: true })
  assert.equal(db.writes, writes)
  await new Promise(r => setTimeout(r, 25))
  assert.equal(db.writes, writes + 1)
  store.undo()
  assert.deepEqual([store.item(c.id, x.id)!.title, store.item(c.id, x.id)!.body], ['X', ''])
  store.redo()
  assert.deepEqual([store.item(c.id, x.id)!.title, store.item(c.id, x.id)!.body], ['Hey', 'b'])
  await store.flush()
})

test('disposing writes what was typed', async () => {
  const { db, store, c, x } = await withTasks()
  store.updateItem(c.id, x.id, { title: 'last' }, { defer: true })
  store.dispose()
  await store.flush()
  assert.equal((db.docs.get(`items_${c.id}/${x.id}`)!.data as { title: string }).title, 'last')
})

test('moving sets the group and the place as one change', async () => {
  const { db, store, c, x, y, status, option } = await withTasks()
  const writes = db.writes
  store.moveItems(c.id, { ids: [y.id], group: { propertyId: status.id, key: option('Done') }, position: { before: x.id } })
  assert.deepEqual(store.items(c.id).items.map(i => i.title), ['Y', 'X'])
  assert.equal(store.item(c.id, y.id)!.values[status.id], option('Done'))
  await store.flush()
  assert.equal(db.writes, writes + 1)
  store.undo()
  assert.deepEqual(store.items(c.id).items.map(i => [i.title, i.values]), [['X', {}], ['Y', {}]])
  await store.flush()
})

test('new items fit the view and group they are made in', async () => {
  const { store, c, status, option } = await withTasks()
  const board = c.views[0]!
  const made = (await store.createItem(c.id, { viewId: board.id, group: option('In progress') }))!
  assert.equal(made.values[status.id], option('In progress'))
  const result = runQuery(store.collection(c.id)!, store.items(c.id).items, board)
  assert.deepEqual(result.groups.find(g => g.name === 'In progress')!.items.map(i => i.id), [made.id])
})

test('deleting is undone by its toast, after other changes too', async () => {
  const { db, store, toasts, c, x, y } = await withTasks()
  const before = store.item(c.id, x.id)!
  store.deleteItems(c.id, [x.id, y.id])
  assert.equal(store.items(c.id).items.length, 0)
  await store.flush()
  await store.createItem(c.id, { title: 'new' })
  toasts.at(-1)!.action!.run()
  await store.flush()
  assert.deepEqual(store.items(c.id).items.map(i => i.title).sort(), ['X', 'Y', 'new'])
  assert.equal(store.item(c.id, x.id)!.createdAt, before.createdAt)
  assert.equal(db.docs.get(`items_${c.id}/${x.id}`)!.deleted, false)
})

test('a deleted collection goes with its items and comes back with them', async () => {
  const { db, store, c } = await withTasks()
  assert.ok(await store.deleteCollection(c.id))
  await store.flush()
  assert.ok([...db.docs.values()].every(d => d.deleted))
  assert.deepEqual(store.collections.value, [])
  store.undo()
  await store.flush()
  assert.equal(store.collection(c.id)!.name, 'Tasks')
  assert.equal(store.items(c.id).items.length, 2)
})

test('deleting a property or an option takes every reference along, undo brings them back', async () => {
  const { store, c, x, status, option } = await withTasks()
  const [board, table] = [c.views[0]!, c.views[1]!]
  store.updateItem(c.id, x.id, { values: { [status.id]: option('Done') } })
  store.updateView(c.id, board.id, { hiddenGroups: [option('Done'), option('To do')] })
  store.updateView(c.id, table.id, {
    sorts: [{ propertyId: status.id, direction: 'asc' }],
    filter: { match: 'and', conditions: [{ id: '1', propertyId: status.id, operator: 'is', value: [option('Done'), option('To do')] }] },
    widths: { [status.id]: 100 },
  })
  assert.ok(await store.deleteOption(c.id, status.id, option('Done')))
  assert.equal(status.id in store.item(c.id, x.id)!.values, false)
  assert.deepEqual(store.collection(c.id)!.views[0]!.hiddenGroups, [option('To do')])
  assert.deepEqual(store.collection(c.id)!.views[1]!.filter.conditions[0]!.value, [option('To do')])
  store.undo()
  assert.equal(store.item(c.id, x.id)!.values[status.id], option('Done'))

  assert.ok(await store.deleteProperty(c.id, status.id))
  await store.flush()
  const now = store.collection(c.id)!
  assert.equal(now.properties.length, 2)
  assert.notEqual(now.views[0]!.groupBy, status.id)
  assert.deepEqual([now.views[1]!.sorts, now.views[1]!.filter.conditions, now.views[1]!.widths], [[], [], {}])
  assert.deepEqual(store.item(c.id, x.id)!.values, {})
  store.undo()
  await store.flush()
  const back = store.collection(c.id)!
  assert.equal(back.views[0]!.groupBy, status.id)
  assert.equal(back.views[1]!.sorts.length, 1)
  assert.equal(store.item(c.id, x.id)!.values[status.id], option('Done'))
})

test('changing a type converts values and drops filters that made sense before', async () => {
  const { store, c, x, status, option } = await withTasks()
  store.updateItem(c.id, x.id, { values: { [status.id]: option('Done') } })
  store.updateView(c.id, c.views[0]!.id, { filter: { match: 'and', conditions: [{ id: '1', propertyId: status.id, operator: 'is', value: [option('Done')] }] } })
  assert.ok(await store.setPropertyType(c.id, status.id, 'text'))
  assert.equal(store.item(c.id, x.id)!.values[status.id], 'Done')
  assert.deepEqual(store.collection(c.id)!.views[0]!.filter.conditions, [])
  assert.ok(await store.setPropertyType(c.id, status.id, 'select'))
  assert.equal(store.item(c.id, x.id)!.values[status.id], option('Done'))
  await store.flush()
})

test('views: added, changed, duplicated, moved, never all deleted', async () => {
  const { store, c } = await withTasks()
  const [board, table] = [c.views[0]!, c.views[1]!]
  const copy = store.duplicateView(c.id, board.id)!
  assert.deepEqual(store.collection(c.id)!.views.map(v => v.id), [board.id, copy.id, table.id])
  store.moveView(c.id, copy.id, 'end')
  assert.equal(store.collection(c.id)!.views.at(-1)!.id, copy.id)
  const label = store.undoLabel.value
  store.updateView(c.id, board.id, { widths: { title: 300 } })
  assert.equal(store.undoLabel.value, label)
  assert.equal(store.collection(c.id)!.views[0]!.widths.title, 300)
  assert.ok(store.deleteView(c.id, board.id))
  assert.ok(store.deleteView(c.id, table.id))
  assert.equal(store.deleteView(c.id, copy.id), false)
  await store.flush()
})

test('a collection stored without views gets a real one when it is changed', async () => {
  const db = new Db()
  db.apply([{ op: 'put', collection: 'collections', id: 'c', data: { name: 'Bare' } }], db.window())
  const { store } = open(db)
  await ready(store)
  store.updateView('c', 'default', { name: 'Mine' })
  await store.flush()
  assert.deepEqual(store.collection('c')!.views.map(v => v.name), ['Mine'])
  assert.ok((db.docs.get('collections/c')!.data as { views: object }).views)
})

test('collections follow the project; what was open is remembered per project', async () => {
  const { store, switchTo, c } = await withTasks()
  const shared = store.createCollection({ name: 'All', scope: { kind: 'everywhere' } })!
  assert.deepEqual(store.collections.value.map(e => e.name), ['Tasks', 'All'])
  store.rememberCollection(c.id)
  store.rememberView(c.id, 'v')
  switchTo('/other')
  assert.deepEqual(store.collections.value.map(e => e.id), [shared.id])
  assert.equal(store.lastCollection(), null)
  switchTo('/p/')
  assert.equal(store.lastCollection(), c.id)
  assert.equal(store.lastView(c.id), 'v')
})

test('duplicates, chats, and csv in and out', async () => {
  const { store, c, x, y } = await withTasks()
  const copies = store.duplicateItems(c.id, [x.id, y.id])
  assert.equal(copies.length, 2)
  assert.deepEqual(store.items(c.id).items.map(i => i.title), ['X', 'X (copy)', 'Y', 'Y (copy)'])
  store.linkChat(c.id, x.id, 't1')
  store.linkChat(c.id, x.id, 't2')
  assert.deepEqual(store.itemsForChat('t2').map(i => i.id), [x.id])
  store.unlinkChat(c.id, x.id, 't1')
  assert.deepEqual(store.item(c.id, x.id)!.chats, ['t2'])

  const csv = (await store.exportCsv(c.id))!
  const made = (await store.importCsvAsCollection(csv, 'Imported'))!
  assert.equal(store.items(made.id).items.length, 4)
  assert.equal(await store.importCsv(c.id, 'Title,Status,Cost\nN,Blocked,3\n'), 1)
  const now = store.collection(c.id)!
  assert.deepEqual(now.properties[0]!.options.map(o => o.name), ['To do', 'In progress', 'Done', 'Blocked'])
  assert.equal(now.properties.at(-1)!.name, 'Cost')
  const last = store.items(c.id).items.at(-1)!
  assert.deepEqual([last.title, last.values[now.properties.at(-1)!.id]], ['N', 3])
  const copy = (await store.duplicateCollection(c.id, { items: true }))!
  assert.equal(store.items(copy.id).items.length, 5)
  await store.flush()
  assert.ok((await store.exportMarkdown(copy.id))!.includes('## N'))
})

test('a read that fails says so and can be tried again', async () => {
  const { db, c } = await withTasks()
  const { store } = open(db)
  await ready(store)
  const state = store.items(c.id)
  await settle()
  assert.equal(state.status, 'ready')

  const broken = db.window()
  broken.list = async () => { throw new Error('locked') }
  const source = new LocalSource(broken)
  const failing = createStore({
    data: broken, storage: { get: () => undefined, set() {}, delete() {}, keys: () => [] },
    workspace: { activeProject: () => null, onProjectChange: () => ({ dispose() {} }) }, ui: { toast() {} }, log: { error() {} },
  }, { source })
  stores.push(failing)
  await ready(failing)
  assert.deepEqual([failing.status.value, failing.error.value], ['error', 'locked'])
  broken.list = db.window().list
  await failing.load()
  assert.equal(failing.status.value, 'ready')
  assert.equal(failing.allCollections.value.length, 1)
})
