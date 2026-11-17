/**
 * Base64 and UTF-8 without relying on the JS runtime: Hermes' `atob`/`TextDecoder` support has
 * varied between releases, and these must behave exactly like the desktop's Rust (`base64`
 * crate, `String::from_utf8_lossy`) since share links and command output pass through them.
 */

const STD = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

function table(alphabet: string): Int16Array {
  const t = new Int16Array(128).fill(-1)
  for (let i = 0; i < alphabet.length; i++) t[alphabet.charCodeAt(i)] = i
  return t
}
const STD_T = table(STD)
const URL_T = table(URL)

function decodeWith(s: string, t: Int16Array, padded: boolean): Uint8Array | null {
  let body = s
  if (padded) {
    if (s.length % 4 !== 0) return null
    const pad = s.endsWith('==') ? 2 : s.endsWith('=') ? 1 : 0
    body = s.slice(0, s.length - pad)
  }
  if (body.length % 4 === 1) return null
  const out = new Uint8Array(Math.floor((body.length * 3) / 4))
  let bits = 0
  let acc = 0
  let o = 0
  for (let i = 0; i < body.length; i++) {
    const c = body.charCodeAt(i)
    const v = c < 128 ? t[c]! : -1
    if (v < 0) return null
    acc = (acc << 6) | v
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out[o++] = (acc >> bits) & 0xff
    }
  }
  // Like the Rust crate: leftover bits must be zero (one encoding per value).
  if (bits > 0 && (acc & ((1 << bits) - 1)) !== 0) return null
  return out
}

function encodeWith(bytes: Uint8Array, alphabet: string, pad: boolean): string {
  let out = ''
  let i = 0
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!
    out += alphabet[(n >> 18) & 63]! + alphabet[(n >> 12) & 63]! + alphabet[(n >> 6) & 63]! + alphabet[n & 63]!
  }
  const rest = bytes.length - i
  if (rest === 1) {
    const n = bytes[i]! << 16
    out += alphabet[(n >> 18) & 63]! + alphabet[(n >> 12) & 63]! + (pad ? '==' : '')
  } else if (rest === 2) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8)
    out += alphabet[(n >> 18) & 63]! + alphabet[(n >> 12) & 63]! + alphabet[(n >> 6) & 63]! + (pad ? '=' : '')
  }
  return out
}

/** Standard alphabet with canonical padding (`STANDARD`); null when it is not base64. */
export const fromBase64 = (s: string) => decodeWith(s, STD_T, true)
/** URL-safe alphabet without padding (`URL_SAFE_NO_PAD`); null when it is not base64url. */
export const fromBase64Url = (s: string) => decodeWith(s, URL_T, false)
export const toBase64 = (b: Uint8Array) => encodeWith(b, STD, true)
export const toBase64Url = (b: Uint8Array) => encodeWith(b, URL, false)

/** UTF-8 bytes of a string (lone surrogates become U+FFFD). */
export function utf8Encode(s: string): Uint8Array {
  const out: number[] = []
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i)
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1)
      if (d >= 0xdc00 && d <= 0xdfff) {
        c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00)
        i++
      }
    }
    if (c >= 0xd800 && c <= 0xdfff) c = 0xfffd
    if (c < 0x80) out.push(c)
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63))
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63))
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63))
  }
  return Uint8Array.from(out)
}

/** Bytes as text, each invalid sequence replaced by U+FFFD (`String::from_utf8_lossy`). */
export function utf8Decode(b: Uint8Array): string {
  let out = ''
  let chunk: number[] = []
  const flush = () => {
    out += String.fromCharCode(...chunk)
    chunk = []
  }
  let i = 0
  while (i < b.length) {
    const c = b[i]!
    let need = 0
    let cp = 0
    let min = 0
    if (c < 0x80) { cp = c; need = 0 }
    else if (c >= 0xc2 && c <= 0xdf) { cp = c & 0x1f; need = 1; min = 0x80 }
    else if (c >= 0xe0 && c <= 0xef) { cp = c & 0x0f; need = 2; min = 0x800 }
    else if (c >= 0xf0 && c <= 0xf4) { cp = c & 0x07; need = 3; min = 0x10000 }
    else { chunk.push(0xfffd); i++; continue }
    let j = 1
    for (; j <= need; j++) {
      const n = b[i + j]
      if (n === undefined || (n & 0xc0) !== 0x80) break
      cp = (cp << 6) | (n & 0x3f)
      // Overlong, surrogate or out-of-range forms are cut short at the first bad byte.
      if (j === 1) {
        if ((c === 0xe0 && n < 0xa0) || (c === 0xed && n > 0x9f) || (c === 0xf0 && n < 0x90) || (c === 0xf4 && n > 0x8f)) break
      }
    }
    if (j <= need) { chunk.push(0xfffd); i += j; continue }
    if (cp < min) { chunk.push(0xfffd); i += need + 1; continue }
    if (cp >= 0x10000) {
      cp -= 0x10000
      chunk.push(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff))
    } else chunk.push(cp)
    i += need + 1
    if (chunk.length > 4096) flush()
  }
  flush()
  return out
}

/** Split bytes at every NUL (like `split(|b| b == 0)`). */
export function splitNul(b: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = []
  let start = 0
  for (let i = 0; i < b.length; i++) {
    if (b[i] === 0) {
      out.push(b.subarray(start, i))
      start = i + 1
    }
  }
  out.push(b.subarray(start))
  return out
}
