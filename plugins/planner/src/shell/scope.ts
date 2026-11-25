import type { Scope } from '../model.ts'
import type { PlannerStore } from '../store.ts'

export function scopeOf(store: PlannerStore, where: 'project' | 'everywhere'): Scope {
  const path = store.projectPath.value
  return where === 'project' && path ? { kind: 'project', path } : { kind: 'everywhere' }
}
