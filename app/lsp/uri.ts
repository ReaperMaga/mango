/**
 * Paths to `file:` URIs and back, for local projects: Windows drives (either case, `:` or `%3A`),
 * UNC shares, spaces, `#`, non-ASCII. A path's separators follow its own kind, not this computer's.
 */

/** A Windows path: a drive or a share. A backslash in a POSIX path is part of a name. */
export const isWindowsPath = (path: string) => /^[a-z]:/i.test(path) || path.startsWith('\\\\') || path.startsWith('//')

/** Forward slashes, no `\\?\` prefix, no trailing slash. */
function normalise(path: string): string {
  let p = path
  if (p.startsWith('\\\\?\\')) p = /^\\\\\?\\UNC\\/i.test(p) ? `\\\\${p.slice(8)}` : p.slice(4)
  if (isWindowsPath(p)) p = p.replace(/\\/g, '/')
  return p.replace(/\/+$/, '') || '/'
}

const encodeSegment = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)

export function pathToUri(path: string): string {
  let p = normalise(path)
  let authority = ''
  if (/^[a-z]:/i.test(p)) {
    p = `/${p[0]!.toLowerCase()}${p.slice(1)}`
  } else if (p.startsWith('//')) {
    const cut = p.indexOf('/', 2)
    authority = cut < 0 ? p.slice(2) : p.slice(2, cut)
    p = cut < 0 ? '/' : p.slice(cut)
  }
  return `file://${encodeURI(authority)}${p.split('/').map(encodeSegment).join('/')}`
}

function decode(s: string) {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

/** The path a `file:` URI names, with forward slashes; null for any other URI. */
export function uriToPath(uri: unknown): string | null {
  if (typeof uri !== 'string') return null
  const m = /^file:(?:\/\/([^/?#]*))?(\/[^?#]*)/i.exec(uri)
  if (!m) return null
  const authority = decode(m[1] ?? '')
  const path = decode(m[2]!)
  if (path.includes('\0')) return null
  if (authority && authority.toLowerCase() !== 'localhost') return `//${authority}${path}`.replace(/\\/g, '/')
  return /^\/[a-z]:/i.test(path) ? path.slice(1).replace(/\\/g, '/') : path
}

/** `file` (forward slashes) inside `root`, as one absolute path. */
export const joinRoot = (root: string, file: string) => `${normalise(root).replace(/\/$/, '')}/${file}`

/** `path` relative to `root` with forward slashes; null when it is not inside it. Windows paths compare without case. */
export function relativeTo(root: string, path: string): string | null {
  const base = `${normalise(root).replace(/\/$/, '')}/`
  const p = normalise(path)
  const windows = isWindowsPath(base)
  const inside = windows ? p.toLowerCase().startsWith(base.toLowerCase()) : p.startsWith(base)
  if (!inside) return null
  const rel = p.slice(base.length)
  return rel && !rel.split('/').some(s => s === '..' || s === '.' || s === '') ? rel : null
}

/** The project's file a URI names; null for one outside it. */
export function uriToFile(root: string, uri: unknown): string | null {
  const path = uriToPath(uri)
  return path === null ? null : relativeTo(root, path)
}

/** Two spellings of one file give one key: Windows does not care about case. */
export const fileKey = (root: string, file: string) => (isWindowsPath(root) ? file.toLowerCase() : file)
