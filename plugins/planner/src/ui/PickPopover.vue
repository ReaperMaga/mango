<script lang="ts">
import type { Color } from '../model.ts'

export interface PickRow { id: string; label: string; icon?: string; color?: Color; checked?: boolean }
</script>

<script setup lang="ts">
import { nextTick, onMounted, ref } from 'vue'
import { colorVar } from './colors.ts'
import Icon from './Icon.vue'
import Popover from './Popover.vue'

/** A short list to pick one of, also inside a dialog (where Mango's own menu would share its Escape). */
const props = defineProps<{ rows: readonly PickRow[]; anchor: HTMLElement | { x: number; y: number }; label: string; heading?: string; width?: number }>()
const emit = defineEmits<{ close: []; pick: [id: string] }>()

const active = ref(Math.max(0, props.rows.findIndex(r => r.checked)))
const list = ref<HTMLElement | null>(null)
const reveal = () => void nextTick(() => list.value?.querySelector('.is-active')?.scrollIntoView({ block: 'nearest' }))
onMounted(reveal)

function pick(id: string | undefined) {
  if (id === undefined) return
  emit('close')
  emit('pick', id)
}
function onKey(e: KeyboardEvent) {
  const n = props.rows.length
  if (!n) return
  if (e.key === 'ArrowDown') active.value = (active.value + 1) % n
  else if (e.key === 'ArrowUp') active.value = (active.value - 1 + n) % n
  else if (e.key === 'Home') active.value = 0
  else if (e.key === 'End') active.value = n - 1
  else if (e.key === 'Enter' || e.key === ' ') pick(props.rows[active.value]?.id)
  else if (e.key === 'Tab') emit('close')
  else return
  e.preventDefault()
  reveal()
}
</script>

<template>
  <Popover :anchor="anchor" :width="width ?? 220" :label="label" @close="emit('close')">
    <div ref="list" class="pl-pick" role="listbox" :aria-label="heading ?? label" tabindex="0" data-autofocus :aria-activedescendant="rows[active] ? `pl-pick-${rows[active]!.id}` : undefined" @keydown="onKey">
      <p v-if="heading" class="pl-pick__head">{{ heading }}</p>
      <div
        v-for="(r, i) in rows"
        :id="`pl-pick-${r.id}`"
        :key="r.id"
        class="pl-pick__row"
        :class="{ 'is-active': i === active }"
        role="option"
        :aria-selected="!!r.checked"
        @pointermove="active = i"
        @click="pick(r.id)"
      >
        <span v-if="r.color" class="pl-pick__dot" :style="{ background: colorVar(r.color).dot }" aria-hidden="true" />
        <Icon v-else-if="r.icon" :name="r.icon" class="pl-pick__icon" />
        <span class="pl-pick__label">{{ r.label }}</span>
        <Icon v-if="r.checked" name="check" class="pl-pick__check" />
      </div>
    </div>
  </Popover>
</template>

<style scoped>
.pl-pick { padding: var(--space-1); }
.pl-pick:focus-visible { outline: none; }
.pl-pick__head { margin: 0; padding: var(--space-1) var(--space-2) 6px; font-size: var(--text-xs); color: var(--fg-subtle); overflow-wrap: anywhere; }
.pl-pick__row { display: flex; align-items: center; gap: var(--space-2); min-height: 30px; padding: 0 var(--space-2); border-radius: var(--radius-sm); cursor: pointer; }
.pl-pick__row.is-active { background: var(--bg-hover); }
.pl-pick__dot { width: 8px; height: 8px; margin: 0 3px; border-radius: 50%; flex: none; }
.pl-pick__icon { color: var(--fg-subtle); }
.pl-pick__label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pl-pick__check { width: 14px; height: 14px; color: var(--accent-ink); }
</style>
