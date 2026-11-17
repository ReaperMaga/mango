<script setup lang="ts">
/**
 * A project's mark: its initials on a tint. The tint is a hue the user picked in Settings > Projects, or
 * one taken from the project's path, so the same project always looks the same.
 */
const props = withDefaults(defineProps<{ name: string; path: string; hue?: number; size?: 'sm' | 'md' }>(), { size: 'md' })

const initials = computed(() => {
  const words = props.name.trim().split(/[\s._-]+/).filter(Boolean)
  const chars = words.length > 1 ? words[0]![0]! + words[1]![0]! : (words[0] ?? '?').slice(0, 2)
  return chars.toUpperCase()
})
const autoHue = computed(() => {
  let h = 0
  for (const c of props.path) h = (h * 31 + c.charCodeAt(0)) % 360
  return h
})
const tint = computed(() => props.hue ?? autoHue.value)
</script>

<template>
  <span class="badge" :class="`badge--${size}`" :style="{ '--badge-hue': tint }" aria-hidden="true">{{ initials }}</span>
</template>

<style scoped>
.badge {
  flex: none;
  display: inline-grid;
  place-items: center;
  width: 24px;
  height: 24px;
  font-size: calc(10px * var(--text-scale));
  font-weight: 640;
  letter-spacing: -0.01em;
  color: oklch(0.82 0.12 var(--badge-hue));
  background: oklch(0.6 0.12 var(--badge-hue) / 0.22);
  border-radius: var(--radius-xs);
}
.badge--sm { width: 20px; height: 20px; font-size: calc(9px * var(--text-scale)); letter-spacing: -0.01em; border-radius: var(--radius-xs); }
:root[data-theme='light'] .badge {
  color: oklch(0.42 0.14 var(--badge-hue));
  background: oklch(0.7 0.12 var(--badge-hue) / 0.25);
}
</style>
