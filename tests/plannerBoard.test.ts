import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isSamePlace, positionAt, previewText, stepIndex, taskCount } from '../plugins/planner/src/views/board/cards.ts'

const list = (s: string) => [...s].map(id => ({ id }))

test('a drop lands before the card at its index, or after the last', () => {
  assert.deepEqual(positionAt(list('abcd'), new Set('b'), 1), { before: 'c' })
  assert.deepEqual(positionAt(list('abcd'), new Set('d'), 3), { after: 'c' })
  assert.equal(positionAt(list('a'), new Set('a'), 0), undefined)
})

test('a drop where the cards are is not a move', () => {
  assert.equal(isSamePlace(list('abc'), ['b'], 1), true)
  assert.equal(isSamePlace(list('abc'), ['b'], 0), false)
  assert.equal(isSamePlace(list('abc'), ['x'], 1), false)
  assert.equal(isSamePlace(list('abcd'), ['a', 'c'], 0), false)
})

test('a block moves one step and stops at the ends', () => {
  assert.equal(stepIndex(list('abc'), new Set('b'), -1), 0)
  assert.equal(stepIndex(list('abc'), new Set('b'), 1), 2)
  assert.equal(stepIndex(list('abc'), new Set('a'), -1), null)
  assert.equal(stepIndex(list('abc'), new Set('c'), 1), null)
  assert.equal(stepIndex(list('abc'), new Set('x'), 1), null)
})

test('a preview is the plain words of a body', () => {
  assert.equal(previewText('# Head\n- [ ] do **this** and [that](http://x.y)\n> some_snake_case `code`'), 'Head do this and that some_snake_case code')
  assert.equal(previewText('word '.repeat(100), 10), 'word word…')
})

test('the tasks of a body are counted', () => {
  assert.deepEqual(taskCount('- [x] a\n  * [ ] b\n1. [X] c\n[ ] not one\n- plain'), { done: 2, all: 3 })
  assert.equal(taskCount('text'), null)
})
