<script setup lang="ts">
import { Columns2, Trash2 } from 'lucide-vue-next'
import { useThreads } from '~/stores/threads'
import { useWorkspace } from '~/stores/workspace'
import type { Thread } from '~/types/chat'
import type { MenuItem } from '~/types/ui'
import { shortAgo, useNow } from '~/utils/time'

/**
 * The sub-agent chats under a chat in the sidebar: one compact row each (ripeness dot, title,
 * state), indented one step per level, so a sub-agent's own sub-agents sit under it.
 */
const props = withDefaults(defineProps<{ parentId: string; depth?: number }>(), { depth: 0 })

const threads = useThreads()
const ws = useWorkspace()
const now = useNow()

const children = computed(() => threads.childrenOf(props.parentId))
const visibleIds = computed(() => new Set(threads.panes.map(p => p.threadId)))

function open(t: Thread) {
  if (t.projectPath !== ws.activeProjectPath) ws.setActiveProject(t.projectPath)
  threads.show(t.id)
}

/** How it went, in a word; the time once it is over. */
function state(t: Thread) {
  if (t.status === 'running' || t.status === 'queued') return 'working'
  if (t.status === 'error') return 'failed'
  const last = t.messages[t.messages.length - 1]
  if (last?.outcome === 'stopped') return 'stopped'
  return shortAgo(t.updatedAt, now.value)
}

const menus = ref<Record<string, { showAt: (x: number, y: number) => void } | null>>({})
function menu(t: Thread): MenuItem[] {
  const busy = t.status === 'running' || t.status === 'queued'
  return [
    { label: 'Open to the side', icon: Columns2, onSelect: () => { ws.setActiveProject(t.projectPath); threads.split(t.id) } },
    { label: 'Delete sub-agent chat', icon: Trash2, danger: true, divider: true, disabled: busy, onSelect: () => threads.remove(t.id) },
  ]
}
</script>

<template>
  <ul class="sbs" role="list" :style="{ '--depth': depth }">
    <li v-for="c in children" :key="c.id">
      <div
        class="sbs__row"
        :class="{ 'is-current': c.id === threads.activePane.threadId, 'is-visible': visibleIds.has(c.id) }"
        role="button"
        tabindex="0"
        :title="`${c.agentType ?? 'Sub-agent'}: ${c.title}`"
        @click="open(c)"
        @keydown.enter.prevent="open(c)"
        @contextmenu.prevent="menus[c.id]?.showAt($event.clientX, $event.clientY)"
      >
        <UiRipenessDot :status="c.status" :size="10" />
        <span class="sbs__title">{{ c.title }}</span>
        <span class="sbs__state tabular" :class="`is-${c.status}`">{{ state(c) }}</span>
      </div>
      <UiMenu :ref="(el: any) => { menus[c.id] = el }" :items="menu(c)" placement="bottom-end" :width="220" label="Sub-agent chat actions" />
      <AppSidebarSubagents v-if="threads.childrenOf(c.id).length" :parent-id="c.id" :depth="depth + 1" />
    </li>
  </ul>
</template>

<style scoped>
.sbs { list-style: none; margin: 0; padding: 0; display: grid; gap: 1px; }
/* A grid, so the context menu's empty inline anchor collapses instead of adding a line box under each row. */
.sbs > li { display: grid; min-width: 0; }
.sbs__row {
  display: grid;
  grid-template-columns: 10px minmax(0, 1fr) auto;
  align-items: center;
  column-gap: var(--space-2);
  height: 28px;
  /* The dot lines up under the parent's title, one step further in per level. */
  padding: 0 8px 0 calc(30px + var(--depth) * 16px);
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: background var(--dur-fast) var(--ease-out);
}
.sbs__row:hover, .sbs__row.is-visible { background: var(--bg-hover); }
.sbs__row.is-current { background: var(--bg-active); }
.sbs__row:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: -2px; }
.sbs__title {
  font-size: var(--text-sm);
  color: var(--fg-subtle);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sbs__row:hover .sbs__title, .sbs__row.is-current .sbs__title { color: var(--fg); }
.sbs__state { font-size: var(--text-2xs); color: var(--fg-faint); }
.sbs__state.is-running, .sbs__state.is-queued { color: var(--ripe-running-fg); }
.sbs__state.is-error { color: var(--ripe-error-fg); }
</style>
