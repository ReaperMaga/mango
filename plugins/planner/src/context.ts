/** What every component of the planner gets: Mango, the store, and where in the planner it is. */

import { inject, type ComputedRef, type InjectionKey } from 'vue'
import type { MangoPluginApi } from './host.ts'
import { isObject } from './patch.ts'
import type { PlannerStore } from './store.ts'

/** The tab view's id, and the key of its one tab per project. */
export const VIEW_ID = 'planner'
export const TAB_KEY = 'main'

/** Where the tab is: its state, so it comes back after a restart. */
export interface Route {
  collectionId: string | null
  /** The view last used there when left out. */
  viewId?: string
  /** An item open as a page. */
  itemId?: string
}

export interface Planner {
  readonly mango: MangoPluginApi
  readonly store: PlannerStore
  readonly route: ComputedRef<Route>
  /** Changes what is given (`undefined` clears), keeps the rest; another collection starts without a view and an item. */
  go(route: Partial<Route>): void
}

export const PLANNER: InjectionKey<Planner> = Symbol('planner')

export function usePlanner(): Planner {
  const planner = inject(PLANNER)
  if (!planner) throw new Error('Used outside of the planner.')
  return planner
}

/** A tab's state as a route, whatever an older version kept there. */
export function readRoute(state: unknown): Route | null {
  if (!isObject(state)) return null
  const text = (v: unknown) => (typeof v === 'string' && v ? v : undefined)
  return { collectionId: text(state.collectionId) ?? null, viewId: text(state.viewId), itemId: text(state.itemId) }
}
