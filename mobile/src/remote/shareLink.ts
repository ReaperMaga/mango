import { fromBase64, fromBase64Url, toBase64Url, utf8Decode, utf8Encode } from './bytes'
import { hasControl, utcText, utf8Length, validInstance } from './shell'
import type { Env } from './types'

/**
 * Share links: `mango://join/<payload>`, read exactly as the desktop reads them
 * (`src-tauri/src/envs/token.rs`) and turned into a saved env as `join.rs` does.
 *
 * A link gives full access to one environment and nothing else: it carries a fresh Ed25519 key
 * seed made for this share (the public half is in the environment's `authorized_keys`) and pins
 * the environment's SSH host key, so the phone connects to exactly that environment.
 *
 * Payload: base64url (no padding) of compact JSON, see `ShareToken`.
 */

export const SCHEME_PREFIX = 'mango://join/'
const MAX_LINK = 2048

/** Everything a share link carries (field names as in the link). */
export interface ShareToken {
  /** Format version (1). */
  v: number
  /** The share's id (also in the key's comment, so it can be revoked). */
  id: string
  /** The environment's name (the instance). */
  n: string
  /** Where it was shared from, for display, e.g. "forge/dev". */
  f: string
  /** Address to connect to (an IP or DNS name). */
  h: string
  /** SSH port. */
  p: number
  /** User inside the environment. */
  u: string
  /** The Ed25519 private key seed, base64url. */
  k: string
  /** The environment's SSH host key: the base64 blob of its `ssh-ed25519` public key. */
  hk: string
  /** When the access ends (unix seconds); 0 = never. */
  e: number
}

const validAddress = (h: string) => h.length > 0 && h.length <= 253 && !h.startsWith('-') && /^[A-Za-z0-9.:-]+$/.test(h)

const validUser = (u: string) => u.length > 0 && u.length <= 32 && /^[a-z_][a-z0-9_-]*$/.test(u)

const ED25519 = [0, 0, 0, 11, ...'ssh-ed25519'.split('').map(c => c.charCodeAt(0))]

/** The base64 wire blob of an `ssh-ed25519` key: string "ssh-ed25519", string <32 bytes>. */
export function validHostKey(hk: string): boolean {
  const blob = fromBase64(hk)
  return !!blob && blob.length === 51 && ED25519.every((b, i) => blob[i] === b)
}

/** The 32-byte key seed in a link; throws when it is damaged. */
export function decodeSeed(s: string): Uint8Array {
  const bytes = fromBase64Url(s.trim())
  if (!bytes || bytes.length !== 32) throw new Error("The link's key is damaged.")
  return bytes
}

const isInt = (x: unknown, max: number): x is number => typeof x === 'number' && Number.isInteger(x) && x >= 0 && x <= max

/** Read a pasted link (or bare payload) and check every field; throws a readable message otherwise. */
export function decode(link: string): ShareToken {
  const clean = link.replace(/\s+/g, '')
  if (utf8Length(clean) > MAX_LINK) throw new Error('That is not a Mango share link (it is far too long).')
  const payload = clean.startsWith(SCHEME_PREFIX) ? clean.slice(SCHEME_PREFIX.length) : clean
  const bad = () => new Error('That is not a Mango share link. Paste the whole line that starts with mango://join/.')
  const json = fromBase64Url(payload.replace(/=+$/, ''))
  if (!json) throw bad()
  let raw: unknown
  try { raw = JSON.parse(utf8Decode(json)) } catch { throw bad() }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw bad()
  const r = raw as Record<string, unknown>
  // Typed as serde reads them: required strings and numbers, `e` defaulting to 0.
  const strings = ['id', 'n', 'f', 'h', 'u', 'k', 'hk'] as const
  if (!isInt(r.v, 255) || !isInt(r.p, 65535) || strings.some(k => typeof r[k] !== 'string')) throw bad()
  if (r.e !== undefined && !isInt(r.e, Number.MAX_SAFE_INTEGER)) throw bad()
  const t: ShareToken = {
    v: r.v, id: r.id as string, n: r.n as string, f: r.f as string, h: r.h as string,
    p: r.p, u: r.u as string, k: r.k as string, hk: r.hk as string, e: (r.e as number | undefined) ?? 0,
  }
  if (t.v !== 1) throw new Error('This share link is from a newer Mango. Update Mango to join it.')
  validInstance(t.n)
  const ok = /^[A-Za-z0-9-]{1,64}$/.test(t.id)
    && [...t.f].length <= 200
    && !hasControl(t.f)
    && validAddress(t.h)
    && t.p !== 0
    && validUser(t.u)
    && validHostKey(t.hk)
  if (!ok) throw bad()
  decodeSeed(t.k)
  return t
}

/** The `mango://join/…` link for a token (as the owner's Mango makes it; for tests and the mock). */
export function encode(t: ShareToken): string {
  // serde writes the fields in declaration order.
  const json = JSON.stringify({ v: t.v, id: t.id, n: t.n, f: t.f, h: t.h, p: t.p, u: t.u, k: t.k, hk: t.hk, e: t.e })
  return `${SCHEME_PREFIX}${toBase64Url(utf8Encode(json))}`
}

/** A `mango://join/…` link opened from outside (deep link, QR code), or null for anything else. */
export function joinLinkOf(url: string): string | null {
  const u = url.trim()
  const ok = u.length > SCHEME_PREFIX.length && u.length <= 4096 && u.slice(0, SCHEME_PREFIX.length).toLowerCase() === SCHEME_PREFIX
  return ok ? u : null
}

/* ---------- from a token to a saved env (`join.rs`) ---------- */

/** When access ends (unix ms), null for a link without an end. */
export const expiresMs = (t: ShareToken): number | null => (t.e !== 0 ? t.e * 1000 : null)

/** `host:port`, with brackets around an IPv6 address. */
export const endpointText = (t: ShareToken) => (t.h.includes(':') ? `[${t.h}]:${t.p}` : `${t.h}:${t.p}`)

export interface JoinPreview {
  instance: string
  sharedFrom: string
  endpoint: string
  expiresAt: number | null
  /** This phone already joined the same share: joining again refreshes it. */
  alreadyJoined: boolean
}

export function preview(t: ShareToken, saved: readonly Env[]): JoinPreview {
  return {
    instance: t.n,
    sharedFrom: t.f,
    endpoint: endpointText(t),
    expiresAt: expiresMs(t),
    alreadyJoined: saved.some(e => e.joined?.shareId === t.id),
  }
}

/** Refuse a link whose access has ended. */
export function checkNotExpired(t: ShareToken, now: number): void {
  const at = expiresMs(t)
  if (at !== null && at <= now) {
    throw new Error(`This link expired on ${utcText(at)}. Ask whoever shared it (${t.f}) for a new one.`)
  }
}

/** The name to show: what the user typed, else what it was called before, else the instance. */
export function pickName(typed: string | null | undefined, before: string | null | undefined, t: ShareToken): string {
  const name = typed?.trim() || before || t.n
  if ([...name].length > 60) throw new Error('Keep the name under 60 characters.')
  if (hasControl(name)) throw new Error("The name can't contain control characters.")
  return name
}

/**
 * The saved env for a token. `keyId` names the Keychain entry holding the link's key
 * (`ssh.importKey(keyId, t.k)`); the host key is pinned to the one in the link.
 */
export function envFromToken(t: ShareToken, id: string, name: string, keyId: string, addedAt: number): Env {
  return {
    id,
    name,
    endpoint: { host: t.h, port: t.p, user: t.u, hostKey: t.hk, keyId },
    joined: { instance: t.n, sharedFrom: t.f, shareId: t.id, expiresAt: expiresMs(t) },
    addedAt,
  }
}
