/**
 * Picking an open pull request or issue to link (app/utils/linkPicker.ts). Plain Node:
 *
 *   node --test tests/linkPicker.test.ts      (or: pnpm test)
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { highlight, isFullReference, numberMatch, pickerRows, typedNumber } from '../app/utils/linkPicker.ts'
import type { GhListItem } from '../app/types/ipc.ts'

const item = (number: number, title: string, kind: 'pr' | 'issue' = 'pr', headRef: string | null = null): GhListItem => ({
  kind, number, title, headRef, state: 'open', author: null, updatedAt: '2026-11-21T00:00:00Z',
  url: `https://github.com/acme/app/${kind === 'pr' ? 'pull' : 'issues'}/${number}`,
})

const open = [
  item(75, 'feat(links): link the branch pull request', 'pr', 'feat/links-branch'),
  item(76, 'fix(git): keep the branch popup inside the window', 'pr', 'fix/branch-popup'),
  item(70, 'Settings crashes when an env file is empty', 'issue'),
  item(7, 'Old one', 'issue'),
  item(12, 'Twelve', 'pr'),
]

test('an empty query offers everything, in order', () => {
  assert.deepEqual(pickerRows(open, '  '), { reference: null, items: open })
})

test('a number puts its own item first, then those it starts', () => {
  const r = pickerRows(open, '#7')
  assert.equal(r.reference, null)
  assert.deepEqual(r.items.map(i => i.number), [7, 75, 76, 70])
})

test('a number the list lacks is offered as a reference, before the near ones', () => {
  const r = pickerRows(open, '1')
  assert.equal(r.reference, '#1')
  assert.deepEqual(r.items.map(i => i.number), [12])
  assert.deepEqual(pickerRows(open, '#99'), { reference: '#99', items: [] })
})

test('a link finds its item, also with something after the number', () => {
  assert.deepEqual(pickerRows(open, 'https://github.com/acme/app/pull/75/files').items.map(i => i.number), [75])
  assert.deepEqual(pickerRows(open, 'https://github.com/acme/app/pulls/76').items.map(i => i.number), [76])
  const other = pickerRows(open, 'https://github.com/other/repo/pull/3')
  assert.deepEqual(other, { reference: 'https://github.com/other/repo/pull/3', items: [] })
  assert.deepEqual(pickerRows(open, 'acme/app#70').reference, 'acme/app#70')
})

test('words match title, branch and number, all of them', () => {
  assert.deepEqual(pickerRows(open, 'branch').items.map(i => i.number), [75, 76])
  assert.deepEqual(pickerRows(open, 'BRANCH popup').items.map(i => i.number), [76])
  assert.deepEqual(pickerRows(open, 'feat/links').items.map(i => i.number), [75])
  assert.deepEqual(pickerRows(open, 'nothing like it').items, [])
})

test('references and numbers are told apart', () => {
  assert.equal(isFullReference('https://github.com/a/b/issues/3#issuecomment-1'), true)
  assert.equal(isFullReference('a/b#3'), true)
  assert.equal(isFullReference('#3'), false)
  assert.equal(isFullReference('https://github.com/a/b'), false)
  assert.equal(typedNumber(' #42 '), 42)
  assert.equal(typedNumber('0'), null)
  assert.equal(typedNumber('4 2'), null)
})

test('highlight marks every word, keeping case', () => {
  assert.deepEqual(highlight('Keep the Branch popup', 'branch'), [
    { text: 'Keep the ', hit: false }, { text: 'Branch', hit: true }, { text: ' popup', hit: false },
  ])
  assert.deepEqual(highlight('aaa', 'a'), [{ text: 'aaa', hit: true }])
  assert.deepEqual(highlight('Twelve', '#12'), [{ text: 'Twelve', hit: false }])
  assert.equal(numberMatch(75, '#7'), 1)
  assert.equal(numberMatch(75, '8'), 0)
  assert.equal(numberMatch(75, 'branch'), 0)
})

const glItem = (number: number, title: string, kind: 'pr' | 'issue'): GhListItem => ({
  kind, number, title, headRef: null, state: 'open', author: null, updatedAt: '2026-11-21T00:00:00Z',
  url: `https://gitlab.com/acme/backend/api/-/${kind === 'pr' ? 'merge_requests' : 'issues'}/${number}`,
})
const gl = [glItem(12, 'Merge twelve', 'pr'), glItem(12, 'Issue twelve', 'issue'), glItem(7, 'Seven', 'pr')]

test('GitLab: ! picks merge requests, # issues, a bare number both', () => {
  assert.deepEqual(pickerRows(gl, '!12', 'gitlab').items.map(i => i.title), ['Merge twelve'])
  assert.deepEqual(pickerRows(gl, '#12', 'gitlab').items.map(i => i.title), ['Issue twelve'])
  assert.deepEqual(pickerRows(gl, '12', 'gitlab').items.map(i => i.title), ['Merge twelve', 'Issue twelve'])
  // Not in the list: looked up as typed (a bare number is a merge request first, then an issue).
  assert.equal(pickerRows(gl, '!7', 'gitlab').reference, null)
  assert.equal(pickerRows(gl, '#7', 'gitlab').reference, '#7')
  assert.equal(pickerRows(gl, '30', 'gitlab').reference, '30')
  // On GitHub `!` means nothing special.
  assert.equal(pickerRows(open, '!12').reference, null)
})

test('GitLab links and references name one item', () => {
  assert.equal(isFullReference('https://gitlab.com/acme/backend/api/-/merge_requests/12/diffs'), true)
  assert.equal(isFullReference('https://gitlab.com/acme/api/-/work_items/3'), true)
  assert.equal(isFullReference('acme/backend/api!12'), true)
  assert.equal(isFullReference('acme/backend/api#12'), true)
  assert.equal(typedNumber('!12'), 12)
  const hit = pickerRows(gl, 'https://gitlab.com/acme/backend/api/-/merge_requests/12/diffs', 'gitlab')
  assert.deepEqual(hit, { reference: null, items: [gl[0]] })
  // The issue with the same number is another item.
  assert.deepEqual(pickerRows(gl, 'https://gitlab.com/acme/backend/api/-/work_items/12', 'gitlab').items, [gl[1]])
})
