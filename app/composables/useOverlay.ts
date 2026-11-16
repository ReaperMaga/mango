/**
 * HTML layers that float over the workspace: menus, dialogs, the command palette, popups,
 * Settings, and resize drags. A browser's page is a native webview drawn above every bit of
 * HTML, so while any of these is up the browsers hide (stores/browser.ts reads `overlayOpen`).
 * Register a layer once, where it lives (UiMenu and UiDialog cover most of them).
 */
const open = reactive(new Set<symbol>())

/** Something floats over the workspace right now. */
export const overlayOpen = computed(() => open.size > 0)

/** Count the layer as open while `isOpen` is true, until the component (or scope) goes away. */
export function useOverlay(isOpen: () => boolean) {
  const key = Symbol('overlay')
  watch(isOpen, (v) => { v ? open.add(key) : open.delete(key) }, { immediate: true })
  onScopeDispose(() => open.delete(key))
}

/**
 * Hold the browsers hidden for a moment (a resize drag: the pointer would vanish into the page
 * the moment it crosses it). Returns the release, which is safe to call twice.
 */
export function holdOverlay(): () => void {
  const key = Symbol('hold')
  open.add(key)
  return () => { open.delete(key) }
}
