/**
 * The usage line in the sidebar footer.
 *
 *   node --test tests/usageSummary.test.ts      (or: pnpm test)
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { shortIn, summarize, tightest } from '../app/utils/usageSummary.ts'

const MIN = 60_000
const H = 60 * MIN
const now = 1_700_000_000_000

test('the tightest window wins, the first on a tie', () => {
  const w = [
    { id: 'five-hour', label: '5-hour', percent: 38, resetsAt: null },
    { id: 'weekly', label: 'Weekly', percent: 84, resetsAt: null },
    { id: 'weekly:opus', label: 'Weekly · Opus', percent: 84, resetsAt: null },
  ]
  assert.equal(tightest(w)?.id, 'weekly')
  assert.equal(tightest([]), null)
})

test('reset times use the two largest units', () => {
  assert.equal(shortIn(30_000), '1m')
  assert.equal(shortIn(42 * MIN), '42m')
  assert.equal(shortIn(2 * H + 36 * MIN), '2h 36m')
  assert.equal(shortIn(3 * H), '3h')
  assert.equal(shortIn(52 * H + 10 * MIN), '2d 4h')
  assert.equal(shortIn(48 * H), '2d')
})

test('calm, high and full readings', () => {
  const calm = summarize([{ id: 'five-hour', label: '5-hour', percent: 37.6, resetsAt: now + 2 * H }], now)
  assert.deepEqual(calm && [calm.percent, calm.tone, calm.text], [38, 'calm', '38% 5-hour'])
  assert.equal(calm?.long, '38% of the 5-hour limit used, resets in 2h.')

  const high = summarize([{ id: 'weekly', label: 'Weekly', percent: 84, resetsAt: null }], now)
  assert.deepEqual(high && [high.tone, high.text, high.long], ['high', '84% weekly', '84% of the weekly limit used.'])

  const full = summarize([{ id: 'five-hour', label: '5-hour', percent: 104, resetsAt: now + 42 * MIN }], now)
  assert.deepEqual(full && [full.percent, full.tone, full.text], [100, 'full', 'Limit · back in 42m'])

  const stale = summarize([{ id: 'five-hour', label: '5-hour', percent: 100, resetsAt: now - MIN }], now)
  assert.equal(stale?.text, 'Limit reached')

  assert.equal(summarize([], now), null)
})
