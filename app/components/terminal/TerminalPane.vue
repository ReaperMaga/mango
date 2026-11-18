<script setup lang="ts">
import { ArrowDownToLine, Server, SquareTerminal, X } from 'lucide-vue-next'
import { useWorkspace } from '~/stores/workspace'
import { useThreads } from '~/stores/threads'
import { registerTerminalSlot } from '~/composables/useTerminalDrag'
import { parseTerminalTab } from '~/utils/terminalTabs'
import { parseEnvPath } from '~/utils/envPath'

/**
 * A terminal shown as a tab in the main area. The xterm itself stays owned by TerminalPanel, which
 * teleports it into `host` while this pane shows it: the shell and its scrollback never restart.
 */
const props = defineProps<{ tabId: string; paneId: string; split: boolean; active: boolean }>()

const ws = useWorkspace()
const threads = useThreads()

const terminalId = computed(() => parseTerminalTab(props.tabId)?.terminalId ?? '')
const tab = computed(() => ws.terminalTabs.find(t => t.id === terminalId.value) ?? null)
const remote = computed(() => parseEnvPath(tab.value?.cwd))
/** The folder it started in: inside the environment for a remote shell. */
const folder = computed(() => remote.value ? remote.value.dir : tab.value?.cwd ?? '')

const host = ref<HTMLElement | null>(null)
watch([terminalId, host], ([id, el], _old, onCleanup) => {
  if (id && el) onCleanup(registerTerminalSlot(id, el))
}, { immediate: true })
</script>

<template>
  <section class="tp" :class="{ 'is-active': active, 'is-split': split }" :aria-label="tab ? `Terminal ${tab.title}` : 'Terminal'">
    <header class="tp__head">
      <component :is="remote ? Server : SquareTerminal" class="tp__icon" aria-hidden="true" />
      <h2 class="tp__name">{{ tab?.title ?? 'Terminal' }}</h2>
      <span v-if="tab?.shell" class="tp__shell">{{ tab.shell }}</span>
      <span v-if="folder" class="tp__dir selectable" :title="folder"><bdi>{{ folder }}</bdi></span>
      <span v-if="tab?.exited" class="tp__state">Exited</span>
      <span class="tp__spacer" />
      <UiIconButton size="sm" label="Move to panel" :disabled="!tab" @click="tab && ws.moveTerminalToPanel(tab.id)"><ArrowDownToLine /></UiIconButton>
      <UiIconButton v-if="split" size="sm" label="Close pane" @click.stop="threads.closePane(paneId)"><X /></UiIconButton>
    </header>
    <div ref="host" class="tp__body" />
  </section>
</template>

<style scoped>
.tp {
  flex: 1 1 0;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--bg-canvas);
}
.tp__head {
  flex: none;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  height: 40px;
  padding: 0 var(--space-3) 0 var(--space-4);
  border-bottom: 1px solid var(--line-soft);
}
.tp.is-split:not(.is-active) .tp__head { opacity: 0.72; }
.tp__icon { flex: none; width: 14px; height: 14px; stroke-width: 1.75; color: var(--accent-ink); }
.tp__name {
  margin: 0;
  flex: none;
  max-width: 40%;
  font-size: var(--text-md);
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.tp__shell { flex: none; font-size: var(--text-xs); color: var(--fg-subtle); }
.tp__dir {
  min-width: 0;
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--fg-subtle);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  /* Keep the end of a long path visible. */
  direction: rtl;
  text-align: left;
}
.tp__state { flex: none; font-size: var(--text-xs); font-weight: 560; color: var(--fg-subtle); }
.tp__spacer { flex: 1; }
/* The inset well the terminal draws on, as in the panel. */
.tp__body {
  flex: 1;
  min-height: 0;
  position: relative;
  background: var(--term-bg);
}
</style>
