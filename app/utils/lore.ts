import type { LoreServer } from '~/types/ipc'
import { t } from '../i18n/index.ts'

/**
 * Lore addresses as a person types them, checked and cleaned up the way the backend does
 * (`parse_server_url`, `parse_repo_url`, `valid_repo_name` in src-tauri/src/lore_servers.rs; keep them in
 * step). The backend checks again: this is for messages while typing. Plain Node testable.
 */

export const LORE_DEFAULT_PORT = 41337
/** The CLI's port for `lores://` without one: 443, like `https://`. Lore's own 41337 has to be written out. */
export const LORE_SECURE_DEFAULT_PORT = 443

/** A `lore://` or `lores://` address (any case). `lores://` is a server the CLI authenticates (TLS). */
export function isLoreUrl(s: string): boolean {
  return /^lores?:\/\//i.test(s.trim())
}

/** The scheme an address keeps: `lores://` when it was typed so, else `lore://`. */
function schemeOf(s: string): string {
  return /^lores:\/\//i.test(s.trim()) ? 'lores://' : 'lore://'
}

function dnsName(s: string): boolean {
  return s.length > 0 && s.length <= 253
    && s.split('.').every(l => l.length > 0 && l.length <= 63 && !l.startsWith('-') && !l.endsWith('-') && /^[a-z0-9-]+$/.test(l))
}

/** `host[:port]` → canonical `host[:port]` (lower case, the scheme's default port dropped), or null. */
function authority(a: string, scheme: string): string | null {
  let host: string
  let port: string | undefined
  if (a.startsWith('[')) {
    const end = a.indexOf(']')
    if (end < 0) return null
    host = a.slice(0, end + 1).toLowerCase()
    const ip = host.slice(1, -1)
    if (!ip.includes(':') || !/^[0-9a-f:.]+$/.test(ip)) return null
    const rest = a.slice(end + 1)
    if (rest && !rest.startsWith(':')) return null
    port = rest ? rest.slice(1) : undefined
  } else {
    const i = a.indexOf(':')
    host = (i < 0 ? a : a.slice(0, i)).toLowerCase()
    port = i < 0 ? undefined : a.slice(i + 1)
    if (!dnsName(host)) return null
  }
  if (port !== undefined) {
    if (!/^\d{1,5}$/.test(port)) return null
    const n = Number(port)
    if (n < 1 || n > 65535) return null
    if (n !== (scheme === 'lores://' ? LORE_SECURE_DEFAULT_PORT : LORE_DEFAULT_PORT)) return `${host}:${n}`
  }
  return host
}

/** Splits `[lore[s]://]authority[/path]`; null for anything a URL could smuggle in. */
function split(input: string, schemeOptional: boolean): { authority: string; path: string; scheme: string } | null {
  let s = input.trim()
  if (!s || /[\s\u0000-\u001f\u007f?#\\@]/.test(s)) return null
  const scheme = schemeOf(s)
  if (isLoreUrl(s)) s = s.slice(s.indexOf('://') + 3)
  else if (!schemeOptional || /^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return null
  const i = s.indexOf('/')
  return i < 0 ? { authority: s, path: '', scheme } : { authority: s.slice(0, i), path: s.slice(i + 1), scheme }
}

/** A server address, `lore://` optional: canonical `lore://host[:port]` (or `lores://…`), or null. */
export function normalizeLoreServer(input: string): string | null {
  const parts = split(input, true)
  if (!parts || parts.path.replace(/\/$/, '') !== '') return null
  const a = authority(parts.authority, parts.scheme)
  return a ? `${parts.scheme}${a}` : null
}

/** Why `input` can't be saved as a server (null when it can); `list` and `selfId` catch a duplicate. */
export function loreServerProblem(input: string, list: LoreServer[] = [], selfId: string | null = null): string | null {
  if (!input.trim()) return t('lore.servers.urlMissing')
  const parts = split(input, true)
  if (parts && parts.path.replace(/\/$/, '') !== '') return t('lore.servers.urlHasRepo')
  const url = normalizeLoreServer(input)
  if (!url) return t('lore.servers.urlBad')
  const other = list.find(s => s.url === url && s.id !== selfId)
  return other ? t('lore.servers.urlTaken', { name: other.name }) : null
}

/** Why `name` can't be a repository name (null when it can). */
export function loreRepoNameProblem(name: string): string | null {
  const n = name.trim()
  if (!n) return t('lore.repo.nameMissing')
  const ok = n.length <= 200 && !/^[-./]/.test(n) && !n.endsWith('/') && /^[A-Za-z0-9/_.-]+$/.test(n)
    && n.split('/').every(p => p && p !== '.' && p !== '..')
  return ok ? null : t('lore.repo.nameBad')
}

/** A repository name from a project (folder) name: what Lore allows, the rest turned into `-`. */
export function loreRepoNameFrom(project: string): string {
  return project.trim().replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^[-.]+/, '').replace(/-+$/, '').slice(0, 200)
}

/** `lore[s]://host[:port]/name` → its server and name, or null. */
export function parseLoreRepoUrl(input: string): { server: string; name: string } | null {
  const parts = split(input, false)
  if (!parts) return null
  const a = authority(parts.authority, parts.scheme)
  const name = parts.path.replace(/\/$/, '')
  if (!a || loreRepoNameProblem(name)) return null
  return { server: `${parts.scheme}${a}`, name }
}

/**
 * The address to use for `server` from a project in an environment on the saved server `hostId` (null
 * for this computer): a server Mango set up there is reached from inside by its instance's own name.
 */
export function loreUrlFor(server: LoreServer, hostId: string | null): string {
  return hostId && server.insideUrl && server.origin?.hostId === hostId ? server.insideUrl : server.url
}
