<script setup lang="ts">
import { AppWindow, Server, SquareTerminal } from 'lucide-vue-next'
import { tabDrag, type Box } from '~/composables/useTabDrag'
import { reg } from '~/plugin-host/registry'
import PluginIcon from '~/plugin-host/ui/PluginIcon.vue'
import { useThreads } from '~/stores/threads'
import { useWindows } from '~/stores/windows'

/**
 * What a tab drag shows over everything: the tab following the pointer, and where it would land (a
 * line between tabs, or a wash over the pane or panel it would fill). A chat dragged to the window's
 * edge, or past it, says that letting go opens it in a window of its own. Never takes the pointer.
 */
const threads = useThreads()
const win = useWindows()
const at = (b: Box) => ({ left: `${b.left}px`, top: `${b.top}px`, width: `${b.width}px`, height: `${b.height}px` })

const chat = computed(() => (tabDrag.item?.kind === 'chat' ? threads.byId(tabDrag.item.id) : null))
/** A plugin's panel tab being dragged (its icon). */
const panelTab = computed(() => (tabDrag.item?.kind === 'panelTab' ? reg.panelTabs.find(t => t.fullId === tabDrag.item!.id) ?? null : null))
/** The chat window's own chat goes back when it is let go over another window; anything else gets a new window. */
const own = computed(() => win.spec.kind === 'chat' && !!chat.value && threads.rootOf(chat.value.id)?.id === win.spec.threadId)
/* A chat at work cannot move: its run stays in this window. */
const busy = computed(() => !!chat.value && threads.isBusyChat(chat.value.id))
const out = computed(() => !!chat.value && !busy.value && tabDrag.place === 'outside')
const edge = computed(() => !!chat.value && !busy.value && tabDrag.place === 'edge')
const hint = computed(() => {
  if (!chat.value || tabDrag.place === 'inside') return ''
  if (busy.value) return 'Still working: it stays in this window'
  if (own.value) return out.value ? 'Let go over another Mango window to return it' : 'Drag onto another Mango window to return it'
  return out.value ? 'Opens in a new window' : 'Drag out of the window to open it on its own'
})

/*
 * The tab follows the pointer below and right of it; near the window's bottom or right edge it flips to
 * the other side. Outside the window it waits at the nearest edge, as close to the pointer as it can.
 */
const ghost = computed(() => {
  const w = window.innerWidth
  const h = window.innerHeight
  const x = Math.min(Math.max(tabDrag.x, 8), w - 8)
  const y = Math.min(Math.max(tabDrag.y, 8), h - 8)
  const left = x + 280 > w ? `calc(${x - 14}px - 100%)` : `${x + 14}px`
  const top = y + 64 > h ? `calc(${y - 12}px - 100%)` : `${y + 12}px`
  return { transform: `translate(${left}, ${top})` }
})

const line = computed(() => {
  const d = tabDrag.drop
  return d && (d.kind === 'strip' || d.kind === 'panel') && d.line ? at(d.line) : null
})
const area = computed(() => {
  const d = tabDrag.drop
  if (d?.kind === 'pane') return at(d.box)
  if (d?.kind === 'panel' && d.box) return at(d.box)
  return null
})
</script>

<template>
  <Teleport to="body">
    <div v-if="tabDrag.item" class="tdl" aria-hidden="true">
      <div v-if="area" class="tdl__area" :style="area" />
      <div v-if="line" class="tdl__line" :style="line" />
      <!-- At the edge and past it: the window's outline says where the chat is going. -->
      <div v-if="(edge || out) && !own" class="tdl__frame" :class="{ 'is-out': out }" />
      <div class="tdl__ghost" :class="{ 'is-out': out && !own }" :style="ghost">
        <span class="tdl__tab">
          <AppWindow v-if="out && !own" class="tdl__icon" />
          <UiRipenessDot v-else-if="chat" :status="chat.archived ? 'archived' : chat.status" :size="11" />
          <PluginIcon v-else-if="panelTab" :icon="panelTab.icon" class="tdl__icon" />
          <component :is="tabDrag.remote ? Server : SquareTerminal" v-else class="tdl__icon" />
          <span class="tdl__title">{{ tabDrag.title }}</span>
        </span>
        <span v-if="hint" class="tdl__hint">{{ hint }}</span>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.tdl {
  position: fixed;
  inset: 0;
  z-index: 90;
  pointer-events: none;
}
.tdl__area {
  position: fixed;
  border-radius: var(--radius-md);
  background: var(--accent-soft);
  box-shadow: inset 0 0 0 1px var(--accent-line);
}
.tdl__line {
  position: fixed;
  border-radius: var(--radius-xs);
  background: var(--accent);
}
/* The window's own outline: faint at the edge, firm once the chat is out. */
.tdl__frame {
  position: fixed;
  inset: 0;
  box-shadow: inset 0 0 0 1px var(--accent-line);
  transition: box-shadow var(--dur-fast) var(--ease-out);
}
.tdl__frame.is-out { box-shadow: inset 0 0 0 2px var(--accent); }
.tdl__ghost {
  position: fixed;
  left: 0;
  top: 0;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--space-1);
  max-width: 260px;
}
.tdl__tab {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 26px;
  max-width: 100%;
  padding: 0 var(--space-3) 0 var(--space-2);
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
  background: var(--bg-raised);
  box-shadow: var(--shadow-pop);
  color: var(--fg);
  font-size: var(--text-sm);
  white-space: nowrap;
  transition: border-color var(--dur-fast) var(--ease-out);
}
.tdl__ghost.is-out .tdl__tab { border-color: var(--accent-line); }
.tdl__icon { flex: none; width: 14px; height: 14px; stroke-width: 1.75; color: var(--accent-ink); }
.tdl__title { overflow: hidden; text-overflow: ellipsis; }
.tdl__hint {
  padding: 2px var(--space-2);
  border-radius: var(--radius-sm);
  background: var(--bg-raised);
  box-shadow: var(--shadow-pop);
  color: var(--fg-muted);
  font-size: var(--text-xs);
  white-space: nowrap;
}
</style>

<style>
/* While a tab is dragged the pointer says so everywhere, over xterm's text cursor too. */
body.is-moving-tab,
body.is-moving-tab * {
  cursor: grabbing !important;
}
</style>
