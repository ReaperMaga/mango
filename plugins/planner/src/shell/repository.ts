/** The repository a project belongs to, as the app already knows it (Mango's forge store). */

import { computed, watchEffect, type ComputedRef } from 'vue'
import type { MangoPluginApi } from '../host.ts'
import { projectKey, safeUrl, type Collection, type ProjectIdentity, type Scope } from '../model.ts'
import { isObject } from '../patch.ts'
import type { PlannerStore } from '../store.ts'

interface Forge { links?: Record<string, unknown>; ensure?: (path: string) => void }
interface Link { host: string; owner: string; repo: string }

/** Mango's stores come without a promise: without this one the repository is just not known. */
function forgeOf(mango: MangoPluginApi): Forge | null {
  try {
    return (mango.stores.byId('forge') as Forge | null | undefined) ?? null
  } catch {
    return null
  }
}
function linkOf(mango: MangoPluginApi, path: string): Link | null {
  const link = forgeOf(mango)?.links?.[path]
  if (!isObject(link)) return null
  const { host, owner, repo } = link
  return typeof host === 'string' && typeof owner === 'string' && typeof repo === 'string' && host && owner && repo ? { host, owner, repo } : null
}
function ensure(mango: MangoPluginApi, path: string) {
  const forge = forgeOf(mango)
  if (typeof forge?.ensure === 'function') forge.ensure(path)
}

/** `host/owner/name` of a project's repository, or null while it is not known. Reactive. */
export function repoOf(mango: MangoPluginApi, path: string): string | null {
  const l = linkOf(mango, path)
  return l ? `${l.host}/${l.owner}/${l.repo}` : null
}

/** A new collection's place: the project in view, with its repository when known, or everywhere. */
export function scopeOf({ mango, store }: { mango: MangoPluginApi; store: PlannerStore }, where: 'project' | 'everywhere'): Scope {
  const path = store.projectPath.value
  if (where !== 'project' || !path) return { kind: 'everywhere' }
  const repo = repoOf(mango, path)
  return { kind: 'project', path, ...(repo ? { repo } : {}) }
}

/** Keeps the store told which repository is open, and which project folders are this computer's. */
export function identifyProjects(mango: MangoPluginApi, store: PlannerStore): () => void {
  return watchEffect(() => {
    const path = store.projectPath.value
    if (!path) return store.identifyProject(null)
    ensure(mango, path)
    const workspace = (mango.stores as Partial<typeof mango.stores> | undefined)?.workspace as { recent?: unknown } | undefined
    const recent = Array.isArray(workspace?.recent) ? workspace.recent.map(r => (isObject(r) ? r.path : null)) : []
    const here = new Set([...mango.workspace.openProjects(), ...recent].filter(p => typeof p === 'string').map(projectKey))
    const identity: ProjectIdentity = { repo: repoOf(mango, path), hasPath: p => here.has(projectKey(p)) }
    store.identifyProject(identity)
  })
}

/** `url` is null when the project has no repository on a forge. */
export interface Repository { readonly label: string; readonly url: string | null }

export function useRepository(mango: MangoPluginApi, store: PlannerStore, collection: () => Collection): ComputedRef<Repository | null> {
  // Made on another computer it is here by its repository: that of the project in view.
  const path = computed(() => {
    const { scope } = collection()
    return scope.kind === 'project' ? (scope.repo && store.projectPath.value && repoOf(mango, store.projectPath.value) === scope.repo ? store.projectPath.value : scope.path) : null
  })
  watchEffect(() => { if (path.value) ensure(mango, path.value) })
  return computed(() => {
    if (!path.value) return null
    const l = linkOf(mango, path.value)
    const url = l ? safeUrl(`https://${l.host}/${l.owner}/${l.repo}`) : null
    if (l && url) return { label: `${l.owner}/${l.repo}`, url }
    const name = path.value.replace(/[\\/]+$/, '').split(/[\\/]/).at(-1)
    return name ? { label: name, url: null } : null
  })
}
