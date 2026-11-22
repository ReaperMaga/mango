<script setup lang="ts">
import { ArrowDownToLine, X } from 'lucide-vue-next'
import PluginIcon from './PluginIcon.vue'
import { parsePanelEditorTab } from '~/plugin-host/ids'
import { findPanelTab, panelTabPlugin } from '~/composables/panelTabs'
import { registerTerminalSlot } from '~/composables/useTerminalDrag'
import { useWorkspace } from '~/stores/workspace'
import { useThreads } from '~/stores/threads'

/**
 * A panel tab (the Git log, or a plugin's from `ui.panelTabs`) moved into the main area. Like a terminal's pane, it only gives
 * the view a place: TerminalPanel keeps the view and teleports it into `host` while this pane
 * shows it, so moving the tab between the panel and the main area keeps its state.
 */
const props = defineProps<{ tabId: string; paneId: string; split: boolean; active: boolean }>()
const ws = useWorkspace()
const threads = useThreads()

const ref_ = computed(() => parsePanelEditorTab(props.tabId)?.ref ?? '')
const tab = computed(() => findPanelTab(ref_.value))
const plugin = computed(() => panelTabPlugin(tab.value))

const host = ref<HTMLElement | null>(null)
watch([ref_, host], ([id, el], _old, onCleanup) => {
  if (id && el) onCleanup(registerTerminalSlot(id, el))
}, { immediate: true })
</script>

<template>
  <section class="pnp" :class="{ 'is-active': active, 'is-split': split }" :aria-label="tab?.title ?? 'Panel tab'">
    <header class="pnp__head">
      <PluginIcon :icon="tab?.icon" class="pnp__icon" />
      <h2 class="pnp__name" :title="tab?.title">{{ tab?.title ?? 'Panel tab' }}</h2>
      <span v-if="plugin" class="pnp__from">{{ plugin }}</span>
      <span class="pnp__spacer" />
      <UiIconButton size="sm" label="Move to panel" :disabled="!tab" @click="ws.movePanelTabToPanel(ref_)"><ArrowDownToLine /></UiIconButton>
      <UiIconButton v-if="split" size="sm" label="Close pane" @click.stop="threads.closePane(paneId)"><X /></UiIconButton>
    </header>
    <div ref="host" class="pnp__body" />
  </section>
</template>

<style scoped>
.pnp {
  flex: 1 1 0;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--bg-canvas);
}
.pnp__head {
  flex: none;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  height: 40px;
  padding: 0 var(--space-3) 0 var(--space-4);
  border-bottom: 1px solid var(--line-soft);
}
.pnp.is-split:not(.is-active) .pnp__head { opacity: 0.72; }
.pnp__icon { flex: none; width: 14px; height: 14px; stroke-width: 1.75; color: var(--accent-ink); }
.pnp__name {
  margin: 0;
  min-width: 0;
  font-size: var(--text-md);
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.pnp__from { flex: none; font-size: var(--text-xs); color: var(--fg-subtle); }
.pnp__spacer { flex: 1; }
.pnp__body {
  flex: 1;
  min-height: 0;
  position: relative;
}
</style>
