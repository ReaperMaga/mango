<script setup lang="ts">
import { PanelRightClose } from 'lucide-vue-next'
import PluginViewHost from '~/components/plugins/PluginViewHost.vue'
import PluginIcon from './PluginIcon.vue'
import type { Owned } from '~/plugin-host/registry'
import type { PluginToolWindow, ToolWindowContext } from '~/plugin-host/types'
import { usePluginRuntime } from '~/plugin-host/runtime'
import { useWorkspace } from '~/stores/workspace'
import { useThreads } from '~/stores/threads'

/**
 * A plugin's tool window in the panel on the right (AppToolPanel owns width and resizing): a header
 * like Mango's own panels, then the plugin's view. A window whose plugin is not running (turned off,
 * failed, not loaded yet) says so calmly instead of showing another tool.
 */
const props = defineProps<{ win: Owned<PluginToolWindow> | null }>()
const { t } = useI18n()
const ws = useWorkspace()
const threads = useThreads()
const runtime = usePluginRuntime()

const ctx = computed<ToolWindowContext>(() => ({
  projectPath: threads.workdir ?? ws.activeProjectPath,
  close: () => ws.closeTool(),
}))
</script>

<template>
  <section class="ptw" :aria-label="win?.title ?? t('plugins.view.toolWindow')">
    <header class="ptw__head">
      <PluginIcon v-if="win" :icon="win.icon" class="ptw__icon" />
      <h2 class="ptw__title" :title="win?.title">{{ win?.title ?? t('plugins.view.plugin') }}</h2>
      <UiIconButton :label="t('plugins.view.closeTool')" size="sm" @click="ws.closeTool()"><PanelRightClose /></UiIconButton>
    </header>
    <div v-if="win" class="ptw__body">
      <PluginViewHost :view="win.view" :ctx="ctx" :plugin-id="win.pluginId" />
    </div>
    <div v-else-if="runtime.ready" class="ptw__gone">
      <p>{{ t('plugins.view.toolGone') }}</p>
    </div>
  </section>
</template>

<style scoped>
.ptw { display: flex; flex-direction: column; flex: 1; min-height: 0; }
.ptw__head {
  flex: none;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  height: var(--tabbar-h);
  padding: 0 var(--space-2) 0 var(--space-3);
  border-bottom: 1px solid var(--line);
}
.ptw__icon { flex: none; width: 14px; height: 14px; stroke-width: 1.75; color: var(--fg-subtle); }
.ptw__title {
  flex: 1;
  min-width: 0;
  margin: 0;
  font-size: var(--text-sm);
  font-weight: 600;
  color: var(--fg);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ptw__body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: auto;
}
.ptw__gone {
  padding: var(--space-4);
  font-size: var(--text-sm);
  color: var(--fg-subtle);
}
.ptw__gone p { margin: 0; max-width: 40ch; text-wrap: pretty; }
</style>
