import type { GhCheck, GhJob, GhJobStep, GhRunState } from '~/types/ipc'
import { safeRef } from './git'
import { STEP_LINES, epochSeconds, isSha, type GhDetail, type GhRef, type GhState } from './github'
import {
  GITLAB_COM, absoluteUrl, apiProject, fullPath, glabApi, glabError, glabGraphql, isGlabSetupError, isGitlabHostIn, isHost,
  isNamespace, isSegment, type Forge,
} from './gitlab'

/**
 * GitLab merge requests, issues and CI job logs, read with glab inside the environment: the port of
 * the desktop's `src-tauri/src/gitlab_items.rs`, in the same shapes as GitHub's (`github.ts`). A merge
 * request is a `kind: 'pr'`, `number` is its iid, `owner` the whole namespace.
 *
 * Differences from the desktop, as for GitHub on the phone: the description is GitLab's Markdown
 * (`description`) rather than its HTML (the phone renders no HTML), avatars are not shown, and a
 * merge request is opened with `glab mr create --fill` in the project folder inside the environment
 * (where glab is). glab is only ever asked about servers known as GitLab there (`isGitlabHostIn` with
 * the hosts its config names), so a token never goes to a server the user did not sign in to.
 */

export const BAD_REFERENCE = 'Paste a merge request or issue link (https://gitlab.com/group/project/-/merge_requests/12), or its reference (!12 for a merge request, #12 for an issue).'
export const NOT_A_JOB = 'That check is not a GitLab CI job, so Mango cannot show its log. Open it on GitLab instead.'
export const NO_PROJECT = 'Could not tell which GitLab project this project belongs to; paste the full link instead.'

export const unknownServer = (host: string, instance: string) =>
  `${host} is not a GitLab server the GitLab CLI in ${instance} is signed in to. Sign in to it from Mango on your computer (the environment's page > Sign in > GitLab CLI), then try again.`

/* ---------- references (the desktop's Kind, Target, route) ---------- */

/** What a reference asks for: a merge request, an issue, or a bare number (a merge request if there is one, else the issue). */
export type GlKind = 'mr' | 'issue' | 'either'

/** A merge request or issue on a GitLab server. */
export interface GlTarget {
  forge: Forge
  iid: number
  kind: GlKind
}

/** Where a reference sends the read: the GitHub code path, or a GitLab target. */
export type Route = { to: 'github' } | { to: 'gitlab'; target: GlTarget }

/** An iid GitLab's GraphQL and REST APIs take (32-bit). */
export function parseIid(s: string): number | null {
  if (!s || s.length > 10 || !/^\d+$/.test(s)) return null
  const n = Number(s)
  return n > 0 && n <= 2_147_483_647 ? n : null
}

const glForge = (host: string, owner: string, repo: string): Forge => ({ provider: 'gitlab', host, owner, repo })

/** `group/sub/project` split into a valid namespace and project. */
export function splitProject(path: string): [string, string] | null {
  const slash = path.lastIndexOf('/')
  if (slash < 0) return null
  const ns = path.slice(0, slash)
  const proj = path.slice(slash + 1)
  return isNamespace(ns) && isSegment(proj) ? [ns, proj] : null
}

const stripScheme = (s: string): string | null => (s.startsWith('https://') ? s.slice(8) : s.startsWith('http://') ? s.slice(7) : null)
const cleanHost = (h: string) => { const l = h.toLowerCase(); return l.startsWith('www.') ? l.slice(4) : l }

/**
 * A link to a merge request, issue or work item: `https://host/group/sub/proj/-/merge_requests/12`
 * (anything after the number), `/-/issues/12`, `/-/work_items/12`. The host as given (lower case,
 * without `www.`); the caller decides whether it is a GitLab server.
 */
export function parseItemUrl(input: string): { forge: Forge; iid: number; kind: 'mr' | 'issue' } | null {
  const rest0 = stripScheme(input.trim())
  if (rest0 === null) return null
  const rest = rest0.split(/[?#]/)[0] ?? ''
  const parts = rest.split('/')
  const dash = parts.indexOf('-')
  const host = cleanHost(parts[0] ?? '')
  if (dash < 3 || !isHost(host)) return null
  const proj = splitProject(parts.slice(1, dash).join('/'))
  if (!proj) return null
  const what = parts[dash + 1]
  const kind = what === 'merge_requests' ? 'mr' : what === 'issues' || what === 'work_items' ? 'issue' : null
  if (!kind) return null
  const iid = parseIid(parts[dash + 2] ?? '')
  if (iid === null) return null
  return { forge: glForge(host, proj[0], proj[1]), iid, kind }
}

const gitlabShaped = (s: string) => ['/-/merge_requests/', '/-/issues/', '/-/work_items/'].some(p => s.includes(p))

/**
 * Who answers `reference` and, for GitLab, exactly what it names (the desktop's `route`). `known`:
 * the hosts the environment's glab is configured for; `project`: the project's forge (null when it
 * has none or it could not be read). Throws a message for a malformed reference or an unknown server.
 *
 * - A link on a GitLab server, or shaped like one: GitLab, refused on a server glab does not know.
 * - `group/sub/proj!12`, `group/sub/proj#12` (a subgroup), `!12`: GitLab.
 * - `owner/repo#12`, `#12` and `12`: GitLab when the project is on GitLab, else GitHub.
 */
export function route(reference: string, known: readonly string[], project: Forge | null, instance: string): Route {
  const s = reference.trim()
  const isGitlab = (h: string) => isGitlabHostIn(h, known)
  if (s.startsWith('https://') || s.startsWith('http://')) {
    const host = cleanHost(s.split('://')[1]?.split(/[/?#]/)[0] ?? '')
    if (!gitlabShaped(s) && !isGitlab(host)) return { to: 'github' }
    const p = parseItemUrl(s)
    if (!p) throw new Error(BAD_REFERENCE)
    if (!isGitlab(p.forge.host)) throw new Error(unknownServer(p.forge.host, instance))
    return { to: 'gitlab', target: p }
  }
  const gl = project?.provider === 'gitlab' ? project : null
  const bang = s.indexOf('!')
  if (bang >= 0) {
    const iid = parseIid(s.slice(bang + 1))
    if (iid === null) throw new Error(BAD_REFERENCE)
    const path = s.slice(0, bang)
    if (!path) {
      if (!gl) throw new Error(NO_PROJECT)
      return { to: 'gitlab', target: { forge: gl, iid, kind: 'mr' } }
    }
    const proj = splitProject(path)
    if (!proj) throw new Error(BAD_REFERENCE)
    return { to: 'gitlab', target: { forge: glForge(gl?.host ?? GITLAB_COM, proj[0], proj[1]), iid, kind: 'mr' } }
  }
  const hash = s.indexOf('#')
  if (hash >= 0) {
    const path = s.slice(0, hash)
    // `group/sub/proj#12`: GitHub has no subgroups, so this is GitLab's.
    if ((path.match(/\//g)?.length ?? 0) >= 2) {
      const proj = splitProject(path)
      const iid = parseIid(s.slice(hash + 1))
      if (!proj || iid === null) throw new Error(BAD_REFERENCE)
      return { to: 'gitlab', target: { forge: glForge(gl?.host ?? GITLAB_COM, proj[0], proj[1]), iid, kind: 'issue' } }
    }
  }
  if (!gl) return { to: 'github' }
  const bare = parseIid(s)
  if (bare !== null) return { to: 'gitlab', target: { forge: gl, iid: bare, kind: 'either' } }
  if (hash < 0) throw new Error(BAD_REFERENCE)
  const iid = parseIid(s.slice(hash + 1))
  if (iid === null) throw new Error(BAD_REFERENCE)
  const path = s.slice(0, hash)
  if (!path) return { to: 'gitlab', target: { forge: gl, iid, kind: 'issue' } }
  const proj = splitProject(path)
  if (!proj) throw new Error(BAD_REFERENCE)
  return { to: 'gitlab', target: { forge: glForge(gl.host, proj[0], proj[1]), iid, kind: 'issue' } }
}

/** A linked item's reference as a target, every part checked (its host is checked where glab runs). */
export function glTargetOfRef(ref: GhRef): GlTarget {
  const host = ref.host.toLowerCase()
  if (!isHost(host) || !isNamespace(ref.owner) || !isSegment(ref.repo) || parseIid(String(ref.number)) === null) throw new Error(BAD_REFERENCE)
  return { forge: glForge(host, ref.owner, ref.repo), iid: ref.number, kind: ref.kind === 'pr' ? 'mr' : 'issue' }
}

/** Where a target opens: `…/-/merge_requests/12` or `…/-/issues/12`. */
export const targetUrl = (t: GlTarget, kind: 'mr' | 'issue' = t.kind === 'issue' ? 'issue' : 'mr') =>
  `https://${t.forge.host}/${fullPath(t.forge)}/-/${kind === 'mr' ? 'merge_requests' : 'issues'}/${t.iid}`

/* ---------- one item's state, for the list ---------- */

const STATE_QUERY = {
  mr: 'query($fullPath: ID!, $iid: String!) { project(fullPath: $fullPath) { mergeRequest(iid: $iid) { title state draft } } }',
  issue: 'query($fullPath: ID!, $iid: String!) { project(fullPath: $fullPath) { issue(iid: $iid) { title state } } }',
} as const

/** `glab api graphql` for a linked item's title and state only. */
export function glStateArgv(t: GlTarget): string[] {
  const kind = t.kind === 'issue' ? 'issue' : 'mr'
  return glabGraphql(t.forge.host, STATE_QUERY[kind], [['fullPath', fullPath(t.forge)], ['iid', String(t.iid)]])
}

/** What `glStateArgv` printed, or null when it is not the expected answer. */
export function parseGlState(stdout: string, t: GlTarget): GhState | null {
  let v: any
  try { v = JSON.parse(stdout.trim()) } catch { return null }
  const pr = t.kind !== 'issue'
  const node = obj(obj(obj(v).data).project)[pr ? 'mergeRequest' : 'issue']
  if (!node || typeof node !== 'object' || typeof node.title !== 'string') return null
  const s = upper(node.state)
  const state: GhState['state'] = s === 'MERGED' ? 'merged' : s === 'CLOSED' || s === 'LOCKED' ? 'closed' : pr && node.draft === true ? 'draft' : 'open'
  return { kind: pr ? 'pr' : 'issue', title: node.title, state, stateReason: !pr && state === 'closed' ? 'completed' : null }
}

/* ---------- one item in full (GraphQL; the desktop's query, item_from_json) ---------- */

const MR_FIELDS = `mergeRequest(iid: $iid) {
      iid title webUrl state draft description createdAt updatedAt
      author { username avatarUrl }
      labels(first: 20) { nodes { title color } }
      userNotesCount sourceBranch targetBranch diffHeadSha squashOnMerge conflicts
      diffStatsSummary { additions deletions fileCount }
      detailedMergeStatus
      userPermissions { canMerge }
      approvedBy { nodes { username } }
      headPipeline { status jobs(first: 100) { nodes { id name status webPath allowFailure stage { name } } } }
      EXTRA
    }`
/** Fields only GitLab's paid tiers' schema has; asked for first, dropped on a server whose schema lacks them. */
const MR_EE_FIELDS = 'approved approvalsLeft approvalsRequired'
const ISSUE_FIELDS = `issue(iid: $iid) {
      iid title webUrl state description createdAt updatedAt
      author { username avatarUrl }
      labels(first: 20) { nodes { title color } }
      userNotesCount
      EXTRA
    }`
const ISSUE_EXTRA_FIELDS = 'closedAsDuplicateOf { iid }'
const PROJECT_FIELDS = 'squashOption { option }'

/** The query for `kind`; `full` asks for the fields an older or free server may not have too. */
export function glQuery(kind: GlKind, full: boolean): string {
  const mr = () => MR_FIELDS.replace('EXTRA', full ? MR_EE_FIELDS : '')
  const issue = () => ISSUE_FIELDS.replace('EXTRA', full ? ISSUE_EXTRA_FIELDS : '')
  const body = kind === 'mr' ? mr() : kind === 'issue' ? issue() : `${mr()}\n    ${issue()}`
  const project = full && kind !== 'issue' ? PROJECT_FIELDS : ''
  return `query($fullPath: ID!, $iid: String!) {\n  project(fullPath: $fullPath) {\n    ${project}\n    ${body}\n  }\n}`
}

/** `glab api graphql` reading one item in full. */
export function glDetailArgv(t: GlTarget, full = true): string[] {
  return glabGraphql(t.forge.host, glQuery(t.kind, full), [['fullPath', fullPath(t.forge)], ['iid', String(t.iid)]])
}

/** A GraphQL error that means the server's schema lacks a field we asked for: worth asking again with less. */
export function schemaLacksField(v: unknown): boolean {
  const errors = obj(v).errors
  return Array.isArray(errors) && errors.some(e => { const m = str(obj(e).message); return m.includes("doesn't exist on type") || m.includes('does not exist on type') })
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const someStr = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)
const upper = (v: unknown): string => str(v).toUpperCase()
const obj = (v: unknown): any => (v && typeof v === 'object' ? v : {})
const count = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : null)
const iidOf = (v: unknown): number | null => (typeof v === 'string' ? parseIid(v) : count(v))

/** GitLab's label colour (`#rrggbb`, sometimes a name on old servers) as GitHub's hex without `#`. */
export function labelColor(v: unknown): string {
  const c = str(v).trim()
  const hex = c.startsWith('#') ? c.slice(1) : c
  if ((hex.length === 3 || hex.length === 6) && /^[0-9a-fA-F]+$/.test(hex)) {
    return (hex.length === 3 ? [...hex].map(ch => ch + ch).join('') : hex).toLowerCase()
  }
  return ''
}

/** A pipeline's or job's status (any case) as a check's state. */
export function checkState(status: string): GhCheck['state'] {
  switch (status.toLowerCase()) {
    case 'success': return 'success'
    case 'failed': return 'failure'
    case 'canceled': case 'canceling': return 'cancelled'
    case 'skipped': return 'skipped'
    case 'manual': return 'neutral'
    default: return 'pending'
  }
}

/** A job's status as a job's or step's state: like `checkState`, plus "queued" for one that has not started. */
export function glRunState(status: string): GhRunState {
  const s = status.toLowerCase()
  if (s === 'running') return 'pending'
  if (['created', 'pending', 'preparing', 'waiting_for_resource', 'scheduled', 'waiting_for_callback'].includes(s)) return 'queued'
  return checkState(s)
}

/** The numeric id of a GraphQL global id (`gid://gitlab/Ci::Build/123`). */
function gidNumber(v: unknown): number | null {
  const tail = str(v).split('/').pop() ?? ''
  if (!/^\d+$/.test(tail)) return null
  const n = Number(tail)
  return Number.isSafeInteger(n) && n > 0 ? n : null
}

function jobCheck(f: Forge, j: any): GhCheck | null {
  j = obj(j)
  if (typeof j.name !== 'string') return null
  const id = gidNumber(j.id)
  const url = (typeof j.webPath === 'string' ? absoluteUrl(f.host, j.webPath) : null)
    ?? (id ? `https://${f.host}/${fullPath(f)}/-/jobs/${id}` : null)
  return { name: j.name, workflow: someStr(obj(j.stage).name), state: checkState(str(j.status)), url, description: null, required: j.allowFailure !== true }
}

/** `detailedMergeStatus` as GitHub's (`mergeable`, `mergeStateStatus`) pair. */
export function mergeStatus(detailed: string, conflicts: boolean): [NonNullable<GhDetail['mergeable']>, NonNullable<GhDetail['mergeState']>] {
  let state: NonNullable<GhDetail['mergeState']>
  switch (detailed) {
    case 'MERGEABLE': state = 'clean'; break
    case 'CONFLICT': state = 'dirty'; break
    case 'NEED_REBASE': state = 'behind'; break
    case 'DRAFT_STATUS': state = 'draft'; break
    case 'CHECKING': case 'UNCHECKED': case 'PREPARING': case 'APPROVALS_SYNCING': case '': state = 'unknown'; break
    default: state = 'blocked'
  }
  if (conflicts) state = 'dirty'
  return [state === 'dirty' ? 'conflicting' : state === 'unknown' ? 'unknown' : 'mergeable', state]
}

function review(node: any, detailed: string): GhDetail['reviewDecision'] {
  const left = count(node.approvalsLeft) ?? 0
  const required = count(node.approvalsRequired) ?? 0
  const approvedBy = Array.isArray(obj(node.approvedBy).nodes) ? node.approvedBy.nodes.length : 0
  if (detailed === 'REQUESTED_CHANGES') return 'changes_requested'
  if (left > 0 || detailed === 'NOT_APPROVED') return 'review_required'
  if ((node.approved === true && required > 0) || approvedBy > 0) return 'approved'
  return null
}

/** GraphQL's answer (already parsed) as a `GhDetail` (the desktop's `item_from_json`). Throws a message. */
export function glDetailFromJson(v: any, t: GlTarget): GhDetail {
  v = obj(v)
  const project = obj(v.data).project
  const firstError = Array.isArray(v.errors) ? someStr(obj(v.errors[0]).message) : null
  const f = t.forge
  if (!project || typeof project !== 'object') {
    throw new Error(firstError ? `GitLab: ${firstError}` : `GitLab has no project ${fullPath(f)}, or the account glab is signed in with cannot see it.`)
  }
  const mr = project.mergeRequest
  const isPr = t.kind === 'mr' ? true : t.kind === 'issue' ? false : !!mr && typeof mr === 'object'
  const node = isPr ? mr : project.issue
  if (!node || typeof node !== 'object') {
    const what = t.kind === 'mr' ? `merge request !${t.iid}` : t.kind === 'issue' ? `issue #${t.iid}` : `merge request or issue ${t.iid}`
    throw new Error(firstError ? `GitLab: ${firstError}` : `There is no ${what} in ${fullPath(f)}.`)
  }
  const s = upper(node.state)
  const state: GhDetail['state'] = s === 'MERGED' ? 'merged' : s === 'CLOSED' || s === 'LOCKED' ? 'closed' : isPr && node.draft === true ? 'draft' : 'open'
  const number = iidOf(node.iid) ?? t.iid
  const url = (typeof node.webUrl === 'string' ? absoluteUrl(f.host, node.webUrl) : null)
    ?? `https://${f.host}/${fullPath(f)}/-/${isPr ? 'merge_requests' : 'issues'}/${number}`
  const login = someStr(obj(node.author).username)
  const labels = Array.isArray(obj(node.labels).nodes)
    ? (node.labels.nodes as unknown[]).flatMap(l => (typeof obj(l).title === 'string' ? [{ name: obj(l).title as string, color: labelColor(obj(l).color) }] : []))
    : []
  const common: GhDetail = {
    provider: 'gitlab',
    kind: isPr ? 'pr' : 'issue',
    url,
    host: f.host,
    owner: f.owner,
    repo: f.repo,
    number,
    title: str(node.title),
    state,
    stateReason: !isPr && state === 'closed' ? (node.closedAsDuplicateOf && typeof node.closedAsDuplicateOf === 'object' ? 'duplicate' : 'completed') : null,
    // Avatars are not shown on the phone.
    author: login ? { login, avatarUrl: null } : null,
    createdAt: str(node.createdAt),
    updatedAt: str(node.updatedAt),
    body: str(node.description),
    labels,
    comments: count(node.userNotesCount) ?? 0,
    headRef: null,
    baseRef: null,
    additions: null,
    deletions: null,
    changedFiles: null,
    reviewDecision: null,
    checks: null,
    checkRuns: [],
    headSha: null,
    mergeable: null,
    mergeState: null,
    mergeMethods: [],
    defaultMergeMethod: null,
    canMerge: false,
  }
  if (!isPr) return common
  const pipeline = obj(node.headPipeline)
  let checks: GhDetail['checks'] = null
  if (typeof pipeline.status === 'string') {
    const c = checkState(pipeline.status)
    checks = c === 'success' ? 'success' : c === 'failure' || c === 'cancelled' ? 'failure' : c === 'pending' || c === 'neutral' ? 'pending' : null
  }
  const jobs = obj(pipeline.jobs).nodes
  const checkRuns = Array.isArray(jobs) ? jobs.flatMap(j => { const c = jobCheck(f, j); return c ? [c] : [] }) : []
  const detailed = upper(node.detailedMergeStatus)
  const [mergeable, mergeState] = mergeStatus(detailed, node.conflicts === true)
  const squash = upper(obj(project.squashOption).option)
  const mergeMethods: GhDetail['mergeMethods'] = squash === 'NEVER' ? ['merge'] : squash === 'ALWAYS' ? ['squash'] : ['merge', 'squash']
  const defaultSquash = squash === 'ALWAYS' || squash === 'DEFAULT_ON' || node.squashOnMerge === true
  const stats = obj(node.diffStatsSummary)
  return {
    ...common,
    headRef: someStr(node.sourceBranch),
    baseRef: someStr(node.targetBranch),
    additions: count(stats.additions),
    deletions: count(stats.deletions),
    changedFiles: count(stats.fileCount),
    reviewDecision: review(node, detailed),
    checks,
    checkRuns,
    headSha: someStr(node.diffHeadSha),
    mergeable,
    mergeState,
    mergeMethods,
    defaultMergeMethod: defaultSquash && mergeMethods.includes('squash') ? 'squash' : mergeMethods[0]!,
    canMerge: (state === 'open' || state === 'draft') && obj(node.userPermissions).canMerge === true,
  }
}

/**
 * `glDetailArgv`'s output: the parsed answer even when GraphQL reported errors (glab then exits
 * non-zero but still prints the body). Throws a message when there is no answer.
 */
export function glGraphqlAnswer(instance: string, host: string, code: number | null, stdout: string, stderr: string): unknown {
  try {
    const v = JSON.parse(stdout)
    if (code === 0 || obj(v).errors !== undefined || obj(v).data !== undefined) return v
  } catch { /* not JSON */ }
  if (code !== 0) throw new Error(glabError(instance, host, code, stderr, stdout))
  throw new Error(`The GitLab CLI in ${instance} answered with something unexpected.`)
}

/* ---------- merging (the desktop's merge, merge_error) ---------- */

/** `glab api --method PUT …/merge_requests/N/merge`, only while the branch still points at `headSha`. Throws for bad input. */
export function glMergeArgv(t: GlTarget, method: string, headSha: string): string[] {
  if (method === 'rebase') throw new Error('GitLab merges with a merge commit or squashes; rebasing is set per project on GitLab.')
  if (method !== 'merge' && method !== 'squash') throw new Error(`"${method}" is not a merge method.`)
  if (!isSha(headSha)) throw new Error('Read the merge request again before merging it.')
  if (t.kind === 'issue') throw new Error('Only merge requests can be merged; that is an issue.')
  const argv = [...glabApi(t.forge.host, `${apiProject(t.forge)}/merge_requests/${t.iid}/merge`), '--method', 'PUT', '-f', `sha=${headSha}`]
  return method === 'squash' ? [...argv, '-f', 'squash=true'] : argv
}

/** The HTTP status glab reported (`(HTTP 405)`, or a `405 Method Not Allowed` style message). */
export function httpStatus(stderr: string): number | null {
  const m = /\(HTTP (\d+)/.exec(stderr)
  if (m) return Number(m[1])
  return [401, 403, 404, 405, 406, 409, 422].find(c => stderr.includes(`${c} `) || stderr.includes(`HTTP ${c}`)) ?? null
}

/** GitLab's own words in a JSON error body (`{"message": "…"}`, sometimes a list or an object). */
export function gitlabSaid(stdout: string): string | null {
  let v: any
  try { v = JSON.parse(stdout) } catch { return null }
  const m = obj(v).message
  if (someStr(m)) return m
  if (Array.isArray(m)) { const parts = m.filter((x): x is string => typeof x === 'string'); return parts.length ? parts.join(' ') : null }
  if (m && typeof m === 'object') {
    const parts = Object.entries(m).flatMap(([k, list]) => (Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string').map(x => `${k} ${x}`) : []))
    return parts.length ? parts.join('; ') : null
  }
  return someStr(obj(v).error)
}

/** A refused merge as something a person can act on. */
export function glMergeFailure(instance: string, t: GlTarget, code: number | null, stdout: string, stderr: string): string {
  const said = gitlabSaid(stdout)
  const detail = said ? ` GitLab says: ${said}` : ''
  switch (httpStatus(stderr)) {
    case 409: return 'The branch got new commits since this was read. Look at them, then merge again.'
    case 406: return `GitLab cannot merge it: the branch has conflicts or must be rebased first.${detail}`
    case 405: return `GitLab will not merge it yet: it may be a draft, closed, blocked by its pipeline, approvals or open threads.${detail}`
    case 422: return `GitLab refused the merge.${detail}`
    case 403: return `The account glab is signed in with may not merge in ${fullPath(t.forge)}.${detail}`
    default: return glabError(instance, t.forge.host, code, stderr, stdout)
  }
}

/* ---------- opening a merge request (the desktop's mr_create for a remote project, created_target) ---------- */

/**
 * `sh` script, run in the project folder: what a merge request needs from git (the desktop's
 * `pr_details` for a remote project). `$1` = the target branch, or empty for the project's default
 * (`origin/HEAD`, else the project's `default_branch` read with `glab api --hostname $2 $3`).
 * Prints `MANGO-BRANCH:<branch>`, `MANGO-BASE:<base>`, then the branch's commits since the base,
 * oldest first (`subject \x1f body \x1e`). `MANGO-ERR:detached` on stderr when HEAD is on no branch.
 */
export const MR_DETAILS = `b=$(GIT_OPTIONAL_LOCKS=0 git symbolic-ref -q --short HEAD)
c=$?
if [ $c -eq 1 ] || { [ $c -eq 0 ] && [ -z "$b" ]; }; then echo "MANGO-ERR:detached" >&2; exit 3; fi
[ $c -eq 0 ] || exit $c
base=$1
if [ -z "$base" ]; then d=$(GIT_OPTIONAL_LOCKS=0 git symbolic-ref -q --short refs/remotes/origin/HEAD) && base=\${d#origin/}; fi
if [ -z "$base" ]; then base=$(glab api --hostname "$2" "$3" 2>/dev/null | grep -o '"default_branch": *"[^"]*"' | head -n 1 | sed 's/.*"\\([^"]*\\)"$/\\1/'); fi
printf 'MANGO-BRANCH:%s\\nMANGO-BASE:%s\\n' "$b" "$base"
[ -n "$base" ] || exit 0
r=$base
GIT_OPTIONAL_LOCKS=0 git rev-parse -q --verify "$r^{commit}" >/dev/null 2>&1 || r=origin/$base
exec env GIT_OPTIONAL_LOCKS=0 git log --no-merges --no-color --reverse '--format=%s%x1f%b%x1e' "$r..HEAD" --`

/** The argv running `MR_DETAILS` for the project `f`. `base` null: the default branch. Throws for an unsafe base. */
export function glMrDetailsArgv(f: Forge, base: string | null): string[] {
  return ['sh', '-c', MR_DETAILS, 'mango-mr', base === null ? '' : safeRef(base), f.host, apiProject(f)]
}

/** A merge request's title and body from the branch's commits (the desktop's `pr_text`); null without commits. */
export function prText(branch: string, log: string): [string, string] | null {
  const commits = log.split('\x1e')
    .map(c => c.replace(/^[\n\r]+/, ''))
    .filter(c => c.trim())
    .map((c): [string, string] => { const i = c.indexOf('\x1f'); return i < 0 ? [c.trim(), ''] : [c.slice(0, i).trim(), c.slice(i + 1).trim()] })
  if (!commits.length) return null
  if (commits.length === 1) return commits[0]!
  const words = (branch.split('/').pop() ?? branch).replace(/[-_]/g, ' ').trim()
  const title = words ? words.charAt(0).toUpperCase() + words.slice(1) : branch
  return [title, commits.map(([s]) => `- ${s}`).join('\n')]
}

/** What `MR_DETAILS` printed: the branch, the target branch, and the title and body. Throws a message. */
export function parseMrDetails(stdout: string, base: string | null): { branch: string; base: string; title: string; body: string } {
  const lines = stdout.split('\n')
  const branch = lines[0]?.startsWith('MANGO-BRANCH:') ? lines[0].slice(13).trim() : ''
  const into = lines[1]?.startsWith('MANGO-BASE:') ? lines[1].slice(11).trim() : ''
  if (!branch) throw new Error('HEAD is detached, so there is no branch to open a merge request from. Switch to a branch first.')
  if (!into) throw new Error('Could not tell the project\'s default branch. Pick the branch to merge into, then try again.')
  const target = safeRef(into)
  const text = prText(branch, lines.slice(2).join('\n'))
  if (!text) throw new Error(`${branch} has no commits that ${base ?? target} doesn't have, so there is nothing to open a merge request for.`)
  return { branch: safeRef(branch), base: target, title: text[0], body: text[1] }
}

/** `glab api --method POST …/merge_requests` with the branches, title and description (`-f`: plain strings). */
export function glMrPostArgv(f: Forge, d: { branch: string; base: string; title: string; body: string }): string[] {
  return [
    ...glabApi(f.host, `${apiProject(f)}/merge_requests`), '--method', 'POST',
    '-f', `source_branch=${d.branch}`, '-f', `target_branch=${d.base}`, '-f', `title=${d.title}`, '-f', `description=${d.body}`,
  ]
}

/** The iid of the merge request the POST made, from its answer. */
export function postedIid(stdout: string): number | null {
  try { return iidOf(obj(JSON.parse(stdout)).iid) } catch { return null }
}

/**
 * The merge request `glab mr create` named: a link to it on a known server, or `!12` in an "already
 * exists" message (then in `f`). The desktop's `created_target`.
 */
export function createdMr(text: string, f: Forge, known: readonly string[]): GlTarget | null {
  for (const w of text.split(/[\s"'<>(),]+/)) {
    if (!(w.startsWith('https://') || w.startsWith('http://')) || !w.includes('/-/merge_requests/')) continue
    const p = parseItemUrl(w)
    if (p && p.kind === 'mr' && isGitlabHostIn(p.forge.host, known)) return { forge: p.forge, iid: p.iid, kind: 'mr' }
  }
  if (!text.toLowerCase().includes('already exists')) return null
  for (const m of text.matchAll(/!(\d*)/g)) {
    const iid = parseIid(m[1] ?? '')
    if (iid !== null) return { forge: f, iid, kind: 'mr' }
  }
  return null
}

/** Why reading the branch's commits (`MR_DETAILS`) failed, in words. */
export function mrDetailsFailure(instance: string, code: number | null, stderr: string): string {
  if (stderr.includes('MANGO-ERR:detached')) {
    return 'HEAD is detached, so there is no branch to open a merge request from. Switch to a branch first.'
  }
  const lower = stderr.toLowerCase()
  if (lower.includes('not a git repository')) return `The project folder in ${instance} is not a git repository.`
  if (lower.includes('unknown revision') || lower.includes('bad revision')) {
    return 'The branch to merge into is not in this checkout. Fetch it first, then open the merge request.'
  }
  const detail = stderr.trim().split('\n').slice(-3).join('\n')
  return detail ? `git failed: ${detail}` : `git failed (exit code ${code ?? '?'}).`
}

/** Why the POST was refused, in words (an existing merge request for the branch is no failure: `createdMr` finds it). */
export function mrPostFailure(instance: string, host: string, branch: string, code: number | null, stderr: string, stdout = ''): string {
  const said = gitlabSaid(stdout)
  const lower = `${stderr}\n${stdout}`.toLowerCase()
  if (lower.includes('source_branch') || (lower.includes('source branch') && (lower.includes('not exist') || lower.includes('not found')))) {
    return `${branch} is not on GitLab yet. Push it first, then open the merge request.`
  }
  if (httpStatus(stderr) === 403) return `The account glab is signed in with may not open merge requests there.${said ? ` GitLab says: ${said}` : ''}`
  if (httpStatus(stderr) === 422 || httpStatus(stderr) === 400) return `GitLab refused the merge request.${said ? ` GitLab says: ${said}` : ''}`
  return glabError(instance, host, code, stderr, stdout)
}


/* ---------- a CI job and its log (the desktop's parse_job_url, job_from_json, split_trace) ---------- */

/** `https://host/group/sub/proj/-/jobs/123` (anything after the id). The host as given; the caller checks it. */
export function parseGlJobUrl(url: string): { forge: Forge; job: number } {
  const rest0 = stripScheme(url.trim())
  if (rest0 === null) throw new Error(NOT_A_JOB)
  const parts = (rest0.split(/[?#]/)[0] ?? '').split('/')
  const dash = parts.indexOf('-')
  const host = cleanHost(parts[0] ?? '')
  if (dash < 3 || !isHost(host) || parts[dash + 1] !== 'jobs') throw new Error(NOT_A_JOB)
  const id = parts[dash + 2] ?? ''
  const n = id && id.length <= 20 && /^\d+$/.test(id) ? Number(id) : 0
  const proj = splitProject(parts.slice(1, dash).join('/'))
  if (!Number.isSafeInteger(n) || n <= 0 || !proj) throw new Error(NOT_A_JOB)
  return { forge: glForge(host, proj[0], proj[1]), job: n }
}

/** A link the GitLab job reader takes: a `/-/jobs/<id>` link. */
export const isGlJobUrl = (url: string): boolean => url.includes('/-/jobs/')

/** `glab api` for the job, and for its whole log (the trace). */
export function glJobArgvs(t: { forge: Forge; job: number }): [string[], string[]] {
  const endpoint = `${apiProject(t.forge)}/jobs/${t.job}`
  return [glabApi(t.forge.host, endpoint), glabApi(t.forge.host, `${endpoint}/trace`)]
}

/** `GET projects/:id/jobs/:id` as a `GhJob` without its log. */
export function glJobFromJson(v: any, url: string): GhJob {
  v = obj(v)
  const web = str(v.web_url)
  return {
    provider: 'gitlab',
    id: count(v.id) ?? 0,
    name: str(v.name),
    workflow: someStr(v.stage),
    url: web.startsWith('https://') || web.startsWith('http://') ? web : url.trim(),
    state: glRunState(str(v.status)),
    startedAt: someStr(v.started_at),
    completedAt: someStr(v.finished_at),
    steps: [],
    logReady: false,
    logError: null,
    logTruncated: false,
  }
}

/** Seconds since the epoch as an ISO 8601 UTC timestamp (`2026-11-16T20:29:33Z`). */
export const isoFromEpoch = (secs: number): string => new Date(secs * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')

type Piece = { t: 'text'; text: string } | { t: 'start' | 'end'; at: number; name: string }

const ERASE = '\x1b[0K'
const isSectionName = (s: string) => s.length > 0 && s.length <= 200 && /^[A-Za-z0-9_.-]+$/.test(s)

/** A marker at the start of `s` (`section_start:<epoch>:<name>[options]` / `section_end:<epoch>:<name>`, then `\r\x1b[0K`), and the rest. */
function marker(s: string): [Piece, string] | null {
  let start: boolean
  let rest: string
  if (s.startsWith('section_start:')) { start = true; rest = s.slice(14) } else if (s.startsWith('section_end:')) { start = false; rest = s.slice(12) } else return null
  const colon = rest.indexOf(':')
  if (colon < 0) return null
  const epoch = rest.slice(0, colon)
  rest = rest.slice(colon + 1)
  if (!epoch || epoch.length > 12 || !/^\d+$/.test(epoch)) return null
  const at = Number(epoch)
  const endAt = rest.search(/[\r\x1b]/)
  const end = endAt < 0 ? rest.length : endAt
  const head = rest.slice(0, end)
  rest = rest.slice(end)
  const name = start ? head.split('[')[0]! : head
  if (!isSectionName(name) || (!start && name !== head)) return null
  if (rest.startsWith('\r')) rest = rest.slice(1)
  if (rest.startsWith(ERASE)) rest = rest.slice(ERASE.length)
  return [{ t: start ? 'start' : 'end', at, name }, rest]
}

/** A trace line in pieces: the text around each section marker, and the markers. */
function pieces(lineText: string): Piece[] {
  const out: Piece[] = []
  let rest = lineText
  for (;;) {
    const next = ['section_start:', 'section_end:']
      .map(m => rest.indexOf(m))
      .filter(i => i >= 0 && marker(rest.slice(i)) !== null)
    if (!next.length) {
      if (rest) out.push({ t: 'text', text: rest })
      return out
    }
    const i = Math.min(...next)
    if (i > 0) out.push({ t: 'text', text: rest.slice(0, i) })
    const [piece, after] = marker(rest.slice(i))!
    out.push(piece)
    rest = after
  }
}

/** What a line shows: a carriage return starts the line over, and the erase-line codes are noise. Colour codes stay. */
function visible(text: string): string {
  const t = text.endsWith('\r') ? text.slice(0, -1) : text
  const clean = (s: string) => s.split(ERASE).join('').split('\x1b[K').join('')
  return t.split('\r').reverse().map(clean).find(s => s !== '') ?? ''
}

/** Plain text, ANSI codes and control characters removed (a section's title). */
function plain(text: string): string {
  let out = ''
  const chars = [...text]
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i]!
    if (c === '\x1b') {
      // A CSI sequence runs to its final byte; a lone escape is dropped.
      if (chars[i + 1] === '[') {
        i += 2
        while (i < chars.length && !(chars[i]! >= '@' && chars[i]! <= '~')) i++
      }
      continue
    }
    const code = c.codePointAt(0)!
    if (!(code <= 0x1f || (code >= 0x7f && code <= 0x9f))) out += c
  }
  return out.trim()
}

/**
 * The runner's timestamp prefix (job log timestamps, on by default since Runner 18.7):
 * `<RFC 3339 UTC>Z <stream: 2 hex><O|E><'+' continues the previous line | ' '>`, then the text
 * directly. The text and whether it continues the previous line; null without a prefix.
 */
function stripTimestamp(l: string): [string, boolean] | null {
  const sp = l.indexOf(' ')
  if (sp < 0) return null
  const stamp = l.slice(0, sp)
  if (!stamp.endsWith('Z') || epochSeconds(stamp) === null) return null
  const rest = l.slice(sp + 1)
  if (rest.length < 3 || !/^[0-9a-fA-F]{2}[OE]/.test(rest)) return null
  if (rest.length === 3) return ['', false]
  if (rest[3] === '+') return [rest.slice(4), true]
  if (rest[3] === ' ') return [rest.slice(4), false]
  return null
}

interface Draft { name: string; section: string | null; start: number | null; end: number | null; closed: boolean; lines: string[] }

/**
 * A job's log as steps (the desktop's `split_trace`): each top-level section is a step (titled from
 * its header line, timed by its markers), a nested section a `##[group]` … `##[endgroup]` fold in
 * it, lines outside every section steps of their own ("Runner" before, "Result" after).
 */
export function splitTrace(trace: string, jobState: GhRunState): GhJobStep[] {
  const lines: string[] = []
  const all = trace.charCodeAt(0) === 0xfeff ? trace.slice(1) : trace
  // As GitLab reads it: the log is timestamped when its first line is.
  const stamped = stripTimestamp(all.split('\n')[0] ?? '') !== null
  for (const raw of all.split('\n')) {
    const [text, more] = (stamped ? stripTimestamp(raw) : null) ?? [raw, false]
    if (more && lines.length) lines[lines.length - 1] += text
    else lines.push(text)
  }
  if (lines.length && lines[lines.length - 1] === '') lines.pop()

  const drafts: Draft[] = []
  const open: string[] = []
  const outside = () => {
    if (!(drafts.length && drafts[drafts.length - 1]!.section === null)) {
      drafts.push({ name: drafts.length ? 'Result' : 'Runner', section: null, start: null, end: null, closed: true, lines: [] })
    }
  }
  for (const l of lines) {
    const parts = pieces(l)
    // A blank line is still a line.
    if (!parts.length) parts.push({ t: 'text', text: '' })
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i]!
      if (p.t === 'text') {
        const shown = visible(p.text)
        if (shown !== '' || parts.length === 1) {
          if (!open.length) outside()
          drafts[drafts.length - 1]!.lines.push(shown)
        }
      } else if (p.t === 'start') {
        let header = ''
        const nx = parts[i + 1]
        if (nx && nx.t === 'text') { i++; header = visible(nx.text) }
        if (!open.length) {
          const title = plain(header)
          drafts.push({ name: title || p.name, section: p.name, start: p.at, end: null, closed: false, lines: [] })
        } else {
          drafts[drafts.length - 1]!.lines.push(`##[group]${plain(header) ? header : p.name}`)
        }
        open.push(p.name)
      } else {
        const depth = open.lastIndexOf(p.name)
        if (depth >= 0) {
          const step = drafts[drafts.length - 1]!
          for (let k = Math.max(depth, 1); k < open.length; k++) step.lines.push('##[endgroup]')
          if (depth === 0) { step.end = p.at; step.closed = true }
          open.length = depth
        }
      }
    }
  }

  const failed = jobState === 'failure' || jobState === 'cancelled'
  let culprit: number | null = null
  if (failed) {
    const lastOpen = drafts.map(d => !d.closed).lastIndexOf(true)
    const script = drafts.map(d => d.section === 'step_script' || d.section === 'build_script' || d.section === 'script').lastIndexOf(true)
    culprit = lastOpen >= 0 ? lastOpen : script >= 0 ? script : drafts.length ? drafts.length - 1 : null
  }
  const last = Math.max(0, drafts.length - 1)
  return drafts.map((d, i): GhJobStep => {
    let state: GhRunState
    if (i === culprit) state = jobState
    else if (!d.closed) state = jobState === 'pending' ? 'pending' : 'success'
    else if (d.section === null && i === last && i > 0) state = jobState === 'pending' ? 'success' : jobState
    else state = 'success'
    const omitted = Math.max(0, d.lines.length - STEP_LINES)
    return {
      number: i + 1,
      name: d.name,
      state,
      startedAt: d.start === null ? null : isoFromEpoch(d.start),
      completedAt: d.end === null ? null : isoFromEpoch(d.end),
      lines: d.lines.slice(omitted),
      omitted,
    }
  })
}

/** Why reading a job failed. */
export function glJobFailure(instance: string, host: string, job: number, code: number | null, stderr: string, stdout = ''): string {
  const said = glabError(instance, host, code, stderr, stdout)
  if (!isGlabSetupError(said) && `${stderr}\n${stdout}`.includes('404')) {
    return `GitLab has no job ${job} there, or the account glab is signed in with in ${instance} cannot see it.`
  }
  return said
}
