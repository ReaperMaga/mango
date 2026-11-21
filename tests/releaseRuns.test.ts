/**
 * The Releases tool window's reading of GitHub (app/utils/releaseRuns.ts). Plain Node:
 *
 *   node --test tests/releaseRuns.test.ts      (or: pnpm test)
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  entryState, formatSize, groupAssets, jobSummary, latestRelease, platformOf, sortJobs, sortReleases, stripeMark, typicalDuration,
} from '../app/utils/releaseRuns.ts'
import type { GhAsset, GhRelease, GhRun, GhRunJob, GhRunState } from '../app/types/ipc.ts'

const release = (tag: string, over: Partial<GhRelease> = {}): GhRelease => ({
  id: 1, tag, name: `Mango ${tag}`, draft: false, prerelease: false, url: `https://github.com/acme/app/releases/tag/${tag}`,
  author: null, createdAt: '2026-11-20T10:00:00Z', publishedAt: '2026-11-20T10:11:00Z', target: 'main', bodyHtml: '', assets: [],
  ...over,
})

let ids = 100
const run = (over: Partial<GhRun> = {}): GhRun => ({
  id: ids++, workflowId: 1, workflow: 'Release', title: 'chore(release)', event: 'push', headBranch: null, headSha: 'abc',
  state: 'success', url: 'https://github.com/acme/app/actions/runs/1', number: 1, attempt: 1,
  createdAt: '2026-11-20T10:00:00Z', startedAt: '2026-11-20T10:00:00Z', updatedAt: '2026-11-20T10:11:00Z',
  ...over,
})

const job = (state: GhRunState): GhRunJob => ({ id: ids++, name: state, state, url: 'https://x/actions/runs/1/job/2', startedAt: null, completedAt: null })

test('a release whose build runs goes on top; the others keep their order', () => {
  const releases = [release('v3', { draft: true, publishedAt: null }), release('v2'), release('v1')]
  const runs = [
    run({ headBranch: 'v3', state: 'pending', createdAt: '2026-11-21T00:00:00Z' }),
    run({ headBranch: 'v2' }),
    run({ headBranch: 'main', event: 'push', workflowId: 9, workflow: 'CI', state: 'pending' }),
  ]
  const s = sortReleases(releases, runs)
  assert.deepEqual(s.inProgress.map(e => e.key), ['tag:v3'])
  assert.deepEqual(s.releases.map(e => e.key), ['tag:v2', 'tag:v1'])
  assert.equal(s.releases[0]!.run?.headBranch, 'v2')
  assert.equal(stripeMark(s), 'running')
})

test('a draft whose build failed stays on top; a published one with a failed re-run does not', () => {
  const releases = [release('v3', { draft: true, publishedAt: null }), release('v2')]
  const runs = [run({ headBranch: 'v3', state: 'failure' }), run({ headBranch: 'v2', state: 'failure' })]
  const s = sortReleases(releases, runs)
  assert.deepEqual(s.inProgress.map(e => e.key), ['tag:v3'])
  assert.equal(stripeMark(s), 'failed')
  assert.equal(entryState(s.inProgress[0]!).word, 'Build failed')
  assert.equal(entryState(s.releases[0]!).word, 'Published')
})

test('the release workflow started by hand is a trial build; a new version tag shows before its release', () => {
  const releases = [release('v1')]
  const runs = [
    run({ headBranch: 'v1' }),
    run({ headBranch: 'main', event: 'workflow_dispatch', state: 'queued' }),
    run({ headBranch: 'v2.0.0', event: 'push', state: 'pending' }),
    // Another workflow started by hand, and a branch push of the release workflow: not releases.
    run({ headBranch: 'main', event: 'workflow_dispatch', workflowId: 7, state: 'pending' }),
    run({ headBranch: 'feature', event: 'push', state: 'pending' }),
  ]
  const s = sortReleases(releases, runs)
  const kinds = s.inProgress.map(e => (e.kind === 'run' ? e.why : e.kind))
  assert.deepEqual(kinds.sort(), ['tag', 'trial'])
  // Finished trial builds do not stay.
  const done = sortReleases(releases, [run({ headBranch: 'v1' }), run({ headBranch: 'main', event: 'workflow_dispatch', state: 'failure' })])
  assert.equal(done.inProgress.length, 0)
  assert.equal(stripeMark(done), null)
})

test('the newest run for a tag is the one shown', () => {
  const s = sortReleases([release('v1')], [
    run({ headBranch: 'v1', state: 'failure', createdAt: '2026-11-20T10:00:00Z' }),
    run({ headBranch: 'v1', state: 'success', createdAt: '2026-11-20T11:00:00Z' }),
  ])
  assert.equal(s.releases[0]!.run?.state, 'success')
})

test('Latest is the newest published release that is not a pre-release', () => {
  const r = latestRelease([
    release('v3', { draft: true, publishedAt: null }),
    release('v2.1-beta', { prerelease: true, publishedAt: '2026-11-22T00:00:00Z' }),
    release('v2', { publishedAt: '2026-11-21T00:00:00Z' }),
    release('v1', { publishedAt: '2026-11-19T00:00:00Z' }),
  ])
  assert.equal(r?.tag, 'v2')
  assert.equal(latestRelease([]), null)
})

test('jobs: what needs a look first, and one line for all of them', () => {
  assert.deepEqual(sortJobs([job('success'), job('queued'), job('failure'), job('pending')]).map(j => j.state), ['failure', 'pending', 'queued', 'success'])
  assert.deepEqual(jobSummary([job('success'), job('success'), job('pending'), job('queued')]), { tone: 'running', text: '2 of 4 done' })
  assert.deepEqual(jobSummary([job('failure'), job('success'), job('skipped')]), { tone: 'error', text: '1 failed, 1 passed' })
  assert.deepEqual(jobSummary([job('failure'), job('pending')]), { tone: 'error', text: '1 failed, 1 running' })
  assert.deepEqual(jobSummary([job('success'), job('skipped')]), { tone: 'done', text: 'passed, 1 skipped' })
  assert.deepEqual(jobSummary([job('success'), job('cancelled')]), { tone: 'idle', text: 'Cancelled' })
  assert.equal(jobSummary([]).tone, 'idle')
})

test('a build usually takes the middle of the last three good runs', () => {
  const took = (min: number) => run({ updatedAt: new Date(Date.parse('2026-11-20T10:00:00Z') + min * 60_000).toISOString() })
  const runs = [took(10), took(12), took(30), run({ state: 'failure' }), run({ workflowId: 2 })]
  assert.equal(typicalDuration(runs, 1), 12 * 60_000)
  assert.equal(typicalDuration(runs, 3), null)
})

test('files group by platform and signatures fold into what they sign', () => {
  const a = (name: string): GhAsset => ({ name, size: 1, downloads: 0, url: `https://x/${name}`, state: 'uploaded' })
  const g = groupAssets([
    a('latest.json'), a('Mango_1.0_x64-setup.exe'), a('Mango_1.0_x64-setup.exe.sig'), a('Mango_1.0_aarch64.dmg'),
    a('Mango_1.0_aarch64.app.tar.gz'), a('Mango_1.0_aarch64.app.tar.gz.sig'), a('Mango_1.0_amd64.AppImage'), a('notes.txt'), a('orphan.sig'),
  ])
  assert.deepEqual(g.groups.map(x => x.platform), ['Windows', 'macOS', 'Linux', 'Updater', 'Other'])
  assert.equal(g.files, 7)
  assert.equal(g.signatures, 2)
  assert.equal(g.groups[0]!.rows[0]!.signature?.name, 'Mango_1.0_x64-setup.exe.sig')
  assert.deepEqual(g.groups[4]!.rows.map(r => r.asset.name), ['notes.txt', 'orphan.sig'])
  assert.equal(platformOf('tool-darwin-arm64.tar.gz'), 'macOS')
  assert.equal(platformOf('tool-windows-amd64.zip'), 'Windows')
  assert.equal(platformOf('tool_linux_x86_64.tar.gz'), 'Linux')
  // "darwin" holds "win", but it is not Windows.
  assert.notEqual(platformOf('darwin.zip'), 'Windows')
})

test('sizes read like a file manager', () => {
  assert.equal(formatSize(512), '512 B')
  assert.equal(formatSize(6422), '6.3 KB')
  assert.equal(formatSize(11_026_279), '10.5 MB')
  assert.equal(formatSize(94_263_800), '89.9 MB')
  assert.equal(formatSize(300 * 1024 * 1024), '300 MB')
})
