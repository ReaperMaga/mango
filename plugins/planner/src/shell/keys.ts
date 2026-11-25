/** Keys as the platform names them, and what a key event means here. */

import type { MangoPluginApi } from '../host.ts'

const isMac = (mango: MangoPluginApi) => mango.platform === 'macos' || (mango.platform === 'browser' && /Mac/.test(navigator.platform))

/** `keyLabel(mango, 'Shift', 'Z')`: `Ctrl+Shift+Z`, or `⌘⇧Z` on a Mac. */
export function keyLabel(mango: MangoPluginApi, ...keys: string[]): string {
  const mac = isMac(mango)
  return [mac ? '⌘' : 'Ctrl', ...keys.map(k => (mac && k === 'Shift' ? '⇧' : k))].join(mac ? '' : '+')
}

export const isMod = (mango: MangoPluginApi, e: KeyboardEvent) => (isMac(mango) ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey)

export function inTextField(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable || target.tagName === 'TEXTAREA') return true
  return target instanceof HTMLInputElement && !['checkbox', 'radio', 'button', 'range', 'color', 'file'].includes(target.type)
}
