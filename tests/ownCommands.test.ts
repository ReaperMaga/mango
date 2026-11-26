/**
 * Mango's own `/create-pr`, `/create-release` and `/handoff`: which messages are them, and what goes to the agent.
 *
 *   node --test tests/ownCommands.test.ts      (or: pnpm test)
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createPrPrompt } from '../app/utils/createPr.ts'
import { createReleasePrompt } from '../app/utils/createRelease.ts'
import { continuedTitle, handoffHistory, handoffPrompt, handoffReply, HANDOFF_LEAD, isHandoff } from '../app/utils/handoff.ts'
import type { Message, Part } from '../app/types/chat.ts'

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

test('/handoff gives the instructions, with notes when there are some', () => {
  const p = handoffPrompt('/handoff')
  assert.ok(p?.startsWith(HANDOFF_LEAD))
  assert.ok(!p.includes('My notes'))
  assert.equal(handoffPrompt('  /handoff \n'), p)
  assert.ok(handoffPrompt('/handoff next: the tests')?.endsWith('next: the tests'))
})

test('other messages are not /handoff', () => {
  for (const text of ['handoff', '/handoffs', '/handoff-now', 'please /handoff', '/create-pr']) {
    assert.equal(handoffPrompt(text), null, text)
    assert.equal(isHandoff(text), false, text)
  }
  assert.equal(createPrPrompt('/handoff'), null)
  assert.equal(createReleasePrompt('/handoff'), null)
})

let n = 0
const msg = (role: Message['role'], parts: Part[], outcome?: Message['outcome']): Message =>
  ({ id: `m${n++}`, role, parts, createdAt: n, ...(outcome ? { outcome } : {}) })
const said = (text: string) => ({ type: 'text' as const, text })

test('the handoff is the text of the reply to the last /handoff', () => {
  const chat = [
    msg('user', [said('fix the tabs')]),
    msg('agent', [said('Done.')], 'done'),
    msg('user', [said('/handoff next: tests')]),
    msg('agent', [{ type: 'thinking', text: 'hm', seconds: 1 }, said('## Goal\nTabs.'), said(' ')], 'done'),
  ]
  assert.equal(handoffReply(chat), '## Goal\nTabs.')
})

test('no handoff when the last message was not /handoff, or the reply failed, stopped or said nothing', () => {
  const asked = msg('user', [said('/handoff')])
  assert.equal(handoffReply([msg('user', [said('hi')]), msg('agent', [said('Hello')], 'done')]), null)
  assert.equal(handoffReply([asked]), null)
  assert.equal(handoffReply([asked, msg('agent', [said('## Goal')], 'stopped')]), null)
  assert.equal(handoffReply([asked, msg('agent', [said('## Goal')], 'error')]), null)
  assert.equal(handoffReply([asked, msg('agent', [{ type: 'notice', level: 'info', text: 'x' }], 'done')]), null)
  // A later message decides, not an earlier handoff.
  assert.equal(handoffReply([asked, msg('agent', [said('## Goal')], 'done'), msg('user', [said('more')]), msg('agent', [said('ok')], 'done')]), null)
})

test('the new chat hands the handoff on, and its title is marked once', () => {
  const h = handoffHistory('Fix tabs', '## Goal\nTabs.')
  assert.ok(h.includes('"Fix tabs"'))
  assert.ok(h.includes('<handoff>\n## Goal\nTabs.\n</handoff>'))
  assert.equal(continuedTitle('Fix tabs'), 'Fix tabs (continued)')
  assert.equal(continuedTitle(continuedTitle('Fix tabs')), 'Fix tabs (continued)')
})
