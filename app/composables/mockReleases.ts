import type { GhAsset, GhRelease, GhReleases, GhRun, GhRunAction, GhRunDetail, GhRunJob, GhRunState } from '~/types/ipc'
import { registerMockJob } from '~/composables/mockGithub'

/**
 * Releases for the browser preview (`pnpm dev`), told as a small story that plays out while you
 * watch: v0.1.29 is being built (draft, jobs finishing one by one, files appearing as each platform
 * uploads, published at the end), a trial build of the release workflow on main fails its Windows
 * job (re-run it), and older releases sit below. Job logs come from mockGithub's `gh_job`.
 */

const OWNER = 'mango-dev'
const REPO = 'mango'
const BASE = `https://github.com/${OWNER}/${REPO}`
const RELEASE_FLOW = 201
const MIN = 60_000

interface MockJob { name: string; from: number; to: number; fails: boolean; platform?: 'win' | 'mac-arm' | 'mac-x64' | 'linux' }
interface MockRun {
  id: number
  event: 'push' | 'workflow_dispatch'
  branch: string
  sha: string
  title: string
  start: number
  jobs: MockJob[]
  attempt: number
  cancelledAt: number | null
}

const stories = new Map<string, { at: number; runs: Map<number, MockRun> }>()

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
  s = { at, runs }
  stories.set(path, s)
  return s
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
    id: run.id, workflowId: RELEASE_FLOW, workflow: 'Release', title: run.title, event: run.event,
    headBranch: run.branch, headSha: run.sha, state, url: `${BASE}/actions/runs/${run.id}`,
    number: run.id - 8960, attempt: run.attempt, createdAt: iso(run.start), startedAt: iso(run.start),
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
  return { host: 'github.com', owner: OWNER, repo: REPO, releases: releases.slice(0, count), runs }
}

export function mockGhTagRun(path: string, tag: string): GhRunDetail | null {
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

export function mockGhRun(path: string, id: number): GhRunDetail {
  const s = story(path)
  const run = s.runs.get(id)
  if (!run) throw new Error(`GitHub has no workflow run ${id}, or the account gh is signed in with cannot see it.`)
  const now = Date.now()
  return { run: toRun(run, now), jobs: runJobs(run, now) }
}

export function mockGhRunAction(path: string, id: number, action: GhRunAction) {
  const s = story(path)
  const run = s.runs.get(id)
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
  run.cancelledAt = null
  run.jobs = run.jobs.map((j, i) => (action === 'rerun-failed' && before[i] === 'success')
    ? j
    : { ...j, fails: false, from: again + (j.from ? 3_000 : 0), to: again + (j.from ? 3_000 : 0) + (j.to - j.from) })
}
