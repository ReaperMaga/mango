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

const { t } = useI18n()
const threads = useThreads()
const ws = useWorkspace()
const now = useNow()

const children = computed(() => threads.childrenOf(props.parentId))
const visibleIds = computed(() => new Set(threads.panes.map(p => p.threadId)))

/**
 * Where the tree lines sit. The trunk runs under the parent's dot: the chat row's dot (centre 15px)
 * at the first level, a sub-agent row's dot (centre 35px + 16px a level) below that. The elbow
 * stops 3px short of this level's dots (left edge 30px + 16px a level).
 */
const treeVars = computed(() => {
  const trunk = props.depth === 0 ? 15 : 35 + (props.depth - 1) * 16
  const dot = 30 + props.depth * 16
  return { '--depth': props.depth, '--trunk': `${trunk}px`, '--elbow': `${dot - 3 - trunk}px` }
})

function open(t: Thread) {
  if (t.projectPath !== ws.activeProjectPath) ws.setActiveProject(t.projectPath)
  threads.show(t.id)
}

/** How it went, in a word; the time once it is over. */
function state(chat: Thread) {
  if (chat.status === 'running' || chat.status === 'queued') return t('shell.chat.stateWorking')
  if (chat.status === 'error') return t('shell.chat.stateFailed')
  const last = chat.messages[chat.messages.length - 1]
  if (last?.outcome === 'stopped') return t('shell.chat.stateStopped')
  return shortAgo(chat.updatedAt, now.value)
}

const menus = ref<Record<string, { showAt: (x: number, y: number) => void } | null>>({})
function menu(chat: Thread): MenuItem[] {
  const busy = chat.status === 'running' || chat.status === 'queued'
  return [
    { label: t('shell.chat.toSide'), icon: Columns2, onSelect: () => threads.split(chat.id) },
    { label: chat.forkOf ? t('shell.chat.delete') : t('shell.chat.deleteSub'), icon: Trash2, danger: true, divider: true, disabled: busy, onSelect: () => ws.confirmThen('delete', { title: chat.forkOf ? t('shell.chat.deleteTitle') : t('shell.chat.deleteSubTitle'), body: t('shell.chat.deleteBody', { title: chat.title }), label: t('shell.chat.delete'), danger: true }, () => threads.remove(chat.id)) },
  ]
}
</script>

<template>
  <ul class="sbs" role="list" :style="treeVars">
    <li v-for="c in children" :key="c.id">
      <div
        class="sbs__row"
        :class="{ 'is-current': c.id === threads.activePane.threadId, 'is-visible': visibleIds.has(c.id) }"
        role="button"
        tabindex="0"
        :title="`${c.forkOf ? t('shell.chat.fork') : (c.agentType ?? t('shell.chat.subAgent'))}: ${c.title}`"
        @click="open(c)"
        @keydown.enter.prevent="open(c)"
        @contextmenu.prevent="menus[c.id]?.showAt($event.clientX, $event.clientY)"
      >
        <UiRipenessDot :status="c.status" :size="10" />
        <span class="sbs__title">{{ c.title }}</span>
        <span class="sbs__state tabular" :class="`is-${c.status}`">{{ state(c) }}</span>
      </div>
      <UiMenu :ref="(el: any) => { menus[c.id] = el }" :items="menu(c)" placement="bottom-end" :width="220" :label="t('shell.chat.subActions')" />
      <AppSidebarSubagents v-if="threads.childrenOf(c.id).length" :parent-id="c.id" :depth="depth + 1" />
    </li>
  </ul>
</template>

<style scoped>
.sbs { list-style: none; margin: 0; padding: 0; display: grid; gap: 1px; }
/* A grid, so the context menu's empty inline anchor collapses instead of adding a line box under each row. */
.sbs > li { position: relative; display: grid; min-width: 0; }

/*
 * Tree lines: a trunk under the parent's dot, an elbow into each child's dot. The trunk runs on
 * past a child (and its own sub-agents) until the last sibling, which ends it with a rounded corner.
 */
.sbs > li::before, .sbs > li:not(:last-child)::after {
  content: '';
  position: absolute;
  z-index: 1;
  left: var(--trunk);
  pointer-events: none;
  border-left: 1px solid var(--line-strong);
}
.sbs > li::before {
  top: 0;
  height: 14px;
  width: var(--elbow);
  border-bottom: 1px solid var(--line-strong);
  border-bottom-left-radius: var(--radius-sm);
}
/* Down past this child and across the gap to the next sibling. */
.sbs > li:not(:last-child)::after { top: 0; bottom: -1px; }
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
