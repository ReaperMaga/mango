/**
 * The message "Solve conflicts with agent" sends to the chat.
 *
 *   node --test tests/conflictPrompt.test.ts      (or: pnpm test)
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { GitOperation } from '../app/types/ipc.ts'
import { PROMPT_SUBJECTS, buildConflictPrompt, describeOperation } from '../app/utils/conflictPrompt.ts'

const op = (over: Partial<GitOperation> = {}): GitOperation => ({
  kind: 'merge', branch: 'feat/rate-limits', incoming: 'main', commit: null, subject: null, step: null, steps: null, message: null, ...over,
})

test('a merge: branches, files, both sides\' commits and the rules', () => {
  const text = buildConflictPrompt({
    vcs: 'git', operation: op(), files: ['src/config.ts', 'src/routes/health.ts'],
    ours: ['Per-route limits'], theirs: ['Serve on 8080', 'Report the version'],
  })
  assert.match(text, /^I'm merging `main` into `feat\/rate-limits` with git and it stopped on conflicts\. Please resolve the conflicts in these 2 files\./)
  assert.match(text, /- `src\/config\.ts`\n- `src\/routes\/health\.ts`/)
  assert.match(text, /What `feat\/rate-limits` did since the two sides split \(newest first\):\n- "Per-route limits"/)
  assert.match(text, /What `main` did:\n- "Serve on 8080"\n- "Report the version"/)
  assert.match(text, /first side .* is `feat\/rate-limits`/)
  assert.match(text, /Remove all conflict markers/)
  assert.match(text, /Do not stage files, mark conflicts resolved, commit, abort or finish the merge, reset, check out files or switch branches/)
  assert.match(text, /summary per file/)
})

test('one file asked from the merge editor', () => {
  const text = buildConflictPrompt({ vcs: 'git', operation: op(), files: ['a.ts', 'b.ts'], only: ['b.ts'] })
  assert.match(text, /Please resolve the conflict in `b\.ts`\./)
  assert.match(text, /Other files are in conflict too; leave them for now\./)
  assert.doesNotMatch(text, /- `a\.ts`/)
})

test('a rebase says which side is which', () => {
  const o = op({ kind: 'rebase', branch: 'feature/x', incoming: 'origin/main', step: 2, steps: 5, subject: 'feat one' })
  assert.equal(describeOperation(o, 'git'), 'I\'m rebasing `feature/x` onto `origin/main` with git and it stopped on conflicts (commit 2 of 5: "feat one")')
  const text = buildConflictPrompt({ vcs: 'git', operation: o, files: ['a.ts'], ours: ['upstream work'], theirs: ['feat one'] })
  assert.match(text, /the first side .* is `origin\/main`, the branch I'm rebasing onto, and the second side .* is my commit being applied/)
  assert.match(text, /What `origin\/main` did since/)
  assert.match(text, /What `feature\/x` did \(the commits being replayed\)/)
  assert.match(text, /continue or abort the rebase/)
})

test('cherry-pick and revert name the commit', () => {
  const pick = buildConflictPrompt({ vcs: 'git', operation: op({ kind: 'cherry-pick', branch: 'main', commit: 'a303afd', subject: 'feat one' }), files: ['a.ts'], theirs: ['feat one'] })
  assert.match(pick, /^I'm cherry-picking commit `a303afd` \("feat one"\) onto `main`/)
  assert.match(pick, /The commit: "feat one"\./)
  const revert = describeOperation(op({ kind: 'revert', branch: 'main', commit: 'abc1234', subject: 'Revert "x"' }), 'git')
  assert.equal(revert, 'I\'m reverting commit `abc1234` (Revert "x") on `main` and it stopped on conflicts')
})

test('Lore: no history, and its own commands named', () => {
  const text = buildConflictPrompt({ vcs: 'lore', operation: op({ branch: 'main', incoming: 'feat' }), files: ['a.txt'] })
  assert.match(text, /with Lore/)
  assert.doesNotMatch(text, /did since/)
  assert.match(text, /no `lore branch merge resolve`, `lore stage` or `lore commit`/)
  assert.match(text, /Leave the `~base`, `~mine` and `~theirs` copies/)
})

test('long lists are capped, subjects kept on one line', () => {
  const many = Array.from({ length: 40 }, (_, i) => `commit ${i}\nwith a second line`)
  const files = Array.from({ length: 50 }, (_, i) => `f${i}.ts`)
  const text = buildConflictPrompt({ vcs: 'git', operation: null, files, ours: many })
  assert.match(text, /^My git merge stopped on conflicts\./)
  assert.match(text, /- …and 10 more/)
  assert.match(text, new RegExp(`- …and ${40 - PROMPT_SUBJECTS} more`))
  assert.match(text, /"commit 0 with a second line"/)
})
