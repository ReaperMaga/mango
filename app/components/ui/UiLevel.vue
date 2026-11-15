<script setup lang="ts">
/**
 * A segmented level meter: `max` segments, the first `value` filled. Used for the
 * reasoning effort, where each segment is one level. `muted` fills in a quieter
 * tone, for a level that only applies by default.
 */
withDefaults(defineProps<{ value: number; max: number; size?: 'sm' | 'md'; muted?: boolean }>(), { size: 'md', muted: false })
</script>

<template>
  <span class="lvl" :class="[`lvl--${size}`, { 'is-muted': muted }]" aria-hidden="true">
    <span v-for="i in max" :key="i" class="lvl__seg" :class="{ 'is-on': i <= value }" />
  </span>
</template>

<style scoped>
.lvl { display: inline-flex; align-items: center; gap: 2px; flex: none; }
.lvl__seg {
  height: 4px;
  width: 10px;
  border-radius: var(--radius-pill);
  background: var(--line-strong);
  transition: background var(--dur-fast) var(--ease-out);
}
.lvl--sm { gap: 1.5px; }
.lvl--sm .lvl__seg { width: 4px; height: 8px; }
/* Each step up a little taller in the chip, so it reads as rising effort. */
.lvl--sm .lvl__seg:nth-child(1) { height: 4px; }
.lvl--sm .lvl__seg:nth-child(2) { height: 6px; }
.lvl--sm .lvl__seg:nth-child(3) { height: 8px; }
.lvl--sm .lvl__seg:nth-child(4) { height: 10px; }
.lvl--sm .lvl__seg:nth-child(5) { height: 12px; }
.lvl--sm .lvl__seg:nth-child(n + 6) { height: 12px; }
.lvl__seg.is-on { background: var(--accent); }
.lvl.is-muted .lvl__seg.is-on { background: var(--fg-faint); }

@media (prefers-reduced-motion: reduce) {
  .lvl__seg { transition: none; }
}
</style>
