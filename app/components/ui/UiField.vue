<script setup lang="ts">
/** Label + control + hint/error. Put an <input class="input"> in the default slot. */
defineProps<{ label: string; hint?: string; error?: string | null; for?: string }>()
</script>

<template>
  <div class="field" :class="{ 'has-error': !!error }">
    <label class="field__label" :for="$props.for">{{ label }}</label>
    <slot />
    <p v-if="error" class="field__msg field__msg--error" role="alert">{{ error }}</p>
    <p v-else-if="hint" class="field__msg">{{ hint }}</p>
  </div>
</template>

<style scoped>
.field { display: grid; gap: 6px; }
.field + .field { margin-top: var(--space-4); }
.field__label { font-size: var(--text-xs); font-weight: 560; color: var(--fg-muted); }
.field__msg { margin: 0; font-size: var(--text-xs); color: var(--fg-subtle); line-height: var(--leading-tight); }
.field__msg--error { color: var(--ripe-error); }
.field :deep(.input) {
  height: 32px;
  width: 100%;
  padding: 0 var(--space-3);
  background: var(--bg-inset);
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  font-size: var(--text-sm);
  transition: border-color var(--dur-fast) var(--ease-out), box-shadow var(--dur-fast) var(--ease-out);
}
.field :deep(.input::placeholder) { color: var(--fg-faint); }
.field :deep(.input:focus-visible) { outline: none; }
.field :deep(.input:focus) { border-color: var(--accent-line); box-shadow: 0 0 0 3px var(--accent-soft); }
.field.has-error :deep(.input) { border-color: color-mix(in oklch, var(--ripe-error) 60%, transparent); }
</style>
