/**
 * Server names for Settings > Git hosting: what a person types for a GitHub Enterprise or self-managed
 * GitLab server, cleaned up the way the backend stores it (`normalize_host` in src-tauri/src/gitlab.rs;
 * keep them in step). Plain Node testable.
 */

export const GITHUB_COM = 'github.com'
export const GITLAB_COM = 'gitlab.com'

/** A host name, optionally with a port. */
export function isHost(s: string): boolean {
  const i = s.lastIndexOf(':')
  const name = i < 0 ? s : s.slice(0, i)
  if (i >= 0) {
    const port = s.slice(i + 1)
    if (!/^\d{1,5}$/.test(port) || Number(port) === 0 || Number(port) > 65535) return false
  }
  return name.length > 0 && name.length <= 253 && name.includes('.')
    && name.split('.').every(l => l.length > 0 && l.length <= 63 && !l.startsWith('-') && !l.endsWith('-') && /^[a-z0-9-]+$/i.test(l))
}

/** Trimmed, lower case, without a scheme, a path or `www.`; null when it is no host name. */
export function normalizeHost(input: string): string | null {
  let s = input.trim().toLowerCase()
  s = s.replace(/^https?:\/\//, '')
  s = s.split('/')[0] ?? ''
  if (s.startsWith('www.')) s = s.slice(4)
  return isHost(s) ? s : null
}

/** Why `input` can't be added to the list of GitLab servers, or null when it can. */
export function gitlabHostProblem(input: string, list: string[]): string | null {
  if (!input.trim()) return 'Type the server\'s name.'
  const host = normalizeHost(input)
  if (!host) return 'Type a server name like gitlab.example.com.'
  if (host === GITLAB_COM) return 'gitlab.com is always known.'
  if (host === GITHUB_COM) return 'github.com is GitHub, not a GitLab server.'
  if (list.includes(host)) return `${host} is already in the list.`
  return null
}
