<script setup lang="ts">
import { computed, ref } from 'vue'
import { usePlanner } from '../context.ts'
import { TITLE, propertyOf, type Collection, type View } from '../model.ts'
import Icon from '../ui/Icon.vue'
import PropertyIcon from '../ui/PropertyIcon.vue'
import { propertyName, propertyRows, setSorts } from './filters.ts'
import PickList from './PickList.vue'
import { dropClass, moved, stepPosition, useReorder } from './reorder.ts'
import { shell } from './strings.ts'

/** What the view is sorted by, the first deciding first. */
const props = defineProps<{ collection: Collection; view: View }>()
const emit = defineEmits<{ close: [] }>()
const { store, mango } = usePlanner()
const { IconButton } = mango.ui.components

const box = ref<HTMLElement | null>(null)
const adding = ref(!props.view.sorts.length)
const sorts = computed(() => props.view.sorts)
const rest = computed(() => propertyRows(props.collection, sorts.value.map(s => s.propertyId)))
const set = (next: typeof sorts.value) => setSorts(store, props.collection, props.view, next)
const typeOf = (id: string) => (id === TITLE ? 'text' : propertyOf(props.collection, id)?.type ?? 'text')

const reorder = useReorder({
  axis: 'y',
  container: () => box.value,
  hold: () => mango.ui.holdOverlay(),
  onDrop: (id, position) => set(moved(sorts.value, s => s.propertyId, id, position)),
})
function step(e: KeyboardEvent, id: string) {
  if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return
  e.preventDefault()
  const position = stepPosition(sorts.value.map(s => s.propertyId), id, e.key === 'ArrowUp' ? -1 : 1)
  if (position) set(moved(sorts.value, s => s.propertyId, id, position))
}
function add(id: string) {
  set([...sorts.value, { propertyId: id, direction: 'asc' }])
  adding.value = false
}
function remove(id: string) {
  const next = sorts.value.filter(s => s.propertyId !== id)
  set(next)
  if (!next.length) emit('close')
}
const flip = (id: string) => set(sorts.value.map(s => (s.propertyId === id ? { ...s, direction: s.direction === 'asc' ? 'desc' : 'asc' } : s)))
</script>

<template>
  <div class="pl-panel pl-sort">
    <div ref="box">
      <div
        v-for="(s, i) in sorts"
        :key="s.propertyId"
        class="pl-panel__row"
        :class="dropClass(reorder, s.propertyId, i === sorts.length - 1)"
        :data-rid="s.propertyId"
        @keydown="step($event, s.propertyId)"
      >
        <span class="pl-panel__grip" :title="shell.reorder(propertyName(collection, s.propertyId))" @pointerdown="reorder.start($event, s.propertyId)"><Icon name="grip-vertical" /></span>
        <PropertyIcon :type="typeOf(s.propertyId)" />
        <span class="pl-panel__label">{{ propertyName(collection, s.propertyId) }}</span>
        <button type="button" class="pl-small" @click="flip(s.propertyId)">
          <Icon :name="s.direction === 'asc' ? 'arrow-up' : 'arrow-down'" />{{ s.direction === 'asc' ? shell.ascending : shell.descending }}
        </button>
        <component :is="IconButton" size="sm" :label="shell.removeSort" @click="remove(s.propertyId)"><Icon name="x" /></component>
      </div>
    </div>
    <PickList v-if="adding" :rows="rest" :label="shell.sortBy" :placeholder="shell.findProperty" :max-height="260" @pick="add">
      <template #icon="{ row }"><PropertyIcon :type="typeOf(row.id)" /></template>
    </PickList>
    <template v-else>
      <div class="pl-panel__sep" />
      <button v-if="rest.length" type="button" class="pl-panel__row" @click="adding = true"><Icon name="plus" /><span class="pl-panel__label">{{ shell.addSort }}</span></button>
      <button type="button" class="pl-panel__row" @click="set([]); emit('close')"><Icon name="x" /><span class="pl-panel__label">{{ shell.clearSorts }}</span></button>
    </template>
  </div>
</template>

<style scoped>
.pl-sort { padding: var(--space-1); }
</style>
