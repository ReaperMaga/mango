import { onBeforeUnmount, onMounted } from 'vue'

/** The window is about to go (or the plugin): what is typed and not given to the store yet has to be, right away. */
export function onCommit(commit: () => void) {
  onMounted(() => window.addEventListener('planner:commit', commit))
  onBeforeUnmount(() => window.removeEventListener('planner:commit', commit))
}
