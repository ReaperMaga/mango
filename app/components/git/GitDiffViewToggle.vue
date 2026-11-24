<script setup lang="ts">
import { Columns2, Rows2 } from 'lucide-vue-next'
import { useWorkspace } from '~/stores/workspace'

/** The diff layout switch in a diff pane's header: side by side or one column, remembered for every diff. */
const { t } = useI18n()
const ws = useWorkspace()

function setView(view: 'split' | 'unified') {
  ws.diffView = view
  ws.persist()
}
</script>

<template>
  <div class="dp__view" role="radiogroup" :aria-label="t('git.diff.layout')">
    <button type="button" role="radio" :aria-checked="ws.diffView === 'split'" :class="{ 'is-on': ws.diffView === 'split' }" :title="t('git.diff.split')" @click="setView('split')">
      <Columns2 /><span class="sr-only">{{ t('git.diff.split') }}</span>
    </button>
    <button type="button" role="radio" :aria-checked="ws.diffView === 'unified'" :class="{ 'is-on': ws.diffView === 'unified' }" :title="t('git.diff.unified')" @click="setView('unified')">
      <Rows2 /><span class="sr-only">{{ t('git.diff.unified') }}</span>
    </button>
  </div>
</template>

<style scoped>
.dp__view {
  flex: none;
  display: inline-flex;
  padding: 2px;
  margin-right: var(--space-1);
  border-radius: var(--radius-sm);
  background: var(--bg-inset);
  box-shadow: inset 0 0 0 1px var(--line-soft);
}
.dp__view button {
  display: grid;
  place-items: center;
  width: 26px;
  height: 22px;
  border-radius: var(--radius-xs);
  color: var(--fg-faint);
  transition: background var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out);
}
.dp__view button svg { width: 14px; height: 14px; stroke-width: 1.75; }
.dp__view button:hover { color: var(--fg-muted); }
.dp__view button.is-on { background: var(--bg-active); color: var(--fg); }
</style>
