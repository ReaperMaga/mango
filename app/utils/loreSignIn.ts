import type { LoreSignIn, LoreSignInState } from '~/types/ipc'
import { LORE_DEFAULT_PORT } from './lore.ts'

/**
 * A Lore server's sign-in as typed (Settings > Lore > Set up a server, and an environment's Lore server):
 * checked the way the backend does (`valid_domain`, `valid_email`, `valid_github_org`,
 * `valid_github_client_id` and `clean` in src-tauri/src/lore_auth.rs; keep them in step). The backend
 * checks again: this is for messages while typing. Plain Node testable (tests/loreSignIn.test.ts).
 */

export const MAX_ORGS = 10

/** A DNS name with a dot, not an IP address: lower case, no trailing dot. */
export function validDomain(s: string): boolean {
  const d = s.trim().replace(/\.$/, '').toLowerCase()
  const labels = d.split('.')
  return d.length <= 253 && labels.length >= 2
    && labels.every(l => l.length > 0 && l.length <= 63 && !l.startsWith('-') && !l.endsWith('-') && /^[a-z0-9-]+$/.test(l))
    && !/^\d+$/.test(labels[labels.length - 1]!)
}

export function normalizeDomain(s: string): string {
  return s.trim().replace(/\.$/, '').toLowerCase()
}

export function validEmail(s: string): boolean {
  const e = s.trim().toLowerCase()
  const at = e.indexOf('@')
  if (at < 1 || at !== e.lastIndexOf('@') || e.length > 254) return false
  const local = e.slice(0, at)
  return local.length <= 64 && !local.startsWith('.') && !local.endsWith('.') && /^[a-z0-9._%+-]+$/.test(local) && validDomain(e.slice(at + 1))
}

export function validGithubOrg(s: string): boolean {
  const o = s.trim()
  return o.length > 0 && o.length <= 39 && /^[A-Za-z0-9-]+$/.test(o) && !o.startsWith('-') && !o.endsWith('-') && !o.includes('--')
}

export function validGithubClientId(s: string): boolean {
  const c = s.trim()
  return c.length >= 4 && c.length <= 100 && /^[A-Za-z0-9._-]+$/.test(c)
}

/** `fruit-co, acme` → the organisations, duplicates (any case) dropped. */
export function parseOrgs(s: string): string[] {
  const out: string[] = []
  for (const o of s.split(/[\s,]+/).map(x => x.trim()).filter(Boolean)) {
    if (!out.some(x => x.toLowerCase() === o.toLowerCase())) out.push(o)
  }
  return out
}

/** The form's values. */
export interface LoreSignInDraft {
  domain: string
  passwords: boolean
  github: boolean
  clientId: string
  orgs: string
  /** A first password user, asked for a password in the terminal (optional). */
  firstUser: string
}

export function draftFrom(s: LoreSignIn | LoreSignInState | null | undefined): LoreSignInDraft {
  return {
    domain: s?.domain ?? '',
    passwords: s ? s.passwords : true,
    github: !!s?.github,
    clientId: s?.github?.clientId ?? '',
    orgs: s?.github?.orgs.join(', ') ?? '',
    firstUser: '',
  }
}

/** What is wrong with each field (null when it is fine); `pick` when neither way to sign in is ticked. */
export interface LoreSignInProblems {
  domain: 'missing' | 'bad' | null
  pick: boolean
  clientId: 'missing' | 'bad' | null
  orgs: 'missing' | 'bad' | 'many' | null
  firstUser: 'bad' | null
}

export function draftProblems(d: LoreSignInDraft): LoreSignInProblems {
  const orgs = parseOrgs(d.orgs)
  return {
    domain: !d.domain.trim() ? 'missing' : validDomain(d.domain) ? null : 'bad',
    pick: !d.passwords && !d.github,
    clientId: !d.github ? null : !d.clientId.trim() ? 'missing' : validGithubClientId(d.clientId) ? null : 'bad',
    orgs: !d.github ? null : !orgs.length ? 'missing' : !orgs.every(validGithubOrg) ? 'bad' : orgs.length > MAX_ORGS ? 'many' : null,
    firstUser: d.passwords && d.firstUser.trim() && !validEmail(d.firstUser) ? 'bad' : null,
  }
}

export function draftValid(d: LoreSignInDraft): boolean {
  const p = draftProblems(d)
  return !p.domain && !p.pick && !p.clientId && !p.orgs && !p.firstUser
}

export function signInFrom(d: LoreSignInDraft): LoreSignIn {
  return {
    domain: normalizeDomain(d.domain),
    passwords: d.passwords,
    github: d.github ? { clientId: d.clientId.trim(), orgs: parseOrgs(d.orgs) } : null,
  }
}

/** The first user to hand to the setup: only with passwords, and only when typed. */
export function firstUserOf(d: LoreSignInDraft): string | null {
  return d.passwords && d.firstUser.trim() ? d.firstUser.trim().toLowerCase() : null
}

/** `lores://domain[:port]`, the address clients use with the sign-in on (as `secure_url`). */
export function secureUrl(domain: string, port: number): string {
  const d = normalizeDomain(domain)
  return port === LORE_DEFAULT_PORT ? `lores://${d}` : `lores://${d}:${port}`
}

/** The callback URL the GitHub OAuth app needs. */
export function githubCallback(domain: string): string {
  return `https://${normalizeDomain(domain) || 'your.domain'}/dex/callback`
}

/**
 * A name that points at a public IPv4 address with nothing to set up (sslip.io answers
 * `203-0-113-7.sslip.io` with 203.0.113.7): for someone without a domain. Null for anything else.
 */
export function sslipName(address: string): string | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(address.trim())
  if (!m) return null
  const o = m.slice(1).map(Number)
  if (o.some(n => n > 255)) return null
  const [a, b] = o as [number, number, number, number]
  const notPublic = a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
  return notPublic ? null : `${o.join('-')}.sslip.io`
}

/** How people sign in, as a short list: "passwords, GitHub (fruit-co, acme)". */
export function signInWays(s: { passwords: boolean; github: { orgs: string[] } | null }, words: { passwords: string; github: string }): string {
  const ways: string[] = []
  if (s.passwords) ways.push(words.passwords)
  if (s.github) ways.push(`${words.github} (${s.github.orgs.join(', ')})`)
  return ways.join(', ')
}
