<script setup lang="ts">
import type { GraphRow } from '~/utils/gitLog'

/** One row of the Git log's graph: the lanes passing by and the commit's node. No `row`: a plain list's dot. */
const props = defineProps<{ row: GraphRow | null; width: number; height: number; merge: boolean; head: boolean }>()

const LANE = 12
const PAD = 4
const RADIUS = 3.5
const RING = RADIUS + 2.5

const laneX = (lane: number) => PAD + lane * LANE + LANE / 2
const middle = computed(() => props.height / 2)

const lines = computed(() => {
  const row = props.row
  if (!row) return []
  const h = props.height
  const x = laneX(row.lane)
  const reach = props.head ? RING : RADIUS
  const end = middle.value - reach
  const start = middle.value + reach
  const mid = (start + h) / 2
  return [
    ...row.through.map(t => ({ color: t.color, d: `M${laneX(t.lane)} 0V${h}` })),
    ...row.up.map((u) => {
      const from = laneX(u.from)
      return { color: u.color, d: u.from === row.lane ? `M${x} 0V${end}` : `M${from} 0C${from} ${end * 0.55} ${x} ${end * 0.45} ${x} ${end}` }
    }),
    ...row.down.map((d) => {
      const to = laneX(d.to)
      return { color: d.color, d: d.to === row.lane ? `M${x} ${start}V${h}` : `M${x} ${start}C${x} ${mid} ${to} ${mid} ${to} ${h}` }
    }),
  ]
})
const nodeX = computed(() => laneX(props.row?.lane ?? 0))
const nodeLane = computed(() => `lane-${props.row?.color ?? 0}`)
</script>

<template>
  <svg class="graph" :width="width" :height="height" :viewBox="`0 0 ${width} ${height}`" aria-hidden="true">
    <path v-for="(line, i) in lines" :key="i" :d="line.d" :class="`lane-${line.color}`" />
    <circle class="graph__node" :class="[nodeLane, { 'is-merge': merge }]" :cx="nodeX" :cy="middle" :r="merge ? RADIUS - 0.5 : RADIUS" />
    <circle v-if="head && row" class="graph__head" :class="nodeLane" :cx="nodeX" :cy="middle" :r="RING" />
  </svg>
</template>

<style scoped>
.graph { display: block; overflow: hidden; }
.graph path { fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; }
.graph__node { fill: currentColor; }
.graph__node.is-merge { fill: none; stroke: currentColor; stroke-width: 1.5; }
.graph__head { fill: none; stroke: currentColor; stroke-width: 1.25; opacity: 0.6; }
/* The file-type tints are Mango's one set of categorical marks, defined for both themes: lines and nodes only, never text. */
.lane-0 { color: var(--file-blue); }
.lane-1 { color: var(--file-orange); }
.lane-2 { color: var(--file-green); }
.lane-3 { color: var(--file-purple); }
.lane-4 { color: var(--file-yellow); }
</style>
