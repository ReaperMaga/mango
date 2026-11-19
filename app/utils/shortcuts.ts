/**
 * Keyboard shortcuts as data: the actions a key can run, their default keys, and the pure parts of
 * matching and showing them (no Vue, no stores). `composables/useShortcuts.ts` runs them;
 * Settings > Shortcuts lets the user rebind them.
 *
 * A binding is a string such as `Mod+Shift+G`: `Mod` is Cmd on macOS and Ctrl elsewhere, then the
 * optional `Alt` and `Shift`, then one key. Every binding needs `Mod`, or typing would trigger it.
 * An empty string is a binding the user cleared.
 */

export type ShortcutGroup = 'General' | 'Layout' | 'Tabs'

/**
 * Where a shortcut works. `always`: anywhere, even in the terminal and in Settings. `app`: not in the
 * terminal (the shell gets the key), but with Settings open. `workspace`: only on the workspace, not
 * under Settings.
 */
export type ShortcutScope = 'always' | 'app' | 'workspace'

export interface ShortcutDef {
  id: string
  label: string
  group: ShortcutGroup
  scope: ShortcutScope
  /** The key out of the box. */
  key: string
}

export const SHORTCUTS: readonly ShortcutDef[] = [
  { id: 'palette', label: 'Command palette', group: 'General', scope: 'always', key: 'Mod+K' },
  { id: 'settings', label: 'Open settings', group: 'General', scope: 'app', key: 'Mod+,' },
  { id: 'usage', label: 'Usage limits', group: 'General', scope: 'app', key: 'Mod+Shift+U' },
  { id: 'new-chat', label: 'New chat', group: 'General', scope: 'workspace', key: 'Mod+N' },
  { id: 'new-chat-worktree', label: 'New chat in a worktree', group: 'General', scope: 'workspace', key: 'Mod+Shift+N' },
  { id: 'open-folder', label: 'Open folder', group: 'General', scope: 'workspace', key: 'Mod+O' },
  { id: 'new-window', label: 'New window', group: 'General', scope: 'workspace', key: 'Mod+Alt+N' },

  { id: 'sidebar', label: 'Toggle sidebar', group: 'Layout', scope: 'workspace', key: 'Mod+B' },
  { id: 'tool-panel', label: 'Toggle tool window', group: 'Layout', scope: 'workspace', key: 'Mod+Alt+B' },
  { id: 'terminal', label: 'Toggle terminal', group: 'Layout', scope: 'always', key: 'Mod+`' },
  { id: 'split', label: 'Split chat or close the split', group: 'Layout', scope: 'workspace', key: 'Mod+\\' },
  { id: 'changes', label: 'Changes', group: 'Layout', scope: 'workspace', key: 'Mod+Shift+G' },
  { id: 'files', label: 'Files', group: 'Layout', scope: 'workspace', key: 'Mod+Shift+E' },
  { id: 'links', label: 'Pull requests', group: 'Layout', scope: 'workspace', key: 'Mod+Shift+P' },
  { id: 'env', label: 'Environment', group: 'Layout', scope: 'workspace', key: 'Mod+Shift+H' },

  { id: 'close-tab', label: 'Close tab', group: 'Tabs', scope: 'workspace', key: 'Mod+W' },
  { id: 'new-terminal', label: 'New terminal', group: 'Tabs', scope: 'workspace', key: 'Mod+Shift+T' },
  { id: 'new-browser', label: 'New browser tab', group: 'Tabs', scope: 'workspace', key: 'Mod+Shift+B' },
  { id: 'save-file', label: 'Save file', group: 'Tabs', scope: 'workspace', key: 'Mod+S' },
]

export const SHORTCUT_GROUPS: readonly ShortcutGroup[] = ['General', 'Layout', 'Tabs']

/** Keys that stay as they are: shown in Settings, but not rebindable. */
export const FIXED_SHORTCUTS: ReadonlyArray<{ label: string; key: string }> = [
  { label: 'Switch to a tab by its number', key: 'Mod+1 to 9' },
  { label: 'Toggle terminal, as well', key: 'Mod+J' },
]

/** What the operating system or the editors in Mango already use: not offered for rebinding. */
const RESERVED = new Set([
  'Mod+C', 'Mod+V', 'Mod+X', 'Mod+A', 'Mod+Z', 'Mod+Y', 'Mod+Shift+Z',
  'Mod+Q', 'Mod+H', 'Mod+M', 'Mod+Enter', 'Mod+Shift+Enter', 'Mod+J',
])

export const isMac = () => /Mac|iPhone|iPad/.test(navigator.platform)

const SYMBOL_CODES: Record<string, string> = {
  Backquote: '`', Backslash: '\\', Comma: ',', Period: '.', Slash: '/', Semicolon: ';', Quote: '\'',
  BracketLeft: '[', BracketRight: ']', Minus: '-', Equal: '=',
}

/** The key of an event, independent of Shift (which turns `\` into `|`) and of the layout's letter case. */
function mainKey(e: KeyboardEvent): string | null {
  // With Alt held a Mac types another glyph (or a dead key): read the physical key.
  if (e.altKey) {
    const phys = /^(?:Key([A-Z])|Digit([0-9]))$/.exec(e.code)
    if (phys) return (phys[1] ?? phys[2])!.toLowerCase()
  }
  if (e.key === 'Dead' || e.key === 'Unidentified') return null
  if (e.key.length === 1) {
    if (e.key === ' ') return 'Space'
    // A shifted symbol reports the other glyph: read the physical key instead.
    if (e.shiftKey && !/[a-z0-9]/i.test(e.key)) return SYMBOL_CODES[e.code] ?? null
    return e.key.toLowerCase()
  }
  if (/^(Shift|Control|Alt|Meta|AltGraph|CapsLock)$/.test(e.key)) return null
  return e.key.replace(/^Arrow/, '')
}

/** The binding an event spells, or null when it is only a modifier, or a dead key. */
export function eventCombo(e: KeyboardEvent): string | null {
  const mac = isMac()
  if (!(mac ? e.metaKey : e.ctrlKey)) return null
  // The other of Ctrl and Cmd is a different key on this platform.
  if (mac ? e.ctrlKey : e.metaKey) return null
  const key = mainKey(e)
  if (!key) return null
  const upper = key.length === 1 ? key.toUpperCase() : key
  return ['Mod', e.altKey ? 'Alt' : '', e.shiftKey ? 'Shift' : '', upper].filter(Boolean).join('+')
}

/** Binding parts as the platform names them: `['Ctrl', 'Shift', 'G']`, or `['⌘', '⇧', 'G']` on a Mac. */
export function comboParts(combo: string): string[] {
  const mac = isMac()
  return combo.split(/\+(?!$)/).filter(Boolean).map((p) => {
    if (p === 'Mod') return mac ? '⌘' : 'Ctrl'
    if (p === 'Shift') return mac ? '⇧' : 'Shift'
    if (p === 'Alt') return mac ? '⌥' : 'Alt'
    return p
  })
}

/** A binding written for a tooltip: `Ctrl+Shift+G`, `⌘⇧G` on a Mac. */
export function comboLabel(combo: string): string {
  return comboParts(combo).join(isMac() ? '' : '+')
}

/** Why a binding can't be used, or null. `owner` is the label of the action that has the key. */
export function refuse(combo: string, forId: string, bindings: Record<string, string>): string | null {
  if (!combo.startsWith('Mod+')) return 'A shortcut needs Ctrl (⌘ on a Mac) held down.'
  if (/^Mod\+[1-9]$/.test(combo)) return 'Ctrl+1 to 9 switch tabs.'
  if (RESERVED.has(combo)) return `${comboLabel(combo)} is used by the system and the text fields.`
  const other = SHORTCUTS.find(s => s.id !== forId && bindings[s.id] === combo)
  if (other) return `${comboLabel(combo)} already runs “${other.label}”.`
  return null
}

/** The bindings in force: each action's default, unless the user chose another key (or cleared it). */
export function resolveBindings(overrides: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const s of SHORTCUTS) out[s.id] = overrides[s.id] ?? s.key
  return out
}

/** Overrides as stored: only known actions, only strings; whatever else an older or newer build wrote is dropped. */
export function cleanOverrides(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (!raw || typeof raw !== 'object') return out
  for (const s of SHORTCUTS) {
    const v = (raw as Record<string, unknown>)[s.id]
    if (typeof v === 'string' && v !== s.key) out[s.id] = v
  }
  return out
}
