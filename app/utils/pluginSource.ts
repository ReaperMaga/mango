/**
 * What a person pastes to install a plugin, read as a git source (`url`, `ref`, `subpath`) for
 * `plugins_probe`. Pure and plain-Node testable (tests/pluginSource.test.ts): no Vue, no `~/` imports.
 *
 * Understood:
 * - `https://host/owner/repo(.git)`, any host (self-hosted too)
 * - a folder or file in a hosting site's web view:
 *   GitHub `/tree|blob/<ref>/<path>`, GitLab `/-/tree|blob/<ref>/<path>`,
 *   Codeberg / Gitea / Forgejo `/src/branch|tag|commit/<ref>/<path>`, Bitbucket `/src/<ref>/<path>`
 *   (a link to `mango-plugin.json`, or any file, means the folder holding it)
 * - `git@host:owner/repo.git` and `ssh://…`, `git://…`
 * - a `#ref:folder` or `#folder` suffix on any of these (it wins over what the link says)
 *
 * A branch with a `/` in its name can't be told apart from a folder in a web link: the first part is
 * taken as the branch, and the Branch field in the dialog sets it exactly.
 */

export interface GitSourceInput {
  url: string
  ref: string | null
  subpath: string | null
}

export type ParsedPluginSource =
  | { ok: true; source: GitSourceInput; /** `host/owner/repo`, for showing. */ repo: string }
  | { ok: false; error: string; /** It looks like a folder on this computer: offer "Add local folder". */ local?: boolean; empty?: boolean }

const MANIFEST = 'mango-plugin.json'

/** Looks like a path on this computer rather than a link. */
function looksLocal(s: string): boolean {
  return /^(~|\.{1,2})([\\/]|$)/.test(s)
    || s.startsWith('/')
    || /^[a-zA-Z]:([\\/]|$)/.test(s)
    || s.startsWith('\\\\')
    || /^file:/i.test(s)
}

/** A folder inside the repository: `/`-separated, no `..`, no leading or trailing slash. Null when empty. */
export function cleanSubpath(raw: string | null | undefined): { ok: true; value: string | null } | { ok: false; error: string } {
  const parts = (raw ?? '').replace(/\\/g, '/').split('/').map(p => p.trim()).filter(p => p && p !== '.')
  if (parts.some(p => p === '..')) return { ok: false, error: 'The folder must be inside the repository (no "..").' }
  if (parts.some(p => /[\0-\x1f]/.test(p))) return { ok: false, error: 'The folder name has characters git can\'t use.' }
  return { ok: true, value: parts.length ? parts.join('/') : null }
}

/** A branch, tag or commit. Null when empty. */
export function cleanRef(raw: string | null | undefined): { ok: true; value: string | null } | { ok: false; error: string } {
  const ref = (raw ?? '').trim()
  if (!ref) return { ok: true, value: null }
  if (/\s/.test(ref) || ref.startsWith('-') || ref.includes('..') || /[\0-\x1f~^:?*[\\]/.test(ref)) {
    return { ok: false, error: `"${ref}" isn't a branch, tag or commit name git accepts.` }
  }
  return { ok: true, value: ref }
}

/** `host/owner/repo` for any git url this module accepts, for display. */
export function repoLabel(url: string): string {
  let s = url.trim()
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/)(.+)$/.exec(s)
  if (scp && !/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `${scp[1]}/${scp[2]}`
  else s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/^[^@/]+@/, '')
  return s.replace(/\/+$/, '').replace(/\.git$/i, '')
}

/** Folder of a file path inside the repository (`a/b/mango-plugin.json` → `a/b`). */
const dirOf = (path: string[]) => path.slice(0, -1)

/** The repository, ref and folder in a hosting site's web link. Null when the path holds none of them. */
function fromWebPath(segments: string[]): { repo: string[]; ref: string | null; path: string[]; file: boolean } | null {
  // GitLab: <group/subgroup/repo>/-/(tree|blob)/<ref>/<path>
  const dash = segments.indexOf('-')
  if (dash >= 2 && (segments[dash + 1] === 'tree' || segments[dash + 1] === 'blob')) {
    return { repo: segments.slice(0, dash), ref: segments[dash + 2] ?? null, path: segments.slice(dash + 3), file: segments[dash + 1] === 'blob' }
  }
  if (segments.length < 3) return null
  const [owner, repo, kind, ...rest] = segments as [string, string, string, ...string[]]
  // GitHub: owner/repo/(tree|blob)/<ref>/<path>
  if (kind === 'tree' || kind === 'blob') {
    return { repo: [owner, repo], ref: rest[0] ?? null, path: rest.slice(1), file: kind === 'blob' }
  }
  if (kind === 'src') {
    // Gitea, Forgejo, Codeberg: owner/repo/src/(branch|tag|commit)/<ref>/<path>
    if (rest[0] === 'branch' || rest[0] === 'tag' || rest[0] === 'commit') {
      return { repo: [owner, repo], ref: rest[1] ?? null, path: rest.slice(2), file: false }
    }
    // Bitbucket: owner/repo/src/<ref>/<path>
    return { repo: [owner, repo], ref: rest[0] ?? null, path: rest.slice(1), file: false }
  }
  return null
}

/** Read a pasted source. `extra` (the dialog's Branch and Folder fields) wins over the link when set. */
export function parsePluginSource(input: string, extra: { ref?: string | null; subpath?: string | null } = {}): ParsedPluginSource {
  let s = input.trim()
  if (!s) return { ok: false, error: 'Paste a link to a git repository.', empty: true }
  if (looksLocal(s)) {
    return { ok: false, local: true, error: 'That looks like a folder on this computer. Use "Add local folder" for it.' }
  }

  // An optional `#ref:folder` / `#folder` suffix.
  let hashRef: string | null | undefined
  let hashPath: string | null | undefined
  const hash = s.indexOf('#')
  if (hash >= 0) {
    const frag = s.slice(hash + 1).trim()
    s = s.slice(0, hash).trim()
    if (frag) {
      const colon = frag.indexOf(':')
      if (colon >= 0) {
        hashRef = frag.slice(0, colon)
        hashPath = frag.slice(colon + 1)
      } else {
        hashPath = frag
      }
    }
  }

  // `github.com/owner/repo` without a scheme: the https link was meant.
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+\/[^\s:]+$/i.test(s)) s = `https://${s}`

  let url: string
  let ref: string | null = null
  let path: string[] = []

  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(s)?.[1]?.toLowerCase()
  const scp = /^([^@/\s]+@)?([a-zA-Z0-9.-]+):(?!\/)([^\s]+)$/.exec(s)
  if (!scheme && scp) {
    // git@host:owner/repo.git
    url = s.replace(/\/+$/, '')
  } else if (scheme === 'ssh' || scheme === 'git' || scheme === 'git+ssh') {
    if (/\s/.test(s)) return { ok: false, error: 'A link can\'t contain spaces.' }
    url = s.replace(/\/+$/, '')
  } else if (scheme === 'http' || scheme === 'https') {
    let u: URL
    try {
      u = new URL(s)
    } catch {
      return { ok: false, error: 'That link can\'t be read. Paste the repository\'s address, such as https://github.com/owner/repo.' }
    }
    if (u.username || u.password) {
      return { ok: false, error: 'Leave the sign-in out of the link: git uses your own credentials for private repositories.' }
    }
    const segments = u.pathname.split('/').filter(Boolean).map(p => decodeURIComponent(p))
    if (!segments.length) return { ok: false, error: 'That link names a site, not a repository. Add the owner and repository, such as https://github.com/owner/repo.' }
    const web = fromWebPath(segments)
    if (web) {
      url = `${u.protocol}//${u.host}/${web.repo.join('/')}`
      ref = web.ref
      path = web.file ? dirOf(web.path) : web.path
      if (!web.file && path[path.length - 1] === MANIFEST) path = dirOf(path)
    } else {
      url = `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}`
    }
  } else if (scheme) {
    return { ok: false, error: `Links starting with ${scheme}:// aren't supported. Use an https:// or ssh link to the repository.` }
  } else {
    return { ok: false, error: 'That isn\'t a repository link. Paste one such as https://github.com/owner/repo or git@github.com:owner/repo.git.' }
  }

  // The suffix wins over the link, and the dialog's fields win over both.
  const refRaw = extra.ref?.trim() ? extra.ref : hashRef !== undefined && hashRef !== '' ? hashRef : ref
  const pathRaw = extra.subpath?.trim() ? extra.subpath : hashPath !== undefined ? hashPath : path.join('/')
  const r = cleanRef(refRaw)
  if (!r.ok) return { ok: false, error: r.error }
  const p = cleanSubpath(pathRaw)
  if (!p.ok) return { ok: false, error: p.error }
  // A folder ending in the manifest names the folder holding it.
  let subpath = p.value
  if (subpath === MANIFEST) subpath = null
  else if (subpath?.endsWith(`/${MANIFEST}`)) subpath = subpath.slice(0, -MANIFEST.length - 1)

  return { ok: true, source: { url, ref: r.value, subpath }, repo: repoLabel(url) }
}
