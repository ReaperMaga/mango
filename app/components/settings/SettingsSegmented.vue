<script setup lang="ts" generic="T extends string">
import type { Component } from 'vue'

/**
 * A short either-or choice shown as one control. Native radios underneath, so
 * arrow keys, form semantics and screen readers work without extra code.
 */
defineProps<{
  modelValue: T
  /** `disabled` options stay visible (with `title` saying why) but can't be picked. */
  options: Array<{ value: T; label: string; icon?: Component; disabled?: boolean; title?: string }>
  /** id of the element that names the group */
  labelledby?: string
  label?: string
  /** id of the element that describes the group (a hint under it) */
  describedby?: string
}>()
const emit = defineEmits<{ 'update:modelValue': [value: T] }>()
const name = useId()
</script>

<template>
  <div class="seg" role="radiogroup" :aria-labelledby="labelledby" :aria-label="label" :aria-describedby="describedby">
    <label v-for="o in options" :key="o.value" class="seg__opt" :title="o.title">
      <input
        class="seg__input"
        type="radio"
        :name="name"
        :value="o.value"
        :checked="modelValue === o.value"
        :disabled="o.disabled"
        @change="emit('update:modelValue', o.value)"
      >
      <span class="seg__face">
        <component :is="o.icon" v-if="o.icon" aria-hidden="true" />
        {{ o.label }}
      </span>
    </label>
  </div>
</template>

<style scoped>
.seg {
  display: inline-flex;
  gap: 2px;
  padding: 2px;
  background: var(--bg-inset);
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
}
.seg__opt { position: relative; display: flex; }
/* The real radio covers its face: clicks and focus land on it directly. */
.seg__input {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  margin: 0;
  opacity: 0;
  cursor: pointer;
}
.seg__face {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 24px;
  padding: 0 10px;
  font-size: var(--text-sm);
  font-weight: 540;
  white-space: nowrap;
  color: var(--fg-subtle);
  border: 1px solid transparent;
  border-radius: var(--radius-xs);
  transition: background var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out), border-color var(--dur-fast) var(--ease-out);
}
.seg__face :deep(svg) { width: 14px; height: 14px; stroke-width: 1.75; flex: none; }
.seg__input:hover:not(:disabled) + .seg__face { color: var(--fg); }
.seg__input:disabled { cursor: default; }
.seg__input:disabled + .seg__face { opacity: 0.55; }
.seg__input:checked + .seg__face {
  color: var(--fg);
  background: var(--bg-raised);
  border-color: var(--line);
}
.seg__input:focus-visible + .seg__face {
  outline: 2px solid var(--focus-ring);
  outline-offset: 1px;
}
</style>
