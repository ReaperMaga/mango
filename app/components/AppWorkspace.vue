<script setup lang="ts">
import { useWorkspace } from '~/stores/workspace'
import { ArrowDownToLine } from 'lucide-vue-next'
import { useFilesSync } from '~/composables/useFilesSync'
import { draggedPanelItem } from '~/composables/useTabDrag'
import { useWindows } from '~/stores/windows'

const ws = useWorkspace()
const win = useWindows()
const column = ref<HTMLElement | null>(null)
useFilesSync()
</script>

<template>
  <div class="workspace">
    <Transition name="rail">
      <!-- A chat window shows its chat alone: no list of the project's chats. -->
      <AppSidebar v-if="ws.sidebarOpen && win.spec.kind !== 'chat'" />
    </Transition>
    <div ref="column" class="workspace__main">
      <ChatArea class="workspace__chat" />
      <Transition name="dock">
        <TerminalPanel v-show="ws.terminalOpen" :container="column" />
      </Transition>
      <!-- A terminal or panel tab dragged out of the main area while the panel is hidden: drop it here to dock it. -->
      <div
        v-if="draggedPanelItem()?.from === 'editor' && !ws.terminalOpen"
        class="workspace__dock-drop"
        data-tab-drop="panel"
      >
        <ArrowDownToLine aria-hidden="true" />{{ draggedPanelItem()?.kind === 'panelTab' ? 'Move to the bottom panel' : 'Move to the terminal panel' }}
      </div>
    </div>
    <Transition name="tool">
      <AppToolPanel v-if="ws.toolPanel" />
    </Transition>
    <AppToolStrip />
    <TabDragLayer />
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
.workspace__dock-drop {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  height: 40px;
  border-top: 1px solid var(--line-soft);
  background: var(--bg-inset);
  color: var(--fg-subtle);
  font-size: var(--text-sm);
}
.workspace__dock-drop svg { width: 14px; height: 14px; stroke-width: 1.75; }

.rail-enter-active, .rail-leave-active { transition: margin-left var(--dur-med) var(--ease-out), opacity var(--dur-med) var(--ease-out); }
.rail-enter-from, .rail-leave-to { margin-left: calc(var(--rail-w, 264px) * -1); opacity: 0; }
.tool-enter-active, .tool-leave-active { transition: margin-right var(--dur-med) var(--ease-out), opacity var(--dur-med) var(--ease-out); }
.tool-enter-from, .tool-leave-to { margin-right: calc(var(--tool-w, 340px) * -1); opacity: 0; }
/* The terminal dock slides up out of the column's bottom edge; its height (--dock-h) stays put, so xterm never refits mid-slide. */
.dock-enter-active, .dock-leave-active { transition: margin-bottom var(--dur-med) var(--ease-out), opacity var(--dur-med) var(--ease-out); }
.dock-enter-from, .dock-leave-to { margin-bottom: calc(var(--dock-h, 0px) * -1); opacity: 0; }
</style>
