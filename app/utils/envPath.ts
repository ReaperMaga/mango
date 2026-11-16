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

/** The parts of an env:// path; null for a local path. */
export function parseEnvPath(path: string | null | undefined): EnvLocation | null {
  if (!path || !path.startsWith(PREFIX)) return null
  const m = /^([^/]+)\/([^/]+)(\/.*)?$/.exec(path.slice(PREFIX.length))
  if (!m) return null
  return { hostId: m[1]!, instance: m[2]!, dir: m[3] || '/' }
}
