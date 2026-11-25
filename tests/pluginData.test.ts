/** `mango.data` (app/plugin-host/data.ts) on the browser preview's backend. Plain Node. */
import { beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { createPluginData, docJson, toWriteOps } from '../app/plugin-host/data.ts'
import { DisposableScope } from '../app/plugin-host/scope.ts'
import { mockPluginData } from '../app/composables/mockPluginData.ts'

const kept = new Map<string, string>()
Object.assign(globalThis, { BroadcastChannel: undefined }) // its open port would keep the test process alive
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: { getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => kept.set(k, v) },
})
beforeEach(() => kept.clear())

function setup(pluginId = 'p') {
  const listeners = new Set<(p: any) => void>()
  const emit = (_: string, p: any) => listeners.forEach(fn => fn(structuredClone(p)))
  const reported: string[] = []
  const scope = new DisposableScope()
  const call = (async (cmd: string, args: unknown) => structuredClone(await mockPluginData(cmd, structuredClone(args), emit))) as never
  const data = createPluginData({
    pluginId, scope, call,
    on: (async (_: string, fn: (p: any) => void) => { listeners.add(fn); return () => listeners.delete(fn) }) as never,
    report: e => reported.push(String((e as Error).message)),
  })
  return { data, scope, emit, listeners, reported }
}

const put = (id: string, data: unknown, expectedRev?: number) => ({ op: 'put' as const, collection: 'notes', id, data, expectedRev })

test('writes, reads, deletes and lists changes', async () => {
  const { data } = setup()
  const proxy = new Proxy({ text: 'hi', gone: undefined, list: new Proxy([1], {}) }, {})
  const [doc] = await data.write([put('a', proxy)])
  assert.deepEqual([doc!.rev, doc!.seq, doc!.data], [1, 1, { text: 'hi', list: [1] }])
  assert.deepEqual((await data.get('notes', 'a'))!.data, { text: 'hi', list: [1] })
  await data.write([put('b', null), { op: 'delete', collection: 'notes', id: 'a' }])
  assert.equal(await data.get('notes', 'a'), null)
  assert.deepEqual((await data.list('notes')).map(d => d.id), ['b'])
  const { seq, docs } = await data.changes(0)
  assert.equal(seq, 3)
  assert.deepEqual(docs.map(d => [d.id, d.deleted, d.rev]), [['b', false, 1], ['a', true, 2]])
  assert.deepEqual(await data.write([]), [])
})

test('a conflict rejects with the documents as they are, and writes nothing', async () => {
  const { data } = setup()
  await data.write([put('a', 1)])
  await assert.rejects(data.write([put('new', 1), put('a', 2, 5), put('never', 1, 2)]), (e: any) => {
    assert.ok(e instanceof Error)
    assert.deepEqual((e as any).conflicts.map((d: any) => [d.id, d.rev, d.data]), [['a', 1, 1], ['never', 0, null]])
    return true
  })
  assert.equal(await data.get('notes', 'new'), null)
  await data.write([{ op: 'delete', collection: 'notes', id: 'a', expectedRev: 1 }])
  assert.equal((await data.write([put('a', 3, 0)]))[0]!.rev, 3)
})

test('onChange: own and others, errors reported, stops with the plugin', async () => {
  const { data, scope, emit, listeners, reported } = setup()
  const seen: unknown[] = []
  data.onChange(() => { throw new Error('bad') })
  data.onChange(async () => { throw new Error('late') })
  data.onChange(c => seen.push([c.seq, c.local, c.docs.map(d => d.data)]))
  await data.write([put('a', { n: 1 })])
  const row = { collection: 'notes', id: 'b', rev: 1, seq: 2, createdAt: 1, updatedAt: 1, deleted: false, data: '2' }
  emit('plugins://data', { pluginId: 'p', seq: 2, docs: [row], origin: 'another window' })
  emit('plugins://data', { pluginId: 'q', seq: 1, docs: [row], origin: 'another window' })
  await new Promise(r => setTimeout(r))
  assert.deepEqual(seen, [[1, true, [{ n: 1 }]], [2, false, [2]]])
  assert.deepEqual(reported.sort(), ['bad', 'bad', 'late', 'late'])
  assert.equal(listeners.size, 1)
  scope.dispose()
  assert.equal(listeners.size, 0)
  // What it saves while it stops is still saved.
  await data.write([put('c', 1)])
  assert.equal(seen.length, 2)
})

test('clearing keeps the seq', async () => {
  const { data, emit } = setup()
  await data.write([put('a', 1), put('b', 1)])
  await mockPluginData('plugin_data_clear', { pluginId: 'p' }, emit)
  assert.equal(await mockPluginData('plugin_data_count', { pluginId: 'p' }, emit), 0)
  assert.equal((await data.write([put('a', 1, 0)]))[0]!.seq, 3)
})

test('refuses what cannot be saved', async () => {
  const bad = (...ops: unknown[]) => assert.throws(() => toWriteOps(ops), TypeError)
  bad(null)
  bad({ op: 'drop', collection: 'a', id: 'b' })
  bad({ ...put('a', 1), collection: 'a b' })
  bad(put('', 1))
  bad(put('a\n', 1))
  bad(put('\ud800', 1))
  bad(put('x'.repeat(129), 1))
  bad(put('a', undefined))
  bad(put('a', () => 1))
  bad(put('a', 1n))
  bad(put('a', 1, -1))
  bad(put('a', 1, 1.5))
  bad(put('a', 'x'.repeat(1024 * 1024)))
  assert.throws(() => toWriteOps(Array.from({ length: 2001 }, () => put('a', 1))), /2000/)
  assert.equal(toWriteOps([put('\u{1F96D}'.repeat(128), 1)]).length, 1)
  const loop: any = {}
  loop.self = loop
  assert.throws(() => docJson(loop, 'x'), TypeError)
  await assert.rejects(setup().data.changes(-1), TypeError)
})
