import { describe, expect, it } from 'vitest'
import type { BackgroundTask } from '~/types/chat'
import { plainOutput, taskDetail, taskElapsed, tasksSummary } from './tasks'
import { linkState } from './linkState'

const task = (over: Partial<BackgroundTask> = {}): BackgroundTask => ({ id: 't', kind: 'command', title: 'pnpm test', status: 'running', startedAt: 1_000, ...over })

describe('background tasks', () => {
  it('sums up what still runs', () => {
    expect(tasksSummary([task(), task({ id: 'b' })]).text).toBe('2 running')
    expect(tasksSummary([task(), task({ id: 'b', status: 'done' })])).toEqual({ running: 1, text: '1 running, 1 finished' })
    expect(tasksSummary([task({ status: 'done' })]).text).toBe('Finished')
    expect(tasksSummary([task({ status: 'done' }), task({ status: 'error' })]).text).toBe('All finished')
  })
  it('counts time until the end, or now', () => {
    expect(taskElapsed(task(), 73_000)).toBe('1m 12s')
    expect(taskElapsed(task({ status: 'done', endedAt: 9_000 }), 99_000)).toBe('8s')
  })
  it('says what a task does or how it ended', () => {
    expect(taskDetail(task())).toBeNull()
    expect(taskDetail(task({ activity: 'Reading files' }))).toBe('Reading files')
    expect(taskDetail(task({ status: 'error' }))).toBe('Failed')
    expect(taskDetail(task({ status: 'done', summary: '42 passed' }))).toBe('Finished: 42 passed')
  })
  it('drops colour codes from output', () => {
    expect(plainOutput('\x1B[32m✓\x1B[0m ok')).toBe('✓ ok')
  })
})

describe('linkState', () => {
  it('reads like the desktop', () => {
    expect(linkState('pr', 'merged')).toMatchObject({ word: 'Merged', tone: 'done', icon: 'pr-merged' })
    expect(linkState('pr', 'draft').tone).toBe('queued')
    expect(linkState('pr', undefined)).toMatchObject({ word: 'Pull request', tone: 'idle' })
    expect(linkState('issue', 'closed', 'not_planned')).toMatchObject({ word: 'Not planned', tone: 'idle' })
    expect(linkState('issue', 'closed', 'completed')).toMatchObject({ word: 'Closed', tone: 'done' })
  })
})
