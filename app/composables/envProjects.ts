import type { EnvInstanceStatus, EnvRemote } from '~/types/ipc'
import { directProblem, directState, instanceKey, useEnvironments } from '~/stores/environments'
import { useWorkspace } from '~/stores/workspace'
import { parseEnvPath } from '~/utils/envPath'

/** Where a remote project lives, for labels: its instance, server and folder. */
export interface RemotePlace {
  hostId: string
  instance: string
  /** The server's name; its id while the saved servers have not been read, or once it is removed. */
  host: string
  /** The folder inside the instance. */
  dir: string
  /** "dev on forge" */
  where: string
  /** Short name for a chip: the instance ("dev"), or a joined environment's own name ("review"). */
  label: string
  /** What follows the short name when there is room: "on forge", or "shared". */
  sub: string
  /** Joined from someone else's share link. */
  shared: boolean
}

/** The labels of an environment, wherever it is shown. Reactive: reads the environments store. */
export function envLabels(hostId: string, instance: string): Omit<RemotePlace, 'dir'> {
  const saved = useEnvironments().host(hostId)
  const host = saved?.name ?? 'a server Mango no longer knows'
  // A joined environment has no server of the user's: it is known by its own name ("review, shared").
  if (saved?.direct) return { hostId, instance, host, where: `${saved.name}, shared`, label: saved.name, sub: 'shared', shared: true }
  return { hostId, instance, host, where: `${instance} on ${host}`, label: instance, sub: `on ${host}`, shared: false }
}

/** Null for a project on this computer. Reactive: reads the environments store. */
export function remotePlace(path: string | null | undefined): RemotePlace | null {
  const loc = parseEnvPath(path)
  if (!loc) return null
  return { ...envLabels(loc.hostId, loc.instance), dir: loc.dir }
}

/**
 * How an environment is doing, from what the environments store already knows (nothing is
 * checked here; see `refreshEnv`):
 * - `ready`: running and reachable
 * - `moving`: starting or stopping
 * - `off`: stopped (start it from Settings)
 * - `bad`: can't be reached or used (with the reason as `label`)
 * - `unknown`: not checked yet this session
 */
export type EnvTone = 'ready' | 'moving' | 'off' | 'bad' | 'unknown'
export interface EnvState { tone: EnvTone; label: string; status: EnvInstanceStatus }

export function envState(hostId: string, instance: string): EnvState {
  const envs = useEnvironments()
  const host = envs.host(hostId)
  if (envs.loaded && !host) return { tone: 'bad', label: 'No longer saved in Mango', status: 'error' }
  const probe = envs.probes[hostId]
  if (host?.direct) {
    const s = directState(host, probe, !!envs.probing[hostId])
    if (directProblem(host, probe)) return { tone: 'bad', label: s.label, status: 'error' }
    if (s.tone === 'ready') return { tone: 'ready', label: 'Connected', status: 'running' }
    return { tone: 'unknown', label: s.label, status: 'unknown' }
  }
  if (probe && !probe.reachable) return { tone: 'bad', label: 'Can\'t reach its server', status: 'error' }
  if (probe && !probe.ok) return { tone: 'bad', label: 'Incus isn\'t ready on its server', status: 'error' }
  const inst = envs.instance(hostId, instance)
  const busy = envs.busy[instanceKey(hostId, instance)]
  if (busy === 'start' || busy === 'restart') return { tone: 'moving', label: 'Starting…', status: 'starting' }
  if (busy === 'stop') return { tone: 'moving', label: 'Stopping…', status: 'stopping' }
  if (busy === 'rename') return { tone: 'moving', label: 'Renaming…', status: 'stopping' }
  if (!inst) {
    if (envs.instances[hostId]) return { tone: 'bad', label: 'Not on its server any more', status: 'error' }
    return { tone: 'unknown', label: envs.probing[hostId] || envs.loadingInstances[hostId] ? 'Checking…' : 'Not checked', status: 'unknown' }
  }
  switch (inst.status) {
    case 'running': return { tone: 'ready', label: 'Running', status: 'running' }
    case 'starting': return { tone: 'moving', label: 'Starting…', status: 'starting' }
    case 'stopping': return { tone: 'moving', label: 'Stopping…', status: 'stopping' }
    case 'stopped': return { tone: 'off', label: 'Stopped', status: 'stopped' }
    case 'frozen': return { tone: 'off', label: 'Frozen', status: 'frozen' }
    case 'error': return { tone: 'bad', label: 'In an error state', status: 'error' }
    default: return { tone: 'unknown', label: 'Not checked', status: 'unknown' }
  }
}

/* ---------- checking, lazily ---------- */

/** When each server was last checked from here, so opening a menu twice does not probe twice. */
const checkedAt = new Map<string, number>()
const FRESH_MS = 60_000

/** Check one server (and list its instances) unless that happened in the last minute. */
export async function refreshEnv(hostId: string, force = false) {
  const envs = useEnvironments()
  if (!envs.loaded) await envs.load().catch(() => {})
  if (!envs.host(hostId) || envs.probing[hostId]) return
  const at = checkedAt.get(hostId) ?? 0
  if (!force && Date.now() - at < FRESH_MS && envs.probes[hostId]) return
  checkedAt.set(hostId, Date.now())
  await envs.refreshHost(hostId).catch(() => {})
}

/**
 * Every saved server and joined environment, for a list of places to pick from. With `once`,
 * only those not checked yet this session (for places that open often, like the command palette).
 */
export async function refreshEnvs(opts: { once?: boolean } = {}) {
  const envs = useEnvironments()
  if (!envs.loaded) await envs.load().catch(() => {})
  await Promise.all(envs.hosts.filter(h => !opts.once || !checkedAt.has(h.id)).map(h => refreshEnv(h.id)))
}

/* ---------- where new projects go ---------- */

/**
 * The remembered place for Open folder, New project and Clone: an environment, or null for this
 * computer. One that is no longer saved counts as this computer.
 */
export function projectWhere(): EnvRemote | null {
  const ws = useWorkspace()
  const envs = useEnvironments()
  const w = ws.where
  if (!w) return null
  if (envs.loaded && !envs.host(w.hostId)) return null
  return w
}

export const samePlace = (a: EnvRemote | null | undefined, b: EnvRemote | null | undefined) =>
  (!a && !b) || (!!a && !!b && a.hostId === b.hostId && a.instance === b.instance)
