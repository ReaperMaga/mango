import type { LoreServer } from '~/types/ipc'
import { t } from '../i18n/index.ts'

/**
 * Lore addresses as a person types them, checked and cleaned up the way the backend does
 * (`parse_server_url`, `parse_repo_url`, `valid_repo_name` in src-tauri/src/lore_servers.rs; keep them in
 * step). The backend checks again: this is for messages while typing. Plain Node testable.
 */

export const LORE_DEFAULT_PORT = 41337

/** A `lore://` address (any case). */
export function isLoreUrl(s: string): boolean {
  return /^lore:\/\//i.test(s.trim())
}

function dnsName(s: string): boolean {
  return s.length > 0 && s.length <= 253
    && s.split('.').every(l => l.length > 0 && l.length <= 63 && !l.startsWith('-') && !l.endsWith('-') && /^[a-z0-9-]+$/.test(l))
}

/** `host[:port]` → canonical `host[:port]` (lower case, default port dropped), or null. */
function authority(a: string): string | null {
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
    if (n !== LORE_DEFAULT_PORT) return `${host}:${n}`
  }
  return host
}

/** Splits `[lore://]authority[/path]`; null for anything a URL could smuggle in. */
function split(input: string, schemeOptional: boolean): { authority: string; path: string } | null {
  let s = input.trim()
  if (!s || /[\s\u0000-\u001f\u007f?#\\@]/.test(s)) return null
  if (isLoreUrl(s)) s = s.slice(7)
  else if (!schemeOptional || /^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return null
  const i = s.indexOf('/')
  return i < 0 ? { authority: s, path: '' } : { authority: s.slice(0, i), path: s.slice(i + 1) }
}

/** A server address, `lore://` optional: canonical `lore://host[:port]`, or null. */
export function normalizeLoreServer(input: string): string | null {
  const parts = split(input, true)
  if (!parts || parts.path.replace(/\/$/, '') !== '') return null
  const a = authority(parts.authority)
  return a ? `lore://${a}` : null
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

/** `lore://host[:port]/name` → its server and name, or null. */
export function parseLoreRepoUrl(input: string): { server: string; name: string } | null {
  const parts = split(input, false)
  if (!parts) return null
  const a = authority(parts.authority)
  const name = parts.path.replace(/\/$/, '')
  if (!a || loreRepoNameProblem(name)) return null
  return { server: `lore://${a}`, name }
}

/**
 * The address to use for `server` from a project in an environment on the saved server `hostId` (null
 * for this computer): a server Mango set up there is reached from inside by its instance's own name.
 */
export function loreUrlFor(server: LoreServer, hostId: string | null): string {
  return hostId && server.insideUrl && server.origin?.hostId === hostId ? server.insideUrl : server.url
}
