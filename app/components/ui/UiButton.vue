<script setup lang="ts">
withDefaults(defineProps<{
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger'
  size?: 'sm' | 'md' | 'lg'
  loading?: boolean
  block?: boolean
  type?: 'button' | 'submit'
}>(), { variant: 'secondary', size: 'md', loading: false, block: false, type: 'button' })
</script>

<template>
  <button
    :type="type"
    class="btn"
    :class="[`btn--${variant}`, `btn--${size}`, { 'btn--block': block, 'is-loading': loading }]"
    :disabled="loading || undefined"
    :aria-busy="loading || undefined"
  >
    <span v-if="loading" class="btn__spin" aria-hidden="true" />
    <slot />
  </button>
</template>

<style scoped>
.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  font-weight: 550;
  white-space: nowrap;
  border-radius: var(--radius-sm);
  border: 1px solid transparent;
  transition: background var(--dur-fast) var(--ease-out), border-color var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out), transform var(--dur-fast) var(--ease-out);
}
.btn:active:not(:disabled) { transform: translateY(0.5px); }
.btn :deep(svg) { width: 15px; height: 15px; stroke-width: 1.85; flex: none; }
.btn--sm { height: 26px; padding: 0 var(--space-2); font-size: var(--text-sm); }
.btn--md { height: 30px; padding: 0 var(--space-3); font-size: var(--text-sm); }
.btn--lg { height: 36px; padding: 0 var(--space-4); font-size: var(--text-md); }
.btn--block { width: 100%; }

.btn--primary { background: var(--accent); color: var(--accent-fg); }
.btn--primary:hover:not(:disabled) { background: var(--accent-strong); }
.btn--secondary { background: var(--bg-panel); border-color: var(--line); color: var(--fg); }
.btn--secondary:hover:not(:disabled) { background: var(--bg-raised); border-color: var(--line-strong); }
.btn--ghost { color: var(--fg-muted); }
.btn--ghost:hover:not(:disabled) { background: var(--bg-hover); color: var(--fg); }
.btn--danger { color: var(--ripe-error); border-color: color-mix(in oklch, var(--ripe-error) 40%, transparent); }
.btn--danger:hover:not(:disabled) { background: color-mix(in oklch, var(--ripe-error) 12%, transparent); }
.btn:disabled { opacity: 0.55; }

.btn__spin {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  border: 1.75px solid currentColor;
  border-right-color: transparent;
  animation: spin 0.7s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }
</style>
