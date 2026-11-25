<script setup lang="ts">
import { computed } from 'vue'
import type { Collection } from '../model.ts'
import Icon from '../ui/Icon.vue'
import { colorVar } from '../ui/colors.ts'

/** A collection's icon in its colour. A mark, never text. */
const props = defineProps<{ collection: Pick<Collection, 'icon' | 'color'> }>()
const color = computed(() => (props.collection.color === 'neutral' ? 'var(--fg-subtle)' : colorVar(props.collection.color).dot))
</script>

<template>
  <span class="pl-cicon" :style="{ color }" aria-hidden="true"><Icon :name="collection.icon" /></span>
</template>

<style scoped>
.pl-cicon { flex: none; display: inline-grid; place-items: center; width: 15px; height: 15px; }
.pl-cicon > svg { width: 15px; height: 15px; stroke-width: 1.75; }
</style>
