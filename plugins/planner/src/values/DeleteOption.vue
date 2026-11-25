<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { usePlanner } from '../context.ts'
import { itemWord, propertyOf } from '../model.ts'
import PickPopover, { type PickRow } from '../ui/PickPopover.vue'
import { strings } from './strings.ts'
import { useOptionCounts } from './useOptionCounts.ts'

/** Deletes an option: at once when no item has it, else asks which one those get. Undo is in the toast. */
const props = defineProps<{ collectionId: string; propertyId: string; optionId: string; anchor: HTMLElement | { x: number; y: number } }>()
const emit = defineEmits<{ close: []; deleted: [] }>()
const { store } = usePlanner()

const collection = computed(() => store.collection(props.collectionId))
const property = computed(() => collection.value && propertyOf(collection.value, props.propertyId))
const option = computed(() => property.value?.options.find(o => o.id === props.optionId) ?? null)
const counts = useOptionCounts(() => props.collectionId, () => props.propertyId)
const count = computed(() => counts.value?.get(props.optionId) ?? 0)

const NONE = '-'
const rows = computed<PickRow[]>(() => [
  ...(property.value?.options ?? []).filter(o => o.id !== props.optionId).map(o => ({ id: o.id, label: o.name, color: o.color })),
  { id: NONE, label: strings.noneOf(property.value?.name ?? ''), color: 'neutral' },
])

async function remove(moveTo: string | null) {
  if (await store.deleteOption(props.collectionId, props.propertyId, props.optionId, { moveTo })) emit('deleted')
}
onMounted(async () => {
  // Their number decides whether to ask.
  const known = counts.value !== null || await store.loadItems(props.collectionId)
  if (known && count.value > 0 && option.value) return
  emit('close')
  if (known) void remove(null)
})
</script>

<template>
  <PickPopover
    v-if="option && count > 0"
    :rows="rows"
    :anchor="anchor"
    :width="240"
    :label="strings.deleteNamed(option.name)"
    :heading="strings.moveItemsTo(count, itemWord(collection, count), option.name)"
    @close="emit('close')"
    @pick="remove($event === NONE ? null : $event)"
  />
</template>
