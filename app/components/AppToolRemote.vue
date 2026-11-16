<script setup lang="ts">
import { SquareTerminal } from 'lucide-vue-next'
import { useWorkspace } from '~/stores/workspace'

/**
 * What a tool window shows for a remote project (a folder inside an environment): the Files
 * and Pull requests views read this computer's disk, which holds nothing of it.
 * Says so calmly and offers the way in that works: a terminal in the instance.
 */
const props = defineProps<{ title: string }>()

const ws = useWorkspace()
const place = computed(() => remotePlace(ws.activeProjectPath))
</script>

<template>
  <section class="tr" :aria-label="props.title">
    <header class="tr__head">
      <h2 class="tr__title">{{ props.title }}</h2>
    </header>
    <div class="tr__body">
      <p class="tr__lead">Not available for remote environments yet.</p>
      <p>
        <template v-if="place"><strong>{{ ws.activeProject?.name }}</strong> is in {{ place.where }}. </template>
        Open a terminal to work in the environment.
      </p>
      <UiButton size="sm" @click="ws.newTerminal()">
        <SquareTerminal aria-hidden="true" />
        Open terminal
      </UiButton>
    </div>
  </section>
</template>

<style scoped>
.tr {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}
.tr__head {
  flex: none;
  display: flex;
  align-items: center;
  height: var(--tabbar-h);
  padding: 0 var(--space-2) 0 var(--space-3);
}
.tr__title {
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
.tr__body {
  display: grid;
  gap: var(--space-2);
  justify-items: start;
  padding: var(--space-3) var(--space-4);
  border-top: 1px solid var(--line-soft);
  font-size: var(--text-sm);
  line-height: var(--leading-normal);
  color: var(--fg-subtle);
}
.tr__body p { margin: 0; max-width: 46ch; overflow-wrap: anywhere; }
.tr__body .tr__lead { color: var(--fg); font-weight: 600; }
.tr__body strong { font-weight: 600; color: var(--fg-muted); }
.tr__body :deep(.btn) { margin-top: var(--space-1); }
</style>
