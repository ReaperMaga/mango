/**
 * The planner's remote source against a stand-in planner server (planner-server/PROTOCOL.md, in memory), and the
 * routed source that puts each collection on this computer or the server, under the real store.
 *
 *   node --test tests/plannerRemote.test.ts     (or: pnpm test)
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventReader, RemoteSource, serverUrl } from '../plugins/planner/src/data/remote.ts'
import { HERE, RoutedSource, SERVER } from '../plugins/planner/src/data/routed.ts'
import { SourceError, type PlannerSource, type SourceDoc, type SourceOp, type SourceStatus } from '../plugins/planner/src/data/source.ts'
import { applyPatch, type JsonObject } from '../plugins/planner/src/patch.ts'
import { createStore, type PlannerStore, type StoreHost } from '../plugins/planner/src/store.ts'

/* ---------------------------------------------------------------- a planner server, in memory */

type Doc = SourceDoc
const URL_ = 'https://planner.test'

class FakeServer {
  docs = new Map<string, Doc>()
  seq = 0
  mutations = new Map<string, string[]>()
  tokens = new Map([['pls_write', 'write'], ['pls_read', 'read']])
  streams = new Set<{ push(event: string, data: unknown): void; close(): void }>()
  requests: Array<{ method: string; path: string; body?: unknown }> = []
  down = false

  key = (kind: string, id: string) => `${kind}/${id}`

  write(ops: SourceOp[], mutationId: string) {
    const named: string[] = []
    if (!this.mutations.has(mutationId)) {
      const changed = new Map<string, Doc>()
      for (const op of ops) {
        const k = this.key(op.kind, op.id)
        if (!named.includes(k)) named.push(k)
        const now = changed.get(k) ?? this.docs.get(k)
        let data = now?.data ?? null
        if (op.op === 'create') { if (!data) data = op.data }
        else if (op.op === 'patch') { if (data) data = applyPatch(data, op.patch) }
        else data = null
        if (data === (now?.data ?? null)) continue
        changed.set(k, { kind: op.kind, id: op.id, collectionId: op.collectionId, seq: 0, createdAt: now?.createdAt || 1, updatedAt: 2, data })
      }
      if (changed.size) {
        const seq = ++this.seq
        const out = [...changed.values()].map(d => ({ ...d, seq }))
        out.forEach(d => this.docs.set(this.key(d.kind, d.id), d))
        this.publish(seq, out)
      }
      this.mutations.set(mutationId, named)
    }
    const list = this.mutations.get(mutationId)!
    return list.map(k => this.docs.get(k) ?? { kind: k.split('/')[0], id: k.split('/')[1], collectionId: '', seq: 0, createdAt: 0, updatedAt: 0, data: null })
  }

  publish(seq: number, docs: Doc[]) {
    for (const s of this.streams) s.push('docs', { seq, docs: structuredClone(docs) })
  }

  /** Someone else's write. */
  others(ops: SourceOp[]) {
    return this.write(ops, `other-${Math.random()}`)
  }

  hello(role: string) {
    return { protocol: 1, server: 'fake', space: { id: 'team', name: 'Team' }, role, seq: this.seq }
  }

  fetch: typeof fetch = async (input, init) => {
    if (this.down) throw new TypeError('fetch failed')
    const url = new URL(String(input))
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    this.requests.push({ method, path: url.pathname + url.search, body })
    const auth = String((init?.headers as Record<string, string>)?.Authorization ?? '')
    const role = this.tokens.get(auth.replace(/^Bearer /, ''))
    const json = (status: number, v: unknown) => new Response(JSON.stringify(v), { status, headers: { 'Content-Type': 'application/json' } })
    if (!role) return json(401, { error: { code: 'unauthorized', message: 'Not a token of this server.' } })
    const path = url.pathname
    if (path === '/v1/hello') return json(200, this.hello(role))
    if (path === '/v1/collections') return json(200, { seq: this.seq, docs: [...this.docs.values()].filter(d => d.kind === 'collection' && d.data) })
    const items = /^\/v1\/collections\/([^/]+)\/items$/.exec(path)
    if (items) return json(200, { seq: this.seq, docs: [...this.docs.values()].filter(d => d.kind === 'item' && d.collectionId === items[1] && d.data) })
    if (path === '/v1/write') {
      if (role !== 'write') return json(403, { error: { code: 'forbidden', message: 'This token may only read.' } })
      return json(200, { seq: this.seq, docs: this.write(body.ops, body.mutationId) })
    }
    if (path === '/v1/changes') {
      const since = Number(url.searchParams.get('since'))
      return json(200, { seq: this.seq, docs: [...this.docs.values()].filter(d => d.seq > since).sort((a, b) => a.seq - b.seq), more: false })
    }
    if (path === '/v1/events') {
      const since = url.searchParams.get('since')
      const encoder = new TextEncoder()
      let ctrl!: ReadableStreamDefaultController<Uint8Array>
      const stream = new ReadableStream<Uint8Array>({ start: (c) => { ctrl = c } })
      const handle = {
        push: (event: string, data: unknown) => { try { ctrl.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)) } catch { /* closed */ } },
        close: () => { this.streams.delete(handle); try { ctrl.close() } catch { /* closed */ } },
      }
      init?.signal?.addEventListener('abort', () => handle.close())
      handle.push('hello', this.hello(role))
      if (since !== null) {
        const docs = [...this.docs.values()].filter(d => d.seq > Number(since)).sort((a, b) => a.seq - b.seq)
        if (docs.length) handle.push('docs', { seq: this.seq, docs })
      }
      this.streams.add(handle)
      return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
    }
    return json(404, { error: { code: 'not_found', message: 'No such route.' } })
  }

  /** Ends every stream, as a lost connection does. */
  drop() {
    for (const s of [...this.streams]) s.close()
  }
}

class Storage {
  map = new Map<string, unknown>()
  get<T>(k: string) { return structuredClone(this.map.get(k)) as T | undefined }
  set(k: string, v: unknown) { this.map.set(k, structuredClone(v)) }
  delete(k: string) { this.map.delete(k) }
  keys() { return [...this.map.keys()] }
}

const tick = (ms = 0) => new Promise(r => setTimeout(r, ms))
async function until(what: () => boolean, ms = 1000) {
  const end = Date.now() + ms
  while (!what()) {
    if (Date.now() > end) throw new Error('Waited too long')
    await tick(2)
  }
}

const sources: PlannerSource[] = []
function remote(server: FakeServer, token = 'pls_write', storage = new Storage()) {
  const r = new RemoteSource({ url: URL_, token }, { storage, log: { warn() {} }, fetch: server.fetch }, { retryMs: 5, maxRetryMs: 20, silenceMs: 2000 })
  sources.push(r)
  return r
}
test.afterEach(() => { sources.splice(0).forEach(s => s.dispose()) })

const collection = (id: string, data: JsonObject = { name: id }): SourceOp => ({ op: 'create', kind: 'collection', id, collectionId: id, data })
const item = (c: string, id: string, data: JsonObject = { title: id }): SourceOp => ({ op: 'create', kind: 'item', id, collectionId: c, data })

/* ---------------------------------------------------------------- remote */

test('a server address is read leniently and never carries a password', () => {
  assert.equal(serverUrl('planner.example.com'), 'https://planner.example.com')
  assert.equal(serverUrl(' http://10.0.0.2:8080/ '), 'http://10.0.0.2:8080')
  assert.equal(serverUrl('https://example.com/planner/'), 'https://example.com/planner')
  assert.equal(serverUrl('ftp://example.com'), null)
  assert.equal(serverUrl('https://me:secret@example.com'), null)
  assert.equal(serverUrl(''), null)
})

test('server-sent events are read across chunks and line endings', () => {
  const got: Array<[string, string]> = []
  const r = new EventReader((e, d) => got.push([e, d]))
  r.push('event: hello\r\ndata: {"a"')
  r.push(':1}\r\n\r\n: ping\n\nevent: docs\ndata: x\ndata: y\n\n')
  assert.deepEqual(got, [['hello', '{"a":1}'], ['docs', 'x\ny']])
})

test('reads and writes go to the server; the stream says it is online and brings others\' writes', async () => {
  const server = new FakeServer()
  server.others([collection('c1')])
  const r = remote(server)
  const heard: SourceDoc[] = []
  r.subscribe(docs => heard.push(...docs))
  await until(() => r.status().online)
  assert.equal(r.label, 'Team')
  assert.deepEqual((await r.loadCollections()).map(d => d.id), ['c1'])

  const written = await r.write([item('c1', 'i1')], 'm1')
  assert.equal(written[0]!.data!.title, 'i1')
  server.others([{ op: 'patch', kind: 'item', id: 'i1', collectionId: 'c1', patch: [{ path: ['title'], value: 'renamed' }] }])
  await until(() => heard.some(d => d.data?.title === 'renamed'))
  assert.deepEqual((await r.loadItems('c1')).map(d => d.data!.title), ['renamed'])
})

test('a write tried again is not made twice', async () => {
  const server = new FakeServer()
  const r = remote(server)
  await r.write([collection('c1'), { op: 'patch', kind: 'collection', id: 'c1', collectionId: 'c1', patch: [{ path: ['n'], value: 1 }] }], 'same')
  const before = server.seq
  await r.write([collection('c1'), { op: 'patch', kind: 'collection', id: 'c1', collectionId: 'c1', patch: [{ path: ['n'], value: 1 }] }], 'same')
  assert.equal(server.seq, before)
})

test('chat links stay on this computer: never sent, kept, and others\' never shown', async () => {
  const server = new FakeServer()
  const storage = new Storage()
  const r = remote(server, 'pls_write', storage)
  server.others([collection('c1'), item('c1', 'theirs', { title: 't', chats: { 'their-chat': 1 } })])

  const [made] = await r.write([item('c1', 'i1', { title: 'mine', chats: { 'chat-a': 5 } })], 'm1')
  assert.deepEqual(made!.data!.chats, { 'chat-a': 5 })
  const sent = server.requests.find(q => q.path === '/v1/write')!.body as { ops: SourceOp[] }
  assert.equal('chats' in (sent.ops[0] as { data: JsonObject }).data, false)
  assert.equal(server.docs.get('item/i1')!.data!.chats, undefined)

  await r.write([{ op: 'patch', kind: 'item', id: 'i1', collectionId: 'c1', patch: [{ path: ['chats', 'chat-b'], value: 6 }, { path: ['title'], value: 'mine!' }] }], 'm2')
  const items = await r.loadItems('c1')
  assert.deepEqual(items.find(d => d.id === 'i1')!.data!.chats, { 'chat-a': 5, 'chat-b': 6 })
  assert.deepEqual(items.find(d => d.id === 'theirs')!.data!.chats, {})
  assert.equal(JSON.stringify([...server.docs.values()]).includes('chat-b'), false)

  // Another window of this computer reads them too.
  const other = remote(server, 'pls_write', storage)
  assert.deepEqual((await other.loadItems('c1')).find(d => d.id === 'i1')!.data!.chats, { 'chat-a': 5, 'chat-b': 6 })
})

test('a read-only token makes the source read only, and its writes are refused', async () => {
  const server = new FakeServer()
  const r = remote(server, 'pls_read')
  await until(() => r.status().online)
  assert.equal(r.status().readonly, true)
  await assert.rejects(r.write([collection('c1')], 'm'), (e: unknown) => e instanceof SourceError && e.kind === 'refused')
})

test('a token the server does not know: refused, read only, and not tried again and again', async () => {
  const server = new FakeServer()
  const r = remote(server, 'pls_nope')
  await until(() => r.status().readonly)
  assert.equal(r.status().online, false)
  await assert.rejects(r.loadCollections(), (e: unknown) => e instanceof SourceError && e.kind === 'refused')
  const tries = server.requests.filter(q => q.path.startsWith('/v1/events')).length
  await tick(60)
  assert.equal(server.requests.filter(q => q.path.startsWith('/v1/events')).length, tries)
})

test('offline: writes fail as offline; after a lost stream it comes back and hears what it missed', async () => {
  const server = new FakeServer()
  const r = remote(server)
  const heard: SourceDoc[] = []
  const statuses: boolean[] = []
  r.subscribe(docs => heard.push(...docs))
  r.onStatus(s => statuses.push(s.online))
  await until(() => r.status().online)
  await r.write([collection('c1')], 'm1')
  await until(() => heard.some(d => d.id === 'c1'))

  server.down = true
  server.drop()
  await until(() => !r.status().online)
  await assert.rejects(r.write([collection('c2')], 'm2'), (e: unknown) => e instanceof SourceError && e.kind === 'offline')
  server.others([item('c1', 'while-away')])

  server.down = false
  await until(() => r.status().online, 2000)
  await until(() => heard.some(d => d.id === 'while-away'))
  const reconnect = server.requests.filter(q => q.path.startsWith('/v1/events')).at(-1)!
  assert.match(reconnect.path, /since=1$/)
  assert.deepEqual(statuses.slice(0, 3), [true, false, true])
})

/* ---------------------------------------------------------------- routed, under the store */

/** This computer's source, in memory. */
class MemorySource implements PlannerSource {
  readonly label = 'This computer'
  docs = new Map<string, Doc>()
  seq = 0
  handlers = new Set<(docs: SourceDoc[]) => void>()
  async loadCollections() { return [...this.docs.values()].filter(d => d.kind === 'collection' && d.data) }
  async loadItems(id: string) { return [...this.docs.values()].filter(d => d.kind === 'item' && d.collectionId === id && d.data) }
  async write(ops: readonly SourceOp[]) {
    const out = new Map<string, Doc>()
    for (const op of ops) {
      const k = `${op.kind}/${op.id}`
      const now = out.get(k) ?? this.docs.get(k)
      let data = now?.data ?? null
      if (op.op === 'create') data ??= op.data
      else if (op.op === 'patch') { if (data) data = applyPatch(data, op.patch) }
      else data = null
      const doc = { kind: op.kind, id: op.id, collectionId: op.collectionId, seq: ++this.seq, createdAt: 1, updatedAt: 2, data }
      this.docs.set(k, doc)
      out.set(k, doc)
    }
    return [...out.values()]
  }
  subscribe(h: (docs: SourceDoc[]) => void) { this.handlers.add(h); return () => { this.handlers.delete(h) } }
  status(): SourceStatus { return { online: true, readonly: false } }
  onStatus() { return () => {} }
  dispose() {}
}

const stores: PlannerStore[] = []
test.afterEach(() => { stores.splice(0).forEach(s => s.dispose()) })

function storeOver(source: PlannerSource) {
  const toasts: string[] = []
  const storage = new Storage()
  const host: StoreHost = {
    data: undefined as never,
    storage,
    workspace: { activeProject: () => '/p', onProjectChange: () => ({ dispose() {} }) },
    ui: { toast: (t: { title: string }) => { toasts.push(t.title) } },
    log: { error() {} },
  }
  const store = createStore(host, { source, deferMs: 5 })
  stores.push(store)
  return { store, toasts }
}

async function connected() {
  const server = new FakeServer()
  server.others([collection('shared', { name: 'Shared', scope: { kind: 'everywhere' } })])
  const local = new MemorySource()
  const routed = new RoutedSource(local)
  const r = new RemoteSource({ url: URL_, token: 'pls_write' }, { storage: new Storage(), log: { warn() {} }, fetch: server.fetch }, { retryMs: 5 })
  routed.setServer(r)
  const { store, toasts } = storeOver(routed)
  await store.load()
  await until(() => store.places.value.find(p => p.id === SERVER)?.status.online === true)
  await until(() => store.allCollections.value.some(c => c.id === 'shared'))
  return { server, local, routed, store, toasts }
}

test('collections from both places show; each new one goes where it was asked to', async () => {
  const { server, local, store } = await connected()
  assert.deepEqual(store.places.value.map(p => [p.id, p.label]), [[HERE, 'This computer'], [SERVER, 'Team']])
  assert.equal(store.placeOf('shared'), SERVER)

  const here = store.createCollection({ name: 'Mine' })!
  const there = store.createCollection({ name: 'Ours', place: SERVER })!
  await store.flush()
  assert.ok(local.docs.has(`collection/${here.id}`))
  assert.ok(server.docs.has(`collection/${there.id}`))
  assert.equal(server.docs.has(`collection/${here.id}`), false)
  assert.equal(store.placeOf(there.id), SERVER)

  const it = await store.createItem(there.id, { title: 'on the server', chats: ['t1'] })
  await store.flush()
  assert.equal(server.docs.get(`item/${it!.id}`)!.data!.title, 'on the server')
  assert.equal(server.docs.get(`item/${it!.id}`)!.data!.chats, undefined)
  assert.deepEqual(store.item(there.id, it!.id)!.chats, ['t1'])
})

test('someone else\'s change on the server shows up', async () => {
  const { server, store } = await connected()
  assert.equal(await store.loadItems('shared'), true)
  server.others([item('shared', 'x', { title: 'from a colleague' })])
  await until(() => store.items('shared').items.some(i => i.title === 'from a colleague'))
})

test('moving a collection takes its items and links along, and can be undone', async () => {
  const { server, local, store, toasts } = await connected()
  const c = store.createCollection({ name: 'Moving' })!
  await store.createItem(c.id, { title: 'one', chats: ['t1'] })
  await store.createItem(c.id, { title: 'two' })
  await store.flush()

  const moved = (await store.moveCollectionTo(c.id, SERVER))!
  assert.ok(moved)
  assert.notEqual(moved.id, c.id)
  assert.equal(moved.name, 'Moving')
  assert.equal(store.placeOf(moved.id), SERVER)
  assert.equal(local.docs.get(`collection/${c.id}`)!.data, null)
  const there = [...server.docs.values()].filter(d => d.kind === 'item' && d.collectionId === moved.id)
  assert.deepEqual(there.map(d => d.data!.title).sort(), ['one', 'two'])
  assert.equal(JSON.stringify(there).includes('t1'), false)
  await store.loadItems(moved.id)
  assert.deepEqual(store.items(moved.id).items.find(i => i.title === 'one')!.chats, ['t1'])

  store.undo()
  await store.flush()
  assert.deepEqual(toasts, [])
  assert.ok(local.docs.get(`collection/${c.id}`)!.data)
  assert.equal(server.docs.get(`collection/${moved.id}`)!.data, null)
})

test('a read-only space locks its collections only', async () => {
  const server = new FakeServer()
  server.others([collection('shared', { name: 'Shared', scope: { kind: 'everywhere' } })])
  const routed = new RoutedSource(new MemorySource())
  routed.setServer(new RemoteSource({ url: URL_, token: 'pls_read' }, { storage: new Storage(), log: { warn() {} }, fetch: server.fetch }, { retryMs: 5 }))
  const { store, toasts } = storeOver(routed)
  await store.load()
  await until(() => store.statusOf('shared').readonly && store.statusOf('shared').online)
  assert.equal(store.sourceStatus.value.readonly, false)

  store.updateCollection('shared', { name: 'No' })
  assert.equal(store.collection('shared')!.name, 'Shared')
  assert.equal(toasts.length, 1)
  const mine = store.createCollection({ name: 'Mine' })
  assert.ok(mine)
  store.updateCollection(mine.id, { name: 'Yes' })
  assert.equal(store.collection(mine.id)!.name, 'Yes')
})

test('disconnecting takes the server\'s collections from view; connecting brings them back', async () => {
  const { server, routed, store } = await connected()
  store.createCollection({ name: 'Mine' })
  await store.flush()
  routed.setServer(null)
  await until(() => !store.allCollections.value.some(c => c.id === 'shared'))
  assert.deepEqual(store.allCollections.value.map(c => c.name), ['Mine'])
  assert.deepEqual(store.places.value.map(p => p.id), [HERE])

  routed.setServer(new RemoteSource({ url: URL_, token: 'pls_write' }, { storage: new Storage(), log: { warn() {} }, fetch: server.fetch }, { retryMs: 5 }))
  await until(() => store.allCollections.value.some(c => c.id === 'shared'))
})

test('the server\'s collections stay in view while it cannot be reached', async () => {
  const { server, store } = await connected()
  server.down = true
  server.drop()
  await until(() => !store.statusOf('shared').online)
  await store.load()
  assert.ok(store.collection('shared'))
})

test('a server that cannot be reached at the start shows its collections once it is back', async () => {
  const server = new FakeServer()
  server.others([collection('shared', { name: 'Shared', scope: { kind: 'everywhere' } })])
  server.down = true
  const routed = new RoutedSource(new MemorySource())
  routed.setServer(new RemoteSource({ url: URL_, token: 'pls_write' }, { storage: new Storage(), log: { warn() {} }, fetch: server.fetch }, { retryMs: 5, maxRetryMs: 10 }))
  const { store } = storeOver(routed)
  await until(() => store.status.value === 'ready')
  assert.equal(store.collection('shared'), null)
  server.down = false
  await until(() => !!store.collection('shared'), 2000)
})

test('a saved server connected while this computer\'s collections still load shows its collections', async () => {
  const server = new FakeServer()
  server.others([collection('shared', { name: 'Shared', scope: { kind: 'everywhere' } })])
  // This computer's data is slower to read than the server is to answer, as at the app's start.
  const local = new MemorySource()
  const read = local.loadCollections.bind(local)
  local.loadCollections = async () => { await tick(60); return read() }
  const routed = new RoutedSource(local)
  const { store } = storeOver(routed)
  // As the plugin starts: the store first, then the saved server.
  routed.setServer(new RemoteSource({ url: URL_, token: 'pls_write' }, { storage: new Storage(), log: { warn() {} }, fetch: server.fetch }, { retryMs: 5 }))
  await until(() => store.allCollections.value.some(c => c.id === 'shared'), 2000)
})
