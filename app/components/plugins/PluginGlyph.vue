<script setup lang="ts">
import type { Component } from 'vue'
import PluginIcon from '~/plugin-host/ui/PluginIcon.vue'

/**
 * A plugin's icon at 16px in Settings (catalog rows, the rail, the detail page): a Vue component, raw
 * `<svg>` markup, or any lucide name in kebab-case, resolved the same way as everywhere plugins draw
 * (`plugin-host/ui/PluginIcon.vue`, which loads names on demand). Unknown names show the puzzle piece.
 */
defineProps<{ icon?: Component | string | null }>()
</script>

<template>
  <span class="glyph" aria-hidden="true"><PluginIcon :icon="icon" /></span>
</template>

<style scoped>
.glyph { display: inline-grid; place-items: center; flex: none; width: 16px; height: 16px; }
.glyph :deep(svg) { width: 100%; height: 100%; }
</style>
