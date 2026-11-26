<script setup lang="ts">
import { computed } from 'vue'
import type { Color } from '../model.ts'
import { colorVar } from './colors.ts'

/** A select option: a neutral chip with a coloured dot. */
const props = defineProps<{ option: { name: string; color: Color } }>()
const color = computed(() => colorVar(props.option.color))
</script>

<template>
  <span class="pl-tag" :title="option.name" :style="{ color: color.fg }">
    <span class="pl-tag__dot" :style="{ background: color.dot }" aria-hidden="true" />
    <span class="pl-tag__name">{{ option.name }}</span>
  </span>
</template>

<style scoped>
.pl-tag {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  max-width: 100%;
  height: 20px;
  padding: 0 7px;
  border-radius: var(--radius-xs);
  background: var(--bg-active);
  font-size: var(--text-xs);
  line-height: 20px;
  vertical-align: middle;
}
.pl-tag__dot { width: 7px; height: 7px; border-radius: 50%; flex: none; }
.pl-tag__name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
