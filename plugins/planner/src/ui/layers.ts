/** The planner's open popovers, the topmost last, so Escape and a click outside reach only the right one. */

export interface Layer { contains(el: Node): boolean }

const layers: Layer[] = []

export function pushLayer(layer: Layer): () => void {
  layers.push(layer)
  return () => {
    const i = layers.indexOf(layer)
    if (i >= 0) layers.splice(i, 1)
  }
}

export const isTopLayer = (layer: Layer) => layers.at(-1) === layer

/** In this layer or one opened over it. */
export function inOrAbove(layer: Layer, el: Node): boolean {
  return layers.slice(layers.indexOf(layer)).some(l => l.contains(el))
}

/** Mango's dialogs that are open. A popover may be in one: those open before it are under it, not over it. */
export const hostDialogs = (): Element[] => [...document.querySelectorAll('.dlg__panel')]

/** In one of Mango's own menus, dialogs or toasts over the planner's layer. */
export function inHostLayer(el: EventTarget | null, under: readonly Element[] = []): boolean {
  const host = el instanceof Element ? el.closest('.menu__pop, .dlg__panel, .toast') : null
  return host !== null && !under.includes(host)
}

export const hostLayerOpen = (under: readonly Element[] = []) =>
  document.querySelector('.menu__pop') !== null || hostDialogs().some(d => !under.includes(d))

/** Something floats that owns Escape: a popover of the planner, or a menu or dialog of Mango's. */
export const anyLayerOpen = () => layers.length > 0 || hostLayerOpen()
