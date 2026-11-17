<script setup lang="ts">
import { Gauge } from 'lucide-vue-next'
import { useUsage } from '~/stores/usage'
import { useWorkspace } from '~/stores/workspace'
import { modLabel } from '~/composables/useShortcuts'
import { formatDuration, useNow } from '~/utils/time'

/* Titlebar widget: the most constrained plan limit across agents, as a small meter. Opens Usage. */
const ws = useWorkspace()
const usage = useUsage()
const now = useNow(60_000)
const mod = ref('Ctrl')
onMounted(() => { mod.value = modLabel() })

/** The window with the highest percent across every readable entry. */
const top = computed(() => {
  let best: { percent: number; label: string; resetsAt?: number | null } | null = null
  for (const e of Object.values(usage.entries)) {
    for (const w of e.usage?.windows ?? []) {
      if (typeof w.percent === 'number' && (!best || w.percent > best.percent)) best = w
    }
  }
  return best
})
const pct = computed(() => (top.value ? Math.max(0, Math.min(100, Math.round(top.value.percent))) : null))
const tone = computed(() => (pct.value === null ? '' : pct.value >= 100 ? 'is-full' : pct.value >= 80 ? 'is-high' : ''))

const title = computed(() => {
  const keys = `(${mod.value}+Shift+U)`
  const reset = usage.hasReset ? ' A limit was reset.' : ''
  const t = top.value
  if (!t || pct.value === null) return `Usage limits${reset} ${keys}`
  const left = t.resetsAt ? t.resetsAt - now.value : 0
  const resets = left > 0 ? `, resets in ${formatDuration(Math.max(60_000, Math.round(left / 60_000) * 60_000))}` : ''
  return `Usage: ${pct.value}% of ${t.label} limit${resets}.${reset} ${keys}`
})
</script>

<template>
  <button
    type="button"
    class="um"
    :class="{ 'is-open': ws.dialog === 'usage' }"
    :title="title"
    :aria-label="title"
    @click="ws.openUsage()"
  >
    <span class="um__icon">
      <Gauge aria-hidden="true" />
      <span v-if="usage.hasReset" class="um__dot" aria-hidden="true" />
    </span>
    <template v-if="pct !== null">
      <span class="um__meter" aria-hidden="true"><i :class="tone" :style="{ width: `${pct}%` }" /></span>
      <span class="um__pct tabular">{{ pct }}%</span>
    </template>
  </button>
</template>

<style scoped>
.um {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 var(--space-2);
  border-radius: var(--radius-md);
  color: var(--fg-muted);
  font-size: var(--text-xs);
  transition: background var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out);
}
.um:hover, .um.is-open { background: var(--bg-hover); color: var(--fg); }
.um__icon { position: relative; display: inline-grid; place-items: center; }
.um__icon svg { width: 16px; height: 16px; }
/* A limit was reset early: a mark on the gauge, until it is dismissed in Usage. */
.um__dot {
  position: absolute;
  top: -3px;
  right: -4px;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--ripe-queued);
  box-shadow: 0 0 0 2px var(--bg-app);
}
.um__meter { width: 28px; height: 4px; border-radius: 2px; background: var(--bg-active); overflow: hidden; display: block; }
.um__meter i { display: block; height: 100%; border-radius: 2px; background: var(--fg-muted); }
.um__meter i.is-high { background: var(--ripe-running); }
.um__meter i.is-full { background: var(--ripe-error); }
@media (max-width: 1179px) { .um__pct { display: none; } }
</style>
