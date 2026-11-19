import { describe, expect, it } from 'vitest'
import { accountLine, resetText, usageLevel } from './usageText'

const NOW = Date.UTC(2026, 10, 19, 12, 0, 0)
const min = 60_000

describe('resetText', () => {
  it('counts down to a reset', () => {
    expect(resetText(null, NOW)).toBe('')
    expect(resetText(NOW - 1, NOW)).toBe('Resetting now')
    expect(resetText(NOW + 12 * min, NOW)).toBe('Resets in 12 min')
    expect(resetText(NOW + 156 * min, NOW)).toBe('Resets in 2 h 36 min')
  })

  it('names the day for a reset further off', () => {
    expect(resetText(NOW + 3 * 24 * 60 * min, NOW)).toMatch(/^Resets \S+ \d/)
    expect(resetText(NOW + 20 * 24 * 60 * min, NOW)).toMatch(/^Resets \d{1,2} \S+$|^Resets \S+ \d{1,2}$/)
  })
})

describe('usageLevel', () => {
  it('warms at 80 and is full at 100', () => {
    expect([0, 79.9, 80, 99, 100, 130].map(usageLevel)).toEqual(['ok', 'ok', 'high', 'high', 'full', 'full'])
  })
})

describe('accountLine', () => {
  it('lists what is known', () => {
    expect(accountLine({ account: 'a@b.c', organization: null, plan: 'max', method: 'claude.ai' })).toBe('a@b.c · Max · claude.ai')
    expect(accountLine({ account: null, organization: null, plan: null, method: 'ChatGPT' })).toBe('ChatGPT')
    expect(accountLine({ account: null, organization: null, plan: null, method: null })).toBe('')
  })
})
