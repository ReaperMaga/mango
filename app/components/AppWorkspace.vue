<script setup lang="ts">
import { useWorkspace } from '~/stores/workspace'
import { useFilesSync } from '~/composables/useFilesSync'

const ws = useWorkspace()
const column = ref<HTMLElement | null>(null)
useFilesSync()
</script>

<template>
  <div class="workspace">
    <Transition name="rail">
      <AppSidebar v-if="ws.sidebarOpen" />
    </Transition>
    <div ref="column" class="workspace__main">
      <ChatArea class="workspace__chat" />
      <TerminalPanel v-show="ws.terminalOpen" :container="column" />
    </div>
    <Transition name="tool">
      <AppToolPanel v-if="ws.toolPanel" />
    </Transition>
    <AppToolStrip />
  </div>
</template>

<style scoped>
.workspace {
  flex: 1;
  display: flex;
  min-width: 0;
  min-height: 0;
}
.workspace__main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  background: var(--bg-canvas);
  /* No top edge: the tab strip's hairline shares one row with the tool window's header. */
  border: 1px solid var(--line-soft);
  border-width: 0 1px;
  overflow: hidden;
}
.workspace__chat { flex: 1; min-height: 0; }

.rail-enter-active, .rail-leave-active { transition: margin-left var(--dur-med) var(--ease-out), opacity var(--dur-med) var(--ease-out); }
.rail-enter-from, .rail-leave-to { margin-left: calc(var(--rail-w, 264px) * -1); opacity: 0; }
.tool-enter-active, .tool-leave-active { transition: margin-right var(--dur-med) var(--ease-out), opacity var(--dur-med) var(--ease-out); }
.tool-enter-from, .tool-leave-to { margin-right: calc(var(--tool-w, 340px) * -1); opacity: 0; }
</style>
