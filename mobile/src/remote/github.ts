import type { LinkedItem } from '~/types/chat'
import type { GhItem, GhJob, GhJobStep, GhRunState } from '~/types/ipc'
import { safeRef, tidyOutput } from './git'

/**
 * Pull requests and issues linked to a chat, read with the GitHub CLI inside the environment.
 * The desktop runs `gh` on its own computer (`src-tauri/src/github.rs`); a phone has none, but the
 * environment usually does: that is where the agent ran `gh pr create`. Only the title and the
 * state are read (one `gh api` call), enough for the list; everything else opens on github.com.
 *
 * Links come from chat files (untrusted): owner, repository and number pass the validators here
 * and reach the shell only quoted (`line()` in `shell.ts`). Only github.com is read or opened.
 */

/** The only host the phone reads or opens. */
export const GITHUB_HOST = 'github.com'

/** A GitHub user or organisation: letters, digits and single hyphens, at most 39. */
export const validGhOwner = (s: string): boolean => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(s)

/** A repository name: letters, digits, `.`, `-`, `_`, at most 100, never `.` or `..`. */
export const validGhRepo = (s: string): boolean => /^[A-Za-z0-9._-]{1,100}$/.test(s) && s !== '.' && s !== '..'

const validNumber = (n: number): boolean => Number.isSafeInteger(n) && n > 0

/** A linked item's whereabouts; `provider` absent is GitHub (links saved before GitLab support). */
export type GhRef = Pick<LinkedItem, 'kind' | 'host' | 'owner' | 'repo' | 'number' | 'provider'>

/** The item is on github.com and every part of it is well formed. */
export function validGhRef(ref: GhRef): boolean {
  return ref.provider !== 'gitlab' && ref.host.toLowerCase() === GITHUB_HOST && validGhOwner(ref.owner) && validGhRepo(ref.repo) && validNumber(ref.number)
}

/**
 * Where the item opens in the browser, built from its validated parts (never the stored `url`,
 * which a chat file could point anywhere). Null for anything not on github.com.
 */
export function ghWebUrl(ref: GhRef): string | null {
  if (!validGhRef(ref)) return null
  return `https://${GITHUB_HOST}/${ref.owner}/${ref.repo}/${ref.kind === 'pr' ? 'pull' : 'issues'}/${ref.number}`
}

/**
 * One pull request or issue in full, as the pull request screen shows it: the desktop's `GhItem`
 * (`gh_item`, `src-tauri/src/github.rs`), except that the description is GitHub's Markdown source
 * (`body`) rather than its rendered HTML: the phone renders no HTML, and `ChatMarkdown` shows the
 * Markdown as text, links and code without fetching anything. Untrusted, like everything from GitHub.
 */
export type GhDetail = Omit<GhItem, 'bodyHtml'> & { body: string }

/** What the phone shows of an item in the list, read from GitHub. */
export interface GhState {
  kind: 'pr' | 'issue'
  title: string
  state: NonNullable<LinkedItem['state']>
  /** An issue closed as "completed", "not_planned" or "duplicate". */
  stateReason: string | null
}

/**
 * The issues endpoint answers for pull requests too (with `pull_request` set), so one call reads
 * either. Only the fields the list needs leave gh: a description can be large.
 */
const JQ = '{title, state, state_reason, draft, merged_at: .pull_request.merged_at, pr: (.pull_request != null)}'

/** Environment for gh: never wait on a prompt nobody sees, no colour, spinner or update notice in what it prints. */
export const GH_ENV: [string, string][] = [
  ['GH_PROMPT_DISABLED', '1'], ['GH_NO_UPDATE_NOTIFIER', '1'], ['GH_SPINNER_DISABLED', '1'], ['NO_COLOR', '1'], ['CLICOLOR', '0'],
]

/** The command that reads one item. Throws for a reference that is not a valid github.com item. */
export function ghItemArgv(ref: GhRef): string[] {
  if (!validGhRef(ref)) throw new Error('Only pull requests and issues on github.com can be read here.')
  return ['gh', 'api', '--hostname', GITHUB_HOST, `repos/${ref.owner}/${ref.repo}/issues/${ref.number}`, '--jq', JQ]
}

/** What `ghItemArgv` printed, or null when it is not the expected answer. */
export function parseGhItem(stdout: string): GhState | null {
  let v: any
  try { v = JSON.parse(stdout.trim()) } catch { return null }
  if (!v || typeof v !== 'object' || typeof v.title !== 'string') return null
  const pr = v.pr === true
  const open = v.state === 'open'
  if (!open && v.state !== 'closed') return null
  const state: GhState['state'] = pr
    ? (open ? (v.draft === true ? 'draft' : 'open') : (typeof v.merged_at === 'string' && v.merged_at ? 'merged' : 'closed'))
    : (open ? 'open' : 'closed')
  return {
    kind: pr ? 'pr' : 'issue',
    title: v.title,
    state,
    stateReason: !pr && typeof v.state_reason === 'string' && v.state_reason ? v.state_reason.toLowerCase() : null,
  }
}

/** Why reading failed, in words a person can act on (the desktop's `MISSING` / `SIGNED_OUT`). */
export function ghFailure(instance: string, ref: GhRef, code: number | null, stderr: string): string {
  const lower = stderr.toLowerCase()
  // `sh: 1: gh: not found` and `bash: gh: command not found`; gh's own `gh: Not Found (HTTP 404)` goes on.
  if (code === 127 || /\bgh: (?:command )?not found\s*$/m.test(lower)) {
    return `The GitHub CLI (gh) is not installed in ${instance}, so the latest state can't be read. Install it there, then sign in with gh auth login.`
  }
  if (code === 4 || lower.includes('gh auth login') || lower.includes('not logged in') || lower.includes('http 401') || lower.includes('bad credentials')) {
    return `The GitHub CLI in ${instance} is not signed in. Run gh auth login in its terminal, then try again.`
  }
  if (lower.includes('http 404') || lower.includes('not found')) {
    return `GitHub doesn't show ${ref.owner}/${ref.repo}#${ref.number} to the account gh uses in ${instance}.`
  }
  if (code === null) return 'Reading from GitHub was interrupted.'
  const detail = tidyOutput(stderr).split('\n')[0]
  return detail ? `Could not read from GitHub: ${detail}` : `Could not read from GitHub (exit code ${code}).`
}

/* ======================================================================================
 * The pull request screen: ports of `src-tauri/src/github.rs` (`gh_item`, `gh_merge`, `gh_job`,
 * `gh_pr_create`). Pure functions: argv builders, parsers and the words for failures. gh runs
 * inside the environment (`sshBackend.ts`); every value is validated here before an argv exists,
 * and the argv reaches the shell only through `line()`.
 * ==================================================================================== */

/** Where a pull request or issue lives (the desktop's `Target`). */
export interface GhTarget {
  host: string
  owner: string
  repo: string
  number: number
}

/** What a person typed to link an item (the desktop's `Reference`). */
export type GhReference = { kind: 'full'; target: GhTarget } | { kind: 'number'; number: number }

export const BAD_REFERENCE = 'Paste a pull request or issue link (https://github.com/owner/repo/pull/12) or its number (#12).'
const ONLY_GITHUB = 'Only pull requests and issues on github.com can be read here.'
export const NO_REPO = 'Could not tell which GitHub repository this project belongs to; paste the full link instead.'

/** The desktop's `is_name`: a repository or owner as a remote URL may hold it. */
export function isName(s: string): boolean {
  return s.length > 0 && s.length <= 100 && s !== '.' && s !== '..' && /^[A-Za-z0-9._-]+$/.test(s)
}

/** The desktop's `is_host`. */
export function isHost(s: string): boolean {
  return s.length > 0 && s.length <= 253 && !/^[.:-]/.test(s) && /^[A-Za-z0-9.:-]+$/.test(s)
}

/** The largest number GitHub's GraphQL `Int` holds. */
const INT_MAX = 2_147_483_647

/** A number GitHub's GraphQL `Int` can hold (the desktop's `parse_number`). */
export function parseNumber(s: string): number | null {
  if (!s || s.length > 10 || !/^\d+$/.test(s)) return null
  const n = Number(s)
  return n > 0 && n <= INT_MAX ? n : null
}

/**
 * `https://host/owner/repo/pull/12` (also `/pulls/`, `/issues/`, anything after the number),
 * `owner/repo#12`, `#12` or `12` (the desktop's `parse_reference`). Throws `BAD_REFERENCE`.
 * Any host parses; `ghTargetOf` then keeps the phone to github.com.
 */
export function parseReference(input: string): GhReference {
  const s = input.trim()
  const bare = parseNumber(s.startsWith('#') ? s.slice(1) : s)
  if (bare !== null) return { kind: 'number', number: bare }
  const hash = s.indexOf('#')
  if (hash >= 0) {
    const repo = s.slice(0, hash)
    const n = parseNumber(s.slice(hash + 1))
    const slash = repo.indexOf('/')
    if (slash >= 0 && n !== null) {
      const owner = repo.slice(0, slash)
      const name = repo.slice(slash + 1)
      if (isName(owner) && isName(name)) return { kind: 'full', target: { host: GITHUB_HOST, owner, repo: name, number: n } }
    }
  }
  const rest = s.startsWith('https://') ? s.slice(8) : s.startsWith('http://') ? s.slice(7) : null
  if (rest === null) throw new Error(BAD_REFERENCE)
  const parts = rest.split('/')
  if (parts.length < 5) throw new Error(BAD_REFERENCE)
  const [rawHost, owner, repo, kind, tail] = parts as [string, string, string, string, string]
  const number = parseNumber(/^\d*/.exec(tail)![0])
  if (number === null) throw new Error(BAD_REFERENCE)
  const lower = rawHost.toLowerCase()
  if (!['pull', 'pulls', 'issues'].includes(kind) || !isHost(lower) || !isName(owner) || !isName(repo)) throw new Error(BAD_REFERENCE)
  const host = lower.startsWith('www.') ? lower.slice(4) : lower
  return { kind: 'full', target: { host, owner, repo, number } }
}

/** The target, checked for the phone: on github.com, every part well formed. Throws otherwise. */
export function checkedTarget(t: GhTarget): GhTarget {
  if (t.host.toLowerCase() !== GITHUB_HOST) throw new Error(`${t.host} is not github.com. ${ONLY_GITHUB}`)
  if (!validGhOwner(t.owner) || !validGhRepo(t.repo) || parseNumber(String(t.number)) === null) throw new Error(BAD_REFERENCE)
  return { host: GITHUB_HOST, owner: t.owner, repo: t.repo, number: t.number }
}

/** A linked item's reference as a target the phone may read. */
export function targetOfRef(ref: GhRef): GhTarget {
  if (!validGhRef(ref)) throw new Error(ONLY_GITHUB)
  return checkedTarget(ref)
}

/** `git remote -v` as (name, url) pairs, fetch URLs only (the desktop's `parse_remotes`). */
export function parseRemotes(list: string): [string, string][] {
  const out: [string, string][] = []
  for (const l of list.split('\n')) {
    const parts = l.split(/\s+/).filter(Boolean)
    const [name, url, kind] = parts
    if (name === undefined || url === undefined) continue
    if (kind === undefined || kind === '(fetch)') out.push([name, url])
  }
  return out
}

/**
 * The (host, owner, repo) a git remote URL names: `https://host/owner/repo(.git)`,
 * `ssh://[user@]host[:port]/owner/repo`, `git://…` or scp-like `[user@]host:owner/repo`
 * (the desktop's `repo_from_url`).
 */
export function repoFromUrl(input: string): [string, string, string] | null {
  const url = input.trim()
  let authority: string
  let path: string
  const scheme = url.indexOf('://')
  if (scheme >= 0) {
    if (!['https', 'http', 'ssh', 'git', 'git+ssh', 'ssh+git'].includes(url.slice(0, scheme).toLowerCase())) return null
    const rest = url.slice(scheme + 3)
    const slash = rest.indexOf('/')
    if (slash < 0) return null
    authority = rest.slice(0, slash)
    path = rest.slice(slash + 1)
  } else {
    // scp-like: a colon before any slash (otherwise it is a local path).
    const colon = url.indexOf(':')
    if (colon < 0) return null
    authority = url.slice(0, colon)
    path = url.slice(colon + 1)
    if (authority.includes('/') || authority.includes('\\')) return null
  }
  const at = authority.lastIndexOf('@')
  let host = at >= 0 ? authority.slice(at + 1) : authority
  if (scheme >= 0) host = host.split(':')[0]!
  host = host.toLowerCase()
  if (host.startsWith('www.')) host = host.slice(4)
  // GitHub's SSH over port 443.
  if (host === 'ssh.github.com') host = 'github.com'
  path = path.replace(/^\/+/, '').replace(/\/+$/, '')
  if (path.endsWith('.git')) path = path.slice(0, -4)
  const slash = path.indexOf('/')
  if (slash < 0) return null
  const owner = path.slice(0, slash)
  const repo = path.slice(slash + 1)
  // A host without a dot is an SSH alias (`Host work` in ~/.ssh/config) only the environment knows.
  if (!host.includes('.') || !isHost(host) || !isName(owner) || !isName(repo)) return null
  return [host, owner, repo]
}

/**
 * The remote whose repository the project belongs to, chosen as `gh` does: `upstream`, then
 * `github`, then `origin`, then the first. Remotes on GitHub itself come before any others
 * (the desktop's `choose_remote`).
 */
export function chooseRemote(remotes: readonly (readonly [string, string])[]): [string, string, string] | null {
  const onGithub = (h: string) => h === 'github.com' || h.endsWith('.ghe.com')
  const rank = (name: string) => { const i = ['upstream', 'github', 'origin'].indexOf(name); return i < 0 ? 3 : i }
  let best: { key: [number, number, number]; repo: [string, string, string] } | null = null
  remotes.forEach(([name, url], i) => {
    const repo = repoFromUrl(url)
    if (!repo) return
    const key: [number, number, number] = [onGithub(repo[0]) ? 0 : 1, rank(name), i]
    if (!best || key[0] < best.key[0] || (key[0] === best.key[0] && (key[1] < best.key[1] || (key[1] === best.key[1] && key[2] < best.key[2])))) {
      best = { key, repo }
    }
  })
  return (best as { repo: [string, string, string] } | null)?.repo ?? null
}

/**
 * The project's own repository from its `git remote -v` (null: the folder is not a git
 * repository), the desktop's `env_repo`, kept to github.com. Throws a message otherwise.
 */
export function projectRepo(remoteList: string | null): { owner: string; repo: string } {
  if (remoteList === null) throw new Error(`${NO_REPO} (The project folder is not a git repository.)`)
  const chosen = chooseRemote(parseRemotes(remoteList))
  if (!chosen) throw new Error(`${NO_REPO} (None of the project's git remotes points at a GitHub repository.)`)
  const [host, owner, repo] = chosen
  if (host !== GITHUB_HOST || !validGhOwner(owner) || !validGhRepo(repo)) {
    throw new Error(`This project's repository is on ${host}, and the phone reads only github.com. Paste a github.com link instead.`)
  }
  return { owner, repo }
}

/** The pull request or issue `reference` names; a bare number is in the project's repository (`repo`). */
export function targetOf(reference: GhReference, repo: { owner: string; repo: string }): GhTarget {
  return reference.kind === 'full'
    ? checkedTarget(reference.target)
    : checkedTarget({ host: GITHUB_HOST, owner: repo.owner, repo: repo.repo, number: reference.number })
}

/* ---------- one item in full (the desktop's QUERY, fetch, item_from_json) ---------- */

/** The desktop's `QUERY`, with the Markdown `body` in place of `bodyHTML`. */
export const GH_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    viewerPermission mergeCommitAllowed squashMergeAllowed rebaseMergeAllowed viewerDefaultMergeMethod
    issueOrPullRequest(number: $number) {
      __typename
      ... on PullRequest {
        title url number state isDraft body createdAt updatedAt
        author { login avatarUrl }
        headRefName headRefOid baseRefName additions deletions changedFiles reviewDecision
        mergeable mergeStateStatus
        comments { totalCount }
        labels(first: 20) { nodes { name color } }
        commits(last: 1) { nodes { commit { statusCheckRollup { state contexts(first: 100) { nodes {
          __typename
          ... on CheckRun {
            name status conclusion detailsUrl isRequired(pullRequestNumber: $number)
            checkSuite { workflowRun { workflow { name } } }
          }
          ... on StatusContext { context state targetUrl description isRequired(pullRequestNumber: $number) }
        } } } } } }
      }
      ... on Issue {
        title url number state stateReason body createdAt updatedAt
        author { login avatarUrl }
        comments { totalCount }
        labels(first: 20) { nodes { name color } }
      }
    }
  }
}`

/** The command that reads one item in full. Throws for a target the phone may not read. */
export function ghDetailArgv(t: GhTarget): string[] {
  const c = checkedTarget(t)
  // `-f` sends the value as a plain string; `-F` would read a value starting with `@` from a file,
  // so it is only used for the number, which is digits.
  return [
    'gh', 'api', 'graphql', '--hostname', GITHUB_HOST,
    '-f', `owner=${c.owner}`, '-f', `name=${c.repo}`, '-F', `number=${c.number}`, '-f', `query=${GH_QUERY}`,
  ]
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const someStr = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)
const lowerOf = (v: unknown): string | null => (typeof v === 'string' && v ? v.toLowerCase() : null)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null)
const obj = (v: unknown): any => (v && typeof v === 'object' ? v : {})
const oneOf = <T extends string>(v: string | null, list: readonly T[]): T | null => (v !== null && (list as readonly string[]).includes(v) ? v as T : null)

type GhCheckOut = GhDetail['checkRuns'][number]

/** One node of `statusCheckRollup.contexts`: a check run or a commit status (the desktop's `check_from_json`). */
export function checkFromJson(c: any): GhCheckOut | null {
  c = obj(c)
  const required = c.isRequired === true
  if (c.__typename === 'StatusContext') {
    if (typeof c.state !== 'string' || typeof c.context !== 'string') return null
    const state = c.state === 'SUCCESS' ? 'success' : c.state === 'FAILURE' || c.state === 'ERROR' ? 'failure' : 'pending'
    return { name: c.context, workflow: null, state, url: someStr(c.targetUrl), description: someStr(c.description), required }
  }
  if (typeof c.name !== 'string') return null
  let state: GhCheckOut['state']
  if (c.status !== 'COMPLETED') state = 'pending'
  else {
    switch (str(c.conclusion)) {
      case 'SUCCESS': state = 'success'; break
      case 'CANCELLED': state = 'cancelled'; break
      case 'SKIPPED': state = 'skipped'; break
      case 'NEUTRAL': case 'STALE': state = 'neutral'; break
      default: state = 'failure'
    }
  }
  return {
    name: c.name,
    workflow: someStr(obj(obj(obj(obj(c.checkSuite).workflowRun).workflow)).name),
    state,
    url: someStr(c.detailsUrl),
    description: null,
    required,
  }
}

const MERGE_METHODS = ['merge', 'squash', 'rebase'] as const
const MERGE_STATES = ['clean', 'blocked', 'behind', 'dirty', 'unstable', 'has_hooks', 'draft', 'unknown'] as const

/** GraphQL's answer (`ghDetailArgv`'s stdout, already parsed) as a `GhDetail` (the desktop's `item_from_json`). Throws a message. */
export function detailFromJson(v: any, t: GhTarget): GhDetail {
  v = obj(v)
  const repo = obj(obj(v.data).repository)
  const firstError = Array.isArray(v.errors) ? someStr(obj(v.errors[0]).message) : null
  if (firstError && (v.data == null || obj(v.data).repository == null)) throw new Error(`GitHub: ${firstError}`)
  const node = repo.issueOrPullRequest
  if (!node || typeof node !== 'object') throw new Error(`There is no pull request or issue #${t.number} in ${t.owner}/${t.repo}.`)
  const isPr = node.__typename === 'PullRequest'
  const s = str(node.state)
  const state: GhDetail['state'] = s === 'MERGED' ? 'merged' : s === 'CLOSED' ? 'closed' : isPr && node.isDraft === true ? 'draft' : 'open'
  const author = typeof obj(node.author).login === 'string'
    ? { login: node.author.login as string, avatarUrl: typeof node.author.avatarUrl === 'string' ? node.author.avatarUrl as string : null }
    : null
  const labels = Array.isArray(obj(node.labels).nodes)
    ? (node.labels.nodes as unknown[]).flatMap(l => (typeof obj(l).name === 'string' ? [{ name: obj(l).name as string, color: str(obj(l).color) }] : []))
    : []
  const rollup = obj(obj(obj(Array.isArray(obj(node.commits).nodes) ? node.commits.nodes[0] : null).commit).statusCheckRollup)
  const checks = typeof rollup.state === 'string'
    ? (rollup.state === 'SUCCESS' ? 'success' : rollup.state === 'FAILURE' || rollup.state === 'ERROR' ? 'failure' : 'pending')
    : null
  const contexts = obj(rollup.contexts).nodes
  const checkRuns = Array.isArray(contexts) ? contexts.flatMap(c => { const k = checkFromJson(c); return k ? [k] : [] }) : []
  const mergeMethods = ([['mergeCommitAllowed', 'merge'], ['squashMergeAllowed', 'squash'], ['rebaseMergeAllowed', 'rebase']] as const)
    .filter(([field]) => repo[field] === true)
    .map(([, method]) => method)
  const canMerge = ['ADMIN', 'MAINTAIN', 'WRITE'].includes(str(repo.viewerPermission))
  const url = someStr(node.url) ?? `https://${t.host}/${t.owner}/${t.repo}/${isPr ? 'pull' : 'issues'}/${t.number}`
  const pr = <T>(value: T): T | null => (isPr ? value : null)
  return {
    provider: 'github',
    kind: isPr ? 'pr' : 'issue',
    url,
    host: t.host,
    owner: t.owner,
    repo: t.repo,
    number: num(node.number) ?? t.number,
    title: str(node.title),
    state,
    stateReason: isPr ? null : lowerOf(node.stateReason),
    author,
    createdAt: str(node.createdAt),
    updatedAt: str(node.updatedAt),
    body: str(node.body),
    labels,
    comments: num(obj(node.comments).totalCount) ?? 0,
    headRef: pr(someStr(node.headRefName)),
    baseRef: pr(someStr(node.baseRefName)),
    additions: pr(num(node.additions)),
    deletions: pr(num(node.deletions)),
    changedFiles: pr(num(node.changedFiles)),
    reviewDecision: pr(oneOf(lowerOf(node.reviewDecision), ['approved', 'changes_requested', 'review_required'] as const)),
    checks: pr(checks),
    checkRuns: isPr ? checkRuns : [],
    headSha: pr(someStr(node.headRefOid)),
    mergeable: pr(oneOf(lowerOf(node.mergeable), ['mergeable', 'conflicting', 'unknown'] as const)),
    mergeState: pr(oneOf(lowerOf(node.mergeStateStatus), MERGE_STATES)),
    mergeMethods: isPr ? mergeMethods : [],
    defaultMergeMethod: pr(oneOf(lowerOf(repo.viewerDefaultMergeMethod), MERGE_METHODS)),
    canMerge: isPr && canMerge,
  }
}

/** `ghDetailArgv`'s stdout as a `GhDetail`. Throws a message (GitHub's errors, no such item, not JSON). */
export function parseGhDetail(stdout: string, t: GhTarget, instance: string): GhDetail {
  let v: unknown
  try { v = JSON.parse(stdout) } catch { throw new Error(`The GitHub CLI in ${instance} answered with something unexpected.`) }
  return detailFromJson(v, t)
}

/* ---------- failures ---------- */

/** `sh: 1: gh: not found` and `bash: gh: command not found`; gh's own `gh: Not Found (HTTP 404)` is not one. */
const ghMissing = (code: number | null, lower: string) => code === 127 || /\bgh: (?:command )?not found\s*$/m.test(lower)
const signedOut = (code: number | null, lower: string) =>
  code === 4 || lower.includes('gh auth login') || lower.includes('not logged in') || lower.includes('authentication required')
  || lower.includes('http 401') || lower.includes('bad credentials')

/**
 * A failed gh call in an environment as something a person can act on (the desktop's `gh_error`
 * with its `MISSING` and `SIGNED_OUT`). `target` names the repository when "could not resolve" it.
 */
export function ghError(instance: string, code: number | null, stderr: string, stdout = '', target: GhTarget | null = null): string {
  const lower = stderr.toLowerCase()
  if (ghMissing(code, lower)) {
    return `The GitHub CLI (gh) is not installed in ${instance}. Install it there (https://cli.github.com), then sign in with gh auth login in its terminal.`
  }
  if (signedOut(code, lower)) return `The GitHub CLI in ${instance} is not signed in. Run gh auth login in its terminal, then try again.`
  if (target && `${lower}\n${stdout.toLowerCase()}`.includes('could not resolve to a repository')) {
    return `GitHub has no repository ${target.owner}/${target.repo}, or the account gh is signed in with in ${instance} cannot see it.`
  }
  if (code === null) return 'The GitHub CLI was interrupted before it answered. Try again.'
  const detail = tidyOutput(stderr) || tidyOutput(stdout)
  return detail ? `The GitHub CLI failed: ${detail}` : `The GitHub CLI failed without saying why (exit code ${code}).`
}

/**
 * Why `ghDetailArgv` failed. `gh api graphql` exits 1 on a GraphQL error but still prints the
 * answer, so a missing item reads as the parser words it.
 */
export function detailFailure(instance: string, t: GhTarget, code: number | null, stderr: string, stdout: string): string {
  const lower = stderr.toLowerCase()
  if (ghMissing(code, lower) || signedOut(code, lower)) return ghError(instance, code, stderr, stdout, t)
  if (stdout.trim().startsWith('{')) {
    try {
      const v = JSON.parse(stdout)
      if (obj(v).errors || obj(obj(v).data).repository !== undefined) {
        const lowerAll = `${lower}\n${stdout.toLowerCase()}`
        if (lowerAll.includes('could not resolve to a repository')) return ghError(instance, code, stderr, stdout, t)
        try { detailFromJson(v, t) } catch (e) { return (e as Error).message }
      }
    } catch { /* not JSON after all */ }
  }
  return ghError(instance, code, stderr, stdout, t)
}

/* ---------- merging (the desktop's merge, merge_error) ---------- */

/** A full commit id (SHA-1 or SHA-256). */
export const isSha = (s: string): boolean => (s.length === 40 || s.length === 64) && /^[0-9a-fA-F]+$/.test(s)

/** `gh api --method PUT repos/o/r/pulls/N/merge`, only while the branch still points at `headSha`. Throws for bad input. */
export function ghMergeArgv(t: GhTarget, method: string, headSha: string): string[] {
  if (!(MERGE_METHODS as readonly string[]).includes(method)) throw new Error(`"${method}" is not a merge method.`)
  if (!isSha(headSha)) throw new Error('Read the pull request again before merging it.')
  const c = checkedTarget(t)
  // `sha`: GitHub refuses (409) when the branch moved since the user looked at it.
  return [
    'gh', 'api', '--hostname', GITHUB_HOST, '--method', 'PUT', `repos/${c.owner}/${c.repo}/pulls/${c.number}/merge`,
    '-f', `merge_method=${method}`, '-f', `sha=${headSha}`,
  ]
}

/** A refused merge in words (the desktop's `merge_error`): gh puts GitHub's JSON on stdout, `gh: … (HTTP n)` on stderr. */
export function mergeFailure(instance: string, t: GhTarget, code: number | null, stdout: string, stderr: string): string {
  let said: string | null = null
  try { said = someStr(obj(JSON.parse(stdout)).message) } catch { /* not JSON */ }
  if (stderr.includes('(HTTP 409)')) return 'The branch got new commits since this was read. Look at them, then merge again.'
  if (stderr.includes('(HTTP 403)') || stderr.includes('(HTTP 404)')) {
    return `The account gh is signed in with may not merge pull requests in ${t.owner}/${t.repo}.${said ? ` GitHub says: ${said}` : ''}`
  }
  if (stderr.includes('(HTTP 405)') || stderr.includes('(HTTP 422)')) {
    return `GitHub refused the merge: ${said ?? 'it cannot be merged right now.'}`
  }
  return ghError(instance, code, stderr, stdout, t)
}

/* ---------- a GitHub Actions job and its log ---------- */

/** Most of a job's log the phone fetches over SSH (the desktop allows 24 MB); past this, its end is dropped. */
export const LOG_CAP = 8 * 1024 * 1024
/** Lines kept per step: a step that printed more keeps its end, where a failure is. */
export const STEP_LINES = 5_000

export const NOT_A_JOB = 'That check is not a GitHub Actions job, so Mango cannot show its log. Open it on GitHub instead.'

/** Where a job lives (the desktop's `JobTarget`). */
export interface GhJobTarget {
  host: string
  owner: string
  repo: string
  job: number
}

/** A job id: a 64-bit number on GitHub, here also one JavaScript holds exactly. */
export function parseId(s: string): number | null {
  if (!s || s.length > 20 || !/^\d+$/.test(s)) return null
  const n = Number(s)
  return Number.isSafeInteger(n) && n > 0 ? n : null
}

/** `https://github.com/owner/repo/actions/runs/<run>/job/<job>` (the desktop's `parse_job_url`), github.com only. */
export function parseJobUrl(url: string): GhJobTarget {
  const s = url.trim()
  if (!s.startsWith('https://')) throw new Error(NOT_A_JOB)
  const rest = s.slice(8).split(/[?#]/)[0] ?? ''
  const parts = rest.split('/')
  if (parts.length < 8 || parts[3] !== 'actions' || parts[4] !== 'runs' || parts[6] !== 'job') throw new Error(NOT_A_JOB)
  const [rawHost, owner, repo, , , run, , jobId] = parts as string[] as [string, string, string, string, string, string, string, string]
  let host = rawHost.toLowerCase()
  if (host.startsWith('www.')) host = host.slice(4)
  const job = parseId(jobId)
  if (parseId(run) === null || job === null || !isHost(host) || !isName(owner) || !isName(repo)) throw new Error(NOT_A_JOB)
  if (host !== GITHUB_HOST) throw new Error(`That job is on ${host}, and the phone reads only github.com. Open it there instead.`)
  if (!validGhOwner(owner) || !validGhRepo(repo)) throw new Error(NOT_A_JOB)
  return { host, owner, repo, job }
}

/** A job's or step's `status` and `conclusion` in the words the screen uses (the desktop's `run_state`). */
export function runState(status: string | null | undefined, conclusion: string | null | undefined): GhRunState {
  if (status === 'completed') {
    switch (conclusion ?? '') {
      case 'success': return 'success'
      case 'cancelled': return 'cancelled'
      case 'skipped': return 'skipped'
      case 'neutral': case 'stale': return 'neutral'
      default: return 'failure'
    }
  }
  return status === 'in_progress' ? 'pending' : 'queued'
}

/**
 * Seconds since the epoch of an ISO 8601 UTC timestamp (`2026-11-16T20:29:33Z`, fractions
 * allowed); only ever compared with others (the desktop's `epoch_seconds`).
 */
export function epochSeconds(s: string): number | null {
  if (s.length < 19 || s[4] !== '-' || s[7] !== '-' || s[10] !== 'T' || s[13] !== ':' || s[16] !== ':') return null
  const n = (a: number, b: number) => { const p = s.slice(a, b); return /^\d+$/.test(p) ? Number(p) : null }
  const y0 = n(0, 4), m = n(5, 7), d = n(8, 10), hh = n(11, 13), mm = n(14, 16), ss = n(17, 19)
  if (y0 === null || m === null || d === null || hh === null || mm === null || ss === null) return null
  // Days from civil (Howard Hinnant's algorithm).
  const y = m <= 2 ? y0 - 1 : y0
  const era = Math.floor(y / 400)
  const yoe = y - era * 400
  const doy = Math.floor((153 * (m > 2 ? m - 3 : m + 9) + 2) / 5) + d - 1
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy
  const days = era * 146_097 + doe - 719_468
  return days * 86_400 + hh * 3600 + mm * 60 + ss
}

/** A log line split into its timestamp (whole seconds) and its text (the desktop's `split_stamp`). */
export function splitStamp(l: string): [number | null, string] {
  const sp = l.indexOf(' ')
  if (sp < 0) return [null, l]
  const stamp = l.slice(0, sp)
  if (!stamp.endsWith('Z')) return [null, l]
  const t = epochSeconds(stamp)
  return t === null ? [null, l] : [t, l.slice(sp + 1)]
}

/** The first line the runner prints for a step of its own, not one inside a composite action. */
export const startsStep = (text: string): boolean =>
  text.startsWith('##[group]Run ') || text === 'Post job cleanup.' || text === 'Cleaning up orphan processes'

/** Rust's `str::lines`: split on `\n`, a trailing `\r` dropped, no empty line after a final `\n`. */
function rustLines(s: string): string[] {
  if (!s) return []
  const out = s.split('\n')
  if (out[out.length - 1] === '') out.pop()
  return out.map(l => (l.endsWith('\r') ? l.slice(0, -1) : l))
}

/**
 * Hand the job's log out to its steps (the desktop's `split_log`, which explains the rules). The
 * log is one stream with a timestamp on each line; steps have start and end times to the second.
 */
export function splitLog(log: string, steps: GhJobStep[]): void {
  const text0 = log.startsWith('﻿') ? log.slice(1) : log
  // Steps that ran, in order; skipped and not started ones printed nothing.
  const ran = steps.map((_, i) => i).filter(i => steps[i]!.state !== 'skipped' && steps[i]!.state !== 'queued' && steps[i]!.startedAt !== null)
  if (!ran.length) return
  const time = (i: number, end: boolean): number | null => {
    const s = steps[ran[i]!]!
    const v = end ? s.completedAt : s.startedAt
    return v ? epochSeconds(v) : null
  }
  let cur = 0
  let nested = 0
  const out: string[][] = ran.map(() => [])
  for (const raw of rustLines(text0)) {
    const [t, text] = splitStamp(raw.endsWith('\r') ? raw.slice(0, -1) : raw)
    // A composite action's own steps are bracketed by these; the screen does not show them.
    if (text.startsWith('##[start-action')) { nested++; continue }
    if (text.startsWith('##[end-action')) { nested = Math.max(0, nested - 1); continue }
    if (t !== null) {
      // Past the end of this step: on to the step running now.
      for (;;) {
        const end = time(cur, true)
        const next = cur + 1 < ran.length ? time(cur + 1, false) : null
        if (cur + 1 < ran.length && end !== null && end < t && next !== null && next <= t) cur++
        else break
      }
      const next = cur + 1 < ran.length ? time(cur + 1, false) : null
      if (nested === 0 && cur + 1 < ran.length && out[cur]!.length > 0 && startsStep(text) && next !== null && next <= t) cur++
    }
    out[cur]!.push(text)
  }
  out.forEach((lines, i) => {
    const step = steps[ran[i]!]!
    step.omitted = Math.max(0, lines.length - STEP_LINES)
    step.lines = lines.slice(step.omitted)
  })
}

/** `gh api repos/o/r/actions/jobs/<id>`'s answer as a `GhJob`, without its log yet (the desktop's `job_from_json`). */
export function jobFromJson(v: any): GhJob {
  v = obj(v)
  const steps: GhJobStep[] = Array.isArray(v.steps)
    ? (v.steps as unknown[]).map((raw) => {
        const s = obj(raw)
        return {
          number: num(s.number) ?? 0,
          name: str(s.name),
          state: runState(someStr(s.status), someStr(s.conclusion)),
          startedAt: someStr(s.started_at),
          completedAt: someStr(s.completed_at),
          lines: [],
          omitted: 0,
        }
      })
    : []
  return {
    provider: 'github',
    id: num(v.id) ?? 0,
    name: str(v.name),
    workflow: someStr(v.workflow_name),
    url: str(v.html_url),
    state: runState(someStr(v.status), someStr(v.conclusion)),
    startedAt: someStr(v.started_at),
    completedAt: someStr(v.completed_at),
    steps,
    logReady: false,
    logError: null,
    logTruncated: false,
  }
}

const jobPath = (t: GhJobTarget) => `repos/${t.owner}/${t.repo}/actions/jobs/${t.job}`

/** `gh api` for the job itself. */
export function ghJobArgv(t: GhJobTarget): string[] {
  return ['gh', 'api', '--hostname', GITHUB_HOST, jobPath(t)]
}

/**
 * `sh` script for the job's whole log, `$1` = the job's API path, `$2` = 1 to keep colour codes.
 * It asks for the log only once the job finished (GitHub has none before), so a job read again
 * and again while it runs costs no download, and the job and its log still come in one round
 * trip (`runAll`). Exit 75: not finished. Logs carry colour codes, which `gh api` only passes on
 * when told to; a gh too old to know the flag passes them anyway (`unknownFlag`, then `$2` = 0).
 */
export const JOB_LOG = `s=$(gh api --hostname ${GITHUB_HOST} "$1" --jq .status) && [ "$s" = completed ] || exit 75
if [ "$2" = 1 ]; then exec gh api --hostname ${GITHUB_HOST} "$1/logs" --allow-escape-sequences; fi
exec gh api --hostname ${GITHUB_HOST} "$1/logs"`

/** The argv of `JOB_LOG` for a job. */
export function ghJobLogArgv(t: GhJobTarget, escapes = true): string[] {
  return ['sh', '-c', JOB_LOG, 'mango-job', jobPath(t), escapes ? '1' : '0']
}

/** `JOB_LOG`'s exit code when the job had not finished. */
export const JOB_RUNNING = 75

/** The log call failed because gh does not know `--allow-escape-sequences`. */
export const unknownFlag = (stderr: string, stdout = '') => `${stderr}\n${stdout}`.includes('unknown flag')

/** Why reading the job failed (the desktop's `job`). */
export function jobFailure(instance: string, t: GhJobTarget, code: number | null, stderr: string, stdout = ''): string {
  const lower = stderr.toLowerCase()
  if (!ghMissing(code, lower) && !signedOut(code, lower) && (stderr.includes('(HTTP 404)') || stderr.includes('Not Found'))) {
    return `GitHub has no job ${t.job} in ${t.owner}/${t.repo}, or the account gh is signed in with in ${instance} cannot see it.`
  }
  return ghError(instance, code, stderr, stdout)
}

/** Why reading a finished job's log failed (the desktop's `job_log`). */
export function jobLogFailure(instance: string, code: number | null, stderr: string, stdout = ''): string {
  if (stderr.includes('(HTTP 410)')) return 'GitHub no longer keeps this log: it expired.'
  if (stderr.includes('(HTTP 404)')) return 'GitHub has no log for this job.'
  return ghError(instance, code, stderr, stdout)
}

/* ---------- opening a pull request (the desktop's pr_create, created_target) ---------- */

/**
 * `sh` script, run in the project folder: `gh pr create --fill` from the checked-out branch, the
 * desktop's local form (it reads the branch with git first). `$1` = base branch, or empty for
 * the repository's default. It names the branch on stderr (`MANGO-BRANCH:`) for the messages,
 * and says `MANGO-ERR:detached` when HEAD is not on a branch.
 */
export const PR_CREATE = `b=$(GIT_OPTIONAL_LOCKS=0 git symbolic-ref -q --short HEAD)
c=$?
if [ $c -eq 1 ] || { [ $c -eq 0 ] && [ -z "$b" ]; }; then echo "MANGO-ERR:detached" >&2; exit 3; fi
[ $c -eq 0 ] || exit $c
printf 'MANGO-BRANCH:%s\\n' "$b" >&2
if [ -n "$1" ]; then exec gh pr create --fill "--head=$b" "--base=$1"; fi
exec gh pr create --fill "--head=$b"`

/** The argv running `PR_CREATE` (in the project folder). `base` null: the default branch. Throws for an unsafe base. */
export function ghPrCreateArgv(base: string | null): string[] {
  const b = base === null ? '' : safeRef(base)
  return ['sh', '-c', PR_CREATE, 'mango-pr', b]
}

/** The branch `PR_CREATE` named, if it got that far. */
export function prBranchOf(stderr: string): string | null {
  const m = /^MANGO-BRANCH:(.*)$/m.exec(stderr)
  return m ? m[1]!.trim() || null : null
}

/** `PR_CREATE`'s stderr without its own markers. */
const ghWords = (stderr: string) => stderr.split('\n').filter(l => !l.startsWith('MANGO-BRANCH:')).join('\n')

/**
 * The pull request a `gh pr create` printed: its link on success, or the one that already exists
 * for the branch ("a pull request for branch … already exists: <link>"). The desktop's `created_target`.
 */
export function createdTarget(text: string): GhTarget | null {
  for (const w of text.split(/\s+/)) {
    if (!w.startsWith('https://') || !w.includes('/pull/')) continue
    try {
      const r = parseReference(w)
      if (r.kind === 'full') return r.target
    } catch { /* not a link after all */ }
  }
  return null
}

/** Why `PR_CREATE` failed, in words. `base` as asked (null: the default branch). */
export function prCreateFailure(instance: string, base: string | null, code: number | null, stderr: string, stdout = ''): string {
  if (stderr.includes('MANGO-ERR:detached')) {
    return 'HEAD is detached, so there is no branch to open a pull request from. Switch to a branch first.'
  }
  const branch = prBranchOf(stderr)
  const said = ghWords(stderr)
  const lower = said.toLowerCase()
  if (!branch && lower.includes('not a git repository')) return `The project folder in ${instance} is not a git repository.`
  if (branch && (lower.includes("head sha can't be blank") || lower.includes('must first push') || lower.includes('head ref must be a branch'))) {
    return `${branch} is not on GitHub yet. Push it first, then open the pull request.`
  }
  if (branch && lower.includes('no commits between')) {
    return `${branch} has no commits that ${base ?? 'the default branch'} doesn't have, so there is nothing to open a pull request for.`
  }
  return ghError(instance, code, said, stdout)
}
