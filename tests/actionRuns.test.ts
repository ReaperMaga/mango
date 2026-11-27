/**
 * The Actions tool window's reading of runs (app/utils/actionRuns.ts). Plain Node:
 *
 *   node --test tests/actionRuns.test.ts      (or: pnpm test)
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { actionsMark, groupRuns, knownEvent, rerunOf, workflowsOf } from '../app/utils/actionRuns.ts'
import type { GhRun } from '../app/types/ipc.ts'

let ids = 1
const run = (over: Partial<GhRun> = {}): GhRun => ({
  id: ids++, workflowId: 1, workflow: 'CI', title: 'feat: x', event: 'push', headBranch: 'main', headSha: 'abc',
  state: 'success', url: 'https://github.com/acme/app/actions/runs/1', number: 1, attempt: 1,
  createdAt: '2026-11-20T10:00:00Z', startedAt: '2026-11-20T10:00:00Z', updatedAt: '2026-11-20T10:05:00Z',
  ...over,
})

test('runs split into going and done, newest first, one workflow when asked', () => {
  const old = run({ createdAt: '2026-11-20T09:00:00Z' })
  const going = run({ state: 'pending', createdAt: '2026-11-20T11:00:00Z' })
  const waiting = run({ state: 'queued', createdAt: '2026-11-20T11:30:00Z', workflowId: 2 })
  const recent = run({ state: 'failure', createdAt: '2026-11-20T10:30:00Z' })
  const all = groupRuns([old, going, waiting, recent])
  assert.deepEqual(all.active.map(r => r.id), [waiting.id, going.id])
  assert.deepEqual(all.done.map(r => r.id), [recent.id, old.id])
  const ci = groupRuns([old, going, waiting, recent], 1)
  assert.deepEqual(ci.active.map(r => r.id), [going.id])
})

test('workflows are listed once each, by name, with how many runs they have', () => {
  const list = workflowsOf([run({ workflowId: 2, workflow: 'Docs' }), run(), run(), run({ workflowId: 3, workflow: 'CodeQL' })])
  assert.deepEqual(list, [{ id: 3, name: 'CodeQL', count: 1 }, { id: 1, name: 'CI', count: 2 }, { id: 2, name: 'Docs', count: 1 }]
    .sort((a, b) => a.name.localeCompare(b.name)))
})

test('the mark: running wins; a failure counts only while it is the newest run of its workflow on the branch', () => {
  assert.equal(actionsMark([run({ state: 'pending', headBranch: 'other' })], 'main'), 'running')
  const failed = run({ state: 'failure', createdAt: '2026-11-20T10:00:00Z' })
  assert.equal(actionsMark([failed], 'main'), 'failed')
  // Fixed by a later run of the same workflow.
  assert.equal(actionsMark([failed, run({ createdAt: '2026-11-20T11:00:00Z' })], 'main'), null)
  // Another workflow passing does not fix it.
  assert.equal(actionsMark([failed, run({ workflowId: 2, createdAt: '2026-11-20T11:00:00Z' })], 'main'), 'failed')
  // Another branch's failure is not this branch's.
  assert.equal(actionsMark([run({ state: 'failure', headBranch: 'feat/x' })], 'main'), null)
  assert.equal(actionsMark([failed], null), null)
})

test('re-running: failed runs re-run their failed jobs, cancelled ones run again whole', () => {
  assert.equal(rerunOf(run({ state: 'failure' })), 'rerun-failed')
  assert.equal(rerunOf(run({ state: 'cancelled' })), 'rerun')
  assert.equal(rerunOf(run({ state: 'success' })), null)
  assert.equal(rerunOf(run({ state: 'pending' })), null)
})

test('events the window has words for', () => {
  assert.equal(knownEvent('pull_request'), 'pull_request')
  assert.equal(knownEvent('dynamic'), null)
})
