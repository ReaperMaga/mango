<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { usePlanner } from '../../context.ts'
import Icon from '../../ui/Icon.vue'
import { inOrAbove, pushLayer } from '../../ui/layers.ts'
import { strings } from '../strings.ts'
import type { BlockKind } from './blocks.ts'

/** The kinds of block, at the caret. The focus stays in the text, which passes the keys on. */
const props = defineProps<{ id: string; blocks: readonly BlockKind[]; active: number; at: { left: number; top: number; bottom: number } }>()
const emit = defineEmits<{ pick: [block: BlockKind]; hover: [index: number]; close: [] }>()

const MARGIN = 8
const WIDTH = 236
const el = ref<HTMLElement | null>(null)
const style = ref<Record<string, string>>({ visibility: 'hidden' })
/** Opened upwards it stays there while typing makes it shorter. */
let up: boolean | null = null

function place() {
  if (!el.value) return
  const below = window.innerHeight - props.at.bottom - MARGIN
  const above = props.at.top - MARGIN
  up ??= el.value.scrollHeight > below && above > below
  style.value = {
    left: `${Math.max(MARGIN, Math.min(props.at.left, window.innerWidth - WIDTH - MARGIN))}px`,
    width: `${WIDTH}px`,
    maxHeight: `${Math.max(120, Math.min(380, (up ? above : below) - 4))}px`,
    ...(up ? { bottom: `${window.innerHeight - props.at.top + 4}px` } : { top: `${props.at.bottom + 4}px` }),
  }
}
watch(() => props.at, place)
watch(() => props.active, async () => {
  await nextTick()
  el.value?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
})

const layer = { contains: (n: Node) => !!el.value?.contains(n) }
const hold = usePlanner().mango.ui.holdOverlay()
const dropLayer = pushLayer(layer)
function onPointerDown(e: PointerEvent) {
  if (!inOrAbove(layer, e.target as Node)) emit('close')
}
onMounted(() => {
  window.addEventListener('pointerdown', onPointerDown, true)
  place()
})
onBeforeUnmount(() => {
  hold.dispose()
  dropLayer()
  window.removeEventListener('pointerdown', onPointerDown, true)
})
</script>

<template>
  <Teleport to="body">
    <div :id="id" ref="el" class="pl-slash" :style="style" role="listbox" :aria-label="strings.blockMenu" @mousedown.prevent>
      <div
        v-for="(b, i) in blocks"
        :id="`${id}-${b.id}`"
        :key="b.id"
        class="pl-slash__row"
        :class="{ 'is-active': i === active }"
        role="option"
        :aria-selected="i === active"
        @pointermove="i !== active && emit('hover', i)"
        @click="emit('pick', b)"
      >
        <Icon :name="b.icon" class="pl-slash__icon" />
        <span class="pl-slash__label">{{ strings.blocks[b.id] }}</span>
        <span v-if="b.hint" class="pl-slash__hint" aria-hidden="true">{{ b.hint }}</span>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.pl-slash {
  position: fixed;
  z-index: 70;
  padding: var(--space-1);
  overflow: hidden auto;
  background: var(--bg-raised);
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-pop);
  color: var(--fg);
  font-size: var(--text-sm);
  animation: pl-slash-in var(--dur-fast) var(--ease-out);
}
.pl-slash__row { display: flex; align-items: center; gap: var(--space-2); min-height: 30px; padding: 0 var(--space-2); border-radius: var(--radius-sm); cursor: pointer; }
.pl-slash__row.is-active { background: var(--bg-hover); }
.pl-slash__icon { width: 15px; height: 15px; color: var(--fg-subtle); }
.pl-slash__label { flex: 1; min-width: 0; }
.pl-slash__hint { font-family: var(--font-mono); font-size: var(--text-xs); color: var(--fg-subtle); }
@keyframes pl-slash-in { from { opacity: 0; transform: translateY(-2px); } }
@media (prefers-reduced-motion: reduce) { .pl-slash { animation: none; } }
</style>
