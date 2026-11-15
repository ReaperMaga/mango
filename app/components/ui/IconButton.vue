<script setup lang="ts">
withDefaults(defineProps<{ label: string; active?: boolean; size?: 'sm' | 'md'; shortcut?: string }>(), { active: false, size: 'md' })
</script>

<template>
  <button
    type="button"
    class="icon-btn"
    :class="[`icon-btn--${size}`, { 'is-active': active }]"
    :aria-label="label"
    :aria-pressed="active || undefined"
    :title="shortcut ? `${label} (${shortcut})` : label"
  >
    <slot />
  </button>
</template>

<style scoped>
.icon-btn {
  display: inline-grid;
  place-items: center;
  flex: none;
  color: var(--fg-subtle);
  border-radius: var(--radius-sm);
  transition: background var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out);
}
.icon-btn--md { width: 28px; height: 28px; }
.icon-btn--sm { width: 22px; height: 22px; border-radius: var(--radius-xs); }
.icon-btn :deep(svg) { width: 16px; height: 16px; stroke-width: 1.75; }
.icon-btn--sm :deep(svg) { width: 14px; height: 14px; }
.icon-btn:hover { background: var(--bg-hover); color: var(--fg); }
.icon-btn:active { background: var(--bg-active); }
.icon-btn.is-active { color: var(--fg); background: var(--bg-active); }
.icon-btn:disabled { opacity: 0.4; background: none; }
</style>
