import type { GhAsset, GhRelease, GhReleases, GhRun, GhRunAction, GhRunDetail, GhRunJob } from '~/types/ipc'
import { safeRef } from './git'
import { GITHUB_HOST, ghError, runState, validGhOwner, validGhRepo } from './github'

/**
 * The Releases screen: ports of `src-tauri/src/releases.rs` (`gh_releases`, `gh_tag_run`, `gh_run`,
 * `gh_run_action`). Pure functions: argv builders, parsers and the words for failures. gh runs
 * inside the environment (`sshBackend.ts`), from the agent's home; the repository comes from the
 * project's git remotes there (`projectRepo` in `github.ts`), kept to github.com. Which run belongs
 * to which release is the desktop's own `~/utils/releaseRuns.ts`, shared as is.
 *
 * Differences from the desktop, as for pull requests: the notes are GitHub's Markdown source
 * (`body`; `bodyHtml` stays empty), since the phone renders no HTML, and avatars are not read.
 * Only the fields shown leave gh (`--jq`): a list of releases with every asset's uploader is large.
 */

/** A release with its notes as Markdown (untrusted: `ChatMarkdown` shows it without HTML or web pictures). */
export type Release = GhRelease & { body: string }
export type Releases = Omit<GhReleases, 'releases'> & { releases: Release[] }

/** How many releases the screen lists at most ("Show older" asks for more, up to this). */
export const MAX_RELEASES = 100
/** Recent workflow runs read to find the ones building releases. */
export const RECENT_RUNS = 50

export const NO_GITHUB = 'This project has no GitHub remote, so it has no releases to show.'

export const RUN_ACTIONS: readonly GhRunAction[] = ['rerun-failed', 'rerun', 'cancel']

export interface GhRepo {
  owner: string
  repo: string
}

function repoPath(r: GhRepo): string {
  if (!validGhOwner(r.owner) || !validGhRepo(r.repo)) throw new Error(NO_GITHUB)
  return `repos/${r.owner}/${r.repo}`
}

/** A workflow run's id: a positive safe integer. */
export function checkRunId(id: number): number {
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('That is not a workflow run.')
  return id
}

/** A release tag as the desktop's `safe_ref` takes it, and short enough to be one. */
export function checkTag(tag: string): string {
  const t = safeRef(tag)
  if (t.length > 255 || /[\x00-\x1f\x7f]/.test(t)) throw new Error(`"${t}" is not a valid tag`)
  return t
}

/* ---------- what gh prints ---------- */

const ASSET = '{name, size, download_count, state, browser_download_url}'
export const RELEASES_JQ = `[.[] | {id, tag_name, name, draft, prerelease, html_url, author: {login: .author.login}, created_at, published_at, target_commitish, body, assets: [(.assets // [])[] | ${ASSET}]}]`
const RUN = '{id, workflow_id, name, display_title, event, head_branch, head_sha, status, conclusion, html_url, run_number, run_attempt, created_at, run_started_at, updated_at}'
export const RUNS_JQ = `{workflow_runs: [(.workflow_runs // [])[] | ${RUN}]}`
export const JOBS_JQ = '{jobs: [(.jobs // [])[] | {id, name, status, conclusion, html_url, started_at, completed_at}]}'
/** One run, on one line (`tojson`: gh prints a string as is), so the jobs can follow it. */
export const RUN_LINE_JQ = `${RUN} | tojson`
/** The newest run that builds a tag (its push, its release being published, or a start by hand), as its id. */
export const NEWEST_JQ = '[(.workflow_runs // [])[] | select(.event == "push" or .event == "release" or .event == "workflow_dispatch")] | sort_by(.created_at) | last | .id // empty'

/** `gh api` for the releases, newest first. */
export function releasesArgv(r: GhRepo, count: number): string[] {
  const n = Math.min(MAX_RELEASES, Math.max(1, Math.floor(count) || 1))
  return ['gh', 'api', '--hostname', GITHUB_HOST, `${repoPath(r)}/releases?per_page=${n}`, '--jq', RELEASES_JQ]
}

/** `gh api` for the repository's recent workflow runs. */
export function runsArgv(r: GhRepo): string[] {
  return ['gh', 'api', '--hostname', GITHUB_HOST, `${repoPath(r)}/actions/runs?per_page=${RECENT_RUNS}`, '--jq', RUNS_JQ]
}

/**
 * `sh` script: a run and its jobs in one round trip. `$1` = `repos/<owner>/<repo>`, `$2` = `tag` or
 * `id`, `$3` = the tag or the run id. For a tag it first finds the newest run for it (the desktop's
 * `tag_run`; GitHub filters by `branch`, which for a tag push is the tag), and prints nothing when
 * none ran. Then the run on one line, then its jobs. `$4`…`$6`: NEWEST_JQ, RUN_LINE_JQ, JOBS_JQ.
 */
export const RUN_READ = `if [ "$2" = tag ]; then
  id=$(gh api --hostname ${GITHUB_HOST} -X GET "$1/actions/runs" -F per_page=10 -f "branch=$3" --jq "$4") || exit $?
  [ -n "$id" ] || exit 0
else id=$3; fi
gh api --hostname ${GITHUB_HOST} "$1/actions/runs/$id" --jq "$5" || exit $?
exec gh api --hostname ${GITHUB_HOST} "$1/actions/runs/$id/jobs?per_page=100" --jq "$6"`

/** The argv of `RUN_READ`: the newest run for a release's tag, or a run by id. */
export function runReadArgv(r: GhRepo, what: { tag: string } | { id: number }): string[] {
  const [mode, value] = 'tag' in what ? ['tag', checkTag(what.tag)] : ['id', String(checkRunId(what.id))]
  return ['sh', '-c', RUN_READ, 'mango-run-read', repoPath(r), mode, value, NEWEST_JQ, RUN_LINE_JQ, JOBS_JQ]
}

/** `gh api -X POST` to re-run a run's failed jobs, the whole run, or cancel it. Throws for anything else. */
export function runActionArgv(r: GhRepo, id: number, action: string): string[] {
  const tail = action === 'rerun-failed' ? 'rerun-failed-jobs' : action === 'rerun' ? 'rerun' : action === 'cancel' ? 'cancel' : null
  if (!tail) throw new Error(`Unknown action on a workflow run: ${action}`)
  return ['gh', 'api', '--hostname', GITHUB_HOST, '-X', 'POST', `${repoPath(r)}/actions/runs/${checkRunId(id)}/${tail}`]
}

/* ---------- parsing (the desktop's *_from_json) ---------- */

const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const someStr = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)
const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0)
const https = (v: unknown): string | null => (typeof v === 'string' && v.startsWith('https://') ? v : null)
const obj = (v: unknown): any => (v && typeof v === 'object' ? v : {})

function assetFromJson(a: any): GhAsset | null {
  const url = https(obj(a).browser_download_url)
  if (!url) return null
  return { name: str(a.name), size: count(a.size), downloads: count(a.download_count), url, state: someStr(a.state) ?? 'uploaded' }
}

export function releaseFromJson(v: any): Release | null {
  v = obj(v)
  const tag = str(v.tag_name)
  const url = https(v.html_url)
  if (!tag || !url) return null
  const login = someStr(obj(v.author).login)
  return {
    id: count(v.id),
    tag,
    name: str(v.name).trim() || tag,
    draft: v.draft === true,
    prerelease: v.prerelease === true,
    url,
    author: login ? { login, avatarUrl: null } : null,
    createdAt: str(v.created_at),
    publishedAt: someStr(v.published_at),
    target: str(v.target_commitish),
    bodyHtml: '',
    body: str(v.body),
    assets: Array.isArray(v.assets) ? v.assets.map(assetFromJson).filter((a: GhAsset | null): a is GhAsset => !!a) : [],
  }
}

export function runFromJson(v: any): GhRun | null {
  v = obj(v)
  const id = count(v.id)
  const url = https(v.html_url)
  if (!id || !url) return null
  return {
    id,
    workflowId: count(v.workflow_id),
    workflow: str(v.name),
    title: str(v.display_title),
    event: str(v.event),
    headBranch: someStr(v.head_branch),
    headSha: str(v.head_sha),
    state: runState(someStr(v.status), someStr(v.conclusion)),
    url,
    number: count(v.run_number),
    attempt: count(v.run_attempt) || 1,
    createdAt: str(v.created_at),
    startedAt: someStr(v.run_started_at),
    updatedAt: str(v.updated_at),
  }
}

export function runsFromJson(v: any): GhRun[] {
  const list = obj(v).workflow_runs
  return Array.isArray(list) ? list.map(runFromJson).filter((r): r is GhRun => !!r) : []
}

export function jobsFromJson(v: any): GhRunJob[] {
  const list = obj(v).jobs
  if (!Array.isArray(list)) return []
  return list.flatMap((j: any): GhRunJob[] => {
    j = obj(j)
    const id = count(j.id)
    const url = https(j.html_url)
    if (!id || !url) return []
    return [{ id, name: str(j.name), state: runState(someStr(j.status), someStr(j.conclusion)), url, startedAt: someStr(j.started_at), completedAt: someStr(j.completed_at) }]
  })
}

const unexpected = (instance: string) => `The GitHub CLI in ${instance} answered with something unexpected.`

export function parseReleases(stdout: string, instance: string): Release[] {
  let v: unknown
  try { v = JSON.parse(stdout) } catch { throw new Error(unexpected(instance)) }
  if (!Array.isArray(v)) throw new Error(unexpected(instance))
  return v.map(releaseFromJson).filter((r): r is Release => !!r)
}

/** The runs gh printed, or none when it printed something else (a repository without Actions still lists its releases). */
export function parseRuns(stdout: string): GhRun[] {
  try { return runsFromJson(JSON.parse(stdout)) } catch { return [] }
}

/** What `RUN_READ` printed: nothing (no run for the tag), or the run's line, then its jobs. */
export function parseRunRead(stdout: string, instance: string): GhRunDetail | null {
  const s = stdout.trim()
  if (!s) return null
  const nl = s.indexOf('\n')
  const head = nl < 0 ? s : s.slice(0, nl)
  let run: GhRun | null = null
  let jobs: unknown = {}
  try {
    run = runFromJson(JSON.parse(head))
    jobs = nl < 0 ? {} : JSON.parse(s.slice(nl + 1))
  } catch { throw new Error(unexpected(instance)) }
  if (!run) throw new Error(unexpected(instance))
  return { run, jobs: jobsFromJson(jobs) }
}

/* ---------- failures (the desktop's not_found and run_action) ---------- */

/** A failed read, `what` naming what GitHub did not show ("repository acme/app", "workflow run 12"). */
export function readFailure(instance: string, what: string, code: number | null, stderr: string, stdout = ''): string {
  const said = ghError(instance, code, stderr, stdout)
  if (said.startsWith('The GitHub CLI (gh) is not installed') || said.includes('is not signed in')) return said
  if (stderr.includes('(HTTP 404)') || stderr.includes('Not Found')) {
    return `GitHub has no ${what}, or the account gh is signed in with in ${instance} cannot see it.`
  }
  return said
}

export function actionFailure(instance: string, id: number, action: GhRunAction, code: number | null, stderr: string, stdout = ''): string {
  const said = ghError(instance, code, stderr, stdout)
  if (said.startsWith('The GitHub CLI (gh) is not installed') || said.includes('is not signed in')) return said
  if (stderr.includes('(HTTP 403)') || stderr.includes('Resource not accessible')) {
    return 'GitHub refused: the account gh is signed in with may not run workflows in this repository.'
  }
  if (stderr.includes('(HTTP 409)')) {
    return action === 'cancel'
      ? 'The run has already finished.'
      : "GitHub can't re-run it yet: the run is still going, or it is too old to re-run."
  }
  return readFailure(instance, `workflow run ${id}`, code, stderr, stdout)
}
