<script setup lang="ts">
import { useWorkspace } from '~/stores/workspace'

/**
 * The open tool window on the right of the chats: the project's files or
 * source control. Owns the width; the panel inside owns its own header.
 */

const ws = useWorkspace()
const root = ref<HTMLElement | null>(null)

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
  <aside ref="root" class="tp" :style="{ width: `${ws.toolWidth}px`, '--tool-w': `${ws.toolWidth}px`, '--left-w': `${ws.sidebarOpen ? ws.sidebarWidth : 0}px` }" :aria-label="ws.toolPanel === 'files' ? 'Files' : 'Changes'">
    <FilesPanel v-if="ws.toolPanel === 'files'" />
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
