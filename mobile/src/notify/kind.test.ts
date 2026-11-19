import { describe, expect, it } from 'vitest'
import { notifyKindOf } from './kind'

const chat = {}
describe('notifyKindOf', () => {
  it('says a chat needs you when it starts waiting, once', () => {
    expect(notifyKindOf(chat, 'running', 'waiting', undefined)).toBe('needsYou')
    expect(notifyKindOf(chat, 'waiting', 'waiting', undefined)).toBeNull()
  })

  it('says a run finished or failed', () => {
    expect(notifyKindOf(chat, 'running', 'working', 'done')).toBe('done')
    expect(notifyKindOf(chat, 'waiting', 'working', 'done')).toBe('done')
    expect(notifyKindOf(chat, 'running', 'error', 'error')).toBe('failed')
  })

  it('stays quiet for a stop, a manual status and a sub-agent', () => {
    expect(notifyKindOf(chat, 'running', 'working', 'stopped')).toBeNull()
    expect(notifyKindOf(chat, 'working', 'done', undefined)).toBeNull()
    expect(notifyKindOf(chat, 'working', 'working', 'done')).toBeNull()
    expect(notifyKindOf({ parentId: 'p' }, 'running', 'waiting', undefined)).toBeNull()
  })
})
