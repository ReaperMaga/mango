/**
 * Long lists drawn a window at a time, and status reads compared without turning them into text.
 *
 *   node --test tests/rowWindow.test.ts      (or: pnpm test)
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { GitFile, GitStatus } from '../app/types/ipc.ts'
import { rowWindow, sameStatus, scrollToRow } from '../app/utils/rowWindow.ts'

test('the rows in view, with some either side', () => {
  // 29px rows from 100px down; the viewport shows 300px from the top.
  assert.deepEqual(rowWindow({ scrollTop: 0, viewport: 300, listTop: 100, count: 20_000, stride: 29, overscan: 0 }), { start: 0, end: 7 })
  assert.deepEqual(rowWindow({ scrollTop: 0, viewport: 300, listTop: 100, count: 20_000, stride: 29, overscan: 5 }), { start: 0, end: 12 })
  // Scrolled well into the list.
  const mid = rowWindow({ scrollTop: 100 + 29 * 5000, viewport: 290, listTop: 100, count: 20_000, stride: 29, overscan: 2 })
  assert.deepEqual(mid, { start: 4998, end: 5012 })
  // Past the end, and a list wholly below or above the viewport.
  assert.deepEqual(rowWindow({ scrollTop: 1e9, viewport: 300, listTop: 0, count: 50, stride: 29 }), { start: 50, end: 50 })
  assert.deepEqual(rowWindow({ scrollTop: 0, viewport: 300, listTop: 5000, count: 50, stride: 29, overscan: 0 }), { start: 0, end: 0 })
  assert.deepEqual(rowWindow({ scrollTop: 0, viewport: 300, listTop: 0, count: 0, stride: 29 }), { start: 0, end: 0 })
})

test('bringing a row into view scrolls only as far as needed', () => {
  const at = { viewport: 290, listTop: 100, stride: 29, rowHeight: 28 }
  assert.equal(scrollToRow({ ...at, scrollTop: 0, index: 2 }), null)
  // Below: its bottom lines up with the viewport's.
  assert.equal(scrollToRow({ ...at, scrollTop: 0, index: 20 }), 100 + 20 * 29 + 28 - 290)
  // Above: its top lines up with the viewport's.
  assert.equal(scrollToRow({ ...at, scrollTop: 5000, index: 10 }), 100 + 10 * 29)
})

const file = (path: string, over: Partial<GitFile> = {}): GitFile => ({ path, origPath: null, index: null, worktree: 'M', conflicted: false, ...over })
const status = (files: GitFile[], over: Partial<GitStatus> = {}): GitStatus => ({
  vcs: 'lore', repository: null, isRepo: true, root: '/w', mainRoot: null, branch: 'main', head: 'r3', upstream: null, ahead: 0, behind: 0, files, ...over,
})

test('status reads compare field by field', () => {
  const files = Array.from({ length: 20_000 }, (_, i) => file(`Assets/F${i}.prefab`))
  const a = status(files)
  assert.equal(sameStatus(a, status(files.map(f => ({ ...f })))), true)
  assert.equal(sameStatus(a, a), true)
  assert.equal(sameStatus(null, null), true)
  assert.equal(sameStatus(a, null), false)
  assert.equal(sameStatus(a, status(files, { head: 'r4' })), false)
  assert.equal(sameStatus(a, status(files.slice(1))), false)
  const staged = files.map((f, i) => (i === 19_999 ? { ...f, index: 'M' } : f))
  assert.equal(sameStatus(a, status(staged)), false)
  const moved = files.map((f, i) => (i === 7 ? { ...f, origPath: 'old' } : f))
  assert.equal(sameStatus(a, status(moved)), false)
})
