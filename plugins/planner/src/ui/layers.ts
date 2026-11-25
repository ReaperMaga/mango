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

/** Mango's own menus, dialogs and toasts float over everything of the planner's. */
export function inHostLayer(el: EventTarget | null): boolean {
  return el instanceof Element && el.closest('.menu__pop, .dlg__panel, .toast') !== null
}

export const hostLayerOpen = () => document.querySelector('.menu__pop, .dlg__panel') !== null

/** Something floats that owns Escape: a popover of the planner, or a menu or dialog of Mango's. */
export const anyLayerOpen = () => layers.length > 0 || hostLayerOpen()
