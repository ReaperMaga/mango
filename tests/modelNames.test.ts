/**
 * Model titles from raw ids, for the model picker. Plain Node, no dependencies:
 *
 *   node --test tests/modelNames.test.ts      (or: pnpm test)
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { modelTitle } from '../app/utils/modelNames.ts'

test('current Claude ids read as family and version', () => {
  assert.equal(modelTitle('claude-opus-5-5'), 'Opus 5.5')
  assert.equal(modelTitle('claude-sonnet-5'), 'Sonnet 5')
  assert.equal(modelTitle('claude-haiku-4-5-20251001'), 'Haiku 4.5')
  assert.equal(modelTitle('claude-fable-5-2'), 'Fable 5.2')
})

test('older ids put the version first', () => {
  assert.equal(modelTitle('claude-3-5-sonnet-20241022'), 'Sonnet 3.5')
  assert.equal(modelTitle('claude-3-7-sonnet-latest'), 'Sonnet 3.7')
})

test('the long-context variant says so', () => {
  assert.equal(modelTitle('claude-sonnet-4-5[1m]'), 'Sonnet 4.5 (1M context)')
})

test('names that are already titles, aliases and other vendors stay as they are', () => {
  for (const name of ['Opus 5.5', 'Default (recommended)', 'opus', 'GPT-5.5', 'gpt-5.4-mini', 'claude-', 'claude-4-5', 'claude-opus_x'])
    assert.equal(modelTitle(name), name)
})
