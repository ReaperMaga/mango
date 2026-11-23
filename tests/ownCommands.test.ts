/**
 * Mango's own `/create-pr` and `/create-release`: which messages are them, and what goes to the agent.
 *
 *   node --test tests/ownCommands.test.ts      (or: pnpm test)
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createPrPrompt } from '../app/utils/createPr.ts'
import { createReleasePrompt } from '../app/utils/createRelease.ts'

test('/create-release alone gives the instructions, without notes', () => {
  const p = createReleasePrompt('/create-release')
  assert.ok(p?.startsWith('Cut a new release'))
  assert.ok(!p.includes('My notes'))
  assert.equal(createReleasePrompt('  /create-release \n'), p)
})

test('notes after /create-release go along', () => {
  const p = createReleasePrompt('/create-release minor,\nstress the new editor')
  assert.ok(p?.endsWith('minor,\nstress the new editor'))
})

test('other messages are not /create-release', () => {
  for (const text of ['create-release', '/create-releases', '/create-release-notes', 'please /create-release', '/create-pr']) {
    assert.equal(createReleasePrompt(text), null, text)
  }
})

test('the two commands do not answer for each other', () => {
  assert.equal(createPrPrompt('/create-release'), null)
  assert.equal(createReleasePrompt('/create-pr draft'), null)
  assert.ok(createPrPrompt('/create-pr draft')?.endsWith('draft'))
})
