/**
 * Two computers' planners, synced through the real planner server. Skipped unless `PLANNER_SERVER` names its binary:
 *
 *   (cd plugins/planner/server && go build -o "$TMPDIR/planner-server" .)
 *   PLANNER_SERVER="$TMPDIR/planner-server" node --test tests/plannerServerLive.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RemoteSource } from '../plugins/planner/src/data/remote.ts'
import { RoutedSource, SERVER } from '../plugins/planner/src/data/routed.ts'
import type { PlannerSource, SourceDoc, SourceStatus } from '../plugins/planner/src/data/source.ts'
import { applyPatch } from '../plugins/planner/src/patch.ts'
import { createStore, type PlannerStore, type StoreHost } from '../plugins/planner/src/store.ts'

const BIN = process.env.PLANNER_SERVER

class Storage {
  map = new Map<string, unknown>()
  get<T>(k: string) { return structuredClone(this.map.get(k)) as T | undefined }
  set(k: string, v: unknown) { this.map.set(k, structuredClone(v)) }
  delete(k: string) { this.map.delete(k) }
  keys() { return [...this.map.keys()] }
}

/** This computer's documents, in memory. */
class MemorySource implements PlannerSource {
  readonly label = 'This computer'
  docs = new Map<string, SourceDoc>()
  seq = 0
  async loadCollections() { return [...this.docs.values()].filter(d => d.kind === 'collection' && d.data) }
  async loadItems(id: string) { return [...this.docs.values()].filter(d => d.kind === 'item' && d.collectionId === id && d.data) }
  async write(ops: Parameters<PlannerSource['write']>[0]) {
    return ops.map((op) => {
      const k = `${op.kind}/${op.id}`
      let data = this.docs.get(k)?.data ?? null
      if (op.op === 'create') data ??= op.data
      else if (op.op === 'patch') { if (data) data = applyPatch(data, op.patch) }
      else data = null
      const doc = { kind: op.kind, id: op.id, collectionId: op.collectionId, seq: ++this.seq, createdAt: 1, updatedAt: 1, data }
      this.docs.set(k, doc)
      return doc
    })
  }
  subscribe() { return () => {} }
  status(): SourceStatus { return { online: true, readonly: false } }
  onStatus() { return () => {} }
  dispose() {}
}

async function until(what: () => boolean, ms = 5000) {
  const end = Date.now() + ms
  while (!what()) {
    if (Date.now() > end) throw new Error('Waited too long')
    await new Promise(r => setTimeout(r, 10))
  }
}

const freePort = () => new Promise<number>((resolve) => {
  const s = createServer().listen(0, '127.0.0.1', () => {
    const port = (s.address() as { port: number }).port
    s.close(() => resolve(port))
  })
})

test('two computers share a collection through the planner server', { skip: !BIN && 'PLANNER_SERVER is not set' }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'planner-server-'))
  const db = join(dir, 'planner.db')
  const run = (...args: string[]) => execFileSync(BIN!, [...args, '--db', db], { encoding: 'utf8' }).trim()
  run('space', 'add', 'team', '--name', 'Team')
  const writer = run('token', 'add', '--space', 'team', '--name', 'a')
  const reader = run('token', 'add', '--space', 'team', '--name', 'b', '--role', 'read')
  const port = await freePort()
  const server: ChildProcess = spawn(BIN!, ['serve', '--addr', `127.0.0.1:${port}`, '--db', db], { stdio: 'ignore' })
  const stores: PlannerStore[] = []
  t.after(() => {
    stores.forEach(s => s.dispose())
    server.kill()
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* still held on Windows */ }
  })
  const url = `http://127.0.0.1:${port}`
  // Up once it answers at all (401 without a token).
  for (let i = 0; ; i++) {
    if (await fetch(`${url}/v1/hello`).then(() => true, () => false)) break
    if (i > 100) throw new Error('The planner server did not start.')
    await new Promise(r => setTimeout(r, 50))
  }

  function computer(token: string) {
    const toasts: string[] = []
    const routed = new RoutedSource(new MemorySource())
    routed.setServer(new RemoteSource({ url, token }, { storage: new Storage(), log: { warn() {} } }, { retryMs: 50 }))
    const host: StoreHost = {
      data: undefined as never,
      storage: new Storage(),
      workspace: { activeProject: () => '/p', onProjectChange: () => ({ dispose() {} }) },
      ui: { toast: (t: { title: string; body?: string }) => { toasts.push(`${t.title}: ${t.body ?? ''}`) } },
      log: { error() {} },
    }
    const store = createStore(host, { source: routed, deferMs: 5 })
    stores.push(store)
    return { store, toasts }
  }

  const a = computer(writer)
  const b = computer(writer)
  const viewer = computer(reader)
  for (const s of [a, b, viewer]) await until(() => s.store.places.value.find(p => p.id === SERVER)?.status.online === true)
  assert.equal(a.store.places.value[1]!.label, 'Team')

  // A makes a board on the server, with an item linked to one of A's chats.
  const c = a.store.createCollection({ name: 'Shared', place: SERVER, scope: { kind: 'everywhere' } })!
  const item = (await a.store.createItem(c.id, { title: 'Write the server', chats: ['chat-a'] }))!
  await a.store.flush()

  // B sees it as it happens, without A's chat link.
  await until(() => !!b.store.collection(c.id))
  assert.equal(await b.store.loadItems(c.id), true)
  const seen = b.store.item(c.id, item.id)!
  assert.equal(seen.title, 'Write the server')
  assert.deepEqual(seen.chats, [])

  // Both change different fields of it at once: both changes stay.
  a.store.updateItem(c.id, item.id, { title: 'Write the planner server' })
  b.store.updateItem(c.id, item.id, { body: 'In Go.' })
  await Promise.all([a.store.flush(), b.store.flush()])
  await until(() => a.store.item(c.id, item.id)?.body === 'In Go.' && b.store.item(c.id, item.id)?.title === 'Write the planner server')
  assert.deepEqual(a.store.item(c.id, item.id)!.chats, ['chat-a'])

  // B deletes it; A hears.
  b.store.deleteItems(c.id, [item.id])
  await b.store.flush()
  await until(() => a.store.item(c.id, item.id) === null)

  // A read-only token sees the board and cannot change it.
  await until(() => !!viewer.store.collection(c.id))
  assert.equal(viewer.store.statusOf(c.id).readonly, true)
  viewer.store.updateCollection(c.id, { name: 'Mine now' })
  assert.equal(viewer.store.collection(c.id)!.name, 'Shared')
  assert.equal(viewer.toasts.length, 1)
  assert.deepEqual(a.toasts, [])
  // Only the offer to undo the deletion: nothing failed.
  assert.deepEqual(b.toasts, ['Item deleted: '])

  // The people are who the tokens are for; a token made while it runs is heard of when asked again.
  const names = (s: PlannerStore) => s.people(c.id)?.all.map(p => `${p.name}${p.active ? '' : ' (read)'}`).join() ?? ''
  await until(() => names(a.store) === 'a,b (read)')
  const me = a.store.people(c.id)!.me!
  assert.match(me, /^per_/)
  run('token', 'add', '--space', 'team', '--name', 'Ben')
  a.store.refreshPeople(c.id)
  await until(() => names(a.store) === 'a,b (read),Ben')
  const ben = a.store.people(c.id)!.all.find(p => p.name === 'Ben')!.id

  // A assigns Ben; B sees it.
  const task = (await a.store.createItem(c.id, { title: 'Review' }))!
  const who = a.store.addProperty(c.id, { name: 'Assignee', type: 'person' })!
  a.store.updateItem(c.id, task.id, { values: { [who.id]: [ben, me] } })
  await a.store.flush()
  await until(() => JSON.stringify(b.store.item(c.id, task.id)?.values[who.id]) === JSON.stringify([ben, me]))

  // Ben is renamed from the server's command line: both computers hear it within a ping, and the name the
  // property wrote down follows.
  run('person', 'rename', ben, '--name', 'Benedict')
  await until(() => names(a.store).includes('Benedict') && names(b.store).includes('Benedict'), 40_000)
  await until(() => a.store.collection(c.id)!.properties.find(p => p.id === who.id)!.people[ben] === 'Benedict', 5000)

  // A renames themself through the server: B sees the new name on the same assignment.
  run('token', 'add', '--space', 'team', '--name', 'zed') // someone to clash with
  await a.store.flush()
  const renamed = await fetch(`${url}/v1/me`, { method: 'POST', headers: { Authorization: `Bearer ${writer}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'ZED' }) })
  assert.equal(renamed.status, 409)
  const ok = await fetch(`${url}/v1/me`, { method: 'POST', headers: { Authorization: `Bearer ${writer}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Ana' }) })
  assert.equal(ok.status, 200)
  await until(() => b.store.people(c.id)!.all.some(p => p.id === me && p.name === 'Ana'), 5000)
})
