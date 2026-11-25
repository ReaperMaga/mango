/** The repository a project collection belongs to, as the app already knows it. */

import { computed, watchEffect, type ComputedRef } from 'vue'
import type { MangoPluginApi } from '../host.ts'
import { safeUrl, type Collection } from '../model.ts'
import { isObject } from '../patch.ts'

/** `url` is null when the project has no repository on a forge. */
export interface Repository { readonly label: string; readonly url: string | null }

interface Forge { links?: Record<string, unknown>; ensure?: (path: string) => void }

export function useRepository(mango: MangoPluginApi, collection: () => Collection): ComputedRef<Repository | null> {
  // Mango's stores come without a promise: without this one the project's name is shown.
  const forge = (() => {
    try {
      return mango.stores.byId('forge') as Forge | null
    } catch {
      return null
    }
  })()
  const path = computed(() => {
    const { scope } = collection()
    return scope.kind === 'project' ? scope.path : null
  })
  watchEffect(() => {
    if (path.value && typeof forge?.ensure === 'function') forge.ensure(path.value)
  })
  return computed(() => {
    if (!path.value) return null
    const link = forge?.links?.[path.value]
    const text = (k: string) => (isObject(link) && typeof link[k] === 'string' ? link[k] as string : '')
    const url = text('host') && text('owner') && text('repo') ? safeUrl(`https://${text('host')}/${text('owner')}/${text('repo')}`) : null
    if (url) return { label: `${text('owner')}/${text('repo')}`, url }
    const name = path.value.replace(/[\\/]+$/, '').split(/[\\/]/).at(-1)
    return name ? { label: name, url } : null
  })
}
