/**
 * Publishing a Lore server outside its Incus server (`env_lore_publish`, and the create dialog's
 * `lorePublish`): which address to offer first, and checking what the user typed the way the
 * backend will (`valid_listen_address`, `valid_publish_port` in src-tauri/src/envs/mod.rs).
 * Plain TypeScript, no Vue: tested in tests/lorePublish.test.ts.
 */
import type { EnvHostAddress } from '../types/ipc'

/** The port Lore listens on inside the instance, and the one offered outside. */
export const LORE_PORT = 41337

/** Every address of the Incus host, in IPv4 and IPv6. */
export const ALL_V4 = '0.0.0.0'
export const ALL_V6 = '::'

/** The address to offer first: the host's tailnet one, else a private one, else all of them. */
export function defaultLoreAddress(addresses: readonly EnvHostAddress[]): string {
  return (addresses.find(a => a.kind === 'tailscale' && !a.address.includes(':'))
    ?? addresses.find(a => a.kind === 'private' && !a.address.includes(':'))
    ?? addresses.find(a => a.kind !== 'public'))?.address ?? ALL_V4
}

const V4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/

/** An IP literal a listen address can take (no names, loopback, multicast or link-local). */
export function validListenAddress(raw: string): boolean {
  const a = raw.trim().replace(/^\[(.*)\]$/, '$1')
  if (V4.test(a)) {
    const first = Number(a.split('.')[0])
    return first !== 127 && !(first >= 224 && first <= 239)
  }
  if (!/^[0-9a-f:.]+$/i.test(a) || !a.includes(':') || (a.match(/::/g) ?? []).length > 1) return false
  const l = a.toLowerCase()
  if (l === '::1' || l.startsWith('ff') || /^fe[89ab]/.test(l)) return false
  // Groups of at most four hex digits (an embedded IPv4 tail aside).
  return l.split(':').every((g, i, all) => g.length <= 4 || (i === all.length - 1 && V4.test(g)))
}

/** A port to publish at: a whole number from 1024 to 65535. */
export function validPublishPort(raw: string | number): boolean {
  const s = String(raw).trim()
  if (!/^\d{1,5}$/.test(s)) return false
  const n = Number(s)
  return n >= 1024 && n <= 65535
}

/**
 * Whether publishing at `address` opens the server to the internet: all addresses, or one the
 * host calls public (an address it does not list counts as public, to be safe).
 */
export function exposesPublicly(address: string, addresses: readonly EnvHostAddress[]): boolean {
  const a = address.trim().replace(/^\[(.*)\]$/, '$1')
  if (a === ALL_V4 || a === ALL_V6) return true
  const known = addresses.find(x => x.address === a)
  return known ? known.kind === 'public' : true
}
