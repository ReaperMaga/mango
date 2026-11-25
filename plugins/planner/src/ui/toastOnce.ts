import type { MangoPluginApi } from '../host.ts'

const REST_MS = 5000
let last = { title: '', at: 0 }

/** A hint, not again while it is still on screen. */
export function toastOnce(mango: MangoPluginApi, title: string, body?: string) {
  if (title === last.title && Date.now() - last.at < REST_MS) return
  last = { title, at: Date.now() }
  mango.ui.toast({ title, body, timeout: REST_MS })
}
