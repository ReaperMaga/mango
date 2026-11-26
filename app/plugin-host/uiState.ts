import { markRaw, reactive } from 'vue'
import type { PluginMenuRow, PluginView, ToastOptions } from './types'

/**
 * What plugins put on screen outside the regular surfaces: toasts (bottom-right) and dialogs
 * (confirm, prompt, a plugin view). `ui/PluginLayers.vue` shows both, mounted once in app.vue.
 * Mango's own code may use the toasts and the prompt too (`toast()`, `openDialog()`).
 */

export interface Toast extends Required<Pick<ToastOptions, 'title' | 'kind' | 'timeout'>> {
  id: number
  body?: string
  action?: ToastOptions['action']
  pluginId: string | null
}

export type PluginDialog =
  | { id: number; pluginId: string; kind: 'confirm'; title: string; body?: string; confirmLabel?: string; danger?: boolean; resolve(v: boolean): void }
  /** `pluginId` null: Mango's own question. */
  | { id: number; pluginId: string | null; kind: 'prompt'; title: string; body?: string; placeholder?: string; value?: string; resolve(v: string | null): void }
  | { id: number; pluginId: string; kind: 'view'; title: string; view: PluginView<{ close(): void }>; width?: number; resolve(): void }

/** A plugin's menu (`ui.contextMenu`): at a point, or hanging from an element. One at a time. */
export interface PluginContextMenu {
  id: number
  pluginId: string
  at: { x: number; y: number } | HTMLElement
  rows: PluginMenuRow[]
  resolve(): void
}

export const layers = reactive({
  menu: null as PluginContextMenu | null,
  toasts: [] as Toast[],
  dialogs: [] as PluginDialog[],
})

let seq = 0
const MAX_TOASTS = 4

export function toast(opts: ToastOptions, pluginId: string | null = null): number {
  const id = ++seq
  const kind = opts.kind && ['info', 'success', 'warning', 'error'].includes(opts.kind) ? opts.kind : 'info'
  const timeout = typeof opts.timeout === 'number' && opts.timeout >= 0 ? opts.timeout : 5000
  layers.toasts.push({
    id,
    title: String(opts.title ?? ''),
    ...(opts.body ? { body: String(opts.body) } : {}),
    kind,
    timeout,
    ...(opts.action && typeof opts.action.run === 'function' ? { action: { label: String(opts.action.label), run: opts.action.run } } : {}),
    pluginId,
  })
  if (layers.toasts.length > MAX_TOASTS) layers.toasts.splice(0, layers.toasts.length - MAX_TOASTS)
  return id
}

export function dismissToast(id: number) {
  const i = layers.toasts.findIndex(t => t.id === id)
  if (i >= 0) layers.toasts.splice(i, 1)
}

type DialogInput = PluginDialog extends infer D ? (D extends PluginDialog ? Omit<D, 'id' | 'resolve'> : never) : never

/** Ask with a dialog; resolves when it is answered or closed. */
export function openDialog(d: DialogInput): Promise<unknown> {
  return new Promise((resolve) => {
    const id = ++seq
    const view = 'view' in d && d.view ? markRaw(d.view as object) : undefined
    layers.dialogs.push({ ...(d as object), ...(view ? { view } : {}), id, resolve } as unknown as PluginDialog)
  })
}

/** Close a dialog with an answer (confirm: boolean, prompt: string or null, view: nothing). */
export function closeDialog(id: number, value?: unknown) {
  const i = layers.dialogs.findIndex(d => d.id === id)
  if (i < 0) return
  const [d] = layers.dialogs.splice(i, 1)
  ;(d!.resolve as (v: unknown) => void)(value)
}

/** The element a press just closed its menu on: the click that follows does not open it again. */
let pressed: HTMLElement | null = null
export function menuPressed(el: HTMLElement | null) { pressed = el }

/** Open a plugin's menu; resolves when it is closed. */
export function openMenu(m: Omit<PluginContextMenu, 'id' | 'resolve'>): Promise<void> {
  if (layers.menu) closeMenu(layers.menu.id)
  if (m.at === pressed) return Promise.resolve()
  return new Promise((resolve) => { layers.menu = markRaw({ ...m, id: ++seq, resolve }) })
}

export function closeMenu(id: number) {
  const m = layers.menu
  if (m?.id !== id) return
  layers.menu = null
  m.resolve()
}

/** A plugin went away: its toasts go, its menu closes, its dialogs close unanswered. */
export function dropPluginLayers(pluginId: string) {
  if (layers.menu?.pluginId === pluginId) closeMenu(layers.menu.id)
  for (const t of layers.toasts.filter(t => t.pluginId === pluginId)) dismissToast(t.id)
  for (const d of layers.dialogs.filter(d => d.pluginId === pluginId)) {
    closeDialog(d.id, d.kind === 'confirm' ? false : d.kind === 'prompt' ? null : undefined)
  }
}
