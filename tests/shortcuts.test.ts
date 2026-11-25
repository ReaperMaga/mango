/**
 * Keyboard shortcuts: the keys an editor claims for itself.
 *
 *   node --test tests/shortcuts.test.ts     (or: pnpm test)
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ownsKey } from '../app/utils/shortcuts.ts'

test('an editor has only the keys it claims', () => {
  const claims = ['Mod+B Mod+I\n  Mod+Shift+K']
  assert.ok(ownsKey(claims, 'Mod+B'))
  assert.ok(ownsKey(claims, 'Mod+Shift+K'))
  assert.equal(ownsKey(claims, 'Mod+K'), false)
  assert.equal(ownsKey(claims, 'Mod+Shift+B'), false)
  assert.equal(ownsKey([], 'Mod+B'), false)
  assert.equal(ownsKey([''], 'Mod+B'), false)
})

test('claims around the focus count together', () => {
  assert.ok(ownsKey(['Mod+E', 'Mod+B'], 'Mod+B'))
})
