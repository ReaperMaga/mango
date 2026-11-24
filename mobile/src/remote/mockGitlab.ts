import type { GhJob, GhRun, GhRunAction, GhRunDetail, GhRunJob } from '~/types/ipc'
import { itemKey } from '~/utils/githubLinks'
import type { GhDetail, GhState } from './github'
import type { Forge } from './gitlab'
import { glJobFromJson, glMergeArgv, parseGlJobUrl, splitTrace, type GlTarget } from './gitlabItems'
import { stableId, workflowId } from './gitlabReleases'
import type { Releases } from './releases'

/**
 * What the preview's "GitLab" knows: one project on gitlab.com in a nested group, with a merge
 * request whose pipeline has a failed job (its trace split into sections), an issue, and releases
 * built by tag pipelines. Made up, and the descriptions say so. `createMockGitlab` keeps one
 * backend's changes (a merge, a merge request it opened, a retried pipeline).
 */

const HOUR = 3_600_000
const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z')
const ago = (h: number) => iso(Date.now() - h * HOUR)

const SIMULATED = '_Simulated: the preview cannot ask GitLab. In the app this is read with the GitLab CLI inside the environment._'

/** The mock project the `scratch` folder's remotes point at. */
export const MOCK_GITLAB: Forge = { provider: 'gitlab', host: 'gitlab.com', owner: 'acme/labs', repo: 'scratch' }
const WEB = `https://${MOCK_GITLAB.host}/${MOCK_GITLAB.owner}/${MOCK_GITLAB.repo}`

/** The commit !12's branch points at (`ghMerge` checks it, as GitLab does). */
export const MOCK_HEAD_12 = '7c3e9a1b5d2f4e6a8b0c1d3e5f7a9b2c4d6e8f0a'

const jobUrl = (id: number) => `${WEB}/-/jobs/${id}`

const BASE: Omit<GhDetail, 'kind' | 'number' | 'url' | 'title' | 'state' | 'body'> = {
  provider: 'gitlab',
  host: MOCK_GITLAB.host,
  owner: MOCK_GITLAB.owner,
  repo: MOCK_GITLAB.repo,
  stateReason: null,
  author: { login: 'ana-dev', avatarUrl: null },
  createdAt: '',
  updatedAt: '',
  labels: [],
  comments: 0,
  headRef: null, baseRef: null, additions: null, deletions: null, changedFiles: null, reviewDecision: null,
  checks: null, checkRuns: [], headSha: null, mergeable: null, mergeState: null, mergeMethods: [], defaultMergeMethod: null, canMerge: false,
}

function items(): GhDetail[] {
  return [
    {
      ...BASE,
      kind: 'pr', number: 12, url: `${WEB}/-/merge_requests/12`,
      title: 'Use bun:sqlite for the bench store',
      state: 'open',
      createdAt: ago(5), updatedAt: ago(0.5),
      body: `## Why

\`bun:sqlite\` inserted 100k rows in 212 ms against 298 ms for better-sqlite3 (see #5).

## What changes

- \`bench/store.ts\` opens the database with \`bun:sqlite\`
- One transaction per batch, as before

${SIMULATED}`,
      labels: [{ name: 'performance', color: '428bca' }],
      comments: 1,
      headRef: 'feat/bun-sqlite', baseRef: 'main', additions: 48, deletions: 31, changedFiles: 3,
      reviewDecision: 'review_required', checks: 'failure',
      checkRuns: [
        { name: 'lint', workflow: 'test', state: 'success', url: jobUrl(9000), description: null, required: true },
        { name: 'bench', workflow: 'test', state: 'failure', url: jobUrl(9001), description: null, required: true },
        { name: 'deploy:preview', workflow: 'deploy', state: 'neutral', url: jobUrl(9002), description: null, required: true },
      ],
      headSha: MOCK_HEAD_12, mergeable: 'mergeable', mergeState: 'blocked',
      mergeMethods: ['merge', 'squash'], defaultMergeMethod: 'squash', canMerge: true,
    },
    {
      ...BASE,
      kind: 'issue', number: 5, url: `${WEB}/-/issues/5`,
      title: 'Compare SQLite drivers for the bench',
      state: 'open',
      createdAt: ago(24 * 4), updatedAt: ago(5),
      body: `Measure inserts and reads of 100k rows with \`bun:sqlite\` and better-sqlite3.\n\n${SIMULATED}`,
      labels: [{ name: 'research', color: 'a8d695' }],
      comments: 2,
    },
  ]
}

/** What the list shows of an item. */
const stateOf = (d: GhDetail): GhState => ({ kind: d.kind, title: d.title, state: d.state, stateReason: d.stateReason })

const keyOf = (kind: 'pr' | 'issue', number: number) => itemKey(MOCK_GITLAB.host, MOCK_GITLAB.owner, MOCK_GITLAB.repo, number, kind, 'gitlab')

/* ---------- CI jobs: traces as the runner prints them ---------- */

const E = '\x1b[0K'
const section = (at: number, name: string, title: string, lines: string[]) => [
  `section_start:${at}:${name}\r${E}${E}\x1b[36;1m${title}\x1b[0;m`,
  ...lines,
  `section_end:${at + Math.max(1, lines.length)}:${name}\r${E}`,
]

function trace(id: number): { json: object; log: string } | null {
  const t0 = Math.floor((Date.now() - 40 * 60_000) / 1000)
  const head = ['\x1b[0KRunning with gitlab-runner 17.5.0 (simulated)\x1b[0;m', '  on shared-runner-7 x1y2z3']
  const prep = [
    ...section(t0, 'prepare_executor', 'Preparing the "docker" executor', ['Using Docker executor with image oven/bun:1.3 ...']),
    ...section(t0 + 2, 'get_sources', 'Getting source from Git repository', ['Fetching changes with git depth set to 20...', `Checking out ${MOCK_HEAD_12.slice(0, 8)} as detached HEAD (ref is feat/bun-sqlite)...`]),
  ]
  const job = (name: string, stage: string, status: string, script: string[]) => ({
    json: {
      id, name, stage, status, web_url: jobUrl(id),
      started_at: iso((t0) * 1000), finished_at: iso((t0 + 60) * 1000),
    },
    log: [...head, ...prep, ...script].join('\n') + '\n',
  })
  if (id === 9000) {
    return job('lint', 'test', 'success', [
      ...section(t0 + 5, 'step_script', 'Executing "step_script" stage of the job script', ['\x1b[32;1m$ bun run lint\x1b[0;m', 'Checked 14 files. No problems found.']),
      ...section(t0 + 9, 'cleanup_file_variables', 'Cleaning up project directory and file based variables', []),
      '\x1b[32;1mJob succeeded\x1b[0;m',
    ])
  }
  if (id === 9001) {
    return job('bench', 'test', 'failed', [
      `section_start:${t0 + 5}:step_script\r${E}${E}\x1b[36;1mExecuting "step_script" stage of the job script\x1b[0;m`,
      '\x1b[32;1m$ bun install\x1b[0;m',
      `section_start:${t0 + 6}:deps[collapsed=true]\r${E}Install dependencies`,
      'bun install v1.3.0', 'Resolved, downloaded and extracted [42]', '42 packages installed',
      `section_end:${t0 + 8}:deps\r${E}`,
      '\x1b[32;1m$ bun bench/sqlite.ts --assert-faster\x1b[0;m',
      'bun:sqlite       insert 100k  212 ms   read 100k   61 ms',
      'better-sqlite3   insert 100k  298 ms   read 100k   94 ms',
      '\x1b[31merror: read 100k took 61 ms, the budget is 50 ms\x1b[0m',
      `section_end:${t0 + 20}:step_script\r${E}`,
      ...section(t0 + 20, 'cleanup_file_variables', 'Cleaning up project directory and file based variables', []),
      '\x1b[31;1mERROR: Job failed: exit code 1\x1b[0;m',
    ])
  }
  return null
}

/* ---------- releases and pipelines ---------- */

function pipelines(): { runs: GhRun[]; jobs: Record<number, GhRunJob[]> } {
  const run = (id: number, iid: number, ref: string, tag: boolean, source: string, state: GhRun['state'], hoursAgo: number, minutes: number, title: string): GhRun => ({
    id, workflowId: workflowId(tag, source), workflow: 'Pipeline', title, event: source, headBranch: ref,
    headSha: MOCK_HEAD_12, state, url: `${WEB}/-/pipelines/${id}`, number: iid, attempt: 1,
    createdAt: ago(hoursAgo), startedAt: ago(hoursAgo), updatedAt: state === 'pending' ? ago(0) : ago(hoursAgo - minutes / 60),
  })
  const runs = [
    run(4102, 58, 'v0.4.0', true, 'push', 'pending', 0.1, 0, 'chore(release): v0.4.0'),
    run(4090, 55, 'v0.3.0', true, 'push', 'success', 50, 9, 'chore(release): v0.3.0'),
    run(4071, 51, 'v0.2.0', true, 'push', 'success', 24 * 9, 8, 'chore(release): v0.2.0'),
  ]
  const job = (id: number, name: string, state: GhRunJob['state'], hoursAgo: number, minutes: number | null): GhRunJob => ({
    id, name, state, url: jobUrl(id), startedAt: state === 'queued' ? null : ago(hoursAgo), completedAt: minutes === null ? null : ago(hoursAgo - minutes / 60),
  })
  return {
    runs,
    jobs: {
      4102: [job(9100, 'build:linux', 'pending', 0.1, null), job(9101, 'build:macos', 'queued', 0.1, null), job(9102, 'publish', 'queued', 0.1, null)],
      4090: [job(9000, 'build:linux', 'success', 50, 6), job(9003, 'build:macos', 'success', 50, 8), job(9004, 'publish', 'success', 49.85, 1)],
      4071: [job(9005, 'build:linux', 'success', 24 * 9, 6), job(9006, 'publish', 'success', 24 * 9 - 0.12, 1)],
    },
  }
}

function releases(): Releases['releases'] {
  const rel = (tag: string, hoursAgo: number, body: string) => ({
    id: stableId(`release:${tag}`), tag, name: tag, draft: false, prerelease: false,
    url: `${WEB}/-/releases/${tag}`, author: { login: 'ana-dev', avatarUrl: null },
    createdAt: ago(hoursAgo), publishedAt: ago(hoursAgo), target: MOCK_HEAD_12.slice(0, 8), bodyHtml: '',
    body: `${body}\n\n${SIMULATED}`,
    assets: [
      { name: `scratch-${tag}-linux-x64.tar.gz`, size: 0, downloads: 0, url: `${WEB}/-/releases/${tag}/downloads/scratch-linux-x64.tar.gz`, state: 'uploaded' },
      { name: `scratch-${tag}-macos-arm64.tar.gz`, size: 0, downloads: 0, url: `${WEB}/-/releases/${tag}/downloads/scratch-macos-arm64.tar.gz`, state: 'uploaded' },
    ],
  })
  return [
    rel('v0.3.0', 49.8, '## Changes\n\n- The bench store uses `bun:sqlite` (!12)'),
    rel('v0.2.0', 24 * 9 - 0.2, '## Changes\n\n- First bench of SQLite drivers (#5)'),
  ]
}

/* ---------- one backend's GitLab ---------- */

export interface MockGitlab {
  state(t: GlTarget, instance: string): GhState
  detail(t: GlTarget, instance: string): GhDetail
  merge(t: GlTarget, method: string, headSha: string, instance: string): void
  job(url: string): GhJob
  mrCreate(branch: string, base: string | null): GhDetail
  releases(count: number): Releases
  run(what: { tag: string } | { id: number }): GhRunDetail | null
  runAction(id: number, action: GhRunAction): void
}

export function createMockGitlab(): MockGitlab {
  const known = new Map(items().map(d => [keyOf(d.kind, d.number), d]))
  const ci = pipelines()
  const openedFor = new Map<string, number>()
  let next = 13

  function detail(t: GlTarget, instance: string): GhDetail {
    if (t.forge.host !== MOCK_GITLAB.host || t.forge.owner !== MOCK_GITLAB.owner || t.forge.repo !== MOCK_GITLAB.repo) {
      throw new Error(`GitLab has no project ${t.forge.owner}/${t.forge.repo}, or the account glab is signed in with in ${instance} cannot see it.`)
    }
    const found = (t.kind !== 'issue' ? known.get(keyOf('pr', t.iid)) : undefined) ?? (t.kind !== 'mr' ? known.get(keyOf('issue', t.iid)) : undefined)
    if (!found) throw new Error(`There is no ${t.kind === 'issue' ? `issue #${t.iid}` : t.kind === 'mr' ? `merge request !${t.iid}` : `merge request or issue ${t.iid}`} in ${t.forge.owner}/${t.forge.repo}.`)
    return JSON.parse(JSON.stringify(found)) as GhDetail
  }

  return {
    state: (t, instance) => stateOf(detail(t, instance)),
    detail,

    merge(t, method, headSha, instance) {
      glMergeArgv(t, method, headSha)
      const d = known.get(keyOf('pr', detail(t, instance).number))!
      if (d.state !== 'open') throw new Error('GitLab will not merge it yet: it may be a draft, closed, blocked by its pipeline, approvals or open threads.')
      if (d.headSha !== headSha) throw new Error('The branch got new commits since this was read. Look at them, then merge again.')
      Object.assign(d, { state: 'merged', updatedAt: iso(Date.now()), canMerge: false })
    },

    job(url) {
      const t = parseGlJobUrl(url)
      const found = trace(t.job)
      if (!found) {
        // A release build's job: its steps are its sections, none read yet in the preview.
        const j = Object.values(ci.jobs).flat().find(x => x.id === t.job)
        if (!j) throw new Error(`GitLab has no job ${t.job} there, or the account glab is signed in with cannot see it.`)
        return { ...glJobFromJson({ id: j.id, name: j.name, stage: 'build', status: j.state === 'pending' ? 'running' : j.state === 'queued' ? 'pending' : j.state, web_url: j.url, started_at: j.startedAt, finished_at: j.completedAt }, url), logReady: j.state !== 'queued', steps: [] }
      }
      const job = glJobFromJson(found.json, url)
      job.steps = splitTrace(found.log, job.state)
      job.logReady = true
      return job
    },

    mrCreate(branch, base) {
      const into = base ?? 'main'
      if (branch === into) throw new Error(`${branch} has no commits that ${into} doesn't have, so there is nothing to open a merge request for.`)
      const number = openedFor.get(branch) ?? next++
      openedFor.set(branch, number)
      const key = keyOf('pr', number)
      if (!known.has(key)) {
        const words = (branch.split('/').pop() ?? branch).replace(/[-_]/g, ' ')
        known.set(key, {
          ...BASE,
          kind: 'pr', number, url: `${WEB}/-/merge_requests/${number}`,
          title: words.charAt(0).toUpperCase() + words.slice(1),
          state: 'open', createdAt: iso(Date.now()), updatedAt: iso(Date.now()),
          body: `- ${words}\n\n${SIMULATED}`,
          headRef: branch, baseRef: into, additions: 12, deletions: 3, changedFiles: 2,
          reviewDecision: null, checks: 'pending',
          checkRuns: [{ name: 'lint', workflow: 'test', state: 'pending', url: jobUrl(9000), description: null, required: true }],
          headSha: MOCK_HEAD_12, mergeable: 'mergeable', mergeState: 'blocked',
          mergeMethods: ['merge', 'squash'], defaultMergeMethod: 'merge', canMerge: true,
        })
      }
      return JSON.parse(JSON.stringify(known.get(key))) as GhDetail
    },

    releases(count) {
      return { provider: 'gitlab', host: MOCK_GITLAB.host, owner: MOCK_GITLAB.owner, repo: MOCK_GITLAB.repo, releases: releases().slice(0, Math.max(1, count)), runs: ci.runs.map(r => ({ ...r })) }
    },

    run(what) {
      const run = 'tag' in what
        ? ci.runs.filter(r => r.headBranch === what.tag).sort((a, b) => b.id - a.id)[0]
        : ci.runs.find(r => r.id === what.id)
      if (!run) return null
      return { run: { ...run }, jobs: (ci.jobs[run.id] ?? []).map(j => ({ ...j })) }
    },

    runAction(id, action) {
      const run = ci.runs.find(r => r.id === id)
      if (!run) throw new Error(`GitLab has no pipeline ${id}, or the account glab is signed in with cannot see it.`)
      if (action === 'cancel') {
        if (run.state !== 'pending' && run.state !== 'queued') throw new Error('The pipeline has already finished.')
        run.state = 'cancelled'
        for (const j of ci.jobs[id] ?? []) if (j.state === 'pending' || j.state === 'queued') j.state = 'cancelled'
      } else {
        run.state = 'pending'
        for (const j of ci.jobs[id] ?? []) if (j.state !== 'success') j.state = 'queued'
      }
    },
  }
}
