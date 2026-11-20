import { describe, expect, it } from 'vitest'
import { runElsewhere } from '@/state/threadModel'
import { elsewhereCaption, elsewhereSubtitle } from './elsewhere'

describe('a run on another computer', () => {
  it('is read from the statuses a run owns, and nothing else', () => {
    expect(runElsewhere({ status: 'running', updatedAt: 5 })).toEqual({ status: 'running', at: 5 })
    expect(runElsewhere({ status: 'queued', updatedAt: 5 })).toEqual({ status: 'queued', at: 5 })
    expect(runElsewhere({ status: 'waiting', updatedAt: 5 })).toEqual({ status: 'waiting', at: 5 })
    for (const status of ['working', 'done', 'error'] as const) expect(runElsewhere({ status, updatedAt: 5 })).toBeNull()
  })

  it('says where, and owns up to a long silence', () => {
    const at = 1_000_000
    expect(elsewhereCaption({ status: 'running', at }, at + 30_000)).toBe('On another computer')
    expect(elsewhereCaption({ status: 'running', at }, at + 5 * 60_000)).toBe('On another computer')
    expect(elsewhereCaption({ status: 'running', at }, at + 12 * 60_000 + 40_000)).toBe('On another computer · quiet for 12m')
    expect(elsewhereCaption({ status: 'running', at }, at + 3 * 3600_000 + 60_000)).toBe('On another computer · quiet for 3h')
    // A copy without a time has nothing to measure against.
    expect(elsewhereCaption({ status: 'running', at: 0 }, at)).toBe('On another computer')
  })

  it('words the list row', () => {
    expect(elsewhereSubtitle({ status: 'running', at: 1 })).toBe('Working on another computer…')
    expect(elsewhereSubtitle({ status: 'queued', at: 1 })).toBe('Working on another computer…')
    expect(elsewhereSubtitle({ status: 'waiting', at: 1 })).toBe('Waiting for you on another computer')
  })
})
