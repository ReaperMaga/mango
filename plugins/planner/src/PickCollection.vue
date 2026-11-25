<script setup lang="ts">
import { computed } from 'vue'
import { usePlanner } from './context.ts'
import type { Collection } from './model.ts'
import CollectionIcon from './shell/CollectionIcon.vue'
import PickList, { type PickRow } from './shell/PickList.vue'
import { shell } from './shell/strings.ts'
import Icon from './ui/Icon.vue'

/** Which collection something goes into; a new one is one of the answers. */
const props = defineProps<{ currentId?: string | null }>()
const emit = defineEmits<{ pick: [collection: Collection]; create: [] }>()
const { store } = usePlanner()
const NEW = '+'

const rows = computed<PickRow[]>(() => {
  const all = store.collections.value
  return [
    ...[...all.filter(c => c.scope.kind === 'project'), ...all.filter(c => c.scope.kind !== 'project')].map(c => ({
      id: c.id,
      label: c.name || shell.unnamed,
      group: c.scope.kind === 'project' ? shell.thisProject : shell.everywhere,
      checked: c.id === props.currentId,
    })),
    { id: NEW, label: shell.newCollectionRow, always: true },
  ]
})
function pick(id: string) {
  const c = store.collection(id)
  if (c) emit('pick', c)
  else emit('create')
}
</script>

<template>
  <PickList class="pl-choose" :rows="rows" :label="shell.switchCollection" :placeholder="shell.findCollection" @pick="pick">
    <template #icon="{ row }">
      <CollectionIcon v-if="store.collection(row.id)" :collection="store.collection(row.id)!" />
      <Icon v-else name="plus" />
    </template>
  </PickList>
</template>

<style scoped>
.pl-choose { margin: 0 calc(-1 * var(--space-2)); }
</style>
