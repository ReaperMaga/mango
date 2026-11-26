/**
 * A Lore server on a machine over SSH: the destination checked as the backend does, and the
 * address clients use. Plain Node, no dependencies:
 *
 *   node --test tests/loreMachine.test.ts      (or: pnpm test)
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { clientUrl, listensEverywhere, loreUrl, machineHost, validSshDest } from '../app/utils/loreMachine.ts'

test('SSH destinations are what the backend takes, never an option', () => {
  for (const ok of ['build.lan', 'me@build.lan', 'root@203.0.113.7', 'my-alias', 'me@[::1]'.replace(/[[\]]/g, '')]) {
    assert.ok(validSshDest(ok), ok)
  }
  for (const bad of ['', '-oProxyCommand=x', 'me@host;id', 'me @host', 'a'.repeat(256), 'me@host/x']) {
    assert.ok(!validSshDest(bad), bad)
  }
})

test('the machine name and the client address', () => {
  assert.equal(machineHost('me@build.lan'), 'build.lan')
  assert.equal(machineHost('build.lan'), 'build.lan')
  assert.ok(listensEverywhere('0.0.0.0') && listensEverywhere('[::]') && listensEverywhere('::'))
  assert.ok(!listensEverywhere('100.64.0.7'))
  assert.equal(loreUrl('2001:db8::1', 41400), 'lore://[2001:db8::1]:41400')
  assert.equal(clientUrl({ ssh: 'me@build.lan', address: '0.0.0.0', listenPort: 41337 }), 'lore://build.lan')
  assert.equal(clientUrl({ ssh: 'me@build.lan', address: '100.64.0.7', listenPort: 41400 }), 'lore://100.64.0.7:41400')
  assert.equal(clientUrl({ ssh: 'me@build.lan', address: '[2001:db8::1]', listenPort: 41337 }), 'lore://[2001:db8::1]')
})
