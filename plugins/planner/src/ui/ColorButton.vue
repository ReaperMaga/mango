<script setup lang="ts">
import { shallowRef } from 'vue'
import type { Color } from '../model.ts'
import { colorVar } from './colors.ts'
import ColorPicker from './ColorPicker.vue'
import Popover from './Popover.vue'

/** A colour as a dot; a click picks another. Events as of ColorPicker. */
defineProps<{ modelValue: Color; label: string; disabled?: boolean }>()
const emit = defineEmits<{ 'update:modelValue': [color: Color]; change: [color: Color] }>()
const anchor = shallowRef<HTMLElement | null>(null)
</script>

<template>
  <button
    type="button"
    class="pl-colorbtn"
    :aria-label="label"
    :title="label"
    aria-haspopup="dialog"
    :aria-expanded="!!anchor"
    :disabled="disabled"
    @click="anchor = $event.currentTarget as HTMLElement"
  ><span :style="{ background: colorVar(modelValue).dot }" /></button>
  <Popover v-if="anchor" :anchor="anchor" :width="236" :label="label" @close="anchor = null">
    <ColorPicker :model-value="modelValue" :label="label" @update:model-value="emit('update:modelValue', $event)" @change="emit('change', $event)" />
  </Popover>
</template>

<style scoped>
.pl-colorbtn { display: grid; place-items: center; width: 28px; height: 28px; flex: none; border-radius: var(--radius-sm); }
.pl-colorbtn:hover:not(:disabled), .pl-colorbtn[aria-expanded='true'] { background: var(--bg-active); }
.pl-colorbtn span { width: 12px; height: 12px; border-radius: 50%; }
</style>
