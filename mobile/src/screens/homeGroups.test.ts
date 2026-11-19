import { describe, expect, it } from 'vitest'
import type { Thread } from '~/types/chat'
import { groupByProject, groupSummary } from './homeGroups'

const chat = (id: string, projectPath: string, updatedAt: number, over: Partial<Thread> = {}): Thread => ({
  id, projectPath, title: id, agent: 'claude', model: '', mode: 'ask', status: 'working', messages: [], createdAt: 1, updatedAt, seen: true, ...over,
})

const MANGO = 'env://h1/dev/home/agent/work/mango'
const JOURNAL = 'env://h1/dev/home/agent/work/journalbridge'

describe('groupByProject', () => {
  it('makes a folder per project, the one with the latest activity first', () => {
    const groups = groupByProject([chat('a', MANGO, 10), chat('b', JOURNAL, 30), chat('c', MANGO, 20)])
    expect(groups.map(g => [g.name, g.chats.map(c => c.id)])).toEqual([
      ['journalbridge', ['b']],
      ['mango', ['c', 'a']],
    ])
    expect(groups[1]!.latest).toBe(20)
  })

  it('shows the dot of the chat that needs you most', () => {
    const [g] = groupByProject([chat('a', MANGO, 30), chat('b', MANGO, 10, { status: 'waiting' }), chat('c', MANGO, 20, { status: 'error' })])
    expect(g!.top!.id).toBe('b')
  })

  it('counts the chats that are working now', () => {
    const [g] = groupByProject([chat('a', MANGO, 3, { status: 'running' }), chat('b', MANGO, 2, { status: 'queued' }), chat('c', MANGO, 1)])
    expect(g!.working).toBe(2)
    expect(groupSummary(g!)).toBe('3 chats · 2 working')
  })

  it('has nothing for no chats', () => {
    expect(groupByProject([])).toEqual([])
  })

  it('says how many chats are in a folder', () => {
    expect(groupSummary({ chats: [chat('a', MANGO, 1)], working: 0 })).toBe('1 chat')
  })
})
