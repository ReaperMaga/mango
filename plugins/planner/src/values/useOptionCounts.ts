import { computed, type ComputedRef } from 'vue'
import { usePlanner } from '../context.ts'
import { propertyOf, valueOf } from '../model.ts'

/** How many items have each option, by option id; null until the items are read. */
export function useOptionCounts(collectionId: () => string, propertyId: () => string): ComputedRef<ReadonlyMap<string, number> | null> {
  const { store } = usePlanner()
  return computed(() => {
    const c = store.collection(collectionId())
    const p = c && propertyOf(c, propertyId())
    const state = store.items(collectionId())
    if (!p || state.status !== 'ready') return null
    const out = new Map<string, number>()
    for (const item of state.items) {
      const v = valueOf(item, p)
      for (const id of Array.isArray(v) ? v as readonly string[] : typeof v === 'string' ? [v] : []) out.set(id, (out.get(id) ?? 0) + 1)
    }
    return out
  })
}
