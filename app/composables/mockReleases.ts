import type { GhAsset, GhRelease, GhReleases, GhRun, GhRunAction, GhRunDetail, GhRunJob, GhRunList, GhRunState } from '~/types/ipc'
import { aliasMockJob, isGitlabMock, registerMockJob } from '~/composables/mockGithub'
import { baseName } from '~/utils/paths'

/**
 * Releases and workflow runs for the browser preview (`pnpm dev`), told as a small story that plays out while you
 * watch: v0.1.29 is being built (draft, jobs finishing one by one, files appearing as each platform
 * uploads, published at the end), a trial build of the release workflow on main fails its Windows
 * job (re-run it), and older releases sit below. Job logs come from mockGithub's `gh_job`.
 *
 * The orchard-api project is on GitLab: the same story told as pipelines, a release appears once its
 * tag pipeline made it, file sizes and downloads are unknown, and one release is still to come.
 */

const OWNER = 'mango-dev'
const REPO = 'mango'
const BASE = `https://github.com/${OWNER}/${REPO}`
const RELEASE_FLOW = 201
const MIN = 60_000

interface MockJob { name: string; from: number; to: number; fails: boolean; platform?: 'win' | 'mac-arm' | 'mac-x64' | 'linux' }
interface MockRun {
  id: number
  /** The workflow, when it is not the release workflow (the Actions window's CI runs). */
  workflow?: { id: number; name: string }
  event: 'push' | 'workflow_dispatch' | 'pull_request' | 'schedule'
  branch: string
  sha: string
  title: string
  start: number
  jobs: MockJob[]
  attempt: number
  cancelledAt: number | null
  /** When its latest attempt started (GitHub moves `run_started_at` on a re-run). */
  restartedAt?: number
}

const stories = new Map<string, { at: number; runs: Map<number, MockRun>; ci: Map<number, MockRun> }>()

function story(path: string) {
  let s = stories.get(path)
  if (s) return s
  const at = Date.now()
  const runs = new Map<number, MockRun>()
  runs.set(9001, {
    id: 9001, event: 'push', branch: 'v0.1.29', sha: '4e1d0a7c2b9f4e0d8a7b6c5d4e3f2a1b0c9d8e7f', title: 'chore(release): v0.1.29',
    start: at - 20_000, attempt: 1, cancelledAt: null,
    jobs: [
      { name: 'Check version', from: 0, to: 6_000, fails: false },
      { name: 'Build (Linux x64)', from: 6_000, to: 36_000, fails: false, platform: 'linux' },
      { name: 'Build (Windows x64)', from: 6_000, to: 40_000, fails: false, platform: 'win' },
      { name: 'Build (macOS Apple Silicon)', from: 6_000, to: 44_000, fails: false, platform: 'mac-arm' },
      { name: 'Build (macOS Intel)', from: 6_000, to: 70_000, fails: false, platform: 'mac-x64' },
      { name: 'Publish release', from: 70_000, to: 74_000, fails: false },
    ],
  })
  runs.set(9002, {
    id: 9002, event: 'workflow_dispatch', branch: 'main', sha: 'd013dd471daf6f6672ea035294ab4f01282f9c38', title: 'Release',
    start: at - 5_000, attempt: 1, cancelledAt: null,
    jobs: [
      { name: 'Check version', from: 0, to: 5_000, fails: false },
      { name: 'Build (Linux x64)', from: 5_000, to: 28_000, fails: false },
      { name: 'Build (Windows x64)', from: 5_000, to: 30_000, fails: true },
    ],
  })
  s = { at, runs, ci: ciRuns(at) }
  stories.set(path, s)
  return s
}

/**
 * The Actions window's other runs: CI on main building right now, a pull request whose tests failed
 * (re-run it), and finished runs of other workflows further down.
 */
function ciRuns(at: number): Map<number, MockRun> {
  const CI = { id: 301, name: 'CI' }
  const checks = (fails: boolean): MockJob[] => [
    { name: 'Typecheck', from: 0, to: 14_000, fails: false },
    { name: 'Unit tests', from: 0, to: 26_000, fails },
    { name: 'Rust (Linux)', from: 0, to: 55_000, fails: false },
    { name: 'Rust (Windows check)', from: 0, to: 48_000, fails: false },
  ]
  const list: MockRun[] = [
    { id: 9101, workflow: CI, event: 'push', branch: 'main', sha: '609baba5d1c0e2f3a4b5c6d7e8f90a1b2c3d4e5f', title: 'feat: open settings from the welcome screen (#131)', start: at - 12_000, attempt: 1, cancelledAt: null, jobs: checks(false) },
    { id: 9102, workflow: CI, event: 'pull_request', branch: 'feat/link-picker', sha: '7a2c9e1f0b3d4c5e6f7a8b9c0d1e2f3a4b5c6d7e', title: 'feat(links): pick an open pull request or issue to link', start: at - 38 * MIN, attempt: 1, cancelledAt: null, jobs: checks(true) },
    { id: 9103, workflow: { id: 302, name: 'Docs' }, event: 'push', branch: 'main', sha: 'cd997df0a1b2c3d4e5f60718293a4b5c6d7e8f90', title: 'chore(release): v0.11.0', start: at - 2 * 60 * MIN, attempt: 1, cancelledAt: null, jobs: [{ name: 'Build site', from: 0, to: 70_000, fails: false }, { name: 'Deploy', from: 70_000, to: 95_000, fails: false }] },
    { id: 9104, workflow: CI, event: 'push', branch: 'main', sha: 'd3f3a53e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c', title: 'feat: resolve merge conflicts in a merge editor and work smoothly with Lore (#130)', start: at - 3 * 60 * MIN, attempt: 1, cancelledAt: null, jobs: checks(false) },
    { id: 9105, workflow: { id: 303, name: 'CodeQL' }, event: 'schedule', branch: 'main', sha: '13dad07a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e', title: 'CodeQL', start: at - 26 * 60 * MIN, attempt: 1, cancelledAt: null, jobs: [{ name: 'Analyze (javascript-typescript)', from: 0, to: 4 * MIN, fails: false }, { name: 'Analyze (rust)', from: 0, to: 7 * MIN, fails: false }] },
  ]
  return new Map(list.map(r => [r.id, r]))
}

const iso = (ms: number) => new Date(ms).toISOString()
const jobUrl = (run: MockRun, i: number) => `${BASE}/actions/runs/${run.id}/job/${run.id * 10 + i + run.attempt * 100}`

function jobState(run: MockRun, j: MockJob, now: number): GhRunState {
  const from = run.start + j.from
  const to = run.start + j.to
  if (run.cancelledAt !== null && run.cancelledAt < to) return run.cancelledAt < from ? 'skipped' : 'cancelled'
  // A job after a failed one is skipped (the release is not published).
  const failedBefore = run.jobs.some(o => o.fails && run.start + o.to <= from)
  if (now < from) return failedBefore ? 'skipped' : 'queued'
  if (failedBefore) return 'skipped'
  if (now < to) return 'pending'
  return j.fails ? 'failure' : 'success'
}

function runJobs(run: MockRun, now: number): GhRunJob[] {
  return run.jobs.map((j, i) => {
    const url = jobUrl(run, i)
    registerMockJob(url, j.name, run.start + j.from, j.to - j.from, j.fails)
    const state = jobState(run, j, now)
    return {
      id: run.id * 10 + i, name: j.name, state, url,
      startedAt: state === 'queued' || state === 'skipped' ? null : iso(run.start + j.from),
      completedAt: state === 'success' || state === 'failure' ? iso(run.start + j.to)
        : state === 'cancelled' ? iso(run.cancelledAt!) : null,
    }
  })
}

function runState(jobs: GhRunJob[]): GhRunState {
  if (jobs.some(j => j.state === 'pending')) return 'pending'
  if (jobs.some(j => j.state === 'queued')) return jobs.some(j => j.startedAt) ? 'pending' : 'queued'
  if (jobs.some(j => j.state === 'failure')) return 'failure'
  if (jobs.some(j => j.state === 'cancelled')) return 'cancelled'
  return 'success'
}

function toRun(run: MockRun, now: number): GhRun {
  const jobs = runJobs(run, now)
  const state = runState(jobs)
  const ends = jobs.map(j => (j.completedAt ? Date.parse(j.completedAt) : 0))
  return {
    id: run.id, workflowId: run.workflow?.id ?? RELEASE_FLOW, workflow: run.workflow?.name ?? 'Release', title: run.title, event: run.event,
    headBranch: run.branch, headSha: run.sha, state, url: `${BASE}/actions/runs/${run.id}`,
    number: run.id - 8960, attempt: run.attempt, createdAt: iso(run.start), startedAt: iso(run.restartedAt ?? run.start),
    updatedAt: iso(state === 'pending' || state === 'queued' ? now : Math.max(...ends, run.start)),
  }
}

/** A finished release run of an older version, about 11 minutes long. */
function pastRun(n: number, at: number): GhRun {
  const start = at - n * 26 * 60 * MIN
  return {
    id: 8000 + n, workflowId: RELEASE_FLOW, workflow: 'Release', title: `chore(release): v0.1.${29 - n}`, event: 'push',
    headBranch: `v0.1.${29 - n}`, headSha: `${(0xabc123 + n).toString(16)}0000000000000000000000000000000000`, state: 'success',
    url: `${BASE}/actions/runs/${8000 + n}`, number: 40 - n, attempt: 1, createdAt: iso(start), startedAt: iso(start),
    updatedAt: iso(start + (11 * MIN) + n * 7_000),
  }
}

function assetsFor(version: string, platforms: Set<string>, downloads: number): GhAsset[] {
  const files: [string, number, string][] = [
    ['win', 11_026_279, `Mango_${version}_x64-setup.exe`],
    ['win', 14_073_856, `Mango_${version}_x64_en-US.msi`],
    ['mac-arm', 13_697_423, `Mango_${version}_aarch64.dmg`],
    ['mac-arm', 13_971_632, `Mango_${version}_aarch64.app.tar.gz`],
    ['mac-x64', 14_567_004, `Mango_${version}_x64.dmg`],
    ['mac-x64', 14_751_263, `Mango_${version}_x64.app.tar.gz`],
    ['linux', 94_263_800, `Mango_${version}_amd64.AppImage`],
    ['linux', 17_044_980, `Mango_${version}_amd64.deb`],
    ['linux', 17_048_723, `Mango-${version}-1.x86_64.rpm`],
  ]
  const out: GhAsset[] = []
  const add = (name: string, size: number, d: number) =>
    out.push({ name, size, downloads: d, url: `${BASE}/releases/download/v${version}/${name}`, state: 'uploaded' })
  files.forEach(([p, size, name], i) => {
    if (!platforms.has(p)) return
    add(name, size, Math.max(0, downloads - i))
    if (!name.endsWith('.dmg')) add(`${name}.sig`, 430, Math.max(0, Math.floor(downloads / 3)))
  })
  if (platforms.has('updater')) add('latest.json', 6_422, downloads + 1)
  return out
}

const NOTES = (version: string) => `<p>Installers for Windows, macOS and Linux are attached below. <a href="https://mango.dev/guide/install">Install notes</a></p>
<h2>What's Changed</h2>
<ul>
<li>feat(links): pick an open pull request or issue to link by <a href="https://github.com/ReaperMaga">@ReaperMaga</a> in <a href="${BASE}/pull/77">#77</a></li>
<li>feat(mobile): pull requests on the phone, as on the desktop in <a href="${BASE}/pull/75">#75</a></li>
<li>fix(git): keep the branch popup inside the window in <a href="${BASE}/pull/76">#76</a></li>
</ul>
<p><strong>Full Changelog</strong>: <a href="${BASE}/compare/v0.1.27...v${version}"><code>v0.1.27...v${version}</code></a></p>`

const ALL = new Set(['win', 'mac-arm', 'mac-x64', 'linux', 'updater'])
const BOT = { login: 'github-actions[bot]', avatarUrl: null }

export function mockGhReleases(path: string, count: number): GhReleases {
  const github = githubReleases(path, count)
  return isGitlabMock(path) ? gitlabReleases(path, github) : github
}

function githubReleases(path: string, count: number): GhReleases {
  const s = story(path)
  const now = Date.now()
  const building = s.runs.get(9001)!
  const buildRun = toRun(building, now)
  const jobs = runJobs(building, now)
  const uploaded = new Set<string>()
  building.jobs.forEach((j, i) => { if (j.platform && jobs[i]!.state === 'success') uploaded.add(j.platform) })
  const published = buildRun.state === 'success'
  if (published) uploaded.add('updater')
  const releases: GhRelease[] = [{
    id: 129, tag: 'v0.1.29', name: 'Mango 0.1.29', draft: !published, prerelease: false,
    url: `${BASE}/releases/tag/v0.1.29`, author: BOT, createdAt: iso(building.start + 8_000),
    publishedAt: published ? buildRun.updatedAt : null, target: 'main',
    bodyHtml: published ? NOTES('0.1.29') : '', assets: assetsFor('0.1.29', uploaded, 0),
  }]
  for (let n = 1; n <= 12; n++) {
    const run = pastRun(n, s.at)
    releases.push({
      id: 129 - n, tag: run.headBranch!, name: `Mango 0.1.${29 - n}`, draft: false, prerelease: false,
      url: `${BASE}/releases/tag/${run.headBranch}`, author: BOT, createdAt: run.createdAt, publishedAt: run.updatedAt,
      target: 'main', bodyHtml: NOTES(`0.1.${29 - n}`), assets: assetsFor(`0.1.${29 - n}`, ALL, n * 6 + 2),
    })
  }
  const runs = [...s.runs.values()].map(r => toRun(r, now))
  for (let n = 1; n <= 6; n++) runs.push(pastRun(n, s.at))
  return { provider: 'github', host: 'github.com', owner: OWNER, repo: REPO, releases: releases.slice(0, count), runs }
}

/* ---------- the same on GitLab ---------- */

const glWeb = (path: string) => `https://gitlab.com/acme/backend/${baseName(path)}`

/** A pipeline for a run: GitLab's own words and links. */
function glRun(path: string, run: GhRun): GhRun {
  return {
    ...run, workflowId: 0, workflow: 'Pipeline', event: run.event === 'workflow_dispatch' ? 'web' : 'push',
    title: run.event === 'workflow_dispatch' ? '' : run.title, url: `${glWeb(path)}/-/pipelines/${run.id}`, number: run.id - 8000,
  }
}

/** A job under its GitLab link, telling the same story in `gh_job`. */
function glJob(path: string, job: GhRunJob): GhRunJob {
  const url = `${glWeb(path)}/-/jobs/${job.id + 5_200_000}`
  aliasMockJob(job.url, url)
  return { ...job, url }
}

const glDetail = (path: string, d: GhRunDetail | null): GhRunDetail | null =>
  (d ? { run: glRun(path, d.run), jobs: d.jobs.map(j => glJob(path, j)) } : null)

function gitlabReleases(path: string, github: GhReleases): GhReleases {
  const web = glWeb(path)
  const release = (r: GhRelease): GhRelease => ({
    ...r, name: r.name.replace('Mango', 'Orchard API'), draft: false, prerelease: false, url: `${web}/-/releases/${r.tag}`,
    author: { login: 'gitlab-ci', avatarUrl: null }, target: (r.id * 7919).toString(16).padEnd(8, '0').slice(0, 8),
    bodyHtml: r.bodyHtml ? `<p>Packages for every platform are listed below. See <a href="/acme/backend/${baseName(path)}/-/merge_requests/14">!14</a> for the rate limits.</p>` : '',
    // GitLab does not say how big a release's files are, nor how often they were downloaded.
    assets: r.assets.map(a => ({ ...a, size: 0, downloads: 0, url: `${web}/-/releases/${r.tag}/downloads/${a.name}` })),
  })
  const upcoming: GhRelease = {
    id: 200, tag: 'v0.2.0', name: 'Orchard API 0.2.0', draft: false, prerelease: false, url: `${web}/-/releases/v0.2.0`,
    author: { login: 'you', avatarUrl: null }, createdAt: new Date(Date.now() - 3_600_000).toISOString(), publishedAt: null,
    target: 'c0ffee12', bodyHtml: '<p>Comes out with the next maintenance window.</p>', assets: [],
  }
  return {
    provider: 'gitlab', host: 'gitlab.com', owner: 'acme/backend', repo: baseName(path),
    // A GitLab release is made by its tag pipeline's last job: while that pipeline runs, there is only the tag.
    releases: [upcoming, ...github.releases.filter(r => !r.draft).map(release)],
    runs: github.runs.map(r => glRun(path, r)),
  }
}

export function mockGhTagRun(path: string, tag: string): GhRunDetail | null {
  const detail = githubTagRun(path, tag)
  return isGitlabMock(path) ? glDetail(path, detail) : detail
}

function githubTagRun(path: string, tag: string): GhRunDetail | null {
  const s = story(path)
  const now = Date.now()
  const live = [...s.runs.values()].find(r => r.branch === tag && r.event === 'push')
  if (live) return { run: toRun(live, now), jobs: runJobs(live, now) }
  const m = /^v0\.1\.(\d+)$/.exec(tag)
  if (!m) return null
  const run = pastRun(29 - Number(m[1]), s.at)
  const start = Date.parse(run.startedAt!)
  const names: [string, number, number][] = [
    ['Check version', 0, 19_000], ['Build (Windows x64)', 22_000, 4.6 * MIN], ['Build (Linux x64)', 22_000, 4.2 * MIN],
    ['Build (macOS Apple Silicon)', 23_000, 4.6 * MIN], ['Build (macOS Intel)', 23_000, 10.9 * MIN], ['Publish release', 10.95 * MIN, 11 * MIN],
  ]
  const jobs = names.map(([name, from, to], i): GhRunJob => {
    const url = `${BASE}/actions/runs/${run.id}/job/${run.id * 10 + i}`
    registerMockJob(url, name, start - 3 * MIN, 1_000, false)
    return { id: run.id * 10 + i, name, state: 'success', url, startedAt: iso(start + from), completedAt: iso(start + to) }
  })
  return { run, jobs }
}

/** The Actions window's list: CI runs and the release story's runs, newest first, a branch's only when asked. */
export function mockGhRuns(path: string, branch: string | null, count: number): GhRunList {
  const s = story(path)
  const now = Date.now()
  let runs = [...s.ci.values(), ...s.runs.values()].map(r => toRun(r, now))
  for (let n = 1; n <= 6; n++) runs.push(pastRun(n, s.at))
  if (branch) runs = runs.filter(r => r.headBranch === branch)
  runs.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
  runs = runs.slice(0, count)
  if (!isGitlabMock(path)) return { provider: 'github', host: 'github.com', owner: OWNER, repo: REPO, runs }
  return { provider: 'gitlab', host: 'gitlab.com', owner: 'acme/backend', repo: baseName(path), runs: runs.map(r => glRun(path, r)) }
}

export function mockGhRun(path: string, id: number): GhRunDetail {
  const s = story(path)
  const run = s.runs.get(id) ?? s.ci.get(id)
  // An older release's finished run, as its tag reads it.
  const past = !run && id > 8000 && id <= 8012 ? githubTagRun(path, `v0.1.${29 - (id - 8000)}`) : null
  if (past) return isGitlabMock(path) ? glDetail(path, past)! : past
  if (!run) throw new Error(`GitHub has no workflow run ${id}, or the account gh is signed in with cannot see it.`)
  const now = Date.now()
  const detail = { run: toRun(run, now), jobs: runJobs(run, now) }
  return isGitlabMock(path) ? glDetail(path, detail)! : detail
}

export function mockGhRunAction(path: string, id: number, action: GhRunAction) {
  const s = story(path)
  const run = s.runs.get(id) ?? s.ci.get(id)
  if (!run) throw new Error(`GitHub has no workflow run ${id}, or the account gh is signed in with cannot see it.`)
  const now = Date.now()
  const state = toRun(run, now).state
  if (action === 'cancel') {
    if (state !== 'pending' && state !== 'queued') throw new Error('The run has already finished.')
    run.cancelledAt = now
    return
  }
  if (state === 'pending' || state === 'queued') throw new Error('GitHub can\'t re-run it yet: the run is still going, or it is too old to re-run.')
  // A new attempt: the jobs that need it run again from now, and this time nothing fails.
  const before = runJobs(run, now).map(j => j.state)
  const again = now - run.start + 2_000
  run.attempt++
  run.restartedAt = now
  run.cancelledAt = null
  run.jobs = run.jobs.map((j, i) => (action === 'rerun-failed' && before[i] === 'success')
    ? j
    : { ...j, fails: false, from: again + (j.from ? 3_000 : 0), to: again + (j.from ? 3_000 : 0) + (j.to - j.from) })
}
