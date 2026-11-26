import type { GhAsset, GhRun, GhRunAction, GhRunDetail, GhRunJob, GhRunState } from '~/types/ipc'
import { safeRef } from './git'
import { absoluteUrl, apiProject, encodePath, fullPath, glabApi, glabError, isGlabSetupError, isHost, isNamespace, isSegment, type Forge } from './gitlab'
import type { Release } from './releases'

/**
 * The Releases screen for a project on a GitLab server: the port of the desktop's
 * `src-tauri/src/gitlab_releases.rs` (its releases and the CI/CD pipelines that build them, in the
 * same shapes as GitHub's). glab runs inside the environment from the agent's home; argv builders,
 * parsers and failure words are pure and tested here.
 *
 * How GitLab maps onto the shapes (as on the desktop): a release's `id` is a stable hash of its tag,
 * no drafts or pre-releases, an upcoming release has no `publishedAt`, its files are its links (no
 * size or downloads). A run is a pipeline: `event` its `source`, `headBranch` its `ref`, `number`
 * its `iid`; every tag pipeline shares one `workflowId`, other pipelines one per source. As for
 * GitHub on the phone, a release's notes are its Markdown (`description`), not the HTML.
 */

/** How many releases the screen lists at most. */
export const MAX_RELEASES = 100
/** Recent pipelines read, and as many recent tag pipelines. */
export const RECENT_RUNS = 50

/** The project, checked: on a server name, a namespace and a project path that are well formed. */
export function checkedForge(f: Forge): Forge {
  if (f.provider !== 'gitlab' || !isHost(f.host) || !isNamespace(f.owner) || !isSegment(f.repo)) {
    throw new Error('This project has no GitLab remote, so it has no releases to show.')
  }
  return f
}

/** `glab api` on the project; `tail` is the path after `projects/<id>/`. */
const api = (f: Forge, tail: string) => glabApi(checkedForge(f).host, `${apiProject(f)}/${tail}`)

/**
 * A small, stable id for something GitLab names but does not number: FNV-1a of `key`, kept within
 * 53 bits so it survives as a JavaScript number, and never 0 (the desktop's `stable_id`).
 */
export function stableId(key: string): number {
  let h = 0xcbf29ce484222325n
  for (const b of new TextEncoder().encode(key)) {
    h ^= BigInt(b)
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn
  }
  const n = Number(h & ((1n << 53n) - 1n))
  return n === 0 ? 1 : n
}

/** The `workflowId` of a pipeline: tag pipelines (the ones that build releases) share one. */
export const workflowId = (tag: boolean, source: string): number => (tag ? stableId('tag') : stableId(`source:${source}`))

/**
 * A pipeline's or job's `status` in the words the screen uses. One waiting for someone to start a
 * manual job is not building: it shows as neutral (the desktop's `state`).
 */
export function glState(status: string): GhRunState {
  switch (status) {
    case 'success': return 'success'
    case 'failed': return 'failure'
    case 'canceled': case 'canceling': return 'cancelled'
    case 'skipped': return 'skipped'
    case 'manual': return 'neutral'
    case 'running': return 'pending'
    default: return 'queued'
  }
}

/* ---------- argv ---------- */

/** The releases, recent pipelines and recent tag pipelines: three reads, one round trip (`runAll`). */
export function releasesArgvs(f: Forge, count: number): [string[], string[], string[]] {
  const n = Math.min(MAX_RELEASES, Math.max(1, Math.floor(count) || 1))
  return [
    api(f, `releases?per_page=${n}`),
    api(f, `pipelines?per_page=${RECENT_RUNS}`),
    api(f, `pipelines?scope=tags&per_page=${RECENT_RUNS}`),
  ]
}

/** Where `RUN_READ` puts the jobs after the pipeline. */
export const JOBS_MARK = 'MANGO-JOBS'

/**
 * `sh` script: a pipeline and its jobs in one round trip. `$1` = host, `$2` = `projects/<id>`,
 * `$3` = `tag` or `id`, `$4` = the percent-encoded tag or the pipeline id. For a tag it first finds
 * the newest tag pipeline for it (the desktop's `tag_run`; the first `"id"` of GitLab's list is that
 * pipeline's) and prints nothing when none ran. Then the pipeline, a `MANGO-JOBS` line, its jobs.
 */
export const RUN_READ = `if [ "$3" = tag ]; then
  l=$(glab api --hostname "$1" "$2/pipelines?scope=tags&ref=$4&per_page=1") || exit $?
  id=$(printf '%s' "$l" | grep -o '"id": *[0-9][0-9]*' | head -n 1 | grep -o '[0-9][0-9]*$')
  [ -n "$id" ] || exit 0
else id=$4; fi
glab api --hostname "$1" "$2/pipelines/$id" || exit $?
printf '\\n%s\\n' ${JOBS_MARK}
exec glab api --hostname "$1" "$2/pipelines/$id/jobs?per_page=100&include_retried=false"`

/** A pipeline id: a positive safe integer. */
export function checkPipelineId(id: number): number {
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('That is not a pipeline.')
  return id
}

/** The argv of `RUN_READ`: the newest pipeline for a release's tag, or a pipeline by id. */
export function runReadArgv(f: Forge, what: { tag: string } | { id: number }): string[] {
  const c = checkedForge(f)
  const [mode, value] = 'tag' in what ? ['tag', encodePath(safeRef(what.tag))] : ['id', String(checkPipelineId(what.id))]
  return ['sh', '-c', RUN_READ, 'mango-pipeline', c.host, apiProject(c), mode, value]
}

/** `glab api` reading one pipeline (a re-run needs its ref first). */
export const pipelineArgv = (f: Forge, id: number): string[] => api(f, `pipelines/${checkPipelineId(id)}`)

/** A ref a new pipeline may run for: a branch or tag name, never a merge request's ref (the desktop's `pipeline_ref`). */
export function pipelineRef(r: string): string {
  const ref = safeRef(r)
  if (ref.startsWith('refs/')) {
    throw new Error('GitLab can only start a new pipeline for a branch or a tag, not for this one. Run it again from its merge request.')
  }
  return ref
}

/**
 * The POST for an action: `rerun-failed` retries the failed and canceled jobs in place, `cancel`
 * cancels the unfinished ones, `rerun` starts a new pipeline for `ref` (GitLab cannot run a whole
 * pipeline again in place). Throws for anything else.
 */
export function runActionArgv(f: Forge, id: number, action: string, ref: string | null = null): string[] {
  const n = checkPipelineId(id)
  let argv: string[]
  if (action === 'rerun-failed') argv = api(f, `pipelines/${n}/retry`)
  else if (action === 'cancel') argv = api(f, `pipelines/${n}/cancel`)
  else if (action === 'rerun') {
    if (ref === null) throw new Error('Read the pipeline again before running it again.')
    // `-f` sends the value as a plain string, never a file.
    argv = [...api(f, 'pipeline'), '-f', `ref=${pipelineRef(ref)}`]
  } else throw new Error(`Unknown action on a pipeline: ${action}`)
  return [...argv, '--method', 'POST']
}

/* ---------- parsing (the desktop's *_from_json) ---------- */

const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const someStr = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)
const posId = (v: unknown): number | null => (typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? v : null)
const obj = (v: unknown): any => (v && typeof v === 'object' ? v : {})
const link = (f: Forge, v: unknown): string | null => (typeof v === 'string' ? absoluteUrl(f.host, v) : null)

function assetFromJson(f: Forge, a: any): GhAsset | null {
  a = obj(a)
  const url = link(f, a.direct_asset_url) ?? link(f, a.url)
  if (!url) return null
  const name = someStr(a.name) ?? url.split('/').pop() ?? ''
  return { name, size: 0, downloads: 0, url, state: 'uploaded' }
}

export function releaseFromJson(f: Forge, v: any): Release | null {
  v = obj(v)
  const tag = str(v.tag_name)
  if (!tag) return null
  const url = link(f, obj(v._links).self) ?? `https://${f.host}/${fullPath(f)}/-/releases/${encodePath(tag)}`
  const name = (someStr(v.name) ?? '').trim() || tag
  const login = someStr(obj(v.author).username)
  const commit = obj(v.commit)
  const target = someStr(commit.short_id) ?? (someStr(commit.id)?.slice(0, 8) ?? '')
  const links = obj(v.assets).links
  return {
    id: stableId(`release:${tag}`),
    tag,
    name,
    draft: false,
    prerelease: false,
    url,
    // Avatars are not read on the phone (as for GitHub).
    author: login ? { login, avatarUrl: null } : null,
    createdAt: str(v.created_at),
    publishedAt: v.upcoming_release === true ? null : someStr(v.released_at),
    target,
    bodyHtml: '',
    body: str(v.description),
    assets: Array.isArray(links) ? links.map(l => assetFromJson(f, l)).filter((a): a is GhAsset => !!a) : [],
  }
}

/** The commit titles a release list names, by full sha, for titling pipelines (GitLab's pipeline list carries no commit). */
export function commitTitles(v: unknown): [string, string][] {
  if (!Array.isArray(v)) return []
  return v.flatMap((r): [string, string][] => {
    const c = obj(obj(r).commit)
    const sha = someStr(c.id)
    const title = someStr(c.title)
    return sha && title ? [[sha, title]] : []
  })
}

/** One pipeline, from a list or read alone; `tag`: it ran for a tag (a single pipeline says so itself). */
export function runFromJson(f: Forge, v: any, tag: boolean): GhRun | null {
  v = obj(v)
  const id = posId(v.id)
  const url = link(f, v.web_url)
  if (!id || !url) return null
  const isTag = tag || v.tag === true
  const source = str(v.source)
  return {
    id,
    workflowId: workflowId(isTag, source),
    workflow: (someStr(v.name) ?? '').trim() || 'Pipeline',
    title: '',
    event: source,
    headBranch: someStr(v.ref),
    headSha: str(v.sha),
    state: glState(str(v.status)),
    url,
    number: posId(v.iid) ?? 0,
    attempt: 1,
    createdAt: str(v.created_at),
    startedAt: someStr(v.started_at),
    updatedAt: someStr(v.finished_at) ?? str(v.updated_at),
  }
}

export function runsFromJson(f: Forge, v: unknown, tag: boolean): GhRun[] {
  return Array.isArray(v) ? v.map(p => runFromJson(f, p, tag)).filter((r): r is GhRun => !!r) : []
}

/** Recent pipelines and recent tag pipelines as one list, newest first, each once, titled from the releases' commits. */
export function mergeRuns(recent: GhRun[], tags: GhRun[], titles: readonly [string, string][]): GhRun[] {
  const runs = [...tags]
  for (const run of recent) if (!runs.some(r => r.id === run.id)) runs.push(run)
  for (const run of runs) {
    const t = titles.find(([sha]) => sha === run.headSha)
    if (t) run.title = t[1]
  }
  return runs.sort((a, b) => b.id - a.id)
}

/** A job that may fail without failing its pipeline counts as neutral when it does. */
export function jobFromJson(f: Forge, j: any): GhRunJob | null {
  j = obj(j)
  const status = str(j.status)
  const id = posId(j.id)
  const url = link(f, j.web_url)
  if (!id || !url) return null
  return {
    id,
    name: str(j.name),
    state: status === 'failed' && j.allow_failure === true ? 'neutral' : glState(status),
    url,
    startedAt: someStr(j.started_at),
    completedAt: someStr(j.finished_at),
  }
}

export function jobsFromJson(f: Forge, v: unknown): GhRunJob[] {
  return Array.isArray(v) ? v.map(j => jobFromJson(f, j)).filter((j): j is GhRunJob => !!j) : []
}

/** The commit title the jobs carry (each job names its pipeline's commit). */
export function titleFromJobs(v: unknown): string | null {
  if (!Array.isArray(v)) return null
  for (const j of v) {
    const t = someStr(obj(obj(j).commit).title)
    if (t) return t
  }
  return null
}

const unexpected = (instance: string) => `The GitLab CLI in ${instance} answered with something unexpected.`

/** The three reads of `releasesArgvs`: the releases must have come; the pipelines may not (no CI/CD, or not visible). */
export function parseGitlabReleases(f: Forge, list: string, recent: string | null, tags: string | null, instance: string): { releases: Release[]; runs: GhRun[] } {
  let v: unknown
  try { v = JSON.parse(list) } catch { throw new Error(unexpected(instance)) }
  if (!Array.isArray(v)) throw new Error(unexpected(instance))
  const releases = v.map(r => releaseFromJson(f, r)).filter((r): r is Release => !!r)
  const read = (s: string | null, tag: boolean) => { if (s === null) return []; try { return runsFromJson(f, JSON.parse(s), tag) } catch { return [] } }
  return { releases, runs: mergeRuns(read(recent, false), read(tags, true), commitTitles(v)) }
}

/** What `RUN_READ` printed: nothing (no pipeline for the tag), or the pipeline, then its jobs. `tag`: the tag asked for. */
export function parseRunRead(f: Forge, stdout: string, instance: string, tag: string | null = null): GhRunDetail | null {
  const s = stdout.trim()
  if (!s) return null
  const at = s.indexOf(`\n${JOBS_MARK}\n`)
  const head = at < 0 ? s : s.slice(0, at)
  const tail = at < 0 ? '' : s.slice(at + JOBS_MARK.length + 2)
  let one: unknown
  let jobs: unknown = []
  try {
    one = JSON.parse(head)
    if (tail.trim()) jobs = JSON.parse(tail)
  } catch { throw new Error(unexpected(instance)) }
  const run = runFromJson(f, one, tag !== null)
  if (!run) throw new Error(unexpected(instance))
  // The newest tag pipeline must be the tag's own.
  if (tag !== null && run.headBranch !== tag) return null
  const title = titleFromJobs(jobs)
  if (title) run.title = title
  return { run, jobs: jobsFromJson(f, jobs) }
}

/** The ref of a pipeline `pipelineArgv` read. */
export function parsePipelineRef(stdout: string, instance: string): string {
  let v: unknown
  try { v = JSON.parse(stdout) } catch { throw new Error(unexpected(instance)) }
  const ref = someStr(obj(v).ref)
  if (!ref) throw new Error(unexpected(instance))
  return ref
}

/* ---------- failures ---------- */

/** A failed read, `what` naming what GitLab did not show ("project acme/app", "pipeline 12"). */
export function readFailure(instance: string, host: string, what: string, code: number | null, stderr: string, stdout = ''): string {
  const said = glabError(instance, host, code, stderr, stdout)
  if (isGlabSetupError(said)) return said
  if (`${stderr}\n${stdout}`.toLowerCase().includes('404')) {
    return `GitLab has no ${what}, or the account glab is signed in with in ${instance} cannot see it.`
  }
  return said
}

/** A refused action in words (the desktop's `run_action` errors). */
export function actionFailure(instance: string, host: string, id: number, action: GhRunAction, code: number | null, stderr: string, stdout = ''): string {
  const said = glabError(instance, host, code, stderr, stdout)
  if (isGlabSetupError(said)) return said
  const lower = `${stderr}\n${stdout}`.toLowerCase()
  if (lower.includes('403') || lower.includes('forbidden')) {
    return 'GitLab refused: the account glab is signed in with may not run pipelines in this project.'
  }
  if (lower.includes('409')) return 'GitLab is already retrying this pipeline.'
  if (lower.includes('400') && action === 'rerun') return `GitLab could not start a new pipeline: ${said}`
  return readFailure(instance, host, `pipeline ${id}`, code, stderr, stdout)
}
