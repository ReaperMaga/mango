<script setup lang="ts">
import { useWorkspace } from '~/stores/workspace'
import { useForge } from '~/stores/forge'
import { holdOverlay } from '~/composables/useOverlay'
import { pluginToolWindow } from '~/plugin-host/registry'
import { isPluginRef } from '~/plugin-host/ids'
import PluginToolWindow from '~/plugin-host/ui/PluginToolWindow.vue'

/**
 * The open tool window on the right of the chats: where the project runs, its files,
 * source control, the chat's pull requests and issues, or the project's releases. Owns the width; the panel
 * inside owns its own header.
 */

const ws = useWorkspace()
const LABELS: Record<string, string> = { env: 'Environment', files: 'Files', changes: 'Changes', links: 'Pull requests', releases: 'Releases' }
/** A plugin's tool window, while its plugin runs (see `plugin-host/`). */
const pluginWin = computed(() => pluginToolWindow(ws.toolPanel))
/** The Pull requests window is Merge requests for a project on GitLab. */
const forge = useForge()
const label = computed(() => pluginWin.value?.title
  ?? (ws.toolPanel === 'links' && forge.providerOf(ws.activeProjectPath) === 'gitlab' ? 'Merge requests' : null)
  ?? LABELS[ws.toolPanel ?? 'files'] ?? 'Tool window')
const root = ref<HTMLElement | null>(null)

let dragging = false
/* A browser's page would swallow the pointer once it crosses it: the browsers hide during the drag. */
let release = () => {}
function startResize(e: PointerEvent) {
  dragging = true
  release = holdOverlay()
  ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
}
function onResize(e: PointerEvent) {
  if (!dragging || !root.value) return
  ws.setToolWidth(root.value.getBoundingClientRect().right - e.clientX)
}
function endResize() {
  if (!dragging) return
  dragging = false
  release()
  ws.persist()
}
</script>

<template>
  <aside ref="root" class="tp" :style="{ width: `${ws.toolWidth}px`, '--tool-w': `${ws.toolWidth}px`, '--left-w': `${ws.sidebarOpen ? ws.sidebarWidth : 0}px` }" :aria-label="label">
    <!-- Switching tools: the old one goes at once, the new one settles in. Not on open: the window itself slides then. -->
    <Transition name="tp-swap">
      <AppToolEnv v-if="ws.toolPanel === 'env'" />
      <FilesPanel v-else-if="ws.toolPanel === 'files'" />
      <LinksPanel v-else-if="ws.toolPanel === 'links'" />
      <ReleasesPanel v-else-if="ws.toolPanel === 'releases'" />
      <PluginToolWindow v-else-if="isPluginRef(ws.toolPanel)" :key="ws.toolPanel" :win="pluginWin" />
      <GitPanel v-else />
    </Transition>
    <div
      class="tp__resize"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize tool window"
      @pointerdown="startResize"
      @pointermove="onResize"
      @pointerup="endResize"
      @pointercancel="endResize"
      @dblclick="ws.setToolWidth(340); ws.persist()"
    />
  </aside>
</template>

<style scoped>
.tp {
  position: relative;
  flex: none;
  /* The chats keep room to breathe (about 400px) beside the sidebar and the tool stripe. */
  max-width: max(280px, calc(100vw - var(--left-w, 0px) - 40px - 400px));
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: var(--bg-app);
}
.tp-swap-enter-active { transition: opacity var(--dur-med) var(--ease-out), transform var(--dur-med) var(--ease-out); }
.tp-swap-enter-from { opacity: 0; transform: translateY(4px); }
.tp__resize {
  position: absolute;
  top: 0;
  left: -3px;
  bottom: 0;
  width: 6px;
  cursor: col-resize;
  z-index: 5;
}
.tp__resize::after {
  content: '';
  position: absolute;
  inset: 0 2px;
  background: transparent;
  transition: background var(--dur-fast) var(--ease-out);
}
.tp__resize:hover::after, .tp__resize:active::after { background: var(--accent-line); }
</style>
