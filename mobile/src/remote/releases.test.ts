import { describe, expect, it } from 'vitest'
import { line } from './shell'
import {
  NEWEST_JQ, RUN_READ, actionFailure, checkTag, jobsFromJson, parseReleases, parseRunRead, parseRuns, readFailure, releaseFromJson,
  releasesArgv, runActionArgv, runReadArgv, runsArgv,
} from './releases'

/** Ported from the tests of `src-tauri/src/releases.rs`, plus the phone's own command lines. */

const repo = { owner: 'acme', repo: 'mango' }

describe('reading', () => {
  it('reads a release, keeping only https downloads, its Markdown notes and no avatar', () => {
    const r = releaseFromJson({
      id: 7, tag_name: 'v0.1.28', name: 'Mango 0.1.28', draft: false, prerelease: false,
      html_url: 'https://github.com/acme/mango/releases/tag/v0.1.28',
      author: { login: 'github-actions[bot]', avatar_url: 'https://avatars.githubusercontent.com/in/15368' },
      created_at: '2026-11-21T00:12:30Z', published_at: '2026-11-21T00:23:45Z', target_commitish: 'main',
      body: '## Notes', body_html: '<p>x</p>',
      assets: [
        { name: 'Mango_0.1.28_x64-setup.exe', size: 11026279, download_count: 2, state: 'uploaded',
          browser_download_url: 'https://github.com/acme/mango/releases/download/v0.1.28/Mango_0.1.28_x64-setup.exe' },
        { name: 'bad', size: 1, download_count: 0, browser_download_url: 'javascript:alert(1)' },
      ],
    })!
    expect(r).toMatchObject({ tag: 'v0.1.28', name: 'Mango 0.1.28', body: '## Notes', bodyHtml: '', publishedAt: '2026-11-21T00:23:45Z' })
    expect(r.author).toEqual({ login: 'github-actions[bot]', avatarUrl: null })
    expect(r.assets).toHaveLength(1)
    expect(r.assets[0]).toMatchObject({ size: 11026279, downloads: 2 })
  })

  it('shows the tag for a release without a title, and drops one without an https page', () => {
    const r = releaseFromJson({ id: 8, tag_name: 'v2.0.0', name: '  ', draft: true, published_at: null, html_url: 'https://github.com/a/b/releases/tag/untagged-1', assets: [] })!
    expect(r.name).toBe('v2.0.0')
    expect(r.draft).toBe(true)
    expect(r.publishedAt).toBeNull()
    expect(releaseFromJson({ tag_name: 'v1', html_url: 'file:///x' })).toBeNull()
    expect(() => parseReleases('nope', 'dev')).toThrow(/unexpected/)
    expect(parseReleases('[]', 'dev')).toEqual([])
  })

  it('reads runs and jobs', () => {
    const runs = parseRuns(JSON.stringify({ workflow_runs: [
      { id: 44842277315, workflow_id: 201, name: 'Release', display_title: 'chore(release): v0.1.28', event: 'push', head_branch: 'v0.1.28',
        head_sha: 'cbcc50f', status: 'in_progress', conclusion: null, html_url: 'https://github.com/acme/mango/actions/runs/44842277315',
        run_number: 40, run_attempt: 1, created_at: '2026-11-21T00:12:41Z', run_started_at: '2026-11-21T00:12:41Z', updated_at: '2026-11-21T00:14:00Z' },
      { id: 2, workflow_id: 3, name: 'CI', event: 'pull_request', status: 'completed', conclusion: 'failure', html_url: 'https://github.com/acme/mango/actions/runs/2' },
      { id: 0, html_url: 'https://github.com/acme/mango/actions/runs/0' },
    ] }))
    expect(runs).toHaveLength(2)
    expect(runs[0]).toMatchObject({ state: 'pending', headBranch: 'v0.1.28' })
    expect(runs[1]).toMatchObject({ state: 'failure', attempt: 1 })
    expect(parseRuns('gh: Not Found')).toEqual([])
    const jobs = jobsFromJson({ jobs: [
      { id: 9, name: 'Build', status: 'completed', conclusion: 'success', html_url: 'https://github.com/acme/mango/actions/runs/1/job/9', started_at: 'a', completed_at: 'b' },
      { id: 10, name: 'Publish', status: 'queued', conclusion: null, html_url: 'https://github.com/acme/mango/actions/runs/1/job/10' },
    ] })
    expect(jobs.map(j => j.state)).toEqual(['success', 'queued'])
    expect(jobs[1]!.startedAt).toBeNull()
  })

  it('reads a run with its jobs, or none', () => {
    expect(parseRunRead('\n', 'dev')).toBeNull()
    const d = parseRunRead(`${JSON.stringify({ id: 5, name: 'Release', status: 'completed', conclusion: 'success', html_url: 'https://github.com/a/b/actions/runs/5' })}\n{"jobs":[]}\n`, 'dev')!
    expect(d.run).toMatchObject({ id: 5, state: 'success' })
    expect(d.jobs).toEqual([])
    expect(() => parseRunRead('{oops', 'dev')).toThrow(/unexpected/)
  })
})

describe('command lines', () => {
  it('asks only github.com, with the fields it shows', () => {
    expect(releasesArgv(repo, 30).slice(0, 5)).toEqual(['gh', 'api', '--hostname', 'github.com', 'repos/acme/mango/releases?per_page=30'])
    expect(releasesArgv(repo, 1000)[4]).toBe('repos/acme/mango/releases?per_page=100')
    expect(runsArgv(repo)[4]).toBe('repos/acme/mango/actions/runs?per_page=50')
    expect(() => releasesArgv({ owner: 'a;rm', repo: 'b' }, 1)).toThrow(/no GitHub remote/)
  })

  it('reads a tag run in one script, the tag as one argument', () => {
    const argv = runReadArgv(repo, { tag: 'v1.2.3' })
    expect(argv.slice(0, 3)).toEqual(['sh', '-c', RUN_READ])
    expect(argv.slice(4, 8)).toEqual(['repos/acme/mango', 'tag', 'v1.2.3', NEWEST_JQ])
    expect(runReadArgv(repo, { id: 9 }).slice(5, 7)).toEqual(['id', '9'])
    expect(line(argv)).toContain(' mango-run-read repos/acme/mango tag v1.2.3 ')
    expect(() => runReadArgv(repo, { tag: '--upload-pack=x' })).toThrow()
    expect(() => runReadArgv(repo, { tag: 'a b' })).toThrow()
    expect(() => runReadArgv(repo, { id: 0 })).toThrow(/not a workflow run/)
    expect(() => checkTag('v1\u0007')).toThrow()
  })

  it('posts only the three actions', () => {
    expect(runActionArgv(repo, 12, 'rerun-failed')).toEqual(['gh', 'api', '--hostname', 'github.com', '-X', 'POST', 'repos/acme/mango/actions/runs/12/rerun-failed-jobs'])
    expect(runActionArgv(repo, 12, 'cancel').at(-1)).toBe('repos/acme/mango/actions/runs/12/cancel')
    expect(() => runActionArgv(repo, 12, 'delete')).toThrow(/Unknown action/)
    expect(() => runActionArgv(repo, -1, 'rerun')).toThrow()
  })
})

describe('failures', () => {
  it('words them', () => {
    expect(readFailure('dev', 'repository acme/mango', 1, 'gh: Not Found (HTTP 404)')).toMatch(/^GitHub has no repository acme\/mango, or the account gh/)
    expect(readFailure('dev', 'x', 127, 'sh: 1: gh: not found')).toMatch(/not installed in dev/)
    expect(readFailure('dev', 'x', 4, 'run gh auth login')).toMatch(/not signed in/)
    expect(actionFailure('dev', 3, 'cancel', 1, 'gh: Conflict (HTTP 409)')).toBe('The run has already finished.')
    expect(actionFailure('dev', 3, 'rerun', 1, 'gh: Conflict (HTTP 409)')).toMatch(/can't re-run it yet/)
    expect(actionFailure('dev', 3, 'rerun', 1, 'gh: Resource not accessible by integration (HTTP 403)')).toMatch(/may not run workflows/)
    expect(actionFailure('dev', 3, 'rerun', 1, 'gh: Not Found (HTTP 404)')).toMatch(/no workflow run 3/)
  })
})
