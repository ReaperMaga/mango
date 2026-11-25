/**
 * Large Claude Code chats after a break: when Mango asks about compacting one and when it may by itself.
 * Plain Node, no dependencies:
 *
 *   node --test tests/idleCompaction.test.ts      (or: pnpm test)
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Message, Thread } from '../app/types/chat.ts'
import type { AgentEvent } from '../app/agents/types.ts'
import { breakToAsk, cacheOwner, dueForCompaction, MIN_TOKENS } from '../app/utils/idleCompaction.ts'
import { claudeCacheTtl, mergeCache, normalizeCache } from '../app/agents/context.ts'
import { claudeAdapter, lastMessage } from '../app/agents/claude.ts'

const MIN = 60_000
const HOUR = 60 * MIN
const T0 = 1_800_000_000_000

const user = (text: string): Message => ({ id: 'u', role: 'user', createdAt: T0 - MIN, parts: [{ type: 'text', text }] })
const reply: Message = { id: 'a', role: 'agent', createdAt: T0 - MIN, outcome: 'done', elapsedMs: MIN, parts: [{ type: 'text', text: 'ok' }] }
const chat = (over: Partial<Thread> = {}): Thread => ({
  id: 't', projectPath: 'C:\\p', title: '', agent: 'claude', model: 'opus', mode: 'ask', effort: null, status: 'working',
  messages: [user('hi'), reply], createdAt: 0, updatedAt: T0, seen: true, sessionId: 's',
  context: { used: 462_000, max: 1_000_000, at: T0 }, cache: { at: T0, ttlMs: HOUR, for: 'opus ' }, ...over,
})

test('asks once the cache is gone, with how long and how much', () => {
  assert.equal(breakToAsk(chat(), 'ask', T0 + HOUR - 1), null)
  assert.deepEqual(breakToAsk(chat(), 'ask', T0 + HOUR), { since: T0, tokens: 462_000 })
  // Automatic could not (the computer slept): it asks too.
  assert.ok(breakToAsk(chat(), 'auto', T0 + 3 * HOUR))
  assert.equal(breakToAsk(chat(), 'off', T0 + 3 * HOUR), null)
  // Settled, failed and archived chats can be written in as well.
  assert.ok(breakToAsk(chat({ status: 'done' }), 'ask', T0 + HOUR))
  assert.ok(breakToAsk(chat({ status: 'error' }), 'ask', T0 + HOUR))
  assert.ok(breakToAsk(chat({ archived: true }), 'ask', T0 + HOUR))
})

test('a short pause is no break, whatever the cache lasts, and a reply from elsewhere counts as use', () => {
  const short = chat({ cache: { at: T0, ttlMs: 5 * MIN, for: 'opus ' } })
  assert.equal(breakToAsk(short, 'ask', T0 + 20 * MIN), null)
  assert.ok(breakToAsk(short, 'ask', T0 + HOUR))
  const later = chat({ messages: [user('hi'), { ...reply, createdAt: T0 + 30 * MIN }] })
  assert.equal(breakToAsk(later, 'ask', T0 + HOUR), null)
})

test('never for a chat there is nothing to compact in, or that should be left alone', () => {
  const never: Partial<Thread>[] = [
    { agent: 'codex' }, { parentId: 'p' }, { sessionId: null }, { keepContext: true }, { cache: undefined },
    { status: 'running' }, { status: 'queued' }, { status: 'waiting' }, { context: undefined },
    { context: { used: MIN_TOKENS - 1, max: 1_000_000, at: T0 } }, { messages: [] }, { messages: [user('hi')] },
    { messages: [user('/compact'), reply] }, { messages: [user('/compact keep the API'), reply] },
  ]
  for (const over of never) {
    assert.equal(breakToAsk(chat(over), 'ask', T0 + 5 * HOUR), null, JSON.stringify(over))
    assert.equal(dueForCompaction(chat(over), 'auto', T0 + 55 * MIN, false), false, JSON.stringify(over))
  }
  assert.ok(breakToAsk(chat({ messages: [user('/compaction is slow'), reply] }), 'ask', T0 + HOUR))
})

test('by itself only when chosen, in the minutes before the cache goes', () => {
  const at = (min: number, over: Partial<Thread> = {}, setting: 'ask' | 'auto' | 'off' = 'auto', busy = false) =>
    dueForCompaction(chat(over), setting, T0 + min * MIN, busy)
  assert.deepEqual([53.9, 54, 58.9, 59, 60, 300].map(m => at(m)), [false, true, true, false, false, false])
  assert.equal(at(55, {}, 'ask'), false)
  assert.equal(at(55, {}, 'off'), false)
  assert.equal(at(55, {}, 'auto', true), false)
  const not: Partial<Thread>[] = [
    { archived: true }, { status: 'done' }, { status: 'error' }, { simulated: true }, { projectPath: 'env://h/i/home/agent/p' },
    { cache: { at: T0, ttlMs: HOUR, for: 'opus ', tried: true } }, { model: 'sonnet' }, { effort: 'high' },
    { messages: [user('hi'), { ...reply, outcome: 'stopped' }] }, { messages: [user('hi'), { ...reply, outcome: 'error' }] },
    { messages: [user('hi'), { ...reply, outcome: undefined }] },
  ]
  for (const over of not) assert.equal(at(55, over), false, JSON.stringify(over))
  // A five-minute cache is never worth it.
  assert.equal(dueForCompaction(chat({ cache: { at: T0, ttlMs: 5 * MIN, for: 'opus ' } }), 'auto', T0 + 3 * MIN, false), false)
})

test('a request starts the cache anew; one that says no time keeps the last, for the same model and effort only', () => {
  assert.equal(claudeCacheTtl({ cache_creation: { ephemeral_1h_input_tokens: 5, ephemeral_5m_input_tokens: 0 } }), HOUR)
  assert.equal(claudeCacheTtl({ cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 5 } }), 5 * MIN)
  assert.equal(claudeCacheTtl({ cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 } }), undefined)
  assert.equal(claudeCacheTtl(undefined), undefined)
  const first = mergeCache(undefined, { at: 1, ttlMs: HOUR }, 'opus ')
  assert.deepEqual(first, { at: 1, ttlMs: HOUR, for: 'opus ' })
  assert.deepEqual(mergeCache({ ...first!, tried: true }, { at: 2 }, 'opus '), { at: 2, ttlMs: HOUR, for: 'opus ' })
  assert.equal(mergeCache(first, { at: 2 }, 'sonnet '), undefined)
  assert.equal(mergeCache(undefined, { at: 2 }, 'opus '), undefined)
  assert.equal(cacheOwner({ model: 'opus', effort: 'high' }), 'opus high')
})

test('a saved cache is checked', () => {
  assert.deepEqual(normalizeCache({ at: 5, ttlMs: 6, for: 'x', tried: true, more: 1 }), { at: 5, ttlMs: 6, for: 'x', tried: true })
  for (const bad of [undefined, null, 'x', {}, { at: 5 }, { at: 5, ttlMs: 'x', for: 'a' }, { at: 5, ttlMs: 6 }, { at: -1, ttlMs: 6, for: 'a' }]) {
    assert.equal(normalizeCache(bad), undefined)
  }
})

test('claude: says when a request went out and when /compact worked', async () => {
  const events: AgentEvent[] = []
  await new Promise<void>((resolve) => {
    claudeAdapter.run({
      cwd: '/p', prompt: '/compact', model: 'default', mode: 'ask', sessionId: 's1',
      async spawn(_args, handlers) {
        const out = (o: unknown) => handlers.onLine(JSON.stringify(o))
        return {
          async write(line) {
            const m = JSON.parse(line)
            if (m.type === 'control_request') return out({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: {} } })
            out({ type: 'stream_event', event: { type: 'message_start', message: { id: 'm1', usage: { input_tokens: 2, cache_read_input_tokens: 10, cache_creation: { ephemeral_1h_input_tokens: 3 } } } } })
            out({ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'auto' } })
            out({ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'manual', pre_tokens: 9, post_tokens: 1 } })
            out({ type: 'result', subtype: 'success', session_id: 's1', result: '' })
          },
          async closeStdin() {},
          async kill() {},
        }
      },
      emit(e) { events.push(e); if (e.type === 'turn-end') resolve() },
    })
  })
  const cache = events.filter(e => e.type === 'cache')
  assert.equal(cache.length, 1)
  assert.equal(cache[0]!.type === 'cache' && cache[0]!.ttlMs, HOUR)
  assert.equal(events.filter(e => e.type === 'compacted').length, 1)
})

test('claude: takes no message while it compacts, so none is lost in it', async () => {
  for (const [prompt, taken] of [['/compact', false], ['hi', true]] as const) {
    const run = claudeAdapter.run({
      cwd: '/p', prompt, model: 'default', mode: 'ask', sessionId: 's1', emit() {},
      spawn: async () => ({ async write() {}, async closeStdin() {}, async kill() {} }),
    })
    await new Promise(resolve => setTimeout(resolve, 5))
    assert.equal(await run.steer!({ prompt: 'and this' }), taken, prompt)
  }
})

test('claude: the last message of a transcript comes with its time', () => {
  const lines = [
    JSON.stringify({ type: 'assistant', uuid: 'a1', timestamp: '2026-11-25T00:48:24.268Z', message: { content: [] } }),
    JSON.stringify({ type: 'cost-state' }),
  ]
  assert.deepEqual(lastMessage(lines), { uuid: 'a1', at: Date.parse('2026-11-25T00:48:24.268Z') })
  assert.equal(lastMessage([lines[1]!]), null)
})
