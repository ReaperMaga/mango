<script setup lang="ts">
import PluginViewHost from '~/components/plugins/PluginViewHost.vue'
import PluginIcon from './PluginIcon.vue'
import { jsonState, parsePluginTab } from '~/plugin-host/ids'
import { pluginNames, pluginTabView, pluginTabs, report } from '~/plugin-host/registry'
import type { TabContext } from '~/plugin-host/types'
import { usePluginRuntime } from '~/plugin-host/runtime'
import { useThreads } from '~/stores/threads'

/**
 * A plugin's tab in the main area (`ui.tabs`): a header like the other panes, then the plugin's view.
 * While its plugin starts the pane waits, empty; when the plugin is not running it says so; turning the plugin
 * off closes the tab. A view with `header: 'none'` draws its own header.
 */
const props = defineProps<{ tabId: string; paneId: string; split: boolean; active: boolean }>()
const { t } = useI18n()
const threads = useThreads()
const runtime = usePluginRuntime()

const ref_ = computed(() => parsePluginTab(props.tabId))
const view = computed(() => (ref_.value ? pluginTabView(ref_.value.pluginId, ref_.value.viewId) : null))
const title = computed(() => pluginTabs[props.tabId]?.title ?? ref_.value?.viewId ?? t('plugins.view.plugin'))
const plugin = computed(() => (ref_.value ? pluginNames[ref_.value.pluginId] ?? ref_.value.pluginId : ''))

/** Its plugin may still bring the view: nothing to say yet. */
const waiting = computed(() => {
  if (view.value) return false
  const status = ref_.value ? runtime.states[ref_.value.pluginId]?.status : undefined
  return status === 'loading' || (status === undefined && !runtime.ready)
})

const ctx = computed<TabContext>(() => {
  const id = props.tabId
  const projectPath = ref_.value?.projectPath ?? null
  const pluginId = ref_.value?.pluginId ?? ''
  // Read here so a component's `ctx` changes with its state; the getter keeps a `mount` view's current.
  void pluginTabs[id]?.state
  return {
    get state() { return pluginTabs[id]?.state },
    projectPath,
    setTitle(next: string) {
      const tab = pluginTabs[id]
      if (!tab || typeof next !== 'string' || !next.trim() || tab.title === next.trim()) return
      tab.title = next.trim()
      if (tab.restore) threads.persistLayout()
    },
    setState(next: unknown) {
      const tab = pluginTabs[id]
      if (!tab) return
      if (tab.restore && next !== undefined && jsonState(next) === undefined) report(pluginId, new Error('The state is not JSON (or is over 256 KB), so it is not kept across restarts.'), 'setState')
      tab.state = next && typeof next === 'object' ? markRaw(next as object) : next
      if (tab.restore) threads.persistLayout()
    },
    close: () => threads.closeTab(id),
  }
})
</script>

<template>
  <section class="ptp" :class="{ 'is-active': active, 'is-split': split }" :aria-label="title">
    <header v-if="view ? view.header !== 'none' : !waiting" class="ptp__head">
      <PluginIcon :icon="view?.icon ?? pluginTabs[tabId]?.icon" class="ptp__icon" />
      <h2 class="ptp__name" :title="title">{{ title }}</h2>
      <span class="ptp__from">{{ plugin }}</span>
    </header>
    <div v-if="view" class="ptp__body">
      <PluginViewHost :key="tabId" :view="view.view" :ctx="ctx" :plugin-id="view.pluginId" />
    </div>
    <div v-else-if="!waiting" class="ptp__gone">
      <p>{{ plugin ? t('plugins.view.tabGone', { plugin }) : t('plugins.view.tabGoneUnnamed') }}</p>
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
