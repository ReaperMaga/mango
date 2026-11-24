/**
 * Projects inside a remote environment (an Incus instance on a master server) are keyed by a
 * path of the form `env://<hostId>/<instance>/<absolute folder inside the instance>`, e.g.
 * `env://6f1c…/dev/home/agent/work/shop`. Everything that keys by project path (threads,
 * tabs, recent projects) works unchanged; whatever touches the disk must check `isEnvPath`
 * first, because the folder is not on this computer.
 */
import type { EnvRemote } from '~/types/ipc'

const PREFIX = 'env://'

export interface EnvLocation extends EnvRemote {
  /** Absolute folder inside the instance, e.g. /home/agent/work/shop */
  dir: string
}

export const isEnvPath = (path: string | null | undefined): boolean => !!path && path.startsWith(PREFIX)

export function envPath(loc: EnvLocation): string {
  const dir = loc.dir.startsWith('/') ? loc.dir : `/${loc.dir}`
  return `${PREFIX}${loc.hostId}/${loc.instance}${dir.replace(/\/+$/, '') || '/'}`
}

/**
 * `path` with its instance renamed from `from` to `to` (on server `hostId`), or null when it is
 * not inside that instance. Used to move projects, chats and prefs along when an instance is renamed.
 */
export function movedEnvPath(path: string | null | undefined, hostId: string, from: string, to: string): string | null {
  const loc = parseEnvPath(path)
  if (!loc || loc.hostId !== hostId || loc.instance !== from) return null
  return envPath({ ...loc, instance: to })
}

/**
 * Which computer an agent CLI for `path` runs on: `local` for this one, `env://<hostId>/<instance>`
 * for a remote environment. What a CLI reports about itself (its models, its sign-in) belongs to that
 * place, not to the project folder, so lists like that are kept per place.
 */
export function placeKey(path: string | null | undefined): string {
  const loc = parseEnvPath(path)
  return loc ? `${PREFIX}${loc.hostId}/${loc.instance}` : 'local'
}

/** The parts of an env:// path; null for a local path. */
export function parseEnvPath(path: string | null | undefined): EnvLocation | null {
  if (!path || !path.startsWith(PREFIX)) return null
  const m = /^([^/]+)\/([^/]+)(\/.*)?$/.exec(path.slice(PREFIX.length))
  if (!m) return null
  return { hostId: m[1]!, instance: m[2]!, dir: m[3] || '/' }
}
