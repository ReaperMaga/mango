<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { usePlanner } from '../context.ts'
import { hostLayerOpen, inHostLayer, inOrAbove, isTopLayer, pushLayer } from './layers.ts'

/**
 * A floating panel, shown while mounted. `cover`: lies over the anchor instead of hanging from it (an editor in
 * place). What is marked `data-autofocus` (or the first control) gets the focus, and it goes back on close.
 */
const props = withDefaults(defineProps<{
  anchor: HTMLElement | { x: number; y: number }
  width?: number
  label: string
  placement?: 'bottom-start' | 'bottom-end'
  cover?: boolean
}>(), { width: 260, placement: 'bottom-start' })
/** `escape`: the user backed out. `outside`: moved on. */
const emit = defineEmits<{ close: [reason: 'escape' | 'outside'] }>()

const GAP = 4
const MARGIN = 8
const MAX_HEIGHT = 460
const MIN_HEIGHT = 120
const FOCUSABLE = 'input:not(:disabled), textarea:not(:disabled), select:not(:disabled), button:not(:disabled), [tabindex]'

const pop = ref<HTMLElement | null>(null)
const inner = ref<HTMLElement | null>(null)
const style = ref<Record<string, string>>({ visibility: 'hidden', left: '0', top: '0', width: `${props.width}px` })
const opener = document.activeElement as HTMLElement | null
const layer = { contains: (el: Node) => !!pop.value?.contains(el) }
let rect: { left: number; right: number; top: number; bottom: number } | null = null

const isPoint = (a: typeof props.anchor): a is { x: number; y: number } => !(a instanceof HTMLElement)

function place() {
  const el = inner.value
  if (!el) return
  const a = props.anchor
  // An anchor that is gone (its row moved away under an edit): stay where it was.
  if (isPoint(a)) rect = { left: a.x, right: a.x, top: a.y, bottom: a.y }
  else if (a.isConnected || !rect) rect = a.getBoundingClientRect()
  const r = rect
  const [vw, vh] = [window.innerWidth, window.innerHeight]
  const width = Math.min(props.width, vw - MARGIN * 2)
  const gap = isPoint(a) || props.cover ? 0 : GAP
  const top = (props.cover ? r.top : r.bottom) + gap
  const bottom = vh - (props.cover ? r.bottom : r.top) + gap
  const below = vh - top - MARGIN
  const above = vh - bottom - MARGIN
  const wanted = Math.min(el.offsetHeight + 2, MAX_HEIGHT)
  const up = wanted > below && above > below
  const left = Math.max(MARGIN, Math.min(props.placement === 'bottom-end' ? r.right - width : r.left, vw - width - MARGIN))
  const clamp = (n: number) => `${Math.max(MARGIN, Math.min(n, vh - MARGIN - Math.min(wanted, MIN_HEIGHT)))}px`
  style.value = {
    left: `${left}px`,
    width: `${width}px`,
    maxHeight: `${Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, up ? above : below))}px`,
    ...(up ? { bottom: clamp(bottom) } : { top: clamp(top) }),
  }
}

function focusables(): HTMLElement[] {
  return [...(pop.value?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])].filter(e => e.tabIndex >= 0 && e.offsetParent !== null)
}

function onWindowKey(e: KeyboardEvent) {
  if (e.key !== 'Escape' || e.isComposing || !isTopLayer(layer) || hostLayerOpen()) return
  e.preventDefault()
  e.stopImmediatePropagation()
  emit('close', 'escape')
}

function onKey(e: KeyboardEvent) {
  // Keys stay in here: the view below has its own for the same ones.
  e.stopPropagation()
  if (e.key !== 'Tab') return
  const all = focusables()
  const at = all.indexOf(document.activeElement as HTMLElement)
  const next = e.shiftKey ? (at <= 0 ? all.at(-1) : null) : (at === all.length - 1 ? all[0] : null)
  if (next) {
    e.preventDefault()
    next.focus()
  }
}

function onPointerDown(e: PointerEvent) {
  const el = e.target as Node
  if (inOrAbove(layer, el) || inHostLayer(el)) return
  // A click on what opened it only closes it.
  const a = props.anchor
  if (!isPoint(a) && a.contains(el)) {
    const swallow = (c: MouseEvent) => {
      if (!a.contains(c.target as Node)) return
      c.preventDefault()
      c.stopPropagation()
    }
    window.addEventListener('click', swallow, { capture: true, once: true })
    window.addEventListener('pointerup', () => setTimeout(() => window.removeEventListener('click', swallow, true)), { capture: true, once: true })
  }
  emit('close', 'outside')
}

function onScroll(e: Event) {
  if (!pop.value?.contains(e.target as Node)) place()
}

const hold = usePlanner().mango.ui.holdOverlay()
const dropLayer = pushLayer(layer)
const resize = new ResizeObserver(() => place())

onMounted(async () => {
  window.addEventListener('keydown', onWindowKey, true)
  window.addEventListener('pointerdown', onPointerDown, true)
  window.addEventListener('scroll', onScroll, true)
  window.addEventListener('resize', place)
  place()
  if (inner.value) resize.observe(inner.value)
  await nextTick()
  const target = pop.value?.querySelector<HTMLElement>('[data-autofocus]') ?? focusables()[0] ?? pop.value
  target?.focus({ preventScroll: true })
})
onBeforeUnmount(() => {
  hold.dispose()
  dropLayer()
  resize.disconnect()
  window.removeEventListener('keydown', onWindowKey, true)
  window.removeEventListener('pointerdown', onPointerDown, true)
  window.removeEventListener('scroll', onScroll, true)
  window.removeEventListener('resize', place)
  const now = document.activeElement
  if ((!now || now === document.body || layer.contains(now)) && opener?.isConnected) opener.focus({ preventScroll: true })
})

defineExpose({ place })
</script>

<template>
  <Teleport to="body">
    <div ref="pop" class="pl-pop" :style="style" role="dialog" :aria-label="label" tabindex="-1" @keydown="onKey">
      <div ref="inner"><slot /></div>
    </div>
  </Teleport>
</template>

<style scoped>
.pl-pop {
  position: fixed;
  z-index: 70;
  overflow: hidden auto;
  background: var(--bg-raised);
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-pop);
  color: var(--fg);
  font-size: var(--text-sm);
  animation: pl-pop-in var(--dur-fast) var(--ease-out);
}
.pl-pop:focus-visible { outline: none; border-radius: var(--radius-md); }
@keyframes pl-pop-in { from { opacity: 0; transform: translateY(-2px); } }
@media (prefers-reduced-motion: reduce) { .pl-pop { animation: none; } }
</style>
