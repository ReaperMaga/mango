/**
 * Reading a pasted plugin source (app/utils/pluginSource.ts). Plain Node:
 *
 *   node --test tests/pluginSource.test.ts      (or: pnpm test)
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parsePluginSource, repoLabel } from '../app/utils/pluginSource.ts'

const ok = (input: string, extra?: { ref?: string | null; subpath?: string | null }) => {
  const r = parsePluginSource(input, extra)
  if (!r.ok) throw new Error(`expected ${input} to parse: ${r.error}`)
  return r
}
const src = (input: string, extra?: { ref?: string | null; subpath?: string | null }) => ok(input, extra).source

test('a plain repository link', () => {
  assert.deepEqual(src('https://github.com/o/r'), { url: 'https://github.com/o/r', ref: null, subpath: null })
  assert.deepEqual(src('  https://github.com/o/r.git/  '), { url: 'https://github.com/o/r.git', ref: null, subpath: null })
  assert.deepEqual(src('https://git.example.com/team/tools/r?tab=readme'), { url: 'https://git.example.com/team/tools/r', ref: null, subpath: null })
  assert.equal(ok('https://github.com/o/r.git').repo, 'github.com/o/r')
})

test('no scheme means https', () => {
  assert.deepEqual(src('github.com/o/r'), { url: 'https://github.com/o/r', ref: null, subpath: null })
})

test('GitHub tree and blob links', () => {
  assert.deepEqual(src('https://github.com/ReaperMaga/mango/tree/main/plugins/focus-timer/'), {
    url: 'https://github.com/ReaperMaga/mango', ref: 'main', subpath: 'plugins/focus-timer',
  })
  assert.deepEqual(src('https://github.com/o/r/blob/v1.2/plugins/a/mango-plugin.json'), {
    url: 'https://github.com/o/r', ref: 'v1.2', subpath: 'plugins/a',
  })
  assert.deepEqual(src('https://github.com/o/r/blob/main/mango-plugin.json'), { url: 'https://github.com/o/r', ref: 'main', subpath: null })
  assert.deepEqual(src('https://github.com/o/r/tree/dev'), { url: 'https://github.com/o/r', ref: 'dev', subpath: null })
})

test('GitLab, Codeberg and Bitbucket links', () => {
  assert.deepEqual(src('https://gitlab.com/group/sub/r/-/tree/main/plugins/x'), {
    url: 'https://gitlab.com/group/sub/r', ref: 'main', subpath: 'plugins/x',
  })
  assert.deepEqual(src('https://gitlab.com/g/r/-/blob/main/p/mango-plugin.json'), { url: 'https://gitlab.com/g/r', ref: 'main', subpath: 'p' })
  assert.deepEqual(src('https://codeberg.org/o/r/src/branch/main/plugins/y'), { url: 'https://codeberg.org/o/r', ref: 'main', subpath: 'plugins/y' })
  assert.deepEqual(src('https://codeberg.org/o/r/src/tag/v2'), { url: 'https://codeberg.org/o/r', ref: 'v2', subpath: null })
  assert.deepEqual(src('https://bitbucket.org/o/r/src/main/p'), { url: 'https://bitbucket.org/o/r', ref: 'main', subpath: 'p' })
})

test('ssh sources', () => {
  assert.deepEqual(src('git@github.com:o/r.git'), { url: 'git@github.com:o/r.git', ref: null, subpath: null })
  assert.deepEqual(src('ssh://git@host.example:2222/o/r.git'), { url: 'ssh://git@host.example:2222/o/r.git', ref: null, subpath: null })
  assert.equal(ok('git@github.com:o/r.git').repo, 'github.com/o/r')
})

test('a #ref:folder or #folder suffix', () => {
  assert.deepEqual(src('https://github.com/o/r#v1:plugins/a'), { url: 'https://github.com/o/r', ref: 'v1', subpath: 'plugins/a' })
  assert.deepEqual(src('git@github.com:o/r.git#plugins/a/'), { url: 'git@github.com:o/r.git', ref: null, subpath: 'plugins/a' })
  assert.deepEqual(src('https://github.com/o/r#dev:'), { url: 'https://github.com/o/r', ref: 'dev', subpath: null })
  // The suffix wins over the link.
  assert.deepEqual(src('https://github.com/o/r/tree/main/a#b'), { url: 'https://github.com/o/r', ref: 'main', subpath: 'b' })
})

test('the dialog fields win', () => {
  assert.deepEqual(src('https://github.com/o/r/tree/feature/x', { ref: 'feature/x', subpath: 'plugins//y/' }), {
    url: 'https://github.com/o/r', ref: 'feature/x', subpath: 'plugins/y',
  })
})

test('errors say what to do', () => {
  const bad = (input: string, extra?: { ref?: string | null; subpath?: string | null }) => {
    const r = parsePluginSource(input, extra)
    assert.equal(r.ok, false, input)
    return r as Extract<typeof r, { ok: false }>
  }
  assert.equal(bad('').empty, true)
  assert.equal(bad('/home/me/my-plugin').local, true)
  assert.equal(bad('C:\\plugins\\mine').local, true)
  assert.equal(bad('./mine').local, true)
  assert.equal(bad('~/mine').local, true)
  assert.equal(bad('file:///tmp/x').local, true)
  assert.match(bad('ftp://example.com/r').error, /aren't supported/)
  assert.match(bad('https://user:token@github.com/o/r').error, /sign-in/)
  assert.match(bad('https://github.com/').error, /site, not a repository/)
  assert.match(bad('https://github.com/o/r#../../etc').error, /inside the repository/)
  assert.match(bad('https://github.com/o/r', { ref: '--upload-pack=x' }).error, /isn't a branch/)
  assert.match(bad('just some words').error, /isn't a repository link/)
})

test('repoLabel', () => {
  assert.equal(repoLabel('https://github.com/o/r.git'), 'github.com/o/r')
  assert.equal(repoLabel('ssh://git@host:22/o/r'), 'host:22/o/r')
  assert.equal(repoLabel('git@gitlab.com:g/r.git'), 'gitlab.com/g/r')
})
