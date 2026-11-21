import type { Thread } from '~/types/chat'
import { parseEnvPath } from '~/utils/envPath'
import type { Env, Instance, RemoteProject } from '@/remote/types'
import { projectName } from './names'

/** `projectsKey` of `@/state/envs`, kept here so this stays free of the stores (and testable in Node). */
const projectsKey = (envId: string, instance: string) => `${envId}/${instance}`

/** An instance a chat can run in: a joined environment's one, or a server's running ones. */
export interface Place {
  env: Env
  instance: string
}

/** A project to start a chat in, with when a chat there was last active (0: never). */
export interface KnownProject extends RemoteProject {
  envId: string
  instance: string
  lastUsed: number
}

export function placesOf(envs: readonly Env[], instances: Record<string, Instance[] | undefined>): Place[] {
  const out: Place[] = []
  for (const env of envs) {
    if (env.joined) out.push({ env, instance: env.joined.instance })
    else for (const i of instances[env.id] ?? []) if (i.state === 'running') out.push({ env, instance: i.name })
  }
  return out
}

/**
 * Whether `path` is a chat's linked worktree rather than a project: one a chat works in, or a
 * folder where Mango puts them (`<parent>/<repo>.worktrees/<branch>`, `remote/git.ts`).
 */
function isWorktree(path: string, worktrees: ReadonlySet<string>): boolean {
  if (worktrees.has(path)) return true
  const parent = path.replace(/\/+$/, '').split('/').slice(0, -1).pop() ?? ''
  return parent.endsWith('.worktrees') && parent !== '.worktrees'
}

/**
 * The projects of `places`: the git repositories the scan found, plus every folder a chat already
 * works in (the desktop opens any folder, git or not, anywhere in the instance; the scan only sees
 * repositories under the agent's home). Worktrees are not projects: a chat gets one from the
 * "New worktree" switch once its project is picked. Recently used first, then by name.
 */
export function knownProjects(
  places: readonly Place[],
  scanned: Record<string, RemoteProject[] | undefined>,
  threads: Record<string, Thread>,
): KnownProject[] {
  const byPath = new Map<string, KnownProject>()
  const inPlace = new Set(places.map(p => projectsKey(p.env.id, p.instance)))
  const worktrees = new Set<string>()
  for (const th of Object.values(threads)) if (th.worktree) worktrees.add(th.worktree)
  for (const p of places) {
    for (const r of scanned[projectsKey(p.env.id, p.instance)] ?? []) {
      if (isWorktree(r.path, worktrees)) continue
      byPath.set(r.path, { ...r, envId: p.env.id, instance: p.instance, lastUsed: 0 })
    }
  }
  for (const th of Object.values(threads)) {
    if (th.parentId) continue
    const loc = parseEnvPath(th.projectPath)
    if (!loc || !inPlace.has(projectsKey(loc.hostId, loc.instance))) continue
    if (isWorktree(th.projectPath, worktrees)) continue
    const known = byPath.get(th.projectPath)
    if (known) known.lastUsed = Math.max(known.lastUsed, th.updatedAt)
    else byPath.set(th.projectPath, { path: th.projectPath, name: projectName(th.projectPath), branch: null, envId: loc.hostId, instance: loc.instance, lastUsed: th.updatedAt })
  }
  return [...byPath.values()].sort((a, b) => b.lastUsed - a.lastUsed || a.name.localeCompare(b.name))
}
