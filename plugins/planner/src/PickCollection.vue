<script setup lang="ts">
import type { MangoPluginApi } from './host.ts'
import type { Collection } from './model.ts'

defineProps<{ mango: MangoPluginApi; collections: readonly Collection[] }>()
const emit = defineEmits<{ pick: [collection: Collection] }>()
</script>

<template>
  <ul class="planner-pick">
    <li v-for="c in collections" :key="c.id">
      <component :is="mango.ui.components.Button" variant="ghost" @click="emit('pick', c)">
        <component :is="mango.ui.components.Icon" :icon="c.icon" />
        {{ c.name }}
      </component>
    </li>
  </ul>
</template>

<style scoped>
.planner-pick { display: flex; flex-direction: column; gap: var(--space-1); margin: 0; padding: 0; list-style: none; }
</style>
