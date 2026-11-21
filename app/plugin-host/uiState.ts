import { markRaw, reactive } from 'vue'
import type { PluginView, ToastOptions } from './types'

/**
 * What plugins put on screen outside the regular surfaces: toasts (bottom-right) and dialogs
 * (confirm, prompt, a plugin view). `ui/PluginLayers.vue` shows both, mounted once in app.vue.
 * Mango's own code may use the toasts too (`toast()`).
 */

export interface Toast extends Required<Pick<ToastOptions, 'title' | 'kind' | 'timeout'>> {
  id: number
  body?: string
  action?: ToastOptions['action']
  pluginId: string | null
}

export type PluginDialog =
  | { id: number; pluginId: string; kind: 'confirm'; title: string; body?: string; confirmLabel?: string; danger?: boolean; resolve(v: boolean): void }
  | { id: number; pluginId: string; kind: 'prompt'; title: string; body?: string; placeholder?: string; value?: string; resolve(v: string | null): void }
  | { id: number; pluginId: string; kind: 'view'; title: string; view: PluginView<{ close(): void }>; width?: number; resolve(): void }

export const layers = reactive({
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

/** A plugin went away: its toasts go, its dialogs close unanswered. */
export function dropPluginLayers(pluginId: string) {
  for (const t of layers.toasts.filter(t => t.pluginId === pluginId)) dismissToast(t.id)
  for (const d of layers.dialogs.filter(d => d.pluginId === pluginId)) {
    closeDialog(d.id, d.kind === 'confirm' ? false : d.kind === 'prompt' ? null : undefined)
  }
}
