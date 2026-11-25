import { onBeforeUnmount, onMounted } from 'vue'

const EVENTS = ['planner:commit', 'pagehide']

/**
 * The window is about to close, or the page to go: what is typed and not given to the store yet has to be, right
 * away. The editor stays, as the closing may be called off.
 */
export function onCommit(commit: () => void) {
  onMounted(() => EVENTS.forEach(e => window.addEventListener(e, commit)))
  onBeforeUnmount(() => EVENTS.forEach(e => window.removeEventListener(e, commit)))
}
