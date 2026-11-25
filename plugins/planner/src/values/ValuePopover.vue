<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { usePlanner } from '../context.ts'
import { isReadonly, propertyOf, storedValue, valueOf, type DateValue, type Item, type Property, type Value } from '../model.ts'
import Popover from '../ui/Popover.vue'
import DateEditor from './DateEditor.vue'
import OptionEditor from './OptionEditor.vue'
import { strings } from './strings.ts'
import TextEditor from './TextEditor.vue'

/**
 * Edits one property of these items through the store. A checkbox has nothing to show: it toggles at once and
 * the popover closes. Without items, a select's options can still be managed.
 */
const props = defineProps<{
  collectionId: string
  property: Property
  itemIds: string[]
  anchor: HTMLElement | { x: number; y: number }
}>()
const emit = defineEmits<{ close: [] }>()
const { store } = usePlanner()

/** As it is now: the one given may be from before an option was added. */
const property = computed(() => {
  const c = store.collection(props.collectionId)
  return (c && propertyOf(c, props.property.id)) ?? null
})
const items = computed<Item[]>(() => {
  const ids = new Set(props.itemIds)
  return store.items(props.collectionId).items.filter(i => ids.has(i.id))
})
const gone = computed(() => !property.value || isReadonly(property.value) || (props.itemIds.length > 0 && !items.value.length))

/** The value they all have, or null. */
const common = computed<Value | null>(() => {
  const p = property.value
  const [first, ...rest] = items.value
  if (!p || !first) return null
  const v = valueOf(first, p)
  return rest.every(i => JSON.stringify(valueOf(i, p)) === JSON.stringify(v)) ? v : null
})
const commonDate = computed(() => (property.value?.type === 'date' ? common.value as DateValue | null : null))

/** One change for all, or one for each group of items that end up with the same value. */
function set(next: Value | null | ((item: Item) => Value | null)) {
  const p = property.value
  if (!p || !items.value.length) return
  const groups = new Map<string, { value: Value | null; ids: string[] }>()
  for (const item of items.value) {
    const value = typeof next === 'function' ? next(item) : next
    const key = JSON.stringify(storedValue(value, p) ?? null)
    const group = groups.get(key)
    if (group) group.ids.push(item.id)
    else groups.set(key, { value, ids: [item.id] })
  }
  for (const g of groups.values()) store.updateItems(props.collectionId, g.ids, { values: { [p.id]: g.value } })
}

function toggleCheckbox() {
  const p = property.value
  if (!p) return
  set(!items.value.every(i => valueOf(i, p) === true))
}

onMounted(() => {
  if (property.value?.type === 'checkbox') {
    toggleCheckbox()
    emit('close')
  }
})
watch(gone, (v) => { if (v) emit('close') }, { immediate: true })

/* Text being typed is kept when the user moves on, not when they back out. */
const text = ref<{ commit(): void; cancel(): void } | null>(null)
function onClose(reason: 'escape' | 'outside') {
  if (reason === 'escape') text.value?.cancel()
  emit('close')
}

const kind = computed(() => {
  switch (property.value?.type) {
    case 'select':
    case 'multiSelect': return 'options'
    case 'date': return 'date'
    case 'text':
    case 'number':
    case 'url': return 'text'
    default: return null
  }
})
const width = computed(() => {
  if (kind.value === 'date') return 256
  const w = props.anchor instanceof HTMLElement ? props.anchor.offsetWidth : 0
  return Math.min(Math.max(w, kind.value === 'options' ? 248 : 260), 480)
})
</script>

<template>
  <Popover
    v-if="property && kind && !gone"
    :anchor="anchor"
    :width="width"
    :label="strings.edit(property.name)"
    :cover="kind === 'text'"
    @close="onClose"
  >
    <OptionEditor
      v-if="kind === 'options'"
      :collection-id="collectionId"
      :property="property"
      :items="items"
      :set="set"
      @done="emit('close')"
    />
    <DateEditor v-else-if="kind === 'date'" :value="commonDate" @change="set" @done="emit('close')" />
    <TextEditor v-else ref="text" :property="property" :value="common" @change="set" @done="emit('close')" />
  </Popover>
</template>
