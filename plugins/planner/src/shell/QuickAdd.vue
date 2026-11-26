<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import { usePlanner } from '../context.ts'
import type { Collection, Item } from '../model.ts'
import Icon from '../ui/Icon.vue'
import CollectionIcon from './CollectionIcon.vue'
import { keyLabel } from './keys.ts'
import PickList from './PickList.vue'
import { shell } from './strings.ts'

/** A new item from anywhere: a title and the collection it goes into. Enter adds it, Mod+Enter opens it too. */
const props = defineProps<{ collectionId: string }>()
const emit = defineEmits<{ added: [collection: Collection, item: Item, open: boolean]; cancel: [] }>()
const { store, mango } = usePlanner()
const { Button } = mango.ui.components

const title = ref('')
const id = ref(props.collectionId)
const choosing = ref(false)
const busy = ref(false)
const input = ref<HTMLInputElement | null>(null)
const collection = computed(() => store.collection(id.value) ?? store.collections.value[0] ?? null)
const rows = computed(() => store.collections.value.map(c => ({ id: c.id, label: c.name || shell.unnamed, checked: c.id === collection.value?.id })))

async function add(open: boolean) {
  const c = collection.value
  const text = title.value.trim()
  if (!c || busy.value || (!text && !open)) return
  busy.value = true
  const item = await store.createItem(c.id, { title: text }).finally(() => { busy.value = false })
  if (item) emit('added', c, item, open)
}
function pick(picked: string) {
  id.value = picked
  choosing.value = false
  void nextTick(() => input.value?.focus())
}
function onKey(e: KeyboardEvent) {
  if (e.key !== 'Enter' || !(e.ctrlKey || e.metaKey) || e.isComposing) return
  e.preventDefault()
  void add(true)
}
</script>

<template>
  <form class="pl-quick" @submit.prevent="add(false)" @keydown="onKey">
    <input ref="input" v-model="title" class="pl-input pl-quick__title" type="text" :placeholder="shell.quickAddTitle" :aria-label="shell.quickAddTitle" autocomplete="off">
    <div class="pl-quick__in">
      <span>{{ shell.quickAddTo }}</span>
      <button v-if="collection" type="button" class="pl-small pl-quick__pick" :aria-expanded="choosing" @click="choosing = !choosing">
        <CollectionIcon :collection="collection" /><span class="pl-panel__label">{{ collection.name || shell.unnamed }}</span><Icon name="chevron-down" />
      </button>
    </div>
    <PickList v-if="choosing" :rows="rows" :label="shell.switchCollection" :placeholder="shell.findCollection" :search="rows.length > 7" :max-height="200" @pick="pick">
      <template #icon="{ row }"><CollectionIcon v-if="store.collection(row.id)" :collection="store.collection(row.id)!" /></template>
    </PickList>
    <footer class="pl-quick__foot">
      <component :is="Button" variant="ghost" @click="emit('cancel')">{{ shell.cancel }}</component>
      <component :is="Button" :disabled="busy" :title="keyLabel(mango, 'Enter')" @click="add(true)">{{ shell.addAndOpen }}</component>
      <component :is="Button" variant="primary" type="submit" :loading="busy" :disabled="!title.trim()" title="Enter">{{ shell.add }}</component>
    </footer>
  </form>
</template>

<style scoped>
.pl-quick { display: grid; gap: var(--space-3); padding-top: var(--space-1); }
.pl-quick__title { height: 34px; font-size: var(--text-md); }
.pl-quick__in { display: flex; align-items: center; gap: var(--space-1); min-width: 0; font-size: var(--text-xs); color: var(--fg-subtle); }
.pl-quick__pick { flex: 0 1 auto; gap: 6px; min-width: 0; color: var(--fg); }
.pl-quick__foot { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: var(--space-2); padding-top: var(--space-1); }
</style>
