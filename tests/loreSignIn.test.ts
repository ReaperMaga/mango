/**
 * A Lore server's sign-in as typed. Plain Node:
 *
 *   node --test tests/loreSignIn.test.ts      (or: pnpm test)
 *
 * The cases mirror `input_is_checked` and `script_validators_agree` in src-tauri/src/lore_auth.rs.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  draftFrom, draftProblems, draftValid, firstUserOf, githubCallback, parseOrgs, secureUrl, signInFrom, signInWays, sslipName,
  validDomain, validEmail, validGithubClientId, validGithubOrg,
} from '../app/utils/loreSignIn.ts'

test('domains, emails and GitHub names check like the backend', () => {
  for (const [v, ok] of [['lore.example.com', true], ['a.b', true], [' Lore.Example.com. ', true], ['localhost', false], ['1.2.3.4', false],
    ['a..b', false], ['x.com;id', false], ['-a.com', false], ['a-.com', false], ['', false]] as const) {
    assert.equal(validDomain(v), ok, v)
  }
  for (const [v, ok] of [['ann@example.com', true], ['a.b+c@x.co', true], [' Ann@Example.COM ', true], ['a@b@c.com', false], ['@x.com', false],
    ['a$@x.com', false], ['a@x', false], ['.a@x.com', false], ['a b@x.com', false]] as const) {
    assert.equal(validEmail(v), ok, v)
  }
  for (const [v, ok] of [['fruit-co', true], ['A1', true], ['a--b', false], ['-a', false], ['a,b', false], ['x'.repeat(40), false]] as const) {
    assert.equal(validGithubOrg(v), ok, v)
  }
  assert.ok(validGithubClientId('Ov23liAbc.1-x') && !validGithubClientId('abc$(id)') && !validGithubClientId('abc'))
  assert.deepEqual(parseOrgs(' fruit-co, Fruit-Co acme,,'), ['fruit-co', 'acme'])
})

test('a draft becomes the sign-in the backend takes', () => {
  const d = { ...draftFrom(null), domain: 'Lore.Example.com', github: true, clientId: ' Ov23li ', orgs: 'fruit-co, acme', firstUser: ' Ann@Example.com ' }
  assert.ok(draftValid(d))
  assert.deepEqual(signInFrom(d), { domain: 'lore.example.com', passwords: true, github: { clientId: 'Ov23li', orgs: ['fruit-co', 'acme'] } })
  assert.equal(firstUserOf(d), 'ann@example.com')
  assert.equal(firstUserOf({ ...d, passwords: false }), null, 'no passwords: no first user')
  assert.deepEqual(draftProblems({ ...d, passwords: false, github: false }).pick, true)
  assert.equal(draftProblems({ ...d, orgs: '' }).orgs, 'missing', 'GitHub without an organisation would let anyone in')
  assert.equal(draftProblems({ ...d, domain: '203.0.113.7' }).domain, 'bad')
  assert.equal(draftProblems({ ...d, firstUser: 'nope' }).firstUser, 'bad')
  assert.equal(draftProblems({ ...d, github: false, clientId: '' }).clientId, null)
  // Back from the server: the same draft, ready to change.
  const back = draftFrom({ on: true, domain: 'lore.example.com', passwords: false, github: { clientId: 'Ov23li', orgs: ['a', 'b'] }, githubSecret: true, certificate: true, users: [] })
  assert.deepEqual([back.passwords, back.github, back.orgs], [false, true, 'a, b'])
})

test('addresses and names to offer', () => {
  assert.equal(secureUrl('Lore.Example.com', 41337), 'lores://lore.example.com:41337')
  assert.equal(secureUrl('lore.example.com', 443), 'lores://lore.example.com')
  assert.equal(secureUrl('lore.example.com', 41400), 'lores://lore.example.com:41400')
  assert.equal(githubCallback('lore.example.com'), 'https://lore.example.com/dex/callback')
  assert.equal(sslipName('203.0.113.7'), '203-0-113-7.sslip.io')
  for (const notPublic of ['10.0.0.1', '192.168.1.2', '172.20.0.1', '100.101.7.1', '127.0.0.1', '0.0.0.0', '2a01::1', '999.1.1.1']) {
    assert.equal(sslipName(notPublic), null, notPublic)
  }
  assert.equal(signInWays({ passwords: true, github: { orgs: ['a', 'b'] } }, { passwords: 'passwords', github: 'GitHub' }), 'passwords, GitHub (a, b)')
})
