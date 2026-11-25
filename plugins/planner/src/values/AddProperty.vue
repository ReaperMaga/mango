<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import { usePlanner } from '../context.ts'
import { PROPERTY_TYPES, type Property, type PropertyType } from '../model.ts'
import { strings as shared } from '../strings.ts'
import Popover from '../ui/Popover.vue'
import PropertyIcon from '../ui/PropertyIcon.vue'
import { strings } from './strings.ts'

/** A new property: a name (the type's own when left empty) and a type. Arrows pick the type, Enter adds it. */
const props = defineProps<{ collectionId: string; anchor: HTMLElement | { x: number; y: number } }>()
const emit = defineEmits<{ close: []; added: [property: Property] }>()
const { store } = usePlanner()

const name = ref('')
const active = ref(0)
const list = ref<HTMLElement | null>(null)
const types = PROPERTY_TYPES
const activeId = computed(() => `pl-add-${types[active.value]}`)

function add(type: Exclude<PropertyType, 'unsupported'>) {
  const made = store.addProperty(props.collectionId, { name: name.value.trim() || freeName(shared.propertyTypes[type]), type })
  emit('close')
  if (made) emit('added', made)
}
function freeName(base: string): string {
  const taken = new Set(store.collection(props.collectionId)?.properties.map(p => p.name.trim().toLowerCase()))
  for (let i = 1; ; i++) {
    const n = i === 1 ? base : `${base} ${i}`
    if (!taken.has(n.toLowerCase())) return n
  }
}
function onKey(e: KeyboardEvent) {
  if (e.isComposing) return
  if (e.key === 'ArrowDown') active.value = (active.value + 1) % types.length
  else if (e.key === 'ArrowUp') active.value = (active.value - 1 + types.length) % types.length
  else if (e.key === 'Enter') add(types[active.value]!)
  else return
  e.preventDefault()
  void nextTick(() => list.value?.querySelector('.is-active')?.scrollIntoView({ block: 'nearest' }))
}
</script>

<template>
  <Popover :anchor="anchor" :width="240" :label="strings.newProperty" @close="emit('close')">
    <div class="pl-add">
      <input
        v-model="name"
        class="pl-add__name"
        data-autofocus
        role="combobox"
        aria-expanded="true"
        aria-controls="pl-add-types"
        :aria-activedescendant="activeId"
        :aria-label="strings.propertyName"
        :placeholder="strings.propertyName"
        autocomplete="off"
        @keydown="onKey"
      >
      <div id="pl-add-types" ref="list" class="pl-add__list" role="listbox" :aria-label="strings.type">
        <div
          v-for="(t, i) in types"
          :id="`pl-add-${t}`"
          :key="t"
          class="pl-add__row"
          :class="{ 'is-active': i === active }"
          role="option"
          :aria-selected="i === active"
          :title="strings.typeHint[t]"
          @pointermove="active = i"
          @click="add(t)"
        >
          <PropertyIcon :type="t" class="pl-add__icon" />
          <span>{{ shared.propertyTypes[t] }}</span>
        </div>
      </div>
    </div>
  </Popover>
</template>

<style scoped>
.pl-add { padding: var(--space-1); }
.pl-add__name { width: 100%; height: 30px; padding: 0 var(--space-2); background: var(--bg-inset); border: 1px solid var(--line); border-radius: var(--radius-sm); font-size: var(--text-sm); }
.pl-add__name::placeholder { color: var(--fg-faint); }
.pl-add__name:focus-visible { outline: none; border-color: var(--accent-line); box-shadow: 0 0 0 3px var(--accent-soft); border-radius: var(--radius-sm); }
.pl-add__list { padding-top: var(--space-1); }
.pl-add__row { display: flex; align-items: center; gap: var(--space-2); min-height: 30px; padding: 0 var(--space-2); border-radius: var(--radius-sm); cursor: pointer; }
.pl-add__row.is-active { background: var(--bg-hover); }
.pl-add__icon { color: var(--fg-subtle); }
</style>
