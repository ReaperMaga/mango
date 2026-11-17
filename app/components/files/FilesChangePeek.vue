<script setup lang="ts">
import { RotateCcw, X } from 'lucide-vue-next'
import type { LineChange } from '~/utils/lineDiff'

/**
 * What a change marker in the editor's gutter stands for, opened under the change: the lines as
 * they were committed, and Revert to put them back (one undo step). Rendered into a Monaco view zone.
 */
const props = defineProps<{ change: LineChange; lineHeight: number; maxLines: number }>()
const emit = defineEmits<{ revert: []; close: [] }>()

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`
const title = computed(() => {
  const c = props.change
  if (c.kind === 'add') return `Added ${plural(c.count, 'line')}`
  if (c.kind === 'del') return `Removed ${plural(c.old.length, 'line')}`
  return `Changed ${plural(c.count, 'line')}, committed as`
})
</script>

<template>
  <div class="peek" :style="{ '--lh': `${lineHeight}px`, '--rows': Math.min(change.old.length, maxLines) }" @mousedown.stop @keydown.esc.stop="emit('close')">
    <div class="peek__head">
      <span class="peek__title">{{ title }}</span>
      <button type="button" class="peek__btn" title="Put the committed lines back (undo restores your edit)" @click="emit('revert')">
        <RotateCcw aria-hidden="true" /><span>Revert</span>
      </button>
      <button type="button" class="peek__btn peek__btn--icon" aria-label="Close" title="Close (Esc)" @click="emit('close')">
        <X aria-hidden="true" />
      </button>
    </div>
    <div v-if="change.old.length" class="peek__old selectable" role="table" aria-label="Committed lines">
      <div v-for="(l, i) in change.old" :key="i" class="peek__line" role="row">
        <span class="peek__sign" aria-hidden="true">−</span><span class="peek__text">{{ l || ' ' }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.peek {
  box-sizing: border-box;
  height: 100%;
  display: flex;
  flex-direction: column;
  margin-right: var(--space-4);
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
  background: var(--bg-panel);
  overflow: hidden;
  font-family: var(--font-ui);
  cursor: default;
}
.peek__head {
  flex: none;
  display: flex;
  align-items: center;
  gap: var(--space-1);
  height: 30px;
  padding: 0 var(--space-1) 0 var(--space-3);
}
.peek__title { flex: 1; min-width: 0; font-size: var(--text-xs); font-weight: 560; color: var(--fg-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.peek__btn {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 22px;
  padding: 0 8px 0 6px;
  border-radius: var(--radius-xs);
  font-size: var(--text-xs);
  font-weight: 540;
  color: var(--fg-subtle);
  transition: background var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out);
}
.peek__btn:hover { background: var(--bg-hover); color: var(--fg); }
.peek__btn:active { background: var(--bg-active); }
.peek__btn:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 1px; }
.peek__btn svg { width: 13px; height: 13px; stroke-width: 1.85; }
.peek__btn--icon { width: 22px; padding: 0; justify-content: center; }
.peek__old {
  flex: 1;
  min-height: 0;
  overflow: auto;
  border-top: 1px solid var(--line-soft);
  background: var(--bg-inset);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  line-height: var(--lh);
}
.peek__line { display: flex; min-width: max-content; padding-right: var(--space-3); white-space: pre; background: var(--diff-del-bg); }
.peek__sign { width: 24px; flex: none; text-align: center; color: var(--diff-del-fg); user-select: none; }
.peek__text { color: var(--diff-del-fg); }
</style>
