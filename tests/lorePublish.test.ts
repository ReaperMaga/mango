/**
 * Publishing a Lore server: the address offered first, and checking typed values the way the
 * backend does. Plain Node, no dependencies:
 *
 *   node --test tests/lorePublish.test.ts      (or: pnpm test)
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ALL_V4, defaultLoreAddress, exposesPublicly, validListenAddress, validPublishPort } from '../app/utils/lorePublish.ts'
import type { EnvHostAddress } from '../app/types/ipc.ts'

const ts: EnvHostAddress = { address: '100.101.7.1', kind: 'tailscale', interface: 'tailscale0' }
const ts6: EnvHostAddress = { address: 'fd7a:115c:a1e0::1', kind: 'tailscale', interface: 'tailscale0' }
const lan: EnvHostAddress = { address: '192.168.1.20', kind: 'private', interface: 'enp3s0' }
const pub: EnvHostAddress = { address: '203.0.113.24', kind: 'public', interface: 'enp1s0' }

test('the tailnet first, then a private address, never a public one by default', () => {
  assert.equal(defaultLoreAddress([pub, lan, ts6, ts]), '100.101.7.1')
  assert.equal(defaultLoreAddress([pub, lan]), '192.168.1.20')
  assert.equal(defaultLoreAddress([ts6, pub]), 'fd7a:115c:a1e0::1')
  assert.equal(defaultLoreAddress([pub]), ALL_V4)
  assert.equal(defaultLoreAddress([]), ALL_V4)
})

test('listen addresses are IP literals the backend takes', () => {
  for (const ok of ['100.101.7.1', '0.0.0.0', '::', '[::]', '2a01:4f8::24', ' 10.0.0.2 ', 'fd7a:115c:a1e0::1', '::ffff:10.0.0.2']) {
    assert.ok(validListenAddress(ok), ok)
  }
  for (const bad of ['', 'forge.lan', 'localhost', '127.0.0.1', '::1', '224.0.0.1', 'fe80::1', '10.0.0.256', '1.2.3.4:80', '1.2.3.4;id', '1::2::3', '12345::1']) {
    assert.ok(!validListenAddress(bad), bad)
  }
})

test('ports from 1024 up', () => {
  for (const ok of ['41337', 1024, '65535', ' 4000 ']) assert.ok(validPublishPort(ok), String(ok))
  for (const bad of ['', '22', 1023, '65536', '4e3', '-1', '41337x', 0]) assert.ok(!validPublishPort(bad), String(bad))
})

test('all addresses and public ones are called out', () => {
  const all = [ts, lan, pub]
  assert.ok(exposesPublicly('0.0.0.0', all))
  assert.ok(exposesPublicly('[::]', all))
  assert.ok(exposesPublicly('203.0.113.24', all))
  assert.ok(exposesPublicly('198.51.100.9', all), 'an address the host does not list counts as public')
  assert.ok(!exposesPublicly('100.101.7.1', all))
  assert.ok(!exposesPublicly('192.168.1.20', all))
})
