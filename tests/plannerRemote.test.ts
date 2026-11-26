/**
 * The planner's remote source against a stand-in planner server (plugins/planner/server/PROTOCOL.md, in memory), and the
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
import { valueOf, valueText } from '../plugins/planner/src/model.ts'
import { runQuery } from '../plugins/planner/src/query.ts'

/* ---------------------------------------------------------------- a planner server, in memory */

type Doc = SourceDoc
const URL_ = 'https://planner.test'

class FakeServer {
  docs = new Map<string, Doc>()
  seq = 0
  mutations = new Map<string, string[]>()
  tokens = new Map([['pls_write', 'write'], ['pls_read', 'read']])
  /** The person each token is for. */
  persons = new Map([['pls_write', 'per_ana'], ['pls_read', 'per_wall']])
  /** Everyone in the space; null: a server older than people. */
  people: Array<{ id: string; name: string; active: boolean }> | null = [
    { id: 'per_ana', name: 'Ana', active: true },
    { id: 'per_ben', name: 'Ben', active: true },
    { id: 'per_wall', name: 'Wall screen', active: false },
  ]

  person(token: string) {
    const id = this.persons.get(token)
    const p = this.people?.find(x => x.id === id)
    return p ? { id: p.id, name: p.name } : undefined
  }
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

  hello(role: string, me?: { id: string; name: string }) {
    return { protocol: 1, server: 'fake', space: { id: 'team', name: 'Team' }, role, ...(me ? { me } : {}), seq: this.seq }
  }

  fetch: typeof fetch = async (input, init) => {
    if (this.down) throw new TypeError('fetch failed')
    const url = new URL(String(input))
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    this.requests.push({ method, path: url.pathname + url.search, body })
    const auth = String((init?.headers as Record<string, string>)?.Authorization ?? '')
    const role = this.tokens.get(auth.replace(/^Bearer /, ''))
    const me = this.person(auth.replace(/^Bearer /, ''))
    const json = (status: number, v: unknown) => new Response(JSON.stringify(v), { status, headers: { 'Content-Type': 'application/json' } })
    if (!role) return json(401, { error: { code: 'unauthorized', message: 'Not a token of this server.' } })
    const path = url.pathname
    if (path === '/v1/hello') return json(200, this.hello(role, me))
    if (path === '/v1/people' && this.people) return json(200, { me, people: this.people })
    if (path === '/v1/me' && this.people && method === 'POST') {
      const name = String(body?.name ?? '').trim()
      if (this.people.some(p => p.id !== me?.id && p.name.toLowerCase() === name.toLowerCase())) {
        return json(409, { error: { code: 'conflict', message: `Someone in this space is called "${name}" already.` } })
      }
      this.people = this.people.map(p => (p.id === me?.id ? { ...p, name } : p))
      for (const st of this.streams) st.push('people', {})
      return json(200, { me: this.person(auth.replace(/^Bearer /, '')), people: this.people })
    }
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
      handle.push('hello', this.hello(role, me))
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

/* ---------------------------------------------------------------- people */

const ANA = 'per_ana'
const BEN = 'per_ben'
const names = (r: { peopleOf(id?: string): { all: readonly { name: string }[] } | null }, id?: string) => r.peopleOf(id)?.all.map(p => p.name).join() ?? null

test('the stream says who this token is; the people are asked for, and again when asked', async () => {
  const server = new FakeServer()
  const r = remote(server)
  let heard = 0
  r.onPeople(() => { heard++ })
  assert.equal(r.peopleOf(), null)
  await until(() => r.peopleOf()?.all.length === 3)
  assert.equal(r.peopleOf()!.me, ANA)
  assert.equal(names(r), 'Ana,Ben,Wall screen')
  assert.ok(heard >= 1)

  server.people!.push({ id: 'per_cleo', name: 'Cleo', active: true })
  r.refreshPeople()
  await until(() => r.peopleOf()?.all.length === 4)
  const asked = server.requests.filter(q => q.path === '/v1/people').length
  r.refreshPeople()
  r.refreshPeople()
  await tick(5)
  assert.equal(server.requests.filter(q => q.path === '/v1/people').length, asked + 1, 'asked once at a time')
})

test('a server older than people has none; what is not a person is not taken', async () => {
  const server = new FakeServer()
  server.people = null
  const r = remote(server)
  await until(() => r.status().online)
  await tick(5)
  assert.equal(r.peopleOf(), null)
  assert.equal(server.requests.some(q => q.path === '/v1/people'), false)

  const odd = new FakeServer()
  odd.people = [
    { id: 'per_ana', name: 'Ana', active: true },
    { id: 'has space', name: 'Nope', active: true },
    { id: 'per_x', name: '@me', active: true },
    { id: 'per_y', name: '', active: true },
  ]
  const o = remote(odd)
  await until(() => o.peopleOf()?.all.length === 1)
  assert.equal(names(o), 'Ana')
})

test('who this computer was is known before the stream says it again, by id only', () => {
  const server = new FakeServer()
  server.down = true
  const r = remote(server)
  r.knownAs(ANA)
  assert.deepEqual(r.peopleOf(), { me: ANA, all: [] })
  r.knownAs(BEN)
  assert.equal(r.peopleOf()!.me, ANA, 'what was heard is not replaced')
})

test('renaming yourself: everyone hears it, and a name someone has is refused', async () => {
  const server = new FakeServer()
  const r = remote(server)
  const other = remote(server, 'pls_read')
  await until(() => names(r) === 'Ana,Ben,Wall screen' && names(other) === 'Ana,Ben,Wall screen')
  await r.rename('Ana Lopes')
  assert.equal(names(r), 'Ana Lopes,Ben,Wall screen')
  // The other computer hears it on its stream.
  await until(() => names(other) === 'Ana Lopes,Ben,Wall screen')
  await assert.rejects(r.rename('ben'), (e: Error) => e instanceof SourceError && e.kind === 'invalid' && /called "ben" already/.test(e.message))
})

test('people belong to the server\'s collections only; a template there gets an assignee', async () => {
  const { store } = await connected()
  await until(() => store.people('shared')?.all.length === 3)
  assert.equal(store.people('shared')!.me, ANA)

  const mine = store.createCollection({ name: 'Mine', template: 'tasks' })!
  assert.equal(store.people(mine.id), null)
  assert.equal(mine.properties.some(p => p.type === 'person'), false)
  assert.equal(mine.views.every(v => v.columns.every(c => mine.properties.some(p => p.id === c.propertyId))), true)

  const ours = store.createCollection({ name: 'Ours', template: 'tasks', place: SERVER })!
  const assignee = ours.properties.find(p => p.type === 'person')!
  assert.equal(assignee.name, 'Assignee')
  const board = ours.views.find(v => v.type === 'board')!
  assert.equal(board.columns.find(c => c.propertyId === assignee.id)!.visible, true)
})

test('a new item in a view of "my" items is assigned to whoever made it', async () => {
  const { server, store } = await connected()
  await until(() => store.people('shared')?.me === ANA)
  const c = store.createCollection({ name: 'Ours', template: 'tasks', place: SERVER })!
  const assignee = c.properties.find(p => p.type === 'person')!
  const view = c.views[0]!
  store.updateView(c.id, view.id, { filter: { match: 'and', conditions: [{ id: 'f', propertyId: assignee.id, operator: 'contains', value: ['@me'] }] } })
  const it = await store.createItem(c.id, { title: 'mine', viewId: view.id })
  await store.flush()
  assert.deepEqual(store.item(c.id, it!.id)!.values[assignee.id], [ANA])
  assert.deepEqual((server.docs.get(`item/${it!.id}`)!.data!.values as JsonObject)[assignee.id], [ANA])
})

test('assigning writes the name down; a rename brings it up to date; moving off the server keeps it readable', async () => {
  const { server, store } = await connected()
  await until(() => store.people('shared')?.all.length === 3)
  const c = store.createCollection({ name: 'Ours', template: 'tasks', place: SERVER })!
  const assignee = c.properties.find(p => p.type === 'person')!
  const it = (await store.createItem(c.id, { title: 'review' }))!
  store.updateItem(c.id, it.id, { values: { [assignee.id]: [BEN, ANA] } })
  await store.flush()
  const written = () => (server.docs.get(`collection/${c.id}`)!.data!.properties as JsonObject)[assignee.id] as JsonObject
  assert.deepEqual(written().people, { [BEN]: { name: 'Ben' }, [ANA]: { name: 'Ana' } })

  const undo = store.undoLabel.value
  // Ben renames himself on his computer: this one hears it and brings the name it wrote down up to date.
  server.people = server.people!.map(p => (p.id === BEN ? { ...p, name: 'Benedict' } : p))
  for (const st of server.streams) st.push('people', {})
  await until(() => (written().people as JsonObject)[BEN] !== undefined && ((written().people as JsonObject)[BEN] as JsonObject).name === 'Benedict')
  assert.equal(store.undoLabel.value, undo, 'bringing names up to date is not a step to undo')

  // Search and export read names, not ids.
  const found = runQuery(store.collection(c.id)!, store.items(c.id).items, store.collection(c.id)!.views[1]!, { search: 'benedict', people: store.people(c.id) })
  assert.deepEqual(found.items.map(i => i.id), [it.id])

  // On this computer there is no server to ask: the names written down are shown.
  const here = await store.moveCollectionTo(c.id, HERE)
  assert.ok(here)
  assert.equal(store.people(here!.id), null)
  const moved = store.items(here!.id).items[0]!
  const p = here!.properties.find(x => x.type === 'person')!
  assert.equal(valueText(valueOf(moved, p), p), 'Benedict, Ana')
})

test('pasting and importing names finds the people they are; a name nobody has is left out', async () => {
  const { store } = await connected()
  await until(() => store.people('shared')?.all.length === 3)
  const c = store.createCollection({ name: 'Ours', template: 'tasks', place: SERVER })!
  const assignee = c.properties.find(p => p.type === 'person')!
  const added = await store.importCsv(c.id, `Title,Assignee\nOne,"ana, BEN"\nTwo,Nobody\n`)
  assert.equal(added, 2)
  await store.flush()
  const byTitle = new Map(store.items(c.id).items.map(i => [i.title, i]))
  assert.deepEqual(byTitle.get('One')!.values[assignee.id], [ANA, BEN])
  assert.equal(byTitle.get('Two')!.values[assignee.id], undefined)
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
