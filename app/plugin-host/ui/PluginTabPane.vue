<script setup lang="ts">
import PluginViewHost from '~/components/plugins/PluginViewHost.vue'
import PluginIcon from './PluginIcon.vue'
import { parsePluginTab } from '~/plugin-host/ids'
import { pluginNames, pluginTabView, pluginTabs } from '~/plugin-host/registry'
import type { TabContext } from '~/plugin-host/types'
import { usePluginRuntime } from '~/plugin-host/runtime'
import { useThreads } from '~/stores/threads'

/**
 * A plugin's tab in the main area (`ui.tabs`): a header like the other panes, then the plugin's view.
 * While its plugin is not running the tab stays and says so; turning the plugin off closes it.
 */
const props = defineProps<{ tabId: string; paneId: string; split: boolean; active: boolean }>()
const threads = useThreads()
const runtime = usePluginRuntime()

const ref_ = computed(() => parsePluginTab(props.tabId))
const view = computed(() => (ref_.value ? pluginTabView(ref_.value.pluginId, ref_.value.viewId) : null))
const title = computed(() => pluginTabs[props.tabId]?.title ?? ref_.value?.viewId ?? 'Plugin')
const plugin = computed(() => (ref_.value ? pluginNames[ref_.value.pluginId] ?? ref_.value.pluginId : ''))

const ctx = computed<TabContext>(() => {
  const id = props.tabId
  return {
    state: pluginTabs[id]?.state,
    projectPath: ref_.value?.projectPath ?? null,
    setTitle(next: string) {
      const tab = pluginTabs[id]
      if (tab && typeof next === 'string' && next.trim()) tab.title = next.trim()
    },
    close: () => threads.closeTab(id),
  }
})
</script>

<template>
  <section class="ptp" :class="{ 'is-active': active, 'is-split': split }" :aria-label="title">
    <header class="ptp__head">
      <PluginIcon :icon="view?.icon" class="ptp__icon" />
      <h2 class="ptp__name" :title="title">{{ title }}</h2>
      <span class="ptp__from">{{ plugin }}</span>
    </header>
    <div v-if="view" class="ptp__body">
      <PluginViewHost :key="tabId" :view="view.view" :ctx="ctx" :plugin-id="view.pluginId" />
    </div>
    <div v-else-if="runtime.ready" class="ptp__gone">
      <p>{{ plugin || 'The plugin' }} is not running, so this tab has nothing to show. Turn it on in Settings &gt; Plugins, or close the tab.</p>
    </div>
  </section>
</template>

<style scoped>
.ptp {
  flex: 1 1 0;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--bg-canvas);
}
.ptp__head {
  flex: none;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  height: 40px;
  padding: 0 var(--space-3) 0 var(--space-4);
  border-bottom: 1px solid var(--line-soft);
}
.ptp.is-split:not(.is-active) .ptp__head { opacity: 0.72; }
.ptp__icon { flex: none; width: 14px; height: 14px; stroke-width: 1.75; color: var(--accent-ink); }
.ptp__name {
  margin: 0;
  min-width: 0;
  font-size: var(--text-md);
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ptp__from { flex: none; font-size: var(--text-xs); color: var(--fg-subtle); }
.ptp__body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: auto;
}
.ptp__gone {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--space-6);
  font-size: var(--text-sm);
  color: var(--fg-subtle);
}
.ptp__gone p { margin: 0; max-width: 46ch; text-align: center; text-wrap: pretty; }
</style>
