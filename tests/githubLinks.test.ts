/**
 * Pull requests, merge requests and issues found in text, and the ones a tool call created
 * (app/utils/githubLinks.ts), plus how they are named (app/utils/forge.ts). Plain Node:
 *
 *   node --test tests/githubLinks.test.ts      (or: pnpm test)
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createdBy, findItemRefs, itemKey, linkFromItem, linkFromRef } from '../app/utils/githubLinks.ts'
import { itemNoun, itemNumber, siteName } from '../app/utils/forge.ts'
import type { Part } from '../app/types/chat.ts'
import type { GhItem } from '../app/types/ipc.ts'

type Tool = Extract<Part, { type: 'tool' }>
const tool = (over: Partial<Tool>): Tool => ({
  type: 'tool', id: 't1', tool: 'bash', target: '', status: 'done', output: '', startedAt: 0, ...over,
} as Tool)

test('GitHub keys stay as they always were', () => {
  const [ref] = findItemRefs('see https://github.com/Acme/App/pull/12/files')
  assert.equal(ref!.key, 'github.com/acme/app#12')
  assert.equal(ref!.provider, 'github')
  assert.equal(ref!.url, 'https://github.com/Acme/App/pull/12')
  // An issue link to the same number is the same item on GitHub.
  assert.equal(findItemRefs('https://github.com/acme/app/issues/12')[0]!.key, ref!.key)
  assert.equal(itemKey('github.com', 'acme', 'app', 12), 'github.com/acme/app#12')
})

test('GitLab links: nested groups, merge requests and issues apart', () => {
  const refs = findItemRefs(`
    MR: https://gitlab.com/acme/backend/api/-/merge_requests/12/diffs
    issue: https://gitlab.example.com:8443/Group/Sub/Deep/proj/-/issues/12#note_1
    work item: https://gitlab.com/acme/backend/api/-/work_items/7
  `)
  assert.deepEqual(refs.map(r => [r.provider, r.kind, r.host, r.owner, r.repo, r.number, r.key]), [
    ['gitlab', 'pr', 'gitlab.com', 'acme/backend', 'api', 12, 'gitlab.com/acme/backend/api!12'],
    ['gitlab', 'issue', 'gitlab.example.com:8443', 'Group/Sub/Deep', 'proj', 12, 'gitlab.example.com:8443/group/sub/deep/proj#12'],
    ['gitlab', 'issue', 'gitlab.com', 'acme/backend', 'api', 7, 'gitlab.com/acme/backend/api#7'],
  ])
  assert.equal(refs[0]!.url, 'https://gitlab.com/acme/backend/api/-/merge_requests/12')
  assert.equal(refs[2]!.url, 'https://gitlab.com/acme/backend/api/-/issues/7')
})

test('GitLab API addresses, group items and a project without a group do not match', () => {
  assert.deepEqual(findItemRefs('https://gitlab.com/api/v4/projects/acme%2Fapi/merge_requests/12'), [])
  assert.deepEqual(findItemRefs('https://gitlab.com/api/v4/projects/12/-/issues/3'), [])
  assert.deepEqual(findItemRefs('https://gitlab.com/groups/acme/-/work_items/5'), [])
  assert.deepEqual(findItemRefs('https://gitlab.com/api/-/issues/3'), [])
})

test('links come out in the order they were written, each once', () => {
  const refs = findItemRefs('https://gitlab.com/a/b/-/issues/1 then https://github.com/a/b/pull/2 and https://gitlab.com/a/b/-/issues/1')
  assert.deepEqual(refs.map(r => r.key), ['gitlab.com/a/b#1', 'github.com/a/b#2'])
})

test('glab mr create and glab issue create make GitLab items', () => {
  const mr = tool({ target: 'glab mr create --fill --yes', output: 'Creating merge request\n!12 feat\nhttps://gitlab.com/acme/api/-/merge_requests/12\n' })
  assert.deepEqual(createdBy(mr).map(r => r.key), ['gitlab.com/acme/api!12'])
  const issue = tool({ target: 'glab.exe issue create -t "Bug"', output: 'https://gitlab.com/acme/api/-/issues/4' })
  assert.deepEqual(createdBy(issue).map(r => r.key), ['gitlab.com/acme/api#4'])
  // An issue link in a merge request's output is not the merge request.
  assert.deepEqual(createdBy(tool({ target: 'glab mr create', output: 'Closes https://gitlab.com/acme/api/-/issues/4' })), [])
  // An existing one it refused to repeat.
  const again = tool({ target: 'glab mr create', status: 'error', output: 'A merge request for branch "x" already exists: https://gitlab.com/acme/api/-/merge_requests/3' })
  assert.deepEqual(createdBy(again).map(r => r.key), ['gitlab.com/acme/api!3'])
})

test('a gh command never takes a GitLab link, nor glab a GitHub one', () => {
  assert.deepEqual(createdBy(tool({ target: 'gh pr create', output: 'https://gitlab.com/acme/api/-/merge_requests/12' })), [])
  assert.deepEqual(createdBy(tool({ target: 'glab mr create', output: 'https://github.com/acme/api/pull/12' })), [])
  assert.deepEqual(createdBy(tool({ target: 'gh pr create --fill', output: 'https://github.com/acme/api/pull/12' })).map(r => r.key), ['github.com/acme/api#12'])
})

test('GitLab MCP create tools count; viewing or mentioning does not', () => {
  const mcp = tool({ tool: 'mcp', target: 'gitlab · create_merge_request', output: '{"iid":12,"web_url":"https://gitlab.com/acme/api/-/merge_requests/12"}' })
  assert.deepEqual(createdBy(mcp).map(r => r.key), ['gitlab.com/acme/api!12'])
  const issue = tool({ tool: 'mcp', target: 'gitlab.create_issue', output: '{"web_url":"https://gitlab.com/acme/api/-/issues/5"}' })
  assert.deepEqual(createdBy(issue).map(r => r.key), ['gitlab.com/acme/api#5'])
  assert.deepEqual(createdBy(tool({ tool: 'mcp', target: 'gitlab · get_merge_request', output: 'https://gitlab.com/acme/api/-/merge_requests/12' })), [])
  assert.deepEqual(createdBy(tool({ target: 'glab mr view 12', output: 'https://gitlab.com/acme/api/-/merge_requests/12' })), [])
  assert.deepEqual(createdBy(tool({ target: 'echo create_merge_request', output: 'https://gitlab.com/acme/api/-/merge_requests/12' })), [])
  assert.deepEqual(createdBy(tool({ target: 'glab mr create', status: 'running', output: 'https://gitlab.com/acme/api/-/merge_requests/12' })), [])
})

test('links write a provider only for GitLab', () => {
  const [gh] = findItemRefs('https://github.com/acme/app/pull/3')
  assert.equal('provider' in linkFromRef(gh!, 'agent'), false)
  const [gl] = findItemRefs('https://gitlab.com/acme/app/-/merge_requests/3')
  assert.equal(linkFromRef(gl!, 'agent').provider, 'gitlab')
  const item = { provider: 'gitlab', kind: 'pr', host: 'gitlab.com', owner: 'a/b', repo: 'c', number: 9, url: 'https://gitlab.com/a/b/c/-/merge_requests/9', title: 'T', state: 'open' } as GhItem
  const link = linkFromItem(item, 'user')
  assert.equal(link.key, 'gitlab.com/a/b/c!9')
  assert.equal(link.provider, 'gitlab')
  assert.equal(linkFromItem({ ...item, provider: 'github', owner: 'a', repo: 'b' }, 'user').key, 'gitlab.com/a/b#9')
})

test('names: pull request #12 on GitHub, merge request !12 on GitLab', () => {
  assert.equal(itemNumber({ kind: 'pr', number: 12 }), '#12')
  assert.equal(itemNumber({ kind: 'pr', number: 12, provider: 'gitlab' }), '!12')
  assert.equal(itemNumber({ kind: 'issue', number: 12, provider: 'gitlab' }), '#12')
  assert.equal(itemNoun('pr', 'gitlab'), 'merge request')
  assert.equal(itemNoun('pr', undefined), 'pull request')
  assert.equal(siteName('gitlab', 'gitlab.com'), 'GitLab')
  assert.equal(siteName('gitlab', 'git.example.org'), 'git.example.org')
  assert.equal(siteName('github', 'github.com'), 'GitHub')
})
