/**
 * The `.loreignore` offered when a project folder becomes a Lore repository. Plain Node:
 *
 *   node --test tests/loreIgnore.test.ts      (or: pnpm test)
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { convertIgnoreLine, loreIgnoreFrom, loreIgnoreProblem, regexToGlob, UNITY_TEMPLATE } from '../app/utils/loreIgnore.ts'

const rules = (text: string) => text.split('\n').filter(l => l && !l.startsWith('#'))

test('simple regex rules become globs, the rest are dropped', () => {
  assert.equal(regexToGlob('^*.private.[0-9]+$'), '*.private.[0-9]*')
  assert.equal(regexToGlob('^*.private.[0-9]+.meta$'), '*.private.[0-9]*.meta')
  assert.equal(regexToGlob('^build\\.log$'), 'build.log')
  assert.equal(regexToGlob('^cache.*$'), 'cache*')
  assert.equal(regexToGlob('^tmp.+$'), 'tmp?*')
  for (const bad of ['^(a|b)$', '^a?$', '^x{2}$', '^\\d+$', '^.*$', '^$', 'plain', '^*$']) assert.equal(regexToGlob(bad), null, bad)
})

test('lines convert as Lore needs them', () => {
  assert.deepEqual(convertIgnoreLine(''), { kind: 'blank' })
  assert.deepEqual(convertIgnoreLine('   \r'), { kind: 'blank' })
  assert.deepEqual(convertIgnoreLine('# note\r'), { kind: 'comment', text: '# note' })
  assert.deepEqual(convertIgnoreLine('Library  '), { kind: 'rule', text: 'Library' })
  assert.deepEqual(convertIgnoreLine('!keep.txt'), { kind: 'rule', text: '!keep.txt' })
  assert.deepEqual(convertIgnoreLine('!**/Gen/**/*.csproj'), { kind: 'dropped', text: '!**/Gen/**/*.csproj', reason: 'exception' })
  assert.deepEqual(convertIgnoreLine('^(a|b)$'), { kind: 'dropped', text: '^(a|b)$', reason: 'regex' })
  assert.deepEqual(convertIgnoreLine('^x\\.y$'), { kind: 'rule', text: 'x.y', from: '^x\\.y$' })
})

test('ignore.conf of a Unity VCS workspace', () => {
  const conf = [
    'Library', 'library', 'Temp', 'temp', '**/Assets/AssetStoreTools', '**/assets/assetstoretools',
    '*.private', '^*.private.[0-9]+$', '^(odd|regex)$', '*.csproj',
    '# Generator projects are source', '!**/Generator~/**/*.csproj', '/Captures', '/captures',
  ].join('\r\n')
  const out = loreIgnoreFrom({ plasticIgnore: conf, plastic: true, unity: true })
  assert.deepEqual(rules(out), ['.plastic/', 'Library', 'Temp', '**/Assets/AssetStoreTools', '*.private', '*.private.[0-9]*', '*.csproj', '/Captures'])
  assert.match(out, /# Dropped, Lore has no regular expressions: \^\(odd\|regex\)\$/)
  assert.match(out, /# Dropped, Lore refuses an exception that starts with \*\*: !\*\*\/Generator~/)
  assert.match(out, /# Generator projects are source/)
  assert.equal(loreIgnoreProblem(out), null)
  assert.ok(out.endsWith('\n') && !out.includes('\n\n\n'))
  // With its own ignore file, the Unity template is not added.
  assert.ok(!out.includes('/Recordings/'))
})

test('.gitignore and ignore.conf together keep each rule once', () => {
  const out = loreIgnoreFrom({ gitignore: 'node_modules/\nLIBRARY\n.plastic/\n', plasticIgnore: 'Library\n', git: true, plastic: true })
  assert.deepEqual(rules(out), ['.git/', '.plastic/', 'Library', 'node_modules/'])
  assert.match(out, /made from ignore\.conf and \.gitignore/)
})

test('a Unity project without an ignore file gets the template', () => {
  const out = loreIgnoreFrom({ unity: true })
  assert.ok(out.includes('/Library/') && out.includes('/*.csproj'))
  assert.equal(loreIgnoreProblem(out), null)
  assert.equal(loreIgnoreProblem(UNITY_TEMPLATE), null)
  assert.ok(!rules(UNITY_TEMPLATE).some(r => r.startsWith('!')))
})

test('nothing to ignore gives nothing', () => {
  assert.equal(loreIgnoreFrom({}), '')
  assert.equal(loreIgnoreFrom({ gitignore: '\n# only a comment\n' }), '')
  assert.deepEqual(rules(loreIgnoreFrom({ git: true })), ['.git/'])
})

test('what Lore refuses is found by line', () => {
  assert.deepEqual(loreIgnoreProblem('a\n  !**/x\n'), { line: 2, text: '!**/x' })
  assert.deepEqual(loreIgnoreProblem('!** /x'), { line: 1, text: '!** /x' })
  assert.equal(loreIgnoreProblem('!a/**/x\n**/y\n# !**/z'), null)
})
