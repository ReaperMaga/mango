import { describe, expect, it } from 'vitest'
import type { Thread } from '~/types/chat'
import type { Env } from '@/remote/types'
import { knownProjects, placesOf } from './places'

const endpoint = { host: 'h', port: 22, user: 'agent', keyId: 'k', hostKey: 'AAAA' }
const joined: Env = { id: 'j', name: 'shop', endpoint, joined: { instance: 'shop', sharedFrom: 'a/b', shareId: 's', expiresAt: null }, addedAt: 0 }
const server: Env = { id: 's', name: 'forge', endpoint, server: { incusRemote: null }, addedAt: 0 }

const chat = (id: string, projectPath: string, updatedAt: number, extra: Partial<Thread> = {}) =>
  ({ id, projectPath, updatedAt, ...extra }) as Thread

describe('placesOf', () => {
  it('takes a joined env as is and only the running instances of a server', () => {
    const places = placesOf([joined, server], {
      s: [{ name: 'dev', state: 'running', kind: 'container' }, { name: 'old', state: 'stopped', kind: 'container' }],
    })
    expect(places.map(p => `${p.env.id}/${p.instance}`)).toEqual(['j/shop', 's/dev'])
  })
})

describe('knownProjects', () => {
  const places = placesOf([joined, server], { s: [{ name: 'dev', state: 'running', kind: 'container' }] })

  it('adds folders chats work in to the scanned repositories, recently used first', () => {
    const list = knownProjects(
      places,
      { 'j/shop': [{ path: 'env://j/shop/home/agent/shop', name: 'shop', branch: 'main' }] },
      {
        a: chat('a', 'env://s/dev/srv/site', 50),
        b: chat('b', 'env://j/shop/home/agent/shop', 80),
        c: chat('c', 'env://j/shop/home/agent/shop', 20),
      },
    )
    expect(list.map(p => [p.path, p.branch, p.lastUsed])).toEqual([
      ['env://j/shop/home/agent/shop', 'main', 80],
      ['env://s/dev/srv/site', null, 50],
    ])
    expect(list[1]!.name).toBe('site')
  })

  it('leaves out sub-agent chats, chats elsewhere, and instances that are not offered', () => {
    const list = knownProjects(places, {}, {
      a: chat('a', 'env://s/dev/srv/a', 1, { parentId: 'x' }),
      b: chat('b', '/Users/me/local', 2),
      c: chat('c', 'env://s/old/srv/c', 3),
      d: chat('d', 'env://gone/dev/srv/d', 4),
    })
    expect(list).toEqual([])
  })

  it('leaves out worktrees: scanned ones beside their repository and the ones chats work in', () => {
    const list = knownProjects(
      places,
      {
        'j/shop': [
          { path: 'env://j/shop/home/agent/shop', name: 'shop', branch: 'main' },
          { path: 'env://j/shop/home/agent/shop.worktrees/fix-login', name: 'fix-login', branch: 'fix-login' },
          { path: 'env://j/shop/home/agent/elsewhere/wt', name: 'wt', branch: 'wt' },
        ],
      },
      {
        a: chat('a', 'env://j/shop/home/agent/shop', 5, { worktree: 'env://j/shop/home/agent/elsewhere/wt' }),
        b: chat('b', 'env://j/shop/home/agent/shop.worktrees/old', 6),
      },
    )
    expect(list.map(p => p.path)).toEqual(['env://j/shop/home/agent/shop'])
  })
})
