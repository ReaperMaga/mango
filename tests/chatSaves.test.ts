/**
 * Saving chats: only chats marked changed are serialised, unchanged ones are not sent again,
 * deleted ones are deleted by their id, a failed save is sent again. Plain Node:
 *
 *   node --test tests/chatSaves.test.ts      (or: pnpm test)
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Thread } from '../app/types/chat.ts'
import {
  createSaves, fingerprint, saveDelay, DEBOUNCE_MS, MAX_WAIT_MS, STREAM_DEBOUNCE_MS, STREAM_MAX_WAIT_MS, type SaveSource,
} from '../app/utils/chatSaves.ts'

function chat(id: string, text = 'hi', projectPath = '/p'): Thread {
  return {
    id, projectPath, title: id, agent: 'claude', model: 'm', mode: 'ask', effort: null, status: 'working',
    createdAt: 1, updatedAt: 1, messages: [{ id: `${id}-m`, role: 'user', createdAt: 1, parts: [{ type: 'text', text }] }],
  } as unknown as Thread
}

/** A source over `list`, counting how many chats were serialised. */
function sourceOf(list: Thread[], layout?: () => unknown) {
  const counted = { n: 0 }
  const wrap = (t: Thread) => {
    // JSON.stringify calls toJSON: one call per chat serialised. Not enumerable, so not in the JSON.
    if (!Object.prototype.hasOwnProperty.call(t, 'toJSON')) {
      Object.defineProperty(t, 'toJSON', { value() { counted.n++; const { ...plain } = this; return plain }, enumerable: false })
    }
    return t
  }
  const s: SaveSource = { threads: () => list.map(wrap), byId: id => { const t = list.find(x => x.id === id); return t ? wrap(t) : null }, layout }
  return { s, counted }
}

const loaded = (saves: ReturnType<typeof createSaves>, list: Thread[]) => {
  for (const t of list) saves.remember(t, JSON.stringify(t))
}

test('the fingerprint tells JSON apart, by length and content', () => {
  assert.equal(fingerprint('{"a":1}'), fingerprint('{"a":1}'))
  assert.notEqual(fingerprint('{"a":1}'), fingerprint('{"a":2}'))
  assert.notEqual(fingerprint('ab'), fingerprint('ba'))
  assert.notEqual(fingerprint(''), '')
  const big = JSON.stringify({ x: 'y'.repeat(1_000_000) })
  assert.notEqual(fingerprint(big), fingerprint(big.replace('yyy', 'yzy')))
})

test('only marked chats are serialised; unchanged ones are not sent again', () => {
  const list = Array.from({ length: 50 }, (_, i) => chat(`c${i}`))
  const saves = createSaves()
  loaded(saves, list)
  const { s, counted } = sourceOf(list)
  saves.mark('c3')
  assert.equal(saves.collect(s), null, 'marked but unchanged: nothing to send')
  assert.equal(counted.n, 1)
  list[3]!.title = 'renamed'
  saves.mark('c3')
  const batch = saves.collect(s)!
  assert.deepEqual(batch.upsert.map(r => r.id), ['c3'])
  assert.equal(JSON.parse(batch.upsert[0]!.data).title, 'renamed')
  assert.deepEqual(batch.changed.map(c => c.t.id), ['c3'])
  assert.equal(batch.changed[0]!.json, batch.upsert[0]!.data)
  assert.equal(counted.n, 2, 'the 49 others were never serialised')
  saves.mark('c3')
  assert.equal(saves.collect(s), null, 'the same again: nothing')
})

test('a marked id whose chat is gone deletes its row, with the project it was in', () => {
  const list = [chat('a', 'x', '/one'), chat('b', 'x', 'env://h/i/dir')]
  const saves = createSaves()
  loaded(saves, list)
  const { s, counted } = sourceOf(list)
  list.splice(1, 1)
  saves.mark(['b', 'never-saved'])
  const batch = saves.collect(s)!
  assert.deepEqual(batch.remove, [{ id: 'b', projectPath: 'env://h/i/dir' }])
  assert.deepEqual(batch.upsert, [])
  assert.equal(counted.n, 0)
  saves.mark('b')
  assert.equal(saves.collect(s), null, 'deleted once')
})

test('a sweep compares every chat and deletes rows of the ones gone', () => {
  const list = [chat('a'), chat('b'), chat('c')]
  const saves = createSaves()
  loaded(saves, list.slice(0, 2))
  const { s, counted } = sourceOf(list)
  list.splice(0, 1)
  saves.mark()
  const batch = saves.collect(s)!
  assert.deepEqual(batch.upsert.map(r => r.id), ['c'])
  assert.deepEqual(batch.remove.map(r => r.id), ['a'])
  assert.equal(counted.n, 2)
})

test('a chat new to the history is sent when marked', () => {
  const saves = createSaves()
  const list = [chat('n')]
  const { s } = sourceOf(list)
  saves.mark('n')
  assert.deepEqual(saves.collect(s)!.upsert.map(r => r.id), ['n'])
  assert.ok(saves.has('n'))
})

test('loading: chats normalization changed are saved, the others are not', () => {
  const rows = [chat('same'), { ...chat('cut'), status: 'running' }] as Thread[]
  const saves = createSaves()
  const normalize = (t: Thread): Thread => ({ ...t, status: t.status === 'running' ? 'working' : t.status })
  const kept: Thread[] = []
  for (const t of rows) {
    const n = normalize(t)
    saves.remember(t, JSON.stringify(t), n)
    kept.push(n)
  }
  const { s, counted } = sourceOf(kept)
  const batch = saves.collect(s)!
  assert.deepEqual(batch.upsert.map(r => r.id), ['cut'])
  assert.equal(JSON.parse(batch.upsert[0]!.data).status, 'working')
  assert.equal(counted.n, 1)
})

test('a failed save is sent again, deletions too', () => {
  const list = [chat('a'), chat('b')]
  const saves = createSaves()
  loaded(saves, list)
  const { s } = sourceOf(list, () => ({ tabs: ['a'] }))
  list[0]!.title = 'changed'
  const gone = list.splice(1, 1)
  assert.equal(gone.length, 1)
  saves.mark(['a', 'b'])
  const first = saves.collect(s)!
  assert.deepEqual(first.upsert.map(r => r.id), ['a'])
  assert.deepEqual(first.remove.map(r => r.id), ['b'])
  assert.equal(first.ui, '{"tabs":["a"]}')
  saves.failed(first)
  const again = saves.collect(s)!
  assert.deepEqual(again.upsert.map(r => r.id), ['a'])
  assert.deepEqual(again.remove, [{ id: 'b', projectPath: '/p' }])
  assert.equal(again.ui, '{"tabs":["a"]}')
  assert.equal(saves.collect(s), null)
})

test('forgotten chats are neither saved nor deleted here', () => {
  const list = [chat('a')]
  const saves = createSaves()
  loaded(saves, list)
  const { s } = sourceOf([])
  saves.forget(['a'])
  saves.mark('a')
  assert.equal(saves.collect(s), null)
  saves.mark()
  assert.equal(saves.collect(s), null)
  assert.equal(saves.has('a'), false)
})

test('the layout is sent only when it changed', () => {
  const saves = createSaves()
  let layout = { tabs: ['a'] }
  const { s } = sourceOf([], () => layout)
  saves.setLayout('{"tabs":["a"]}')
  saves.mark([])
  assert.equal(saves.collect(s), null)
  layout = { tabs: ['a', 'b'] }
  saves.mark([])
  assert.equal(saves.collect(s)!.ui, '{"tabs":["a","b"]}')
})

test('streamed output saves less often than other changes', () => {
  assert.equal(saveDelay(1000, 1000, true), DEBOUNCE_MS)
  assert.equal(saveDelay(1000 + MAX_WAIT_MS - 100, 1000, true), 100)
  assert.equal(saveDelay(1000, 1000, false), STREAM_DEBOUNCE_MS)
  assert.equal(saveDelay(1000 + STREAM_MAX_WAIT_MS - 500, 1000, false), 500)
  assert.equal(saveDelay(1000 + STREAM_MAX_WAIT_MS + 5, 1000, false), 0)
  assert.ok(STREAM_MAX_WAIT_MS > MAX_WAIT_MS)
})

test('rows loaded compare the same before and after their fingerprints are taken in idle time', () => {
  const list = [chat('a'), chat('b'), chat('c')]
  const saves = createSaves()
  for (const t of list) saves.remember(t, JSON.stringify(t), { ...t })
  const { s } = sourceOf(list)
  saves.mark('a')
  assert.equal(saves.collect(s), null, 'unchanged, fingerprint taken on the spot')
  assert.equal(saves.settle(1000), false, 'the rest taken now')
  saves.mark(['b', 'c'])
  assert.equal(saves.collect(s), null)
  list[2]!.title = 'new'
  saves.mark(['b', 'c'])
  assert.deepEqual(saves.collect(s)!.upsert.map(r => r.id), ['c'])
})
