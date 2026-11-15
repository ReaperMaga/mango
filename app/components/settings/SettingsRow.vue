<script setup lang="ts">
/** A setting on one line: what it is on the left, the control on the right. */
defineProps<{ label: string; hint?: string }>()
const id = useId()
</script>

<template>
  <div class="srow">
    <div class="srow__text">
      <div :id="id" class="srow__label">{{ label }}</div>
      <p v-if="hint || $slots.hint" class="srow__hint"><slot name="hint">{{ hint }}</slot></p>
    </div>
    <div class="srow__control">
      <slot :label-id="id" />
    </div>
  </div>
</template>

<style scoped>
.srow {
  display: flex;
  align-items: center;
  gap: var(--space-6);
  min-height: 52px;
  padding: var(--space-3) 0;
}
.srow__text { flex: 1; min-width: 0; }
.srow__label { font-size: var(--text-sm); font-weight: 560; color: var(--fg); }
.srow__hint {
  margin: 2px 0 0;
  font-size: var(--text-xs);
  color: var(--fg-subtle);
  text-wrap: pretty;
}
.srow__control { flex: none; }
</style>
