import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyRelease, bulletFor, notesFromSubjects } from '../scripts/changelog.ts'

test('only user-visible desktop commits become bullets', () => {
  assert.equal(bulletFor('feat(git): add stash list (#12)')?.text, 'Add stash list.')
  assert.equal(bulletFor('chore(release): v1.0.0'), null)
  assert.equal(bulletFor('feat(mobile): new screen'), null)
  assert.equal(bulletFor('merge: bring main'), null)
})

test('notes are grouped', () => {
  const md = notesFromSubjects(['fix: a', 'feat: b', 'feat: b', 'ci: c'])
  assert.equal(md, '### New\n\n- B.\n\n### Fixes\n\n- A.\n')
})

test('release replaces Unreleased and keeps hand-written bullets first', () => {
  const src = '# Changelog\n\nintro\n\n## Unreleased\n\n### New\n\n- Hand.\n\n## 1.0.0\n\n- old\n'
  const out = applyRelease(src, '1.1.0', '### Fixes\n\n- Gen.\n')
  assert.match(out, /## 1\.1\.0\n\n### New\n\n- Hand\.\n\n### Fixes\n\n- Gen\.\n\n## 1\.0\.0/)
  assert.doesNotMatch(out, /Unreleased/)
  assert.equal(applyRelease(out, '1.1.0', 'x'), out)
})

test('inserts above the newest version and refuses an empty release', () => {
  const out = applyRelease('# C\n\n## 1.0.0\n\n- old\n', '1.0.1', '### New\n\n- X.\n')
  assert.ok(out.indexOf('## 1.0.1') < out.indexOf('## 1.0.0'))
  assert.throws(() => applyRelease('# C\n', '1.0.1', ''))
})
