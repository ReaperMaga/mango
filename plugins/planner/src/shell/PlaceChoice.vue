<script setup lang="ts">
import { usePlanner } from '../context.ts'
import Icon from '../ui/Icon.vue'
import { shell } from './strings.ts'

/** Where a new collection lives: this computer or the planner server. Shown only while a server is connected. */
const model = defineModel<string>({ required: true })
const { store } = usePlanner()

function onKey(e: KeyboardEvent) {
  const by = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 }[e.key]
  if (!by) return
  e.preventDefault()
  const list = store.places.value
  const at = list.findIndex(p => p.id === model.value)
  model.value = list[(at + by + list.length) % list.length]!.id
  const group = e.currentTarget as HTMLElement
  requestAnimationFrame(() => group.querySelector<HTMLElement>('[aria-checked="true"]')?.focus())
}
</script>

<template>
  <div v-if="store.places.value.length > 1" class="pl-place" role="radiogroup" :aria-label="shell.place" @keydown="onKey">
    <button
      v-for="p in store.places.value"
      :key="p.id"
      type="button"
      role="radio"
      class="pl-place__one"
      :aria-checked="model === p.id"
      :tabindex="model === p.id ? 0 : -1"
      :title="p.status.online ? undefined : p.status.message"
      @click="model = p.id"
    >
      <Icon :name="p.id === 'local' ? 'monitor' : p.status.online ? 'cloud' : 'cloud-off'" />{{ p.label }}
    </button>
  </div>
</template>

<style scoped>
.pl-place { display: inline-flex; max-width: 100%; padding: 2px; gap: 2px; background: var(--bg-inset); border: 1px solid var(--line-soft); border-radius: var(--radius-sm); }
.pl-place__one { display: inline-flex; align-items: center; gap: 6px; min-width: 0; height: 24px; padding: 0 var(--space-3); border-radius: var(--radius-xs); font-size: var(--text-xs); font-weight: 550; color: var(--fg-subtle); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pl-place__one svg { flex: none; width: 13px; height: 13px; stroke-width: 1.85; }
.pl-place__one:hover { color: var(--fg); }
.pl-place__one[aria-checked='true'] { background: var(--bg-active); color: var(--fg); }
</style>
