<script setup lang="ts">
import { computed, ref } from 'vue'
import { usePlanner } from '../context.ts'
import { propertyOf, type Collection, type Property, type View } from '../model.ts'
import Icon from '../ui/Icon.vue'
import PropertyIcon from '../ui/PropertyIcon.vue'
import { propertyMenu } from '../values/PropertyMenu.ts'
import { dropClass, moved, stepPosition, useReorder } from './reorder.ts'
import { shell } from './strings.ts'

/** Which properties the view shows, and in which order. */
const props = defineProps<{ collection: Collection; view: View }>()
const emit = defineEmits<{ addProperty: [] }>()
const planner = usePlanner()
const { store, mango } = planner
const { IconButton } = mango.ui.components

const box = ref<HTMLElement | null>(null)
const columns = computed(() => props.view.columns.flatMap((c) => {
  const property = propertyOf(props.collection, c.propertyId)
  return property ? [{ ...c, property }] : []
}))
const set = (next: View['columns']) => store.updateView(props.collection.id, props.view.id, { columns: next.map(c => ({ propertyId: c.propertyId, visible: c.visible })) })
const toggle = (id: string) => set(props.view.columns.map(c => (c.propertyId === id ? { ...c, visible: !c.visible } : c)))

const reorder = useReorder({
  axis: 'y',
  container: () => box.value,
  hold: () => mango.ui.holdOverlay(),
  onDrop: (id, position) => set(moved(props.view.columns, c => c.propertyId, id, position)),
})
function step(e: KeyboardEvent, id: string) {
  if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return
  e.preventDefault()
  const position = stepPosition(columns.value.map(c => c.propertyId), id, e.key === 'ArrowUp' ? -1 : 1)
  if (position) set(moved(props.view.columns, c => c.propertyId, id, position))
}
const menu = (e: MouseEvent, p: Property) => void propertyMenu(planner, props.collection, p, e.currentTarget as HTMLElement)
</script>

<template>
  <div class="pl-panel pl-props">
    <p v-if="!columns.length" class="pl-panel__note">{{ shell.noProperties }}</p>
    <div v-else class="pl-panel__head">{{ shell.shown }}</div>
    <div ref="box">
      <div
        v-for="(c, i) in columns"
        :key="c.propertyId"
        class="pl-panel__row is-hoverable"
        :class="dropClass(reorder, c.propertyId, i === columns.length - 1)"
        :data-rid="c.propertyId"
        @keydown="step($event, c.propertyId)"
      >
        <span class="pl-panel__grip" :title="shell.reorder(c.property.name)" @pointerdown="reorder.start($event, c.propertyId)"><Icon name="grip-vertical" /></span>
        <button type="button" class="pl-props__main" role="switch" :aria-checked="c.visible" :title="c.visible ? shell.hide(c.property.name) : shell.show(c.property.name)" @click="toggle(c.propertyId)">
          <PropertyIcon :type="c.property.type" />
          <span class="pl-panel__label" :class="{ 'is-off': !c.visible }">{{ c.property.name || shell.unnamed }}</span>
          <Icon :name="c.visible ? 'eye' : 'eye-off'" class="pl-props__eye" :class="{ 'is-off': !c.visible }" />
        </button>
        <component :is="IconButton" size="sm" :label="shell.propertyMenu" @click="menu($event, c.property)"><Icon name="ellipsis" /></component>
      </div>
    </div>
    <div v-if="columns.length" class="pl-panel__sep" />
    <button v-if="view.type === 'board'" type="button" class="pl-panel__row" role="switch" :aria-checked="view.cardPreview === 'body'" @click="store.updateView(collection.id, view.id, { cardPreview: view.cardPreview === 'body' ? 'none' : 'body' })">
      <Icon name="text" />
      <span class="pl-panel__label">{{ shell.bodyPreview }}</span>
      <Icon v-if="view.cardPreview === 'body'" name="check" class="pl-panel__check" />
    </button>
    <button type="button" class="pl-panel__row" @click="emit('addProperty')"><Icon name="plus" /><span class="pl-panel__label">{{ shell.addProperty }}</span></button>
  </div>
</template>

<style scoped>
.pl-props { padding: var(--space-1); }
.pl-props__main { flex: 1; min-width: 0; display: flex; align-items: center; gap: var(--space-2); height: 28px; text-align: left; border-radius: var(--radius-xs); }
.pl-props__main > svg { flex: none; width: 15px; height: 15px; stroke-width: 1.75; color: var(--fg-subtle); }
.pl-props__main > svg.pl-props__eye.is-off { color: var(--fg-faint); }
</style>
