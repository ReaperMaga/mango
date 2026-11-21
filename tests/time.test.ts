/**
 * The day marks of a chat.
 *
 *   node --test tests/time.test.ts      (or: pnpm test)
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dayLabel, sameDay } from '../app/utils/time.ts'

const at = (y: number, m: number, d: number, h = 12) => new Date(y, m - 1, d, h).getTime()

test('same calendar day, whatever the hour', () => {
  assert.equal(sameDay(at(2026, 3, 3, 0), at(2026, 3, 3, 23)), true)
  assert.equal(sameDay(at(2026, 3, 3, 23), at(2026, 3, 4, 0)), false)
})

test('today and yesterday are named', () => {
  const now = at(2026, 3, 10)
  assert.equal(dayLabel(at(2026, 3, 10, 8), now), 'Today')
  assert.equal(dayLabel(at(2026, 3, 9, 20), now), 'Yesterday')
})

test('older days carry their date, and the year once it is not this one', () => {
  const now = at(2026, 3, 10)
  assert.match(dayLabel(at(2026, 3, 3), now), /3/)
  assert.doesNotMatch(dayLabel(at(2026, 3, 3), now), /2026/)
  assert.match(dayLabel(at(2025, 12, 24), now), /2025/)
})
