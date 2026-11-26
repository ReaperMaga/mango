/**
 * Lore addresses and names as typed in Settings > Lore, New project and Clone. Plain Node:
 *
 *   node --test tests/lore.test.ts      (or: pnpm test)
 *
 * The cases mirror `server_urls` and `repo_urls_and_names` in src-tauri/src/lore_servers.rs.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { LoreServer } from '../app/types/ipc.ts'
import {
  isLoreUrl, loreRepoNameFrom, loreRepoNameProblem, loreServerProblem, loreUrlFor, normalizeLoreServer, parseLoreRepoUrl,
} from '../app/utils/lore.ts'

test('server addresses normalise like the backend', () => {
  const ok: Array<[string, string]> = [
    ['lore://lore.example.com', 'lore://lore.example.com'],
    ['  LORE://Lore.Example.com/  ', 'lore://lore.example.com'],
    ['lore.example.com', 'lore://lore.example.com'],
    ['lore://10.0.0.5:41337', 'lore://10.0.0.5'],
    ['lore://h:65535', 'lore://h:65535'],
    ['lore://[::1]', 'lore://[::1]'],
    ['lore://[2001:DB8::1]:9000', 'lore://[2001:db8::1]:9000'],
    ['lore://my-lore.incus', 'lore://my-lore.incus'],
  ]
  for (const [input, want] of ok) assert.equal(normalizeLoreServer(input), want, input)
  for (const bad of ['', 'https://h', 'lore://', 'lore://:1', 'lore://h:0', 'lore://h:65536', 'lore://user@h', 'lore://h/repo',
    'lore://h?x', 'lore://h#x', 'lore://h h', 'lore://-h', 'lore://h_x', 'lore://[::1', 'lore://h;rm']) {
    assert.equal(normalizeLoreServer(bad), null, bad)
  }
})

test('server problems name the fix', () => {
  const list: LoreServer[] = [{ id: 'a', name: 'Studio', url: 'lore://h', insideUrl: null, origin: null }]
  assert.equal(loreServerProblem('lore://h:41337', list), 'Already in the list as "Studio".')
  assert.equal(loreServerProblem('lore://h', list, 'a'), null, 'editing itself')
  assert.match(loreServerProblem('lore://h/repo')!, /names a repository/)
  assert.match(loreServerProblem('nope nope')!, /lore:\/\/host/)
  assert.match(loreServerProblem('  ')!, /address/)
})

test('repository names and addresses', () => {
  assert.equal(loreRepoNameProblem('game/main-art_v2.0'), null)
  for (const bad of ['', '-x', '.x', '/x', 'x/', 'a/./b', 'a/../b', 'a//b', 'a b', 'ü']) assert.ok(loreRepoNameProblem(bad), bad)
  assert.equal(loreRepoNameFrom('My Game!'), 'My-Game')
  assert.equal(loreRepoNameFrom('.hidden'), 'hidden')
  assert.deepEqual(parseLoreRepoUrl('lore://H:41337/game/art/'), { server: 'lore://h', name: 'game/art' })
  assert.deepEqual(parseLoreRepoUrl('lore://h:9/x'), { server: 'lore://h:9', name: 'x' })
  for (const bad of ['lore://h', 'lore://h/', 'h/x', 'lore://h/../x', 'lore://u@h/x']) assert.equal(parseLoreRepoUrl(bad), null, bad)
  assert.ok(isLoreUrl(' LORE://x') && !isLoreUrl('https://x'))
})

test('a server set up in an environment is reached by its inside address from there', () => {
  const s: LoreServer = {
    id: 'x', name: 'Studio', url: 'lore://203.0.113.7:41400', insideUrl: 'lore://lore-srv.incus', origin: { hostId: 'h1', instance: 'lore-srv' },
  }
  assert.equal(loreUrlFor(s, null), 'lore://203.0.113.7:41400', 'this computer')
  assert.equal(loreUrlFor(s, 'h1'), 'lore://lore-srv.incus', 'an environment on the same server')
  assert.equal(loreUrlFor(s, 'h2'), 'lore://203.0.113.7:41400', 'an environment elsewhere')
  assert.equal(loreUrlFor({ ...s, insideUrl: null }, 'h1'), 'lore://203.0.113.7:41400')
})
