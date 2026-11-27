/**
 * Keeping the Files view in step cheaply: listings and status reads compared without turning them
 * into text, folders marked up only as far as needed, focus-driven work rate-limited, and a long
 * tree drawn a window at a time.
 *
 *   node --test tests/filesSync.test.ts      (or: pnpm test)
 */
import { mock, test } from 'node:test'
import assert from 'node:assert/strict'
import type { FsEntry, GitFile, GitStatus } from '../app/types/ipc.ts'
import { markFolders, sameChanges, sameEntries } from '../app/utils/filesSync.ts'
import { focusGate } from '../app/utils/focusGate.ts'
import { offsetsOf, piecesOf, scrollToOffset, windowByOffsets } from '../app/utils/treeWindow.ts'

const entry = (path: string, isDir = false, ignored = false): FsEntry => ({ name: path.slice(path.lastIndexOf('/') + 1), path, isDir, ignored })

test('a listing that says the same is the same', () => {
  const a = [entry('Assets', true), entry('Assets.meta'), entry('Library', true, true)]
  assert.ok(sameEntries(a, a))
  assert.ok(sameEntries(a, a.map(e => ({ ...e }))))
  assert.ok(sameEntries([], []))
  assert.ok(!sameEntries(null, []))
  assert.ok(!sameEntries(a, a.slice(1)))
  assert.ok(!sameEntries(a, [a[0]!, entry('Assets.meta', true), a[2]!]))
  assert.ok(!sameEntries(a, [a[0]!, a[1]!, entry('Library', true, false)]))
  assert.ok(!sameEntries(a, [a[0]!, entry('Other.meta'), a[2]!]))
})

const file = (path: string, worktree: GitFile['worktree'] = 'M'): GitFile => ({ path, index: null, worktree, conflicted: false }) as GitFile
const status = (files: GitFile[], head = 'abc'): GitStatus => ({ isRepo: true, branch: 'main', head, files }) as GitStatus

test('status reads compared by their changes', () => {
  const s = status([file('a.cs'), file('b.cs', '?')])
  assert.ok(sameChanges(s, s))
  assert.ok(sameChanges(null, null))
  assert.ok(sameChanges(s, status([file('a.cs'), file('b.cs', '?')])))
  assert.ok(!sameChanges(s, null))
  assert.ok(!sameChanges(s, status([file('a.cs'), file('b.cs', '?')], 'def')))
  assert.ok(!sameChanges(s, status([file('a.cs'), file('b.cs', 'M')])))
  assert.ok(!sameChanges(s, status([file('a.cs')])))
})

test('folders holding changes keep the strongest, walking up only as far as needed', () => {
  const RANK: Record<string, number> = { modified: 1, added: 2, untracked: 2, conflict: 3 }
  const rank = (k: string) => RANK[k]!
  // The same as setting every ancestor to the highest-ranked kind, the first one among equals.
  const slow = (files: [string, string][]) => {
    const out = new Map<string, string>()
    for (const [rel, kind] of files) {
      const parts = rel.split('/')
      for (let i = 1; i < parts.length; i++) {
        const dir = parts.slice(0, i).join('/')
        const had = out.get(dir)
        if (!had || rank(kind) > rank(had)) out.set(dir, kind)
      }
    }
    return out
  }
  const files: [string, string][] = [
    ['a/b/x.cs', 'modified'], ['a/b/y.cs', 'added'], ['a/c/z.cs', 'untracked'], ['a/b/w.cs', 'untracked'],
    ['top.cs', 'modified'], ['d/e/f/g.cs', 'modified'], ['d/e/conflict.cs', 'conflict'], ['d/e/f/h.cs', 'added'],
  ]
  const fast = new Map<string, string>()
  for (const [rel, kind] of files) markFolders(fast, rel, kind, rank)
  assert.deepEqual([...fast].sort(), [...slow(files)].sort())
})

test('focus-driven work runs at most once in its quiet time, and the last focus still counts', () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    let at = 0
    let runs = 0
    const gate = focusGate(() => runs++, 5000, () => at)
    gate()
    assert.equal(runs, 1)
    at = 1000; gate()
    at = 2000; gate()
    assert.equal(runs, 1)
    // The focuses inside the quiet time run once, when it is over.
    at = 5000; mock.timers.tick(4000)
    assert.equal(runs, 2)
    at = 6000; mock.timers.tick(10_000)
    assert.equal(runs, 2)
    // Long after: at once.
    at = 20_000; gate()
    assert.equal(runs, 3)
    // A waiting run can be dropped.
    at = 21_000; gate(); gate.cancel()
    at = 30_000; mock.timers.tick(20_000)
    assert.equal(runs, 3)
  } finally {
    mock.timers.reset()
  }
})

test('a long tree drawn a window at a time, rows of a few heights', () => {
  // 1000 rows of 26px, one note of 24px at 10 and a taller name field at 500.
  const height = (i: number) => (i === 10 ? 24 : i === 500 ? 44 : 26)
  const tops = offsetsOf(1000, height)
  assert.equal(tops.length, 1001)
  assert.equal(tops[11], 10 * 26 + 24)
  assert.equal(tops[1000], 998 * 26 + 24 + 44)

  // At the top, 260px in view below 4px of padding: rows 0..9 (row 10 starts below it) and two more.
  assert.deepEqual(windowByOffsets({ tops, scrollTop: 0, viewport: 260, listTop: 4, overscan: 2 }), { start: 0, end: 12 })
  // Scrolled into the middle.
  const mid = windowByOffsets({ tops, scrollTop: 4 + tops[600]!, viewport: 26 * 10, listTop: 4, overscan: 0 })
  assert.deepEqual(mid, { start: 600, end: 611 })
  // Past the end, and an empty list.
  assert.deepEqual(windowByOffsets({ tops, scrollTop: 1e9, viewport: 260, listTop: 0, overscan: 3 }), { start: 997, end: 1000 })
  assert.deepEqual(windowByOffsets({ tops: [0], scrollTop: 0, viewport: 260, listTop: 0 }), { start: 0, end: 0 })

  // The gaps keep the whole tree's height, pinned rows drawn where they are.
  const pieces = piecesOf(tops, { start: 600, end: 610 }, [3, 500, 605, 900, 2000])
  const total = pieces.reduce((sum, p) => sum + (p.type === 'gap' ? p.height : height(p.index)), 0)
  assert.equal(total, tops[1000])
  assert.deepEqual(pieces.filter(p => p.type === 'row').map(p => (p as { index: number }).index),
    [3, 500, ...Array.from({ length: 10 }, (_, i) => 600 + i), 900])
  assert.equal(new Set(pieces.map(p => (p.type === 'gap' ? p.key : p.index))).size, pieces.length)
  // Nothing left out at either end: no gaps.
  assert.deepEqual(piecesOf(offsetsOf(3, () => 26), { start: 0, end: 3 }).map(p => p.type), ['row', 'row', 'row'])

  // Bringing a row into view scrolls only as far as needed.
  assert.equal(scrollToOffset({ tops, index: 2, scrollTop: 0, viewport: 260, listTop: 4 }), null)
  assert.equal(scrollToOffset({ tops, index: 600, scrollTop: 0, viewport: 260, listTop: 4 }), 4 + tops[601]! - 260)
  assert.equal(scrollToOffset({ tops, index: 5, scrollTop: 5000, viewport: 260, listTop: 4 }), 4 + tops[5]!)
})
