/**
 * Whether opening a project asks "This window or New window". Plain Node:
 *
 *   node --test tests/openWhere.test.ts      (or: pnpm test)
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openProjectInOf, whereToOpen } from '../app/utils/openWhere.ts'

const P = '/home/me/shop'
const Q = 'env://host-1/dev/home/agent/api'
const base = { pref: 'ask' as const, windowKind: 'main' as const, openHere: [Q], path: P, elsewhere: false }

test('a window with other projects asks, or follows the remembered choice', () => {
  assert.equal(whereToOpen(base), 'ask')
  assert.equal(whereToOpen({ ...base, windowKind: 'project' }), 'ask')
  assert.equal(whereToOpen({ ...base, pref: 'new' }), 'new')
  assert.equal(whereToOpen({ ...base, pref: 'this' }), 'this')
})

test('nothing to choose: open here without asking', () => {
  for (const pref of ['ask', 'new'] as const) {
    assert.equal(whereToOpen({ ...base, pref, openHere: [] }), 'this', 'empty window')
    assert.equal(whereToOpen({ ...base, pref, openHere: [Q, P] }), 'this', 'already open here')
    assert.equal(whereToOpen({ ...base, pref, windowKind: 'chat' }), 'this', 'chat window')
    assert.equal(whereToOpen({ ...base, pref, elsewhere: true }), 'this', 'open in another window')
  }
})

test('a stored pref from any build reads back as a known value', () => {
  assert.equal(openProjectInOf(undefined), 'ask')
  assert.equal(openProjectInOf('sideways'), 'ask')
  assert.equal(openProjectInOf(3), 'ask')
  assert.equal(openProjectInOf('new'), 'new')
  assert.equal(openProjectInOf('this'), 'this')
})
