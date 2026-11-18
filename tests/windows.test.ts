/**
 * Which window shows what, and which window owns which chat. Plain Node:
 *
 *   node --test tests/windows.test.ts      (or: pnpm test)
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  MAIN_WINDOW, chatRefs, claimsFor, holderOf, lostChats, ownerOf, parseWindowQuery, rootIds, windowQuery, withClaims, withoutWindow,
  type ClaimTable,
} from '../app/utils/windows.ts'

const P = '/home/me/shop'
const Q = 'env://host-1/dev/home/agent/api'
const R = 'C:\\Users\\me\\game'

test('a window URL says what it shows, and reads back the same', () => {
  for (const spec of [
    { kind: 'project' as const, path: P },
    { kind: 'project' as const, path: Q },
    { kind: 'project' as const, path: R },
    { kind: 'project' as const, path: null },
    { kind: 'chat' as const, threadId: 't-abc123', path: P },
  ]) {
    assert.deepEqual(parseWindowQuery(`?${windowQuery(spec)}`), spec)
  }
  assert.deepEqual(parseWindowQuery(windowQuery({ kind: 'project', path: P }, 'w-1')), { kind: 'project', path: P, id: 'w-1' })
  assert.equal(windowQuery({ kind: 'main' }), '')
})

test('the backend\'s query (percent-encoded) reads as the frontend writes it', () => {
  // As `windows.rs` builds it.
  assert.deepEqual(parseWindowQuery('?window=project&path=%2Fhome%2Fme%2Fa%20b'), { kind: 'project', path: '/home/me/a b' })
  assert.deepEqual(parseWindowQuery('?window=project&path=C%3A%5CUsers%5Cme%5Cx%26y%3D1'), { kind: 'project', path: 'C:\\Users\\me\\x&y=1' })
  assert.deepEqual(parseWindowQuery('?window=chat&thread=t-1&path=%2Fp'), { kind: 'chat', threadId: 't-1', path: '/p' })
})

test('anything unreadable is the main window', () => {
  assert.deepEqual(parseWindowQuery(''), { kind: 'main' })
  assert.deepEqual(parseWindowQuery('?window=settings'), { kind: 'main' })
  assert.deepEqual(parseWindowQuery('?window=chat'), { kind: 'main' })
  assert.deepEqual(parseWindowQuery('?window=chat&thread=../../x'), { kind: 'main' })
  // A made-up id is ignored (the preview only; the app uses its window labels).
  assert.deepEqual(parseWindowQuery('?window=project&id=main'), { kind: 'project', path: null })
})

const threads = [
  { id: 'a', projectPath: P },
  { id: 'a-sub', projectPath: P, parentId: 'a' },
  { id: 'a-sub-sub', projectPath: P, parentId: 'a-sub' },
  { id: 'b', projectPath: P },
  { id: 'c', projectPath: Q },
]
const refs = chatRefs(threads)
const ref = (id: string) => refs.find(r => r.id === id)!

test('sub-agent chats belong with their top-level chat', () => {
  const roots = rootIds(threads)
  assert.equal(roots.get('a-sub-sub'), 'a')
  assert.equal(roots.get('b'), 'b')
  // A parent that is not loaded, or a loop, does not hang or throw.
  assert.equal(rootIds([{ id: 'x', parentId: 'gone' }]).get('x'), 'x')
  const loop = rootIds([{ id: 'x', parentId: 'y' }, { id: 'y', parentId: 'x' }])
  assert.ok(['x', 'y'].includes(loop.get('x')!))
})

test('the main window owns everything nobody claims', () => {
  const table: ClaimTable = { main: [] }
  for (const r of refs) assert.equal(ownerOf(table, r), MAIN_WINDOW)
})

test('a project window owns its project\'s chats; a chat window its chat, before the project\'s window', () => {
  let table: ClaimTable = { main: claimsFor({ kind: 'main' }, [P, Q]) }
  assert.equal(ownerOf(table, ref('a')), 'main')
  table = withClaims(table, 'w-1', claimsFor({ kind: 'project', path: P }, [P]))
  assert.equal(holderOf(table, { kind: 'project', key: P }), 'w-1', 'the claim moved')
  assert.equal(ownerOf(table, ref('a')), 'w-1')
  assert.equal(ownerOf(table, ref('c')), 'main')
  table = withClaims(table, 'w-2', claimsFor({ kind: 'chat', threadId: 'a', path: P }, []))
  assert.equal(ownerOf(table, ref('a')), 'w-2')
  assert.equal(ownerOf(table, ref('a-sub-sub')), 'w-2', 'sub-agents follow their chat')
  assert.equal(ownerOf(table, ref('b')), 'w-1')
})

test('a window lets go of exactly the chats that move, and gets them back when the other closes', () => {
  const before: ClaimTable = { main: claimsFor({ kind: 'main' }, [P, Q]) }
  const after = withClaims(before, 'w-1', [{ kind: 'project', key: P }])
  assert.deepEqual(lostChats(refs, after, 'main').map(c => c.id), ['a', 'a-sub', 'a-sub-sub', 'b'])
  // The new window, holding nothing yet, loses nothing.
  assert.deepEqual(lostChats([], after, 'w-1'), [])
  // Window 1 closes: main owns them again.
  const closed = withoutWindow(after, 'w-1')
  for (const r of refs) assert.equal(ownerOf(closed, r), 'main')
})

test('claiming does not touch other windows\' other claims, and claims are not doubled', () => {
  const table: ClaimTable = { 'main': [{ kind: 'project', key: P }, { kind: 'project', key: Q }], 'w-1': [] }
  const next = withClaims(withClaims(table, 'w-1', [{ kind: 'project', key: Q }]), 'w-1', [{ kind: 'project', key: Q }])
  assert.deepEqual(next.main, [{ kind: 'project', key: P }])
  assert.deepEqual(next['w-1'], [{ kind: 'project', key: Q }])
  assert.deepEqual(table.main!.length, 2, 'the table given is not changed')
})

test('a window claims its open projects; a chat window only its chats', () => {
  assert.deepEqual(claimsFor({ kind: 'project', path: P }, [P, P, Q]), [{ kind: 'project', key: P }, { kind: 'project', key: Q }])
  assert.deepEqual(claimsFor({ kind: 'chat', threadId: 'a', path: P }, [P], ['n']), [{ kind: 'chat', key: 'a' }, { kind: 'chat', key: 'n' }])
  assert.deepEqual(claimsFor({ kind: 'main' }, [], ['busy']), [{ kind: 'chat', key: 'busy' }])
})
