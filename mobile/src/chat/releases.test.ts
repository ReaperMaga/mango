import { describe, expect, it } from 'vitest'
import type { GhRun } from '~/types/ipc'
import { sortReleases } from '~/utils/releaseRuns'
import type { Release } from '@/remote/releases'
import { agoWords, entryFacts, githubLink, jobTook, releasesSummary, rerunAction, runEta, runTook } from './releases'

const NOW = Date.parse('2026-11-21T12:00:00Z')

function release(tag: string, over: Partial<Release> = {}): Release {
  return {
    id: 1, tag, name: `Mango ${tag}`, draft: false, prerelease: false, url: `https://github.com/a/b/releases/tag/${tag}`,
    author: { login: 'github-actions[bot]', avatarUrl: null }, createdAt: '2026-11-21T10:00:00Z', publishedAt: '2026-11-21T10:10:00Z',
    target: 'main', bodyHtml: '', body: '', assets: [], ...over,
  }
}
function run(over: Partial<GhRun> = {}): GhRun {
  return {
    id: 1, workflowId: 7, workflow: 'Release', title: 't', event: 'push', headBranch: 'v1', headSha: 'abc', state: 'success',
    url: 'https://github.com/a/b/actions/runs/1', number: 3, attempt: 1, createdAt: '2026-11-21T11:00:00Z', startedAt: '2026-11-21T11:00:00Z',
    updatedAt: '2026-11-21T11:10:00Z', ...over,
  }
}

describe('releases screen words', () => {
  it('opens only github.com', () => {
    expect(githubLink('https://github.com/a/b/releases/download/v1/x.dmg')).toBe('https://github.com/a/b/releases/download/v1/x.dmg')
    expect(githubLink('https://evil.example/x')).toBeNull()
    expect(githubLink('http://github.com/a')).toBeNull()
    expect(githubLink('javascript:alert(1)')).toBeNull()
  })

  it('says when', () => {
    expect(agoWords('2026-11-21T11:54:00Z', NOW)).toBe('6 min ago')
    expect(agoWords('2026-11-21T09:00:00Z', NOW)).toBe('3 hours ago')
    expect(agoWords('2026-11-21T11:59:50Z', NOW)).toBe('just now')
    expect(agoWords(null, NOW)).toBeNull()
  })

  it('counts files without signatures, and downloads', () => {
    const a = (name: string, downloads: number) => ({ name, size: 1, downloads, url: 'https://github.com/x', state: 'uploaded' })
    const r = release('v0.1.33', { assets: [a('x.exe', 10), a('x.exe.sig', 3), a('y.dmg', 6)] })
    expect(entryFacts({ kind: 'release', key: 'tag:v0.1.33', release: r, run: null })).toBe('v0.1.33 · 2 files · 19 downloads')
  })

  it('sums up the project row', () => {
    const rs = [release('v2'), release('v1', { publishedAt: '2026-11-20T10:00:00Z' })]
    expect(releasesSummary(sortReleases(rs, []), rs)).toEqual({ text: 'Latest v2', tone: 'subtle' })
    const building = [release('v3', { draft: true, publishedAt: null }), ...rs]
    const runs = [run({ headBranch: 'v3', state: 'pending' })]
    expect(releasesSummary(sortReleases(building, runs), building)).toEqual({ text: 'Building v3', tone: 'running' })
    const failed = [run({ headBranch: 'v3', state: 'failure' })]
    expect(releasesSummary(sortReleases(building, failed), building)).toEqual({ text: 'Build failed: v3', tone: 'error' })
    expect(releasesSummary(sortReleases([], []), [])).toEqual({ text: 'No releases yet', tone: 'subtle' })
  })

  it('times runs and jobs, and guesses the end', () => {
    expect(runTook(run(), NOW)).toBe('10m 0s')
    expect(runTook(run({ state: 'pending' }), NOW)).toBe('1h 0m')
    const past = [run({ id: 2 }), run({ id: 3 }), run({ id: 4 })]
    const live = run({ id: 9, state: 'pending', startedAt: '2026-11-21T11:55:00Z' })
    expect(runEta(live, past, NOW, () => '12:05')).toBe('Recent builds took about 10 min: done around 12:05.')
    expect(runEta({ ...live, startedAt: '2026-11-21T11:00:00Z' }, past, NOW)).toMatch(/longer than usual/)
    expect(runEta(run(), past, NOW)).toBeNull()
    expect(jobTook({ id: 1, name: 'x', state: 'queued', url: '', startedAt: null, completedAt: null }, NOW)).toBe('Waiting')
    expect(jobTook({ id: 1, name: 'x', state: 'success', url: '', startedAt: '2026-11-21T11:00:00Z', completedAt: '2026-11-21T11:00:42Z' }, NOW)).toBe('42s')
  })

  it('offers a re-run for unhappy runs only', () => {
    expect(rerunAction(run({ state: 'failure' }))).toBe('rerun-failed')
    expect(rerunAction(run({ state: 'cancelled' }))).toBe('rerun')
    expect(rerunAction(run())).toBeNull()
    expect(rerunAction(null)).toBeNull()
  })
})
