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
  /** muted detail on the label's line, right-aligned (e.g. a project's branch); a one-line alternative to `hint` */
  aside?: string
  /** `aside` is code (a branch, a path): set it in the monospace face */
  asideMono?: boolean
  /** small muted text on the right (e.g. a shortcut) */
  kbd?: string
  onSelect?: () => void
  /** A second action on the row's far end, shown on hover or keyboard focus (e.g. close a project). Delete runs it from the keyboard. The menu stays open. */
  remove?: { label: string; onSelect: () => void }
}
