import type { Component } from 'vue'

export interface MenuItem {
  label: string
  /** `label` is code (a branch, a path): set it in the monospace face */
  labelMono?: boolean
  hint?: string
  /** `hint` is code (a branch, a path): set it in the monospace face */
  hintMono?: boolean
  /** a small icon before `hint`, saying what kind of thing it names (e.g. a server before an environment) */
  hintIcon?: Component
  /** a quiet dot at the row's end: the thing is open (e.g. a project open in this window). `checked` wins over it. */
  open?: boolean
  icon?: Component
  checked?: boolean
  /** the row is a setting that is on or off ('checkbox') or one of a set ('radio'): screen readers hear its state */
  check?: 'checkbox' | 'radio'
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
  /** A second action on the row's far end, shown on hover or keyboard focus (e.g. close a project, or take a recent one off the list). Delete runs it from the keyboard. The menu stays open. */
  remove?: { label: string; onSelect: () => void }
  /** Another action on the row, as an icon before its end, shown on hover or keyboard focus (e.g. open in a new window). Shift+Enter runs it. The menu closes. */
  action?: { label: string; icon: Component; disabled?: boolean; /** why it is disabled, shown as its tooltip */ reason?: string; onSelect: () => void }
}
