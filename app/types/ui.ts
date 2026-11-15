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
  /** small muted text on the right (e.g. a shortcut) */
  kbd?: string
  onSelect?: () => void
}
