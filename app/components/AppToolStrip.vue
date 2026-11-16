<script setup lang="ts">
import { Files, GitBranch, GitPullRequest } from 'lucide-vue-next'
import { useWorkspace, type ToolView } from '~/stores/workspace'
import { useGit, refreshGit } from '~/stores/git'
import { useThreads } from '~/stores/threads'
import { modLabel } from '~/composables/useShortcuts'

/**
 * The tool window stripe on the right edge of the workspace, the way an IDE
 * docks its tool windows: one button per tool, a click opens it beside the
 * chats and a second click puts it away.
 */

const ws = useWorkspace()
const git = useGit()
const mod = ref('Ctrl')
onMounted(() => (mod.value = modLabel()))

/** Number of changed files in the active project, shown on the Changes button. */
const changeCount = computed(() => git.status(ws.activeProjectPath)?.files.length ?? 0)
// Keep that number honest without the Changes view being open.
watch(() => ws.activeProjectPath, (path) => { if (path) refreshGit(path).catch(() => {}) }, { immediate: true })
function onWindowFocus() { if (ws.activeProjectPath) refreshGit(ws.activeProjectPath).catch(() => {}) }
onMounted(() => window.addEventListener('focus', onWindowFocus))
onBeforeUnmount(() => window.removeEventListener('focus', onWindowFocus))

/** Pull requests and issues linked to the chat in the active pane (or the chat a sub-agent belongs to). */
const threads = useThreads()
const linkCount = computed(() => {
  const id = threads.activePane.threadId
  return (id && threads.byId(id) ? threads.rootOf(id)?.links?.length : 0) ?? 0
})

const tools = computed(() => [
  { id: 'files' as ToolView, label: 'Files', icon: Files, keys: `${mod.value}+Shift+E`, count: 0, counts: '' },
  { id: 'changes' as ToolView, label: 'Changes', icon: GitBranch, keys: `${mod.value}+Shift+G`, count: changeCount.value, counts: 'changed file' },
  { id: 'links' as ToolView, label: 'Pull requests', icon: GitPullRequest, keys: `${mod.value}+Shift+P`, count: linkCount.value, counts: 'linked item' },
])
</script>

<template>
  <nav class="ts" aria-label="Tool windows">
    <button
      v-for="t in tools"
      :key="t.id"
      type="button"
      class="ts__btn"
      :class="{ 'is-active': ws.toolPanel === t.id }"
      :aria-pressed="ws.toolPanel === t.id"
      :aria-label="t.count ? `${t.label}, ${t.count} ${t.counts}${t.count === 1 ? '' : 's'}` : t.label"
      :title="`${t.label} (${t.keys})`"
      @click="ws.toggleTool(t.id)"
    >
      <component :is="t.icon" />
      <span v-if="t.count" class="ts__count tabular" aria-hidden="true">{{ t.count > 99 ? '99+' : t.count }}</span>
    </button>
  </nav>
</template>

<style scoped>
.ts {
  flex: none;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  width: 40px;
  padding-top: var(--space-1);
  background: var(--bg-app);
}
.ts__btn {
  position: relative;
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  border-radius: var(--radius-sm);
  color: var(--fg-faint);
  transition: background var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out);
}
.ts__btn svg { width: 17px; height: 17px; stroke-width: 1.75; }
.ts__btn:hover { background: var(--bg-hover); color: var(--fg-muted); }
.ts__btn.is-active { background: var(--bg-active); color: var(--fg); }
.ts__count {
  position: absolute;
  top: 1px;
  right: -1px;
  min-width: 14px;
  height: 14px;
  padding: 0 3px;
  border-radius: var(--radius-pill);
  background: var(--accent);
  color: var(--accent-fg);
  font-size: 9.5px;
  font-weight: 650;
  line-height: 14px;
  text-align: center;
}
</style>
