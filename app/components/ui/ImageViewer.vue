<script setup lang="ts">
import { ChevronLeft, ChevronRight, X } from 'lucide-vue-next'
import { call } from '~/composables/useBackend'
import { closeImage, imageViewer } from '~/utils/imageViewer'
import { formatSize } from '~/utils/attachments'
import { useOverlay } from '~/composables/useOverlay'

/**
 * Full-size view of an attached or agent-produced image. Opens on the small preview
 * at once and swaps in the full picture from the attachment store when it arrives.
 * Escape or a click outside closes; arrow keys step through the set.
 */
const current = computed(() => imageViewer.images[imageViewer.index] ?? null)
useOverlay(() => imageViewer.open && !!current.value)
const full = ref<Record<string, string>>({})
const failed = ref(false)
const panel = ref<HTMLElement | null>(null)
let returnFocus: HTMLElement | null = null

const src = computed(() => {
  const a = current.value
  return a ? full.value[a.path] ?? a.thumb ?? '' : ''
})

watch(current, async (a) => {
  failed.value = false
  if (!a || full.value[a.path]) return
  try {
    const data = await call('attachment_read', { path: a.path })
    full.value = { ...full.value, [a.path]: `data:${a.mime || 'image/png'};base64,${data}` }
  } catch {
    // Gone from disk (or never stored): the preview is all there is.
    failed.value = !a.thumb
  }
}, { immediate: true })

watch(() => imageViewer.open, async (open) => {
  if (open) {
    returnFocus = document.activeElement as HTMLElement | null
    await nextTick()
    panel.value?.focus()
  } else {
    full.value = {}
    returnFocus?.focus?.()
    returnFocus = null
  }
})

function step(by: number) {
  const n = imageViewer.images.length
  if (n > 1) imageViewer.index = (imageViewer.index + by + n) % n
}

function onKey(e: KeyboardEvent) {
  if (!imageViewer.open) return
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeImage() }
  else if (e.key === 'ArrowRight') { e.preventDefault(); step(1) }
  else if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1) }
}
onMounted(() => window.addEventListener('keydown', onKey, true))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey, true))
</script>

<template>
  <Teleport to="body">
    <Transition name="iv">
      <div v-if="imageViewer.open && current" class="iv" @mousedown.self="closeImage()">
        <figure
          ref="panel"
          class="iv__fig"
          role="dialog"
          aria-modal="true"
          :aria-label="current.name"
          tabindex="-1"
          @mousedown.self="closeImage()"
        >
          <img v-if="src" class="iv__img" :src="src" :alt="current.name">
          <p v-else-if="failed" class="iv__missing">This image is no longer on disk.</p>
          <figcaption class="iv__cap">
            <span class="iv__name" :title="current.path">{{ current.name }}</span>
            <span v-if="current.size" class="iv__meta tabular">{{ formatSize(current.size) }}</span>
            <span v-if="imageViewer.images.length > 1" class="iv__meta tabular">{{ imageViewer.index + 1 }} / {{ imageViewer.images.length }}</span>
          </figcaption>
        </figure>
        <template v-if="imageViewer.images.length > 1">
          <button type="button" class="iv__nav iv__nav--prev" aria-label="Previous image" title="Previous (←)" @click="step(-1)"><ChevronLeft /></button>
          <button type="button" class="iv__nav iv__nav--next" aria-label="Next image" title="Next (→)" @click="step(1)"><ChevronRight /></button>
        </template>
        <button type="button" class="iv__close" aria-label="Close" title="Close (Esc)" @click="closeImage()"><X /></button>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.iv {
  position: fixed;
  inset: 0;
  z-index: 90;
  display: grid;
  place-items: center;
  padding: var(--space-10) var(--space-12);
  background: var(--scrim);
}
.iv__fig {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-3);
  max-width: 100%;
  max-height: 100%;
  margin: 0;
  outline: none;
}
.iv__img {
  display: block;
  min-width: 0;
  min-height: 0;
  max-width: 100%;
  max-height: calc(100vh - var(--space-10) * 2 - 40px);
  object-fit: contain;
  border-radius: var(--radius-md);
  background: var(--bg-inset);
  box-shadow: var(--shadow-pop);
}
.iv__missing {
  margin: 0;
  padding: var(--space-6) var(--space-8);
  border-radius: var(--radius-md);
  background: var(--bg-raised);
  color: var(--fg-muted);
  font-size: var(--text-sm);
}
.iv__cap {
  display: flex;
  align-items: baseline;
  gap: var(--space-3);
  max-width: 100%;
  padding: 4px var(--space-3);
  border-radius: var(--radius-sm);
  background: var(--bg-raised);
  font-size: var(--text-xs);
  color: var(--fg-muted);
}
.iv__name { min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; color: var(--fg); font-weight: 540; }
.iv__meta { flex: none; color: var(--fg-subtle); }

.iv__close, .iv__nav {
  position: absolute;
  display: grid;
  place-items: center;
  width: 32px;
  height: 32px;
  border-radius: var(--radius-sm);
  background: var(--bg-raised);
  border: 1px solid var(--line);
  color: var(--fg-muted);
  transition: color var(--dur-fast) var(--ease-out), background var(--dur-fast) var(--ease-out);
}
.iv__close:hover, .iv__nav:hover { color: var(--fg); background: var(--bg-hover); }
.iv__close:focus-visible, .iv__nav:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
.iv__close svg, .iv__nav svg { width: 16px; height: 16px; stroke-width: 2; }
.iv__close { top: var(--space-3); right: var(--space-3); }
.iv__nav { top: 50%; margin-top: -16px; }
.iv__nav--prev { left: var(--space-3); }
.iv__nav--next { right: var(--space-3); }

.iv-enter-active, .iv-leave-active { transition: opacity var(--dur-fast) var(--ease-out); }
.iv-enter-active .iv__img { transition: transform var(--dur-med) var(--ease-out); }
.iv-enter-from, .iv-leave-to { opacity: 0; }
.iv-enter-from .iv__img { transform: scale(0.96); }

@media (prefers-reduced-motion: reduce) {
  .iv-enter-active, .iv-leave-active, .iv-enter-active .iv__img { transition: none; }
  .iv-enter-from .iv__img { transform: none; }
}
</style>
