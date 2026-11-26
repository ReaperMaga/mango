/**
 * A Lore server on a machine over SSH (Settings > Lore > Set up a server, `lore_machine_run`): the
 * SSH destination checked as the backend does (`valid_ssh_dest` in src-tauri/src/envs/mod.rs), the
 * machine's name, and the address clients use. Plain TypeScript, no Vue: tested in
 * tests/loreMachine.test.ts.
 */
import type { LoreMachine } from '../types/ipc'
import { ALL_V4, ALL_V6, LORE_PORT } from './lorePublish.ts'

/** `host`, `user@host` or an alias from ~/.ssh/config; never an option. */
export function validSshDest(raw: string): boolean {
  const s = raw.trim()
  return s.length > 0 && s.length <= 255 && !s.startsWith('-') && /^[A-Za-z0-9._@%+:-]+$/.test(s)
}

/** The host part of an SSH destination: `me@build.lan` -> `build.lan`. */
export function machineHost(ssh: string): string {
  const s = ssh.trim()
  return s.slice(s.lastIndexOf('@') + 1)
}

/** Listening on every address (so clients use the machine's name instead). */
export function listensEverywhere(address: string): boolean {
  const a = address.trim().replace(/^\[(.*)\]$/, '$1')
  return a === ALL_V4 || a === ALL_V6
}

/** `lore://host[:port]`: IPv6 in brackets, Lore's own port left out (as the backend's `lore_url`). */
export function loreUrl(host: string, port: number): string {
  const h = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
  return port === LORE_PORT ? `lore://${h}` : `lore://${h}:${port}`
}

/**
 * What clients connect to: the address it listens at, or the machine's SSH host when it listens
 * on all of them (the user can change it: an SSH alias is not a name others can look up).
 */
export function clientUrl(m: Pick<LoreMachine, 'ssh' | 'address' | 'listenPort'>): string {
  const host = listensEverywhere(m.address) ? machineHost(m.ssh) : m.address.trim().replace(/^\[(.*)\]$/, '$1')
  return loreUrl(host, m.listenPort)
}
