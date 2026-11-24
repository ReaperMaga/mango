/**
 * Remote project paths and the place an agent CLI runs in. Plain Node, no dependencies:
 *
 *   node --test tests/envPath.test.ts      (or: pnpm test)
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { placeKey } from '../app/utils/envPath.ts'

test('local projects all run their agents on this computer', () => {
  assert.equal(placeKey('/home/me/work/shop'), 'local')
  assert.equal(placeKey('C:\\Users\\me\\shop'), 'local')
  assert.equal(placeKey(null), 'local')
  assert.equal(placeKey(undefined), 'local')
})

test('a remote project runs its agents in its instance, whatever the folder', () => {
  assert.equal(placeKey('env://h1/dev/home/agent/work/shop'), 'env://h1/dev')
  assert.equal(placeKey('env://h1/dev/home/agent/other'), 'env://h1/dev')
  assert.equal(placeKey('env://h1/dev'), 'env://h1/dev')
})

test('instances and servers are told apart', () => {
  assert.notEqual(placeKey('env://h1/dev/x'), placeKey('env://h1/prod/x'))
  assert.notEqual(placeKey('env://h1/dev/x'), placeKey('env://h2/dev/x'))
})
