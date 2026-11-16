import type { Component } from 'vue'

export interface MenuItem {
  label: string
  hint?: string
  icon?: Component
  checked?: boolean
  disabled?: boolean
  danger?: boolean
  /** renders a divider before this item */
  divider?: boolean
  /** a small heading before this item, starting a group (e.g. a server's name over its environments) */
  group?: string
  /** small muted text on the right (e.g. a shortcut) */
  kbd?: string
  onSelect?: () => void
}
