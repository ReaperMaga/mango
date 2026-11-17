/// <reference types="node" />
import { describe, expect, it } from 'vitest'
import { fromBase64, fromBase64Url, toBase64, toBase64Url, utf8Decode, utf8Encode } from './bytes'
import {
  SCHEME_PREFIX, checkNotExpired, decode, encode, envFromToken, joinLinkOf, pickName, preview, type ShareToken,
} from './shareLink'

/** Ported from `src-tauri/src/envs/token.rs` and `join.rs`. */

/** The wire blob of an ssh-ed25519 key: string "ssh-ed25519", string <32 bytes>. */
function hostKey(fill = 5): string {
  return Buffer.concat([Buffer.from([0, 0, 0, 11]), Buffer.from('ssh-ed25519'), Buffer.from([0, 0, 0, 32]), Buffer.alloc(32, fill)]).toString('base64')
}

function token(e = 0): ShareToken {
  return {
    v: 1,
    id: 'a1b2c3',
    n: 'dev',
    f: 'forge/dev',
    h: '203.0.113.24',
    p: 22001,
    u: 'agent',
    k: Buffer.alloc(32, 9).toString('base64url'),
    hk: hostKey(),
    e,
  }
}

/** A link exactly as the desktop's `token::encode` makes it: serde's compact JSON, base64url without padding. */
function desktopLink(t: ShareToken | Record<string, unknown>): string {
  return SCHEME_PREFIX + Buffer.from(JSON.stringify(t)).toString('base64url')
}

describe('share links', () => {
  it('round-trips a link the desktop made', () => {
    const t = token()
    const link = desktopLink(t)
    expect(link.length).toBeLessThan(400)
    expect(decode(link)).toEqual(t)
    expect(encode(t)).toBe(link)
    // Pasted with line breaks or without the scheme.
    const wrapped = `  ${link.slice(0, 40)}\n${link.slice(40)}  `
    expect(decode(wrapped)).toEqual(t)
    expect(decode(link.slice(SCHEME_PREFIX.length))).toEqual(t)
    // `e` may be left out (serde's default).
    const { e: _, ...noEnd } = t
    expect(decode(desktopLink(noEnd)).e).toBe(0)
  })

  it('rejects bad links', () => {
    expect(() => decode('https://example.com')).toThrow()
    expect(() => decode('mango://join/!!!')).toThrow()
    expect(() => decode(desktopLink({ ...token(), h: '-oProxyCommand=sh' }))).toThrow()
    expect(() => decode(desktopLink({ ...token(), u: 'root;id' }))).toThrow()
    expect(() => decode(desktopLink({ ...token(), hk: Buffer.from('not a key').toString('base64') }))).toThrow()
    expect(() => decode(desktopLink({ ...token(), n: 'dev;rm' }))).toThrow()
    expect(() => decode(desktopLink({ ...token(), p: 0 }))).toThrow()
    expect(() => decode(desktopLink({ ...token(), p: 70000 }))).toThrow()
    expect(() => decode(desktopLink({ ...token(), p: '22' }))).toThrow()
    expect(() => decode(desktopLink({ ...token(), f: 'a\u0007b' }))).toThrow()
    expect(() => decode(desktopLink({ ...token(), k: 'short' }))).toThrow(/key is damaged/)
    expect(() => decode(desktopLink({ ...token(), v: 2 }))).toThrow(/newer Mango/)
    expect(() => decode(`${SCHEME_PREFIX}${'A'.repeat(3000)}`)).toThrow(/far too long/)
  })

  it('previews and names', () => {
    const t = token()
    const p = preview(t, [])
    expect([p.instance, p.sharedFrom, p.endpoint]).toEqual(['dev', 'forge/dev', '203.0.113.24:22001'])
    expect(p.expiresAt).toBeNull()
    expect(p.alreadyJoined).toBe(false)
    const saved = envFromToken(t, 'x', 'dev', 'key-x', 0)
    expect(preview(t, [saved]).alreadyJoined).toBe(true)
    const v6 = { ...token(5), h: 'fd7a:115c:a1e0::1' }
    expect(preview(v6, []).endpoint).toBe('[fd7a:115c:a1e0::1]:22001')
    expect(preview(v6, []).expiresAt).toBe(5000)

    expect(pickName(null, null, t)).toBe('dev')
    expect(pickName('  ', 'Old', t)).toBe('Old')
    expect(pickName(' Mine ', 'Old', t)).toBe('Mine')
    expect(() => pickName('x'.repeat(61), null, t)).toThrow()
    expect(() => pickName('a\nb', null, t)).toThrow()
  })

  it('refuses expired links', () => {
    expect(() => checkNotExpired(token(0), Number.MAX_SAFE_INTEGER)).not.toThrow()
    expect(() => checkNotExpired(token(2_000_000_000), 1000)).not.toThrow()
    expect(() => checkNotExpired(token(1000), 1_000_001)).toThrow(
      'This link expired on 1970-01-01 00:16 UTC. Ask whoever shared it (forge/dev) for a new one.',
    )
  })

  it('turns a token into an env', () => {
    const env = envFromToken(token(1_900_000_000), 'id1', 'My dev', 'key-1', 42)
    expect(env.endpoint).toEqual({ host: '203.0.113.24', port: 22001, user: 'agent', hostKey: hostKey(), keyId: 'key-1' })
    expect(env.joined).toEqual({ instance: 'dev', sharedFrom: 'forge/dev', shareId: 'a1b2c3', expiresAt: 1_900_000_000_000 })
    expect(env.server).toBeUndefined()
  })

  it('finds join links among opened URLs', () => {
    expect(joinLinkOf(' mango://join/abc ')).toBe('mango://join/abc')
    expect(joinLinkOf('MANGO://JOIN/abc')).toBe('MANGO://JOIN/abc')
    expect(joinLinkOf('mango://join/')).toBeNull()
    expect(joinLinkOf('mango://settings')).toBeNull()
    expect(joinLinkOf(`mango://join/${'a'.repeat(5000)}`)).toBeNull()
  })
})

describe('bytes', () => {
  it('matches Node for base64 and UTF-8', () => {
    for (const n of [0, 1, 2, 3, 31, 32, 51, 100]) {
      const b = Uint8Array.from({ length: n }, (_, i) => (i * 37 + 11) & 255)
      expect(toBase64(b)).toBe(Buffer.from(b).toString('base64'))
      expect(toBase64Url(b)).toBe(Buffer.from(b).toString('base64url'))
      expect(fromBase64(toBase64(b))).toEqual(b)
      expect(fromBase64Url(toBase64Url(b))).toEqual(b)
    }
    expect(fromBase64('abc')).toBeNull()
    expect(fromBase64Url('a+b')).toBeNull()
    const s = 'héllo — 漢字 🍋'
    expect(utf8Encode(s)).toEqual(new Uint8Array(Buffer.from(s)))
    expect(utf8Decode(new Uint8Array(Buffer.from(s)))).toBe(s)
    // Invalid sequences become U+FFFD, like `from_utf8_lossy`.
    expect(utf8Decode(Uint8Array.from([0x61, 0xff, 0x62, 0xe2, 0x82, 0x63]))).toBe('a�b�c')
    expect(utf8Decode(Uint8Array.from([0xe0, 0x80, 0x41]))).toBe('��A')
  })
})
