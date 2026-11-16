<script setup lang="ts">
import { useWorkspace } from '~/stores/workspace'
import { isEnvPath } from '~/utils/envPath'

/**
 * The open tool window on the right of the chats: the project's files, source
 * control, or the chat's pull requests and issues. Owns the width; the panel
 * inside owns its own header.
 */

const ws = useWorkspace()
const LABELS = { files: 'Files', changes: 'Changes', links: 'Pull requests' } as const
const root = ref<HTMLElement | null>(null)
const remote = computed(() => isEnvPath(ws.activeProjectPath))

let dragging = false
function startResize(e: PointerEvent) {
  dragging = true
  ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
}
function onResize(e: PointerEvent) {
  if (!dragging || !root.value) return
  ws.setToolWidth(root.value.getBoundingClientRect().right - e.clientX)
}
function endResize() {
  if (!dragging) return
  dragging = false
  ws.persist()
}
</script>

<template>
  <aside ref="root" class="tp" :style="{ width: `${ws.toolWidth}px`, '--tool-w': `${ws.toolWidth}px`, '--left-w': `${ws.sidebarOpen ? ws.sidebarWidth : 0}px` }" :aria-label="LABELS[ws.toolPanel ?? 'files']">
    <!-- A remote project has nothing on this computer's disk for these views to read. -->
    <AppToolRemote v-if="remote" :title="LABELS[ws.toolPanel ?? 'files']" />
    <FilesPanel v-else-if="ws.toolPanel === 'files'" />
    <LinksPanel v-else-if="ws.toolPanel === 'links'" />
    <GitPanel v-else />
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
