import { describe, expect, it } from 'vitest'
import type { Message } from '~/types/chat'
import { findMessages, pinnedMessages, plainText } from './find'
import { dayLabel, sameDay } from './time'

const msg = (id: string, role: 'user' | 'agent', text: string, extra: Partial<Message> = {}): Message =>
  ({ id, role, parts: text ? [{ type: 'text', text }] : [], createdAt: 0, ...extra })

describe('finding in a chat', () => {
  const all = [msg('a', 'user', 'Fix the Login page'), msg('b', 'agent', 'Done.\n\nThe login form now validates.', { pinned: true }), msg('c', 'agent', '')]
  it('reads only the words of a message', () => {
    expect(plainText(all[1]!)).toBe('Done.\n\nThe login form now validates.')
    expect(plainText(all[2]!)).toBe('')
  })
  it('finds case-insensitively, in order, with a line around the match', () => {
    const hits = findMessages(all, 'LOGIN')
    expect(hits.map(h => h.index)).toEqual([0, 1])
    expect(hits[1]!.snippet).toContain('login form')
  })
  it('finds nothing for an empty or unknown query', () => {
    expect(findMessages(all, '  ')).toEqual([])
    expect(findMessages(all, 'zebra')).toEqual([])
  })
  it('lists the pinned ones', () => {
    expect(pinnedMessages(all).map(h => h.message.id)).toEqual(['b'])
  })
})

describe('day marks', () => {
  const at = (y: number, m: number, d: number, h = 12) => new Date(y, m - 1, d, h).getTime()
  it('same calendar day, whatever the hour', () => {
    expect(sameDay(at(2026, 3, 3, 0), at(2026, 3, 3, 23))).toBe(true)
    expect(sameDay(at(2026, 3, 3, 23), at(2026, 3, 4, 0))).toBe(false)
  })
  it('names today and yesterday; older days carry their date', () => {
    const now = at(2026, 3, 10)
    expect(dayLabel(at(2026, 3, 10, 8), now)).toBe('Today')
    expect(dayLabel(at(2026, 3, 9, 20), now)).toBe('Yesterday')
    expect(dayLabel(at(2025, 12, 24), now)).toMatch(/2025/)
  })
})
