/**
 * Terminals as tabs in the main area: tab ids, and where a dragged tab lands. Plain Node:
 *
 *   node --test tests/terminalTabs.test.ts      (or: pnpm test)
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { editorTabOf, insertionIndex, isTerminalTab, paneZone, parseTerminalTab, placeBefore, terminalTabId } from '../app/utils/terminalTabs.ts'

test('tab ids carry the project and the terminal', () => {
  for (const project of ['/home/me/app', 'C:\\work\\app', 'env://h1/box/home/agent/app']) {
    const id = terminalTabId(project, 'term-3')
    assert.ok(isTerminalTab(id))
    assert.deepEqual(parseTerminalTab(id), { projectPath: project, terminalId: 'term-3' })
  }
  for (const other of [null, undefined, '', 'chat-1', 'file\u0001/p\u0001a.ts', 'browser\u0001/p\u0001b1']) {
    assert.equal(isTerminalTab(other), false)
    assert.equal(parseTerminalTab(other), null)
  }
})

test('the main-area tab of a terminal', () => {
  const tabs = ['chat-1', terminalTabId('/p', 'term-1'), terminalTabId('/q', 'term-12')]
  assert.equal(editorTabOf(tabs, 'term-1'), tabs[1])
  assert.equal(editorTabOf(tabs, 'term-12'), tabs[2])
  assert.equal(editorTabOf(tabs, 'term-2'), null)
})

test('insertion index: left half before, right half after', () => {
  const spans = [{ left: 0, width: 100 }, { left: 102, width: 80 }, { left: 184, width: 60 }]
  assert.equal(insertionIndex(spans, -10), 0)
  assert.equal(insertionIndex(spans, 49), 0)
  assert.equal(insertionIndex(spans, 51), 1)
  assert.equal(insertionIndex(spans, 141), 1)
  assert.equal(insertionIndex(spans, 143), 2)
  assert.equal(insertionIndex(spans, 215), 3)
  assert.equal(insertionIndex(spans, 900), 3)
  assert.equal(insertionIndex([], 10), 0)
})

test('placeBefore inserts or moves, never duplicates', () => {
  assert.deepEqual(placeBefore(['a', 'b', 'c'], 'x', 'b'), ['a', 'x', 'b', 'c'])
  assert.deepEqual(placeBefore(['a', 'b', 'c'], 'x', null), ['a', 'b', 'c', 'x'])
  assert.deepEqual(placeBefore(['a', 'b', 'c'], 'c', 'a'), ['c', 'a', 'b'])
  assert.deepEqual(placeBefore(['a', 'b', 'c'], 'a', null), ['b', 'c', 'a'])
  assert.deepEqual(placeBefore(['a', 'b', 'c'], 'a', 'c'), ['b', 'a', 'c'])
  assert.deepEqual(placeBefore(['a', 'b', 'c'], 'b', 'b'), ['a', 'b', 'c'])
  assert.deepEqual(placeBefore(['a'], 'x', 'x'), ['a', 'x'])
  // A `before` that is not in the list puts it at the end.
  assert.deepEqual(placeBefore(['a', 'b'], 'x', 'gone'), ['a', 'b', 'x'])
  const objs = [{ id: 1 }, { id: 2 }]
  assert.deepEqual(placeBefore(objs, objs[1]!, objs[0]!), [objs[1], objs[0]])
  const list = ['a', 'b']
  placeBefore(list, 'b', 'a')
  assert.deepEqual(list, ['a', 'b'], 'the input is left alone')
})

test('pane zones: the right third splits, only when it may', () => {
  const pane = { left: 100, width: 900 }
  assert.equal(paneZone(pane, 150, true), 'center')
  assert.equal(paneZone(pane, 699, true), 'center')
  assert.equal(paneZone(pane, 700, true), 'right')
  assert.equal(paneZone(pane, 990, true), 'right')
  assert.equal(paneZone(pane, 990, false), 'center')
})
