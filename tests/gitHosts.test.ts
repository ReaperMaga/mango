/**
 * Server names typed into Settings > Git hosting. Plain Node, no dependencies:
 *
 *   node --test tests/gitHosts.test.ts      (or: pnpm test)
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { gitlabHostProblem, normalizeHost } from '../app/utils/gitHosts.ts'

test('normalises like the backend', () => {
  assert.equal(normalizeHost(' https://GitLab.Example.com/foo '), 'gitlab.example.com')
  assert.equal(normalizeHost('git.corp.io:8443'), 'git.corp.io:8443')
  assert.equal(normalizeHost('www.git.corp.io'), 'git.corp.io')
  for (const bad of ['localhost', 'evil.com:99999', 'evil.com:0', '-x.com', 'a b.com', '', 'a..b', 'x.com:']) {
    assert.equal(normalizeHost(bad), null, bad)
  }
})

test('what the list accepts', () => {
  assert.equal(gitlabHostProblem('git.corp.io', []), null)
  assert.ok(gitlabHostProblem('', []))
  assert.ok(gitlabHostProblem('nope', []))
  assert.ok(gitlabHostProblem('https://gitlab.com', []))
  assert.ok(gitlabHostProblem('github.com', []))
  assert.match(gitlabHostProblem('GIT.corp.io', ['git.corp.io'])!, /already/)
})
