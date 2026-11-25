<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { strings } from '../strings.ts'

/** The shape of what is being read. Shows after a moment: reading is usually done by then. */
defineProps<{ head?: boolean }>()
const WIDTHS = [58, 41, 66, 35, 52, 47]
const late = ref(false)
let timer: ReturnType<typeof setTimeout> | undefined
onMounted(() => { timer = setTimeout(() => { late.value = true }, 150) })
onBeforeUnmount(() => clearTimeout(timer))
</script>

<template>
  <div class="pl-skel" role="status" :aria-label="strings.loading">
    <template v-if="late">
      <div v-if="head" class="pl-skel__head"><span class="pl-skel__bar" style="width: 120px" /><span class="pl-skel__bar" style="width: 70px" /></div>
      <div v-for="w in WIDTHS" :key="w" class="pl-skel__row"><span class="pl-skel__bar" :style="{ width: `${w}%` }" /></div>
    </template>
  </div>
</template>

<style scoped>
.pl-skel { flex: 1; min-height: 0; overflow: hidden; }
.pl-skel__head { display: flex; align-items: center; gap: var(--space-4); height: 40px; padding: 0 var(--space-4); border-bottom: 1px solid var(--line-soft); }
.pl-skel__row { display: flex; align-items: center; height: 36px; padding: 0 var(--space-4); }
.pl-skel__bar { height: 10px; border-radius: var(--radius-xs); background: var(--bg-hover); animation: pl-skel 1.4s ease-in-out infinite alternate; }
@keyframes pl-skel { from { opacity: 1; } to { opacity: 0.45; } }
@media (prefers-reduced-motion: reduce) { .pl-skel__bar { animation: none; } }
</style>
