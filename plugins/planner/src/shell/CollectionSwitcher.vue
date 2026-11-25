<script setup lang="ts">
import { computed, ref } from 'vue'
import { usePlanner } from '../context.ts'
import type { Collection } from '../model.ts'
import type { Position } from '../order.ts'
import Icon from '../ui/Icon.vue'
import CollectionIcon from './CollectionIcon.vue'
import { collectionRows } from './collectionMenu.ts'
import PickList, { type PickRow } from './PickList.vue'
import { stepPosition, useReorder } from './reorder.ts'
import { shell } from './strings.ts'

/** The collections to switch to: the project's, then those shown everywhere. Dragging a row (or Alt+arrows) reorders. */
const props = defineProps<{ currentId: string | null }>()
const emit = defineEmits<{ pick: [collection: Collection]; create: []; /** Something else opens. */ leave: [] }>()
const planner = usePlanner()
const { store, mango } = planner
const { IconButton } = mango.ui.components
const NEW = '+'
const box = ref<HTMLElement | null>(null)

const list = computed(() => {
  const all = store.collections.value
  return [...all.filter(c => c.scope.kind === 'project'), ...all.filter(c => c.scope.kind !== 'project')]
})
const byId = computed(() => new Map(list.value.map(c => [c.id, c])))
const rows = computed<PickRow[]>(() => [
  ...list.value.map(c => ({
    id: c.id,
    label: c.name || shell.unnamed,
    group: c.scope.kind === 'project' ? shell.thisProject : shell.everywhere,
    checked: c.id === props.currentId,
  })),
  { id: NEW, label: shell.newCollectionRow, always: true },
])

/** The collections of its group: it only moves among those. */
const group = (id: string) => list.value.filter(c => c.scope.kind === byId.value.get(id)?.scope.kind).map(c => c.id)
const reorder = useReorder({
  axis: 'y',
  container: () => box.value,
  hold: () => mango.ui.holdOverlay(),
  onDrop(id, position) {
    const ids = group(id)
    const others = ids.filter(i => i !== id)
    const before = typeof position === 'object' && 'before' in position ? position.before : null
    let to: Position | null = null
    if (before !== null && ids.includes(before)) to = position
    else if (others.length) {
      // Past the end of its group is its end; before its start is its start.
      const at = before === null ? list.value.length : list.value.findIndex(c => c.id === before)
      const first = list.value.findIndex(c => c.id === ids[0])
      to = at <= first ? { before: others[0]! } : { after: others.at(-1)! }
    }
    if (to) store.moveCollection(id, to)
  },
  disabled: () => store.sourceStatus.value.readonly,
})
function move(id: string, by: -1 | 1) {
  const position = stepPosition(group(id), id, by)
  if (position) store.moveCollection(id, position)
}
function menu(id: string, at: HTMLElement | { x: number; y: number }) {
  const c = byId.value.get(id)
  if (!c) return
  // Chosen from here, they go on elsewhere.
  void mango.ui.contextMenu(at, collectionRows(planner, c).map(r => ({ ...r, onSelect: () => { emit('leave'); r.onSelect?.() } })))
}
function pick(id: string) {
  const c = byId.value.get(id)
  if (c) emit('pick', c)
  else emit('create')
}
</script>

<template>
  <div ref="box">
    <PickList :rows="rows" :label="shell.switchCollection" :placeholder="shell.findCollection" :reorder="reorder" @pick="pick" @move="move" @menu="menu">
      <template #icon="{ row }">
        <CollectionIcon v-if="byId.get(row.id)" :collection="byId.get(row.id)!" />
        <Icon v-else name="plus" />
      </template>
      <template #end="{ row }">
        <component
          :is="IconButton"
          v-if="byId.get(row.id)"
          size="sm"
          class="pl-switch__more"
          tabindex="-1"
          :label="shell.collectionMenu(row.label)"
          @pointerdown.stop
          @click.stop="menu(row.id, $event.currentTarget)"
        ><Icon name="ellipsis" /></component>
      </template>
    </PickList>
  </div>
</template>

<style scoped>
.pl-switch__more { opacity: 0; margin-right: -4px; }
:deep(.pl-pick__row.is-active) .pl-switch__more { opacity: 1; }
</style>
