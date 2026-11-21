/**
 * The text of an earlier conversation, handed to an agent whose session was cut back.
 *
 *   node --test tests/transcript.test.ts      (or: pnpm test)
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { transcript } from '../app/utils/transcript.ts'
import type { Message } from '../app/types/chat.ts'

const msg = (role: 'user' | 'agent', text: string, extra: Partial<Message> = {}): Message =>
  ({ id: text, role, parts: text ? [{ type: 'text', text }] : [], createdAt: 0, ...extra })

test('nothing said, nothing to hand over', () => {
  assert.equal(transcript([]), null)
  assert.equal(transcript([msg('agent', '')]), null)
})

test('both sides in order, tool calls left out', () => {
  const t = transcript([
    msg('user', 'hi'),
    { id: 'a', role: 'agent', createdAt: 0, parts: [{ type: 'tool', id: 't', tool: 'bash', label: 'Ran', status: 'ok' } as never, { type: 'text', text: 'hello' }] },
  ])!
  assert.match(t, /User: hi\n\nAssistant: hello/)
  assert.doesNotMatch(t, /bash/)
})

test('a sub-agent task is not a person speaking', () => {
  assert.equal(transcript([msg('user', 'task', { fromAgent: true })]), null)
})

test('attached files are named', () => {
  const t = transcript([msg('user', 'see', { attachments: [{ id: '1', name: 'a.png', path: '/x/a.png', mime: 'image/png', size: 1, kind: 'image' }] })])!
  assert.match(t, /\[attached: \/x\/a\.png\]/)
})

test('too long: the newest messages stay', () => {
  const big = 'x'.repeat(5000)
  const all = Array.from({ length: 20 }, (_, i) => msg(i % 2 ? 'agent' : 'user', `${i}${big}`))
  const t = transcript(all)!
  assert.match(t, /Older messages left out/)
  assert.match(t, /19x{10}/)
  assert.doesNotMatch(t, /\n0x{10}/)
})
