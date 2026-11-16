<script setup lang="ts">
import { Maximize, Minus, Plus } from 'lucide-vue-next'
import { formatSize } from '~/utils/attachments'

/**
 * A picture open in a file tab: fitted to the pane at first, zoomable with
 * the buttons, Ctrl+wheel or + / - / 0, and scrollable once it is larger than
 * the pane. Transparent areas show over a checkerboard.
 */
const props = defineProps<{
  src: string
  name: string
  /** Bytes on disk. */
  size: number
  /** Vector: fitting may scale it up (to 4×) as well as down. */
  vector?: boolean
  /** The size the picture asks for, when the image itself cannot say (SVG without width and height). */
  intrinsic?: { width: number; height: number } | null
}>()

const STEPS = [0.05, 0.1, 0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 6, 8, 12, 16, 24, 32]

const stage = ref<HTMLElement | null>(null)
const natural = ref<{ width: number; height: number } | null>(null)
const failed = ref(false)
const zoom = ref<number | 'fit'>('fit')
const room = ref({ width: 0, height: 0 })

let observer: ResizeObserver | null = null
onMounted(() => {
  if (!stage.value) return
  observer = new ResizeObserver(([entry]) => {
    if (entry) room.value = { width: entry.contentRect.width, height: entry.contentRect.height }
  })
  observer.observe(stage.value)
})
onBeforeUnmount(() => observer?.disconnect())

// Another picture (or the same file changed on disk): measure again, fit again only for a new file.
watch(() => props.name, () => { zoom.value = 'fit' })
watch(() => props.src, () => { failed.value = false })

function onLoad(e: Event) {
  const img = e.target as HTMLImageElement
  failed.value = false
  natural.value = props.intrinsic
    ?? (img.naturalWidth && img.naturalHeight ? { width: img.naturalWidth, height: img.naturalHeight } : { width: 300, height: 150 })
}
watch(() => props.intrinsic, (size) => { if (size) natural.value = size })

const fitScale = computed(() => {
  const n = natural.value
  if (!n || !room.value.width) return 1
  // The stage's content box: its padding is the room kept around a fitted picture.
  const s = Math.min(room.value.width / n.width, room.value.height / n.height)
  // A raster picture is never blown up to fit; a small icon may grow, but stays an icon.
  return Math.max(0.01, Math.min(props.vector ? 4 : 1, s))
})
const scale = computed(() => (zoom.value === 'fit' ? fitScale.value : zoom.value))
const percent = computed(() => `${Math.round(scale.value * 100)}%`)

const box = computed(() => {
  const n = natural.value
  if (!n) return {}
  return { width: `${Math.max(1, Math.round(n.width * scale.value))}px`, height: `${Math.max(1, Math.round(n.height * scale.value))}px` }
})

function zoomBy(dir: 1 | -1) {
  const now = scale.value
  const next = dir > 0 ? STEPS.find(s => s > now + 1e-6) : [...STEPS].reverse().find(s => s < now - 1e-6)
  if (next) zoom.value = next
}
function toggleFit() {
  zoom.value = zoom.value === 'fit' ? 1 : 'fit'
}

function onWheel(e: WheelEvent) {
  if (!e.ctrlKey && !e.metaKey) return
  e.preventDefault()
  zoomBy(e.deltaY < 0 ? 1 : -1)
}
function onKey(e: KeyboardEvent) {
  if (e.ctrlKey || e.metaKey || e.altKey) return
  if (e.key === '+' || e.key === '=') { e.preventDefault(); zoomBy(1) }
  else if (e.key === '-') { e.preventDefault(); zoomBy(-1) }
  else if (e.key === '0') { e.preventDefault(); zoom.value = 'fit' }
  else if (e.key === '1') { e.preventDefault(); zoom.value = 1 }
}
</script>

<template>
  <div class="iview">
    <div
      ref="stage"
      class="iview__stage"
      tabindex="0"
      :aria-label="`${name}, ${percent}. Plus and minus zoom, 0 fits, 1 shows actual size.`"
      @wheel="onWheel"
      @keydown="onKey"
    >
      <p v-if="failed" class="iview__note">{{ vector ? `${name} is not valid SVG, so it cannot be drawn. Its code shows what is wrong.` : `${name} could not be shown as an image.` }}</p>
      <img
        v-show="!failed && natural"
        class="iview__img"
        :class="{ 'is-pixelated': !vector && scale >= 3 }"
        :src="src"
        :alt="name"
        :style="box"
        draggable="false"
        @load="onLoad"
        @error="failed = true"
        @dblclick="toggleFit"
      >
    </div>
    <footer class="iview__bar">
      <span v-if="natural && !failed" class="iview__meta tabular">{{ Math.round(natural.width) }} × {{ Math.round(natural.height) }}</span>
      <span class="iview__meta tabular">{{ formatSize(size) }}</span>
      <span class="iview__spacer" />
      <UiIconButton size="sm" label="Zoom out" shortcut="-" :disabled="scale <= STEPS[0]!" @click="zoomBy(-1)"><Minus /></UiIconButton>
      <button type="button" class="iview__pct tabular" :title="zoom === 'fit' ? 'Show actual size (1)' : 'Fit to the pane (0)'" @click="toggleFit">{{ percent }}</button>
      <UiIconButton size="sm" label="Zoom in" shortcut="+" :disabled="scale >= STEPS[STEPS.length - 1]!" @click="zoomBy(1)"><Plus /></UiIconButton>
      <UiIconButton size="sm" label="Fit to the pane" shortcut="0" :active="zoom === 'fit'" @click="zoom = 'fit'"><Maximize /></UiIconButton>
    </footer>
  </div>
</template>

<style scoped>
.iview { position: absolute; inset: 0; display: flex; flex-direction: column; background: var(--bg-inset); }
.iview__stage {
  flex: 1;
  min-height: 0;
  display: flex;
  overflow: auto;
  padding: var(--space-6);
  outline: none;
}
.iview__stage:focus-visible { box-shadow: inset 0 0 0 2px var(--focus-ring); }
/* margin: auto centres the picture and still lets it scroll from its top-left corner once it is larger. */
.iview__img {
  flex: none;
  margin: auto;
  display: block;
  max-width: none;
  /* Transparent pixels sit on a quiet checkerboard. */
  background:
    repeating-conic-gradient(var(--bg-hover) 0 25%, transparent 0 50%) 0 0 / 16px 16px,
    var(--bg-canvas);
  box-shadow: 0 0 0 1px var(--line-soft);
  user-select: none;
}
.iview__img.is-pixelated { image-rendering: pixelated; }
.iview__note { margin: auto; font-size: var(--text-sm); color: var(--fg-subtle); }

.iview__bar {
  flex: none;
  display: flex;
  align-items: center;
  gap: var(--space-1);
  height: 32px;
  padding: 0 var(--space-2) 0 var(--space-4);
  border-top: 1px solid var(--line-soft);
  background: var(--bg-canvas);
}
.iview__meta { font-size: var(--text-xs); color: var(--fg-subtle); }
.iview__meta + .iview__meta::before { content: '·'; margin: 0 var(--space-2) 0 var(--space-1); color: var(--fg-faint); }
.iview__spacer { flex: 1; }
.iview__pct {
  min-width: 48px;
  height: 22px;
  padding: 0 4px;
  border-radius: var(--radius-xs);
  font-size: var(--text-xs);
  color: var(--fg-muted);
  text-align: center;
}
.iview__pct:hover { background: var(--bg-hover); color: var(--fg); }
</style>
