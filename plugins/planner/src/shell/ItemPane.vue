<script setup lang="ts">
import { computed, ref } from 'vue'
import { usePlanner } from '../context.ts'
import { shell } from './strings.ts'

/** The item beside the view: its left edge resizes it, and the width is kept. `overlay`: over the view, for want of room. */
const props = defineProps<{ available: number; overlay: boolean }>()
const { mango } = usePlanner()

const KEY = 'itemWidth'
const DEFAULT = 440
const MIN = 340
/** What the view keeps beside it. */
const VIEW_MIN = 320

const saved = mango.storage.get<unknown>(KEY)
const wanted = ref(typeof saved === 'number' && saved >= MIN ? saved : DEFAULT)
const max = computed(() => (props.overlay ? props.available : Math.max(MIN, props.available - VIEW_MIN)))
/** Over the view it leaves a useful part of it, or none. */
const SLIVER = 120
const width = computed(() => {
  if (props.available < 560) return props.available
  const w = Math.min(wanted.value, max.value)
  return props.overlay && props.available - w < SLIVER ? props.available : w
})
const root = ref<HTMLElement | null>(null)
const resizing = ref(false)

function set(n: number) {
  wanted.value = Math.round(Math.max(MIN, Math.min(n, max.value)))
}
const keep = () => mango.storage.set(KEY, wanted.value)

function start(e: PointerEvent) {
  if (e.button !== 0) return
  e.preventDefault()
  const hold = mango.ui.holdOverlay()
  const el = e.currentTarget as HTMLElement
  const right = root.value!.getBoundingClientRect().right
  el.setPointerCapture(e.pointerId)
  resizing.value = true
  const move = (ev: PointerEvent) => set(right - ev.clientX)
  const end = () => {
    el.removeEventListener('pointermove', move)
    el.removeEventListener('lostpointercapture', end)
    hold.dispose()
    resizing.value = false
    keep()
  }
  el.addEventListener('pointermove', move)
  el.addEventListener('lostpointercapture', end)
}
function onKey(e: KeyboardEvent) {
  const by = { ArrowLeft: 16, ArrowRight: -16 }[e.key]
  if (!by) return
  e.preventDefault()
  set(width.value + by)
  keep()
}
function reset() {
  wanted.value = DEFAULT
  keep()
}
</script>

<template>
  <aside ref="root" class="pl-pane" :class="{ 'is-overlay': overlay }" :style="{ width: `${width}px` }">
    <div
      v-if="available >= 560"
      class="pl-pane__edge"
      :class="{ 'is-on': resizing }"
      role="separator"
      aria-orientation="vertical"
      tabindex="0"
      :aria-label="shell.resizePane"
      :aria-valuenow="width"
      :aria-valuemin="MIN"
      :aria-valuemax="max"
      @pointerdown="start"
      @dblclick="reset"
      @keydown="onKey"
    />
    <slot />
  </aside>
</template>

<style scoped>
.pl-pane { position: relative; flex: none; display: flex; flex-direction: column; min-height: 0; background: var(--bg-canvas); border-left: 1px solid var(--line-soft); }
.pl-pane.is-overlay { position: absolute; inset: 0 0 0 auto; z-index: 6; box-shadow: var(--shadow-pop); border-left-color: var(--line); }
.pl-pane__edge { position: absolute; top: 0; bottom: 0; left: -3px; width: 6px; cursor: col-resize; z-index: 7; touch-action: none; }
.pl-pane__edge::after { content: ''; position: absolute; inset: 0 2px; transition: background var(--dur-fast) var(--ease-out); }
.pl-pane__edge:hover::after, .pl-pane__edge.is-on::after { background: var(--accent-line); }
.pl-pane__edge:focus-visible { outline: none; }
.pl-pane__edge:focus-visible::after { background: var(--focus-ring); }
</style>
