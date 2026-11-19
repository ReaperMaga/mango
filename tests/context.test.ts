/**
 * Reading how full a conversation's context window is, from each CLI. Plain Node, no dependencies:
 *
 *   node --test tests/context.test.ts      (or: pnpm test)
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { claudeContext, claudeRequestTokens, codexContext, contextLevel, contextPercent, formatTokens, mergeContext, normalizeContext } from '../app/agents/context.ts'

/** Trimmed from a real `get_context_usage` answer (Claude Code 2.1). */
const claudeAnswer = {
  categories: [
    { id: 'system_prompt', name: 'System prompt', tokens: 2634, color: 'promptBorder', kind: 'used' },
    { id: 'system_tools', name: 'System tools', tokens: 8885, color: 'inactive', kind: 'used' },
    { id: 'system_tools_deferred', name: 'System tools (deferred)', tokens: 14486, color: 'inactive', isDeferred: true, kind: 'deferred' },
    { id: 'mcp_tools', name: 'MCP tools', tokens: 0, kind: 'used' },
    { id: 'messages', name: 'Messages', tokens: 72852, color: 'purple_FOR_SUBAGENTS_ONLY', kind: 'used' },
    { id: 'autocompact_buffer', name: 'Autocompact buffer', tokens: 33000, color: 'inactive', kind: 'buffer' },
    { id: 'free_space', name: 'Free space', tokens: 873152, color: 'promptBorder', kind: 'free' },
  ],
  totalTokens: 93848,
  maxTokens: 1000000,
  percentage: 9,
  model: 'claude-sonnet-5-5',
  autoCompactThreshold: 967000,
  isAutoCompactEnabled: true,
  gridRows: [[]],
}

test('claude: the /context answer, without deferred or empty parts', () => {
  const c = claudeContext(claudeAnswer)!
  assert.equal(c.used, 93848)
  assert.equal(c.max, 1000000)
  assert.equal(c.compactAt, 967000)
  assert.equal(c.model, 'claude-sonnet-5-5')
  assert.deepEqual(c.parts!.map(p => [p.id, p.tokens, p.kind]), [
    ['system_prompt', 2634, 'used'],
    ['system_tools', 8885, 'used'],
    ['messages', 72852, 'used'],
    ['autocompact_buffer', 33000, 'buffer'],
    ['free_space', 873152, 'free'],
  ])
})

test('claude: no compaction point when auto-compact is off; junk is no reading', () => {
  assert.equal(claudeContext({ ...claudeAnswer, isAutoCompactEnabled: false })!.compactAt, undefined)
  assert.equal(claudeContext(null), null)
  assert.equal(claudeContext({ totalTokens: 10 }), null)
  assert.equal(claudeContext({ totalTokens: 'x', maxTokens: 100 }), null)
})

test('claude: a request\'s prompt size counts cached input', () => {
  assert.equal(claudeRequestTokens({ input_tokens: 2, cache_creation_input_tokens: 1269, cache_read_input_tokens: 92577, output_tokens: 415 }), 93848)
  assert.equal(claudeRequestTokens({ input_tokens: 12 }), 12)
  assert.equal(claudeRequestTokens(undefined), null)
  assert.equal(claudeRequestTokens({}), null)
})

test('codex: the newest request and the model window', () => {
  const usage = {
    total: { totalTokens: 90000, inputTokens: 85000, cachedInputTokens: 60000, outputTokens: 5000, reasoningOutputTokens: 1000 },
    last: { totalTokens: 31000, inputTokens: 30000, cachedInputTokens: 20000, outputTokens: 1000, reasoningOutputTokens: 200 },
    modelContextWindow: 258400,
  }
  const c = codexContext(usage)!
  assert.equal(c.used, 31000)
  assert.equal(c.max, 258400)
  assert.equal(codexContext({ ...usage, modelContextWindow: null })!.max, 0)
  assert.equal(codexContext({}), null)
})

test('a live reading keeps the last window and drops the stale breakdown', () => {
  const full = claudeContext(claudeAnswer)!
  const live = mergeContext(full, { used: 120000, max: 0, at: 5 })
  assert.deepEqual(live, { used: 120000, max: 1000000, compactAt: 967000, model: 'claude-sonnet-5-5', at: 5 })
  assert.equal(mergeContext(undefined, { used: 10, max: 0, at: 1 }).max, 0)
  // A full reading replaces whatever was there.
  assert.equal(mergeContext(live, full), full)
})

test('percent and token counts', () => {
  assert.equal(contextPercent({ used: 93848, max: 1000000 }), 9)
  assert.equal(contextPercent({ used: 300, max: 200 }), 100)
  assert.equal(contextPercent({ used: 5, max: 0 }), null)
  assert.equal(contextPercent(undefined), null)
  assert.deepEqual(
    [512, 1234, 93848, 200000, 999960, 1000000, 1500000].map(formatTokens),
    ['512', '1.2k', '93.8k', '200k', '1M', '1M', '1.5M'],
  )
})

test('the warning level follows the compaction point, else the window', () => {
  assert.equal(contextLevel({ used: 46200, max: 200000, compactAt: 167000 }), 'ok')
  assert.equal(contextLevel({ used: 140000, max: 200000, compactAt: 167000 }), 'high')
  assert.equal(contextLevel({ used: 168000, max: 200000, compactAt: 167000 }), 'full')
  assert.equal(contextLevel({ used: 170000, max: 200000 }), 'high')
  assert.equal(contextLevel({ used: 5, max: 0 }), 'ok')
})

test('saved readings are checked', () => {
  assert.equal(normalizeContext(undefined), undefined)
  assert.equal(normalizeContext({ used: 'a', max: 1 }), undefined)
  const c = normalizeContext({ used: 10, max: 100, parts: [{ id: 'm', label: 'Messages', tokens: 10, kind: 'used' }, { label: 'x', tokens: -1, kind: 'used' }, null], at: 3 })
  assert.deepEqual(c, { used: 10, max: 100, parts: [{ id: 'm', label: 'Messages', tokens: 10, kind: 'used' }], at: 3 })
})
