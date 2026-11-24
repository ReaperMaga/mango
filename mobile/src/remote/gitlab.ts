import type { ForgeProvider } from '~/types/ipc'
import { tidyOutput } from './git'
import { parseRemotes, validGhOwner, validGhRepo } from './github'

/**
 * GitLab, read with the GitLab CLI (`glab`) inside the environment: the port of the desktop's
 * `src-tauri/src/gitlab.rs` (which projects live on a GitLab server, remote parsing, `glab api`
 * and its errors). Merge requests, issues, jobs, releases and pipelines follow in
 * `gitlabItems.ts` and `gitlabReleases.ts`. Like `gh`, `glab` owns the sign-in: the phone never
 * sees a token, and a missing or signed-out `glab` comes back as words that say what to run.
 *
 * Which hosts are GitLab: gitlab.com, names whose first label is `gitlab` (`gitlab.example.com`),
 * and the self-managed servers the environment's `glab` is configured for (read from its config
 * file, host names only: `GLAB_HOSTS`). The desktop's own list of servers (Settings > Git hosting)
 * lives on that computer; the phone has `glab`'s list instead.
 *
 * Every value from a chat file, a link or the UI passes the validators here before an argv
 * exists, and the argv reaches the shell only through `line()` (`shell.ts`). Fields go to
 * `glab api` with `-f` only (a raw string; `-F` would read a value starting with `@` from a file).
 */

export const GITLAB_COM = 'gitlab.com'

/** Which forge a repository lives on, with where (the desktop's `Forge`). On GitLab `owner` is the whole namespace. */
export interface Forge {
  provider: ForgeProvider
  host: string
  owner: string
  repo: string
}

/** `group/subgroup/project`. */
export const fullPath = (f: Pick<Forge, 'owner' | 'repo'>): string => `${f.owner}/${f.repo}`

/** A full project path for a REST URL segment: every `/` (and anything else outside the name characters) percent-encoded. */
export function encodePath(path: string): string {
  let out = ''
  for (const b of new TextEncoder().encode(path)) {
    const c = String.fromCharCode(b)
    out += /[A-Za-z0-9._-]/.test(c) ? c : `%${b.toString(16).toUpperCase().padStart(2, '0')}`
  }
  return out
}

/** The project in a REST path: `projects/group%2Fsubgroup%2Fproject`. */
export const apiProject = (f: Pick<Forge, 'owner' | 'repo'>): string => `projects/${encodePath(fullPath(f))}`

/* ---------- names (the desktop's is_segment, is_namespace, is_host, normalize_host) ---------- */

/**
 * One segment of a GitLab path (a group or project): letters, digits, `-`, `_`, `.`; no leading
 * `-` or `.`, and none of GitLab's reserved `.git` / `.atom` endings.
 */
export function isSegment(s: string): boolean {
  return s.length > 0 && s.length <= 255 && !/^[-.]/.test(s) && !s.endsWith('.git') && !s.endsWith('.atom') && /^[A-Za-z0-9._-]+$/.test(s)
}

/** A namespace: one to twenty segments joined by `/` (GitLab nests groups up to 20 deep). */
export function isNamespace(s: string): boolean {
  const parts = s.split('/')
  return parts.length > 0 && parts.length <= 20 && parts.every(isSegment)
}

/** A host name, optionally with a port. */
export function isHost(s: string): boolean {
  let name = s
  const colon = s.lastIndexOf(':')
  if (colon >= 0) {
    name = s.slice(0, colon)
    const p = s.slice(colon + 1)
    if (!p || p.length > 5 || !/^\d+$/.test(p) || Number(p) === 0 || Number(p) > 65535) return false
  }
  return name.length > 0 && name.length <= 253 && name.includes('.')
    && name.split('.').every(l => l.length > 0 && l.length <= 63 && !l.startsWith('-') && !l.endsWith('-') && /^[A-Za-z0-9-]+$/.test(l))
}

/** A host as stored and compared: trimmed, lower case, without a scheme, a path or `www.`. Null when it is no host name. */
export function normalizeHost(input: string): string | null {
  let s = input.trim().toLowerCase()
  if (s.startsWith('https://')) s = s.slice(8)
  else if (s.startsWith('http://')) s = s.slice(7)
  s = s.split('/')[0] ?? ''
  if (s.startsWith('www.')) s = s.slice(4)
  return isHost(s) ? s : null
}

/* ---------- which hosts are GitLab ---------- */

/**
 * Whether `host` is a GitLab server: gitlab.com, a `gitlab.*` name, or one in `known` (the hosts
 * the environment's glab is configured for; they may carry ports: a match on the name alone counts).
 */
export function isGitlabHostIn(host: string, known: readonly string[]): boolean {
  const h = host.toLowerCase()
  const bare = h.split(':')[0] ?? h
  return bare === GITLAB_COM
    || bare.endsWith('.gitlab.com')
    || (bare.startsWith('gitlab.') && (bare.match(/\./g)?.length ?? 0) >= 2)
    || known.some(c => c === h || c.split(':')[0] === bare)
}

const isGithubHost = (h: string) => h === 'github.com' || h.endsWith('.ghe.com')

/**
 * `sh` script printing the hosts the environment's glab is configured for, one per line: the keys
 * of `hosts:` in its config file, and nothing else of it (tokens stay where they are). Prints
 * nothing when glab was never set up.
 */
export const GLAB_HOSTS = `f="\${GLAB_CONFIG_DIR:-\${XDG_CONFIG_HOME:-$HOME/.config}/glab-cli}/config.yml"
[ -r "$f" ] || exit 0
exec awk '
/^hosts:[ \\t]*$/ { h = 1; ind = ""; next }
h && /^[^ \\t]/ { h = 0 }
h && match($0, /^ +/) {
  lead = substr($0, 1, RLENGTH)
  if (ind == "") ind = lead
  if (lead != ind) next
  k = substr($0, RLENGTH + 1)
  if (k !~ /^["\\x27]?[A-Za-z0-9.:-]+["\\x27]?:[ \\t]*$/) next
  sub(/:[ \\t]*$/, "", k); gsub(/["\\x27]/, "", k); print k
}' "$f"`

/** What `GLAB_HOSTS` printed, each a valid host name, without gitlab.com (always known). */
export function parseGlabHosts(stdout: string): string[] {
  const out: string[] = []
  for (const l of stdout.split('\n')) {
    const h = normalizeHost(l)
    if (h && h !== GITLAB_COM && !out.includes(h) && out.length < 50) out.push(h)
  }
  return out
}

/* ---------- the project's forge, from its git remotes ---------- */

/**
 * The (host, path) a git remote URL names: `https://host/a/b/c(.git)`, `ssh://[user@]host[:port]/a/b`,
 * `git://…` or scp-like `[user@]host:a/b` (the desktop's `split_remote`). The host is lower case
 * without port or `www.`; the path has no leading or trailing `/` and no `.git`.
 */
export function splitRemote(input: string): [string, string] | null {
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
  path = path.replace(/^\/+/, '').replace(/\/+$/, '')
  if (path.endsWith('.git')) path = path.slice(0, -4)
  // A host without a dot is an SSH alias (`Host work` in ~/.ssh/config) only the environment knows.
  if (!host.includes('.') || !path) return null
  return [host, path]
}

/** The GitLab project a remote URL names, when its host is a GitLab server (the desktop's `gitlab_project_from_url`). */
export function gitlabProjectFromUrl(url: string, known: readonly string[]): Forge | null {
  const split = splitRemote(url)
  if (!split) return null
  const [h, path] = split
  if (!isGitlabHostIn(h, known)) return null
  // `altssh.gitlab.com` is gitlab.com's SSH over port 443.
  const host = h === 'altssh.gitlab.com' ? GITLAB_COM : h
  const slash = path.lastIndexOf('/')
  if (slash < 0) return null
  const owner = path.slice(0, slash)
  const repo = path.slice(slash + 1)
  return isNamespace(owner) && isSegment(repo) ? { provider: 'gitlab', host, owner, repo } : null
}

/** The remote's forge: GitHub (github.com, GHE.com) or a GitLab server; other hosts: null (the desktop's `forge_of`). */
export function forgeOf(url: string, known: readonly string[]): Forge | null {
  const gl = gitlabProjectFromUrl(url, known)
  if (gl) return gl
  const split = splitRemote(url)
  if (!split) return null
  const host = split[0] === 'ssh.github.com' ? 'github.com' : split[0]
  if (!isGithubHost(host)) return null
  const slash = split[1].indexOf('/')
  if (slash < 0) return null
  const owner = split[1].slice(0, slash)
  const repo = split[1].slice(slash + 1)
  return isSegment(owner) && isSegment(repo) && !repo.includes('/') ? { provider: 'github', host, owner, repo } : null
}

/**
 * The forge the project belongs to, from `git remote -v` (the desktop's `choose_forge`): among
 * remotes on GitHub or a GitLab server, `upstream`, then `github` / `gitlab`, then `origin`, then
 * the first; GitHub first on a tie.
 */
export function chooseForge(remoteList: string, known: readonly string[]): Forge | null {
  const rank = (name: string) => (name === 'upstream' ? 0 : name === 'github' || name === 'gitlab' ? 1 : name === 'origin' ? 2 : 3)
  let best: { key: [number, number, number]; forge: Forge } | null = null
  parseRemotes(remoteList).forEach(([name, url], i) => {
    const forge = forgeOf(url, known)
    if (!forge) return
    const key: [number, number, number] = [rank(name), forge.provider === 'github' ? 0 : 1, i]
    if (!best || key[0] < best.key[0] || (key[0] === best.key[0] && (key[1] < best.key[1] || (key[1] === best.key[1] && key[2] < best.key[2])))) {
      best = { key, forge }
    }
  })
  return (best as { forge: Forge } | null)?.forge ?? null
}

/** Neither GitHub nor a GitLab server among the project's remotes. */
export const NO_FORGE = 'Could not tell which GitHub repository or GitLab project this project belongs to; paste the full link instead.'

/**
 * The project's forge from its `git remote -v` (null: the folder is not a git repository) and the
 * hosts glab knows there: a GitLab project, or a repository on github.com (the phone reads no other
 * GitHub). Throws a message otherwise.
 */
export function pickForge(remoteList: string | null, known: readonly string[]): Forge {
  if (remoteList === null) throw new Error(`${NO_FORGE} (The project folder is not a git repository.)`)
  const f = chooseForge(remoteList, known)
  if (!f) throw new Error(`${NO_FORGE} (None of the project's git remotes points at GitHub or a GitLab server.)`)
  if (f.provider === 'github' && f.host !== 'github.com') {
    throw new Error(`This project's repository is on ${f.host}, and the phone reads only github.com. Paste a github.com link instead.`)
  }
  if (f.provider === 'github' && (!validGhOwner(f.owner) || !validGhRepo(f.repo))) throw new Error(NO_FORGE)
  return f
}

/* ---------- running glab ---------- */

/** Environment for glab: never prompt, no colour, update notices, hyperlinks or telemetry (the desktop's `glab()`). */
export const GLAB_ENV: [string, string][] = [
  ['NO_PROMPT', '1'], ['GLAB_NO_PROMPT', '1'], ['GLAB_CHECK_UPDATE', 'false'], ['GLAB_SEND_TELEMETRY', 'false'],
  ['NO_COLOR', '1'], ['CLICOLOR', '0'], ['FORCE_HYPERLINKS', '0'], ['GIT_TERMINAL_PROMPT', '0'],
]

/** `glab api --hostname {host} {endpoint}`: the start of every API call (the caller adds `-f` fields). Throws for a bad host. */
export function glabApi(host: string, endpoint: string): string[] {
  if (!isHost(host)) throw new Error(`"${host}" is not a server name.`)
  return ['glab', 'api', '--hostname', host, endpoint]
}

/** `glab api graphql` with `-f` variables and the query, on `host`. */
export function glabGraphql(host: string, query: string, vars: [string, string][]): string[] {
  return [...glabApi(host, 'graphql'), ...vars.flatMap(([k, v]) => ['-f', `${k}=${v}`]), '-f', `query=${query}`]
}

/** `sh: 1: glab: not found` and `bash: glab: command not found`. */
export const glabMissing = (code: number | null, lower: string): boolean =>
  code === 127 || /\bglab: (?:command )?not found\s*$/m.test(lower)

const signedOut = (lower: string): boolean =>
  lower.includes('glab auth login') || lower.includes('401 unauthorized') || lower.includes('not logged in')
  || lower.includes('no token') || lower.includes('has not been authenticated')

/**
 * A failed glab call in an environment as something a person can act on (the desktop's
 * `glab_error` with its `MISSING` and `SIGNED_OUT`, worded for the environment it ran in).
 */
export function glabError(instance: string, host: string | null, code: number | null, stderr: string, stdout = ''): string {
  const detail = tidyOutput(stderr) || tidyOutput(stdout)
  const lower = `${stderr}\n${stdout}`.toLowerCase()
  if (glabMissing(code, stderr.toLowerCase())) {
    return `The GitLab CLI (glab) is not installed in ${instance}. Install the GitLab CLI component in the environment from Mango on your computer, then sign in to GitLab there.`
  }
  if (signedOut(lower)) {
    return `The GitLab CLI in ${instance} is not signed in to ${host ?? GITLAB_COM}. Sign in from Mango on your computer (the environment's page > Sign in > GitLab CLI), or run glab auth login in its terminal.`
  }

  if (lower.includes('404 not found') || lower.includes('404 project not found')) {
    return `GitLab has no such project or item, or the account glab is signed in with in ${instance} cannot see it.`
  }
  if (code === null) return 'The GitLab CLI was interrupted before it answered. Try again.'
  return detail ? `The GitLab CLI failed: ${detail}` : `The GitLab CLI failed without saying why (exit code ${code}).`
}

/** Whether a message is glab missing or signed out (so a caller's own wording does not replace it). */
export const isGlabSetupError = (m: string): boolean =>
  m.startsWith('The GitLab CLI (glab) is not installed') || m.includes('is not signed in')

/**
 * A link GitLab returned that may be relative (avatars, uploads on self-managed servers): made
 * absolute on `host`, and only ever http(s) (the desktop's `absolute_url`).
 */
export function absoluteUrl(host: string, url: string): string | null {
  const u = url.trim()
  if (u.startsWith('https://') || u.startsWith('http://')) return u
  return u.startsWith('/') ? `https://${host}${u}` : null
}
