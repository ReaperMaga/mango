<script setup lang="ts">
import { usePlanner } from '../context.ts'

/** A lucide icon by name, drawn by Mango. 15px unless styled otherwise. */
defineProps<{ name: string }>()
const { Icon } = usePlanner().mango.ui.components
</script>

<template>
  <component :is="Icon" :icon="name" class="pl-icon" />
</template>

<style scoped>
:where(.pl-icon) { width: 15px; height: 15px; stroke-width: 1.75; flex: none; }
</style>
