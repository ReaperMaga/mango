import type { GhAsset, GhRelease, GhRun, GhRunJob, GhRunState } from '~/types/ipc'

/**
 * The Releases tool window's reading of GitHub: which workflow runs belong to which release, what a
 * run's jobs add up to, about how long a build takes, and a release's files sorted by platform.
 * Plain functions, so they run in Node tests (tests/releaseRuns.test.ts).
 */

export const isActive = (s: GhRunState) => s === 'pending' || s === 'queued'
export const isBad = (s: GhRunState) => s === 'failure' || s === 'cancelled'

/** Events that build a release: pushing its tag, publishing it, or starting the workflow by hand. */
const TAG_EVENTS = new Set(['push', 'release'])

/** A tag that names a version (`v1.2.3`, `1.2`, `app-v0.2.0-beta.1`). */
const VERSION_TAG = /\d+\.\d+/

const newestFirst = (a: GhRun, b: GhRun) => b.createdAt.localeCompare(a.createdAt)

/** The runs for a release's tag, newest first. */
export function runsForTag(runs: GhRun[], tag: string): GhRun[] {
  return runs.filter(r => r.headBranch === tag && TAG_EVENTS.has(r.event)).sort(newestFirst)
}

/** The workflows that build releases: the ones that ran for a release's tag. */
export function releaseWorkflows(releases: GhRelease[], runs: GhRun[]): Set<number> {
  const tags = new Set(releases.map(r => r.tag))
  return new Set(runs.filter(r => r.headBranch && tags.has(r.headBranch) && TAG_EVENTS.has(r.event)).map(r => r.workflowId))
}

/** A row of the window: a release (with its newest run), or a run that has no release (yet). */
export type ReleaseEntry =
  | { kind: 'release'; key: string; release: GhRelease; run: GhRun | null }
  /** `trial`: the release workflow started by hand; `tag`: a tag push whose release is not made yet. */
  | { kind: 'run'; key: string; run: GhRun; why: 'trial' | 'tag' }

export const releaseKey = (tag: string) => `tag:${tag}`
export const runKey = (id: number) => `run:${id}`

export interface SortedReleases {
  /** Builds that run, and drafts whose build failed, newest first. */
  inProgress: ReleaseEntry[]
  /** Every other release, in GitHub's order (newest first). */
  releases: ReleaseEntry[]
}

export function sortReleases(releases: GhRelease[], runs: GhRun[]): SortedReleases {
  const tags = new Set(releases.map(r => r.tag))
  const flows = releaseWorkflows(releases, runs)
  const inProgress: ReleaseEntry[] = []
  const rest: ReleaseEntry[] = []
  for (const release of releases) {
    const run = runsForTag(runs, release.tag)[0] ?? null
    const entry: ReleaseEntry = { kind: 'release', key: releaseKey(release.tag), release, run }
    const building = !!run && (isActive(run.state) || (release.draft && isBad(run.state)))
    ;(building ? inProgress : rest).push(entry)
  }
  for (const run of runs) {
    if (!isActive(run.state) || !flows.has(run.workflowId)) continue
    if (run.headBranch && tags.has(run.headBranch)) continue
    if (run.event === 'workflow_dispatch') inProgress.push({ kind: 'run', key: runKey(run.id), run, why: 'trial' })
    else if (run.event === 'push' && run.headBranch && VERSION_TAG.test(run.headBranch)) {
      inProgress.push({ kind: 'run', key: runKey(run.id), run, why: 'tag' })
    }
  }
  const started = (e: ReleaseEntry) => e.run?.createdAt ?? (e.kind === 'release' ? e.release.createdAt : '')
  inProgress.sort((a, b) => started(b).localeCompare(started(a)))
  return { inProgress, releases: rest }
}

/** The release GitHub calls Latest: the newest published one that is not a pre-release. */
export function latestRelease(releases: GhRelease[]): GhRelease | null {
  let best: GhRelease | null = null
  for (const r of releases) {
    if (r.draft || r.prerelease || !r.publishedAt) continue
    if (!best || r.publishedAt > best.publishedAt!) best = r
  }
  return best
}

/** What the tool stripe's button shows in its corner: a build running, or one that failed. */
export function stripeMark(sorted: SortedReleases): 'running' | 'failed' | null {
  const runs = sorted.inProgress.map(e => e.run).filter((r): r is GhRun => !!r)
  if (runs.some(r => isActive(r.state))) return 'running'
  if (runs.some(r => isBad(r.state))) return 'failed'
  return null
}

/* ---------- jobs ---------- */

const JOB_ORDER: GhRunState[] = ['failure', 'cancelled', 'pending', 'queued', 'success', 'neutral', 'skipped']

/** The jobs that need a look first: failed, then running, then waiting, then done. */
export function sortJobs(jobs: GhRunJob[]): GhRunJob[] {
  return [...jobs].sort((a, b) => JOB_ORDER.indexOf(a.state) - JOB_ORDER.indexOf(b.state))
}

export type Tone = 'running' | 'done' | 'error' | 'idle'

/** One line for a run's jobs: "4 of 6 done", "1 failed, 4 passed", "passed". */
export function jobSummary(jobs: GhRunJob[]): { tone: Tone; text: string } {
  const n = (...s: GhRunState[]) => jobs.filter(j => s.includes(j.state)).length
  const failed = n('failure')
  const cancelled = n('cancelled')
  const active = n('pending', 'queued')
  const passed = n('success')
  const finished = jobs.length - active
  if (!jobs.length) return { tone: 'idle', text: 'No jobs yet' }
  if (active) {
    return failed
      ? { tone: 'error', text: `${failed} failed, ${active} running` }
      : { tone: 'running', text: `${finished} of ${jobs.length} done` }
  }
  if (failed) return { tone: 'error', text: passed ? `${failed} failed, ${passed} passed` : `${failed} failed` }
  if (cancelled) return { tone: 'idle', text: 'Cancelled' }
  const skipped = n('skipped', 'neutral')
  return { tone: 'done', text: skipped ? `passed, ${skipped} skipped` : 'passed' }
}

/** The first job that failed, for saying what broke. */
export const firstFailure = (jobs: GhRunJob[]) => jobs.find(j => j.state === 'failure') ?? null

/** How long a finished run took, in ms. */
export function runDuration(run: GhRun): number | null {
  if (isActive(run.state)) return null
  const start = Date.parse(run.startedAt ?? run.createdAt)
  const end = Date.parse(run.updatedAt)
  return Number.isFinite(start) && Number.isFinite(end) && end >= start ? end - start : null
}

/** About how long a run of this workflow takes: the middle of its last three good runs. */
export function typicalDuration(runs: GhRun[], workflowId: number, except?: number): number | null {
  const took = runs
    .filter(r => r.workflowId === workflowId && r.id !== except && r.state === 'success')
    .sort(newestFirst)
    .slice(0, 3)
    .map(runDuration)
    .filter((d): d is number => d !== null)
    .sort((a, b) => a - b)
  return took.length ? took[Math.floor(took.length / 2)]! : null
}

/* ---------- assets ---------- */

export interface AssetRow {
  asset: GhAsset
  /** Its `.sig` file (the updater's signature), folded into the row. */
  signature: GhAsset | null
}

export interface AssetGroup {
  platform: string
  rows: AssetRow[]
}

const PLATFORMS = ['Windows', 'macOS', 'Linux', 'Updater', 'Other'] as const

export function platformOf(name: string): (typeof PLATFORMS)[number] {
  const n = name.toLowerCase()
  if (/\.(exe|msi|msix|appx|appxbundle|msixbundle)$/.test(n)) return 'Windows'
  if (/\.(dmg|pkg)$/.test(n) || /\.app\.(tar\.gz|zip)$/.test(n)) return 'macOS'
  if (/\.(appimage|deb|rpm|snap|flatpak|apk)$/.test(n)) return 'Linux'
  if (/^(latest|update|updates)[\w.-]*\.(json|ya?ml)$/.test(n)) return 'Updater'
  if (/(^|[-_.])(darwin|macos|mac|osx|apple)([-_.]|$)/.test(n)) return 'macOS'
  if (/(^|[-_.])(win|windows|win32|win64)([-_.]|$)/.test(n)) return 'Windows'
  if (/(^|[-_.])linux([-_.]|$)/.test(n)) return 'Linux'
  return 'Other'
}

/** A release's files by platform, each `.sig` folded into the file it signs. */
export function groupAssets(assets: GhAsset[]): { groups: AssetGroup[]; files: number; signatures: number } {
  const byName = new Map(assets.map(a => [a.name, a]))
  const folded = new Set<string>()
  for (const a of assets) if (a.name.endsWith('.sig') && byName.has(a.name.slice(0, -4))) folded.add(a.name)
  const groups = new Map<string, AssetRow[]>()
  for (const a of assets) {
    if (folded.has(a.name)) continue
    const p = platformOf(a.name)
    const rows = groups.get(p) ?? []
    rows.push({ asset: a, signature: byName.get(`${a.name}.sig`) ?? null })
    groups.set(p, rows)
  }
  const ordered = PLATFORMS.filter(p => groups.has(p)).map(p => ({
    platform: p,
    rows: groups.get(p)!.sort((x, y) => x.asset.name.localeCompare(y.asset.name)),
  }))
  return { groups: ordered, files: assets.length - folded.size, signatures: folded.size }
}

export const totalDownloads = (assets: GhAsset[]) => assets.reduce((sum, a) => sum + a.downloads, 0)

/* ---------- what a row or the open entry says it is ---------- */

export type EntryMark = 'running' | 'failed' | 'cancelled' | 'passed' | 'tag'

/** An entry's state in a word, its tone, and which mark it takes. */
export function entryState(e: ReleaseEntry): { tone: Tone | 'queued'; word: string; mark: EntryMark } {
  const run = e.run
  const unreleased = e.kind === 'run' || e.release.draft
  if (run && isActive(run.state)) return { tone: 'running', word: 'Building', mark: 'running' }
  if (run && unreleased && run.state === 'failure') return { tone: 'error', word: 'Build failed', mark: 'failed' }
  if (run && unreleased && run.state === 'cancelled') return { tone: 'idle', word: 'Build cancelled', mark: 'cancelled' }
  if (e.kind === 'run') return { tone: 'done', word: 'Built', mark: 'passed' }
  if (e.release.draft) return { tone: 'idle', word: 'Draft', mark: 'tag' }
  if (e.release.prerelease) return { tone: 'queued', word: 'Pre-release', mark: 'tag' }
  return { tone: 'done', word: 'Published', mark: 'tag' }
}

/** "6.3 KB", "10.5 MB", "1.2 GB". */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = bytes / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`
}
