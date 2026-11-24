import { describe, expect, it } from 'vitest'
import type { Forge } from './gitlab'
import {
  RUN_READ, actionFailure, commitTitles, glState, jobsFromJson, mergeRuns, parseGitlabReleases, parsePipelineRef, parseRunRead, pipelineRef,
  releaseFromJson, releasesArgvs, runActionArgv, runFromJson, runReadArgv, runsFromJson, stableId, titleFromJobs, workflowId,
} from './gitlabReleases'
import { line } from './shell'

/** Ported from the tests of `src-tauri/src/gitlab_releases.rs`, plus the phone's command lines. */

const f: Forge = { provider: 'gitlab', host: 'gitlab.example.com', owner: 'acme/apps', repo: 'mango' }

describe('ids', () => {
  it('are FNV-1a, fit JavaScript and do not change', () => {
    expect(stableId('')).toBe(Number(0xcbf29ce484222325n & ((1n << 53n) - 1n)))
    expect(stableId('a')).toBe(Number(0xaf63dc4c8601ec8cn & ((1n << 53n) - 1n)))
    expect(stableId('release:v1.0.0')).toBe(stableId('release:v1.0.0'))
    expect(stableId('release:v1.0.0')).not.toBe(stableId('release:v1.0.1'))
    for (const k of ['', 'tag', 'release:v0.1.28', 'source:push']) {
      const id = stableId(k)
      expect(id > 0 && Number.isSafeInteger(id)).toBe(true)
    }
    expect(workflowId(true, 'push')).not.toBe(workflowId(false, 'push'))
    expect(workflowId(true, 'push')).toBe(workflowId(true, 'api'))
  })
})

describe('releases', () => {
  it('reads a release, its notes as Markdown and its links as files', () => {
    const r = releaseFromJson(f, {
      tag_name: 'v0.2', name: 'Awesome app v0.2 beta', description: '## CHANGELOG',
      description_html: '<h2>CHANGELOG</h2>',
      created_at: '2019-01-03T01:56:19.539Z', released_at: '2019-01-03T01:56:19.539Z', upcoming_release: false,
      author: { username: 'root', avatar_url: 'https://www.gravatar.com/avatar/x' },
      commit: { id: '079e90101242458910cccd35eab0e211dfc359c0', short_id: '079e9010', title: 'Update README.md' },
      assets: {
        sources: [{ format: 'zip', url: 'https://gitlab.example.com/root/awesome-app/-/archive/v0.2/awesome-app-v0.2.zip' }],
        links: [
          { id: 2, name: 'awesome-v0.2.msi', url: 'http://192.168.10.15:3000/msi', direct_asset_url: 'https://gitlab.example.com/root/awesome-app/-/releases/v0.2/downloads/awesome-v0.2.msi' },
          { id: 1, name: 'awesome-v0.2.dmg', url: 'http://192.168.10.15:3000' },
          { id: 3, name: 'evil', url: 'javascript:alert(1)' },
        ],
      },
      _links: { self: 'https://gitlab.example.com/root/awesome-app/-/releases/v0.2' },
    })!
    expect([r.tag, r.name, r.id, r.draft, r.prerelease]).toEqual(['v0.2', 'Awesome app v0.2 beta', stableId('release:v0.2'), false, false])
    expect(r.url).toBe('https://gitlab.example.com/root/awesome-app/-/releases/v0.2')
    expect(r.author).toEqual({ login: 'root', avatarUrl: null })
    expect(r.publishedAt).toBe('2019-01-03T01:56:19.539Z')
    expect(r.target).toBe('079e9010')
    expect([r.body, r.bodyHtml]).toEqual(['## CHANGELOG', ''])
    expect(r.assets.map(a => a.url)).toEqual(['https://gitlab.example.com/root/awesome-app/-/releases/v0.2/downloads/awesome-v0.2.msi', 'http://192.168.10.15:3000'])
    expect([r.assets[0]!.size, r.assets[0]!.downloads, r.assets[0]!.state]).toEqual([0, 0, 'uploaded'])
  })

  it('reads an upcoming release, and a bare one', () => {
    const r = releaseFromJson(f, { tag_name: 'v3.0.0', name: null, upcoming_release: true, created_at: '2026-11-20T10:00:00.000Z', released_at: '2026-12-24T10:00:00.000Z', commit: { id: '4b1d2c3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c' } })!
    expect([r.name, r.publishedAt, r.target]).toEqual(['v3.0.0', null, '4b1d2c3e'])
    expect(r.url).toBe('https://gitlab.example.com/acme/apps/mango/-/releases/v3.0.0')
    expect(r.assets).toEqual([])
    expect(releaseFromJson(f, { name: 'no tag' })).toBeNull()
  })
})

describe('pipelines', () => {
  it('maps states', () => {
    for (const [gl, ours] of [
      ['created', 'queued'], ['waiting_for_resource', 'queued'], ['preparing', 'queued'], ['pending', 'queued'], ['scheduled', 'queued'],
      ['running', 'pending'], ['success', 'success'], ['failed', 'failure'], ['canceled', 'cancelled'], ['canceling', 'cancelled'],
      ['skipped', 'skipped'], ['manual', 'neutral'],
    ] as const) expect(glState(gl), gl).toBe(ours)
  })

  it('reads pipelines and titles them from the releases', () => {
    const recent = [
      { id: 47, iid: 12, status: 'running', source: 'push', ref: 'main', sha: 'a91957a858320c0e17f3a0eca7cfacbff50ea29a', name: null, web_url: 'https://gitlab.example.com/acme/apps/mango/-/pipelines/47', created_at: '2026-11-21T00:12:41.123Z', updated_at: '2026-11-21T00:14:00.456Z' },
      { id: 46, iid: 11, status: 'success', source: 'push', ref: 'v0.2', sha: '079e90101242458910cccd35eab0e211dfc359c0', name: 'Release', web_url: 'https://gitlab.example.com/acme/apps/mango/-/pipelines/46', created_at: '2026-11-20T00:12:41.123Z', updated_at: '2026-11-20T00:20:00.000Z' },
      { id: 45, iid: 10, status: 'failed', source: 'merge_request_event', ref: 'refs/merge-requests/3/head', sha: 'b', web_url: 'javascript:alert(1)' },
      { id: 0, web_url: 'https://gitlab.example.com/acme/apps/mango/-/pipelines/0' },
    ]
    const tags = [
      recent[1],
      { id: 30, iid: 5, status: 'manual', source: 'web', ref: 'v0.1', sha: 'c', web_url: 'https://gitlab.example.com/acme/apps/mango/-/pipelines/30', created_at: '2026-10-01T00:00:00.000Z', updated_at: '2026-10-01T00:10:00.000Z' },
    ]
    const titles = commitTitles([{ tag_name: 'v0.2', commit: { id: '079e90101242458910cccd35eab0e211dfc359c0', title: 'chore(release): v0.2' } }])
    const runs = mergeRuns(runsFromJson(f, recent, false), runsFromJson(f, tags, true), titles)
    expect(runs.map(r => r.id)).toEqual([47, 46, 30])
    const [main, release, manual] = runs as [typeof runs[0], typeof runs[0], typeof runs[0]]
    expect([main.state, main.event, main.workflow, main.headBranch, main.number, main.attempt, main.title]).toEqual(['pending', 'push', 'Pipeline', 'main', 12, 1, ''])
    expect([release.workflow, release.title, release.headBranch]).toEqual(['Release', 'chore(release): v0.2', 'v0.2'])
    expect(release.workflowId).toBe(manual.workflowId)
    expect(release.workflowId).not.toBe(main.workflowId)
    expect([manual.state, manual.event]).toEqual(['neutral', 'web'])
  })

  it('reads one pipeline and its jobs', () => {
    const one = { id: 46, iid: 11, name: 'Build pipeline', status: 'failed', source: 'push', ref: 'v0.2', sha: '079e9010', tag: true, created_at: '2026-11-20T00:12:41.123Z', updated_at: '2026-11-20T00:30:00.000Z', started_at: '2026-11-20T00:12:45.000Z', finished_at: '2026-11-20T00:20:00.000Z', web_url: 'https://gitlab.example.com/acme/apps/mango/-/pipelines/46' }
    const run = runFromJson(f, one, false)!
    expect(run.workflowId).toBe(workflowId(true, 'push'))
    expect([run.startedAt, run.updatedAt, run.state]).toEqual(['2026-11-20T00:12:45.000Z', '2026-11-20T00:20:00.000Z', 'failure'])
    const jobs = [
      { id: 7, status: 'failed', name: 'lint', allow_failure: true, started_at: '2026-11-20T00:12:45.000Z', finished_at: '2026-11-20T00:13:45.000Z', commit: { title: 'chore(release): v0.2' }, web_url: 'https://gitlab.example.com/acme/apps/mango/-/jobs/7' },
      { id: 8, status: 'failed', name: 'build:windows', allow_failure: false, started_at: '2026-11-20T00:13:50.000Z', finished_at: '2026-11-20T00:20:00.000Z', web_url: 'https://gitlab.example.com/acme/apps/mango/-/jobs/8' },
      { id: 9, status: 'manual', name: 'publish', allow_failure: true, started_at: null, finished_at: null, web_url: 'https://gitlab.example.com/acme/apps/mango/-/jobs/9' },
      { id: 10, status: 'created', name: 'no page', web_url: null },
    ]
    expect(titleFromJobs(jobs)).toBe('chore(release): v0.2')
    const read = jobsFromJson(f, jobs)
    expect(read.map(j => j.state)).toEqual(['neutral', 'failure', 'neutral'])
    expect([read[1]!.url, read[1]!.completedAt, read[2]!.startedAt]).toEqual(['https://gitlab.example.com/acme/apps/mango/-/jobs/8', '2026-11-20T00:20:00.000Z', null])

    // As `RUN_READ` prints them: the pipeline, a mark, the jobs.
    const d = parseRunRead(f, `${JSON.stringify(one)}\nMANGO-JOBS\n${JSON.stringify(jobs)}\n`, 'dev', 'v0.2')!
    expect([d.run.id, d.run.title, d.jobs.length]).toEqual([46, 'chore(release): v0.2', 3])
    expect(parseRunRead(f, '', 'dev', 'v0.2')).toBeNull()
    expect(parseRunRead(f, `${JSON.stringify(one)}\nMANGO-JOBS\n[]`, 'dev', 'v9')).toBeNull()
    expect(() => parseRunRead(f, 'nope', 'dev')).toThrow(/unexpected/)
  })
})

describe('commands', () => {
  it('reads releases and both pipeline lists, values encoded and quoted', () => {
    const [list, recent, tags] = releasesArgvs(f, 500)
    expect(list).toEqual(['glab', 'api', '--hostname', 'gitlab.example.com', 'projects/acme%2Fapps%2Fmango/releases?per_page=100'])
    expect(recent![4]).toBe('projects/acme%2Fapps%2Fmango/pipelines?per_page=50')
    expect(tags![4]).toBe('projects/acme%2Fapps%2Fmango/pipelines?scope=tags&per_page=50')
    expect(() => releasesArgvs({ ...f, owner: 'a;b' }, 5)).toThrow(/no GitLab remote/)
  })

  it('reads a pipeline by tag or id in one script', () => {
    expect(runReadArgv(f, { tag: 'v1.2/beta' }).slice(3)).toEqual(['mango-pipeline', 'gitlab.example.com', 'projects/acme%2Fapps%2Fmango', 'tag', 'v1.2%2Fbeta'])
    expect(runReadArgv(f, { id: 46 }).slice(6)).toEqual(['id', '46'])
    expect(() => runReadArgv(f, { tag: '--upload-pack=x' })).toThrow()
    expect(() => runReadArgv(f, { tag: 'v1 x' })).toThrow()
    expect(() => runReadArgv(f, { id: 0 })).toThrow()
    expect(RUN_READ).toContain('include_retried=false')
  })

  it('retries, cancels, or starts a new pipeline for the same ref', () => {
    expect(line(runActionArgv(f, 5, 'rerun-failed'))).toBe('glab api --hostname gitlab.example.com projects/acme%2Fapps%2Fmango/pipelines/5/retry --method POST')
    expect(line(runActionArgv(f, 5, 'cancel'))).toBe('glab api --hostname gitlab.example.com projects/acme%2Fapps%2Fmango/pipelines/5/cancel --method POST')
    expect(line(runActionArgv(f, 5, 'rerun', 'v1.2'))).toBe('glab api --hostname gitlab.example.com projects/acme%2Fapps%2Fmango/pipeline -f ref=v1.2 --method POST')
    expect(() => runActionArgv(f, 5, 'delete')).toThrow(/Unknown action/)
    expect(() => runActionArgv(f, 5, 'rerun')).toThrow()
    expect(() => pipelineRef('refs/merge-requests/3/head')).toThrow(/merge request/)
    expect(() => pipelineRef('-x')).toThrow()
    expect(pipelineRef('v1.2.3')).toBe('v1.2.3')
    expect(parsePipelineRef('{"id":5,"ref":"main"}', 'dev')).toBe('main')
  })

  it('words refusals', () => {
    expect(actionFailure('dev', 'gitlab.com', 5, 'rerun', 1, 'glab: 403 Forbidden (HTTP 403)')).toMatch(/may not run pipelines/)
    expect(actionFailure('dev', 'gitlab.com', 5, 'rerun-failed', 1, 'glab: 409 Conflict (HTTP 409)')).toMatch(/already retrying/)
    expect(actionFailure('dev', 'gitlab.com', 5, 'cancel', 1, 'glab: 404 Not Found (HTTP 404)')).toMatch(/GitLab has no pipeline 5/)
    expect(actionFailure('dev', 'gitlab.com', 5, 'cancel', 127, 'sh: 1: glab: not found')).toMatch(/not installed/)
  })

  it('tolerates a project without pipelines', () => {
    const r = parseGitlabReleases(f, JSON.stringify([{ tag_name: 'v1', description: 'x' }]), null, 'not json', 'dev')
    expect([r.releases.length, r.runs]).toEqual([1, []])
    expect(() => parseGitlabReleases(f, '{"message":"x"}', null, null, 'dev')).toThrow(/unexpected/)
  })
})
