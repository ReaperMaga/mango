<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { usePlanner } from '../context.ts'
import { TITLE, propertyOf, type Collection, type Condition, type View } from '../model.ts'
import { isActive } from '../query.ts'
import Icon from '../ui/Icon.vue'
import Popover from '../ui/Popover.vue'
import PropertyIcon from '../ui/PropertyIcon.vue'
import ConditionEditor from './ConditionEditor.vue'
import { conditionText, operatorText, propertyName, setFilter, setSorts } from './filters.ts'
import SortPanel from './SortPanel.vue'
import { shell } from './strings.ts'

/** What the view is filtered and sorted by, editable in place. Shown only while there is something to show. */
const props = defineProps<{ collection: Collection; view: View; readonly: boolean }>()
const emit = defineEmits<{ add: [anchor: HTMLElement] }>()
const { store } = usePlanner()

const root = ref<HTMLElement | null>(null)
const editing = ref<{ id: string; anchor: HTMLElement } | null>(null)
const sorting = ref<HTMLElement | null>(null)
const conditions = computed(() => props.view.filter.conditions)
const edited = computed(() => conditions.value.find(c => c.id === editing.value?.id) ?? null)
watch(() => props.view.id, () => {
  editing.value = null
  sorting.value = null
})

/** Opens a filter's editor, once its chip is there. */
async function edit(id: string) {
  await nextTick()
  const anchor = root.value?.querySelector<HTMLElement>(`[data-cid="${CSS.escape(id)}"]`)
  if (anchor) editing.value = { id, anchor }
}
function change(id: string, part: Partial<Condition>, typing = false) {
  setFilter(store, props.collection, props.view, { conditions: conditions.value.map(c => (c.id === id ? { ...c, ...part } : c)) }, typing)
}
function remove(id: string) {
  editing.value = null
  setFilter(store, props.collection, props.view, { conditions: conditions.value.filter(c => c.id !== id) })
}
function clearAll() {
  store.updateView(props.collection.id, props.view.id, { filter: { match: 'and', conditions: [] }, sorts: [] })
}
const onDelete = (e: KeyboardEvent, run: () => void) => {
  if (e.key !== 'Delete' && e.key !== 'Backspace') return
  e.preventDefault()
  e.stopPropagation()
  run()
}
defineExpose({ edit })
</script>

<template>
  <div ref="root" class="pl-bar">
    <button
      v-if="conditions.length > 1"
      type="button"
      class="pl-small"
      :disabled="readonly"
      :title="shell.matchHint"
      @click="setFilter(store, collection, view, { match: view.filter.match === 'and' ? 'or' : 'and' })"
    >{{ view.filter.match === 'and' ? shell.matchAll : shell.matchAny }}</button>

    <span v-for="c in conditions" :key="c.id" class="pl-chip" :class="{ 'is-idle': !isActive(c), 'is-open': editing?.id === c.id }">
      <button
        type="button"
        class="pl-chip__main"
        :data-cid="c.id"
        :disabled="readonly"
        aria-haspopup="dialog"
        :aria-expanded="editing?.id === c.id"
        :title="`${shell.editFilter}: ${propertyName(collection, c.propertyId)} ${operatorText(c.operator)} ${conditionText(collection, c, store.people(collection.id))}`"
        @click="edit(c.id)"
        @keydown="onDelete($event, () => !readonly && remove(c.id))"
      >
        <PropertyIcon :type="c.propertyId === TITLE ? 'text' : propertyOf(collection, c.propertyId)?.type ?? 'text'" />
        <span class="pl-chip__name">{{ propertyName(collection, c.propertyId) }}</span>
        <span class="pl-chip__op">{{ operatorText(c.operator) }}</span>
        <span v-if="conditionText(collection, c, store.people(collection.id))" class="pl-chip__value">{{ conditionText(collection, c, store.people(collection.id)) }}</span>
        <span v-else-if="!isActive(c)" class="pl-chip__op">…</span>
      </button>
      <button v-if="!readonly" type="button" class="pl-chip__x" :aria-label="shell.removeFilter" :title="shell.removeFilter" @click="remove(c.id)"><Icon name="x" /></button>
    </span>

    <button v-if="conditions.length && !readonly" type="button" class="pl-small" :title="shell.addFilter" @click="emit('add', $event.currentTarget as HTMLElement)">
      <Icon name="plus" />{{ shell.filter }}
    </button>
    <span v-if="conditions.length && view.sorts.length" class="pl-bar__sep" aria-hidden="true" />

    <span v-for="s in view.sorts" :key="s.propertyId" class="pl-chip">
      <button
        type="button"
        class="pl-chip__main"
        :disabled="readonly"
        aria-haspopup="dialog"
        :aria-label="`${shell.editSort}: ${propertyName(collection, s.propertyId)}, ${s.direction === 'asc' ? shell.ascending : shell.descending}`"
        :title="shell.editSort"
        @click="sorting = $event.currentTarget as HTMLElement"
        @keydown="onDelete($event, () => !readonly && setSorts(store, collection, view, view.sorts.filter(e => e.propertyId !== s.propertyId)))"
      >
        <Icon :name="s.direction === 'asc' ? 'arrow-up' : 'arrow-down'" />
        <span class="pl-chip__name">{{ propertyName(collection, s.propertyId) }}</span>
      </button>
      <button v-if="!readonly" type="button" class="pl-chip__x" :aria-label="shell.removeSort" :title="shell.removeSort" @click="setSorts(store, collection, view, view.sorts.filter(e => e.propertyId !== s.propertyId))"><Icon name="x" /></button>
    </span>

    <button v-if="!readonly" type="button" class="pl-small" @click="clearAll">{{ shell.clear }}</button>

    <Popover v-if="editing && edited" :key="editing.id" :anchor="editing.anchor" :width="260" :label="shell.editFilter" @close="editing = null">
      <ConditionEditor
        :collection="collection"
        :condition="edited"
        @change="(part, typing) => change(edited!.id, part, typing)"
        @remove="remove(edited!.id)"
        @done="editing = null"
      />
    </Popover>
    <Popover v-if="sorting" :anchor="sorting" :width="280" :label="shell.sortBy" @close="sorting = null">
      <SortPanel :collection="collection" :view="view" @close="sorting = null" />
    </Popover>
  </div>
</template>

<style scoped>
.pl-bar { flex: none; display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-1); padding: 5px var(--space-3); border-bottom: 1px solid var(--line-soft); }
.pl-bar__sep { width: 1px; height: 14px; margin: 0 2px; background: var(--line); }
.pl-chip { display: inline-flex; align-items: center; max-width: 100%; min-width: 0; height: 24px; border: 1px solid var(--line); border-radius: var(--radius-sm); font-size: var(--text-xs); color: var(--fg-muted); transition: background var(--dur-fast) var(--ease-out), border-color var(--dur-fast) var(--ease-out); }
.pl-chip:hover, .pl-chip.is-open { background: var(--bg-hover); border-color: var(--line-strong); }
.pl-chip.is-idle { border-style: dashed; }
.pl-chip__main { display: inline-flex; align-items: center; gap: 5px; min-width: 0; height: 100%; padding: 0 2px 0 6px; color: inherit; border-radius: var(--radius-sm); }
.pl-chip__main:disabled { cursor: default; padding-right: 6px; }
.pl-chip__main > svg { flex: none; width: 13px; height: 13px; stroke-width: 1.75; color: var(--fg-subtle); }
.pl-chip__main > span { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pl-chip__name { max-width: 160px; }
.pl-chip__op { flex: none; color: var(--fg-subtle); }
.pl-chip__value { max-width: 220px; color: var(--fg); font-weight: 560; }
.pl-chip__x { flex: none; display: grid; place-items: center; width: 20px; height: 100%; color: var(--fg-faint); border-radius: var(--radius-xs); }
.pl-chip__x svg { width: 12px; height: 12px; stroke-width: 2; }
.pl-chip__x:hover { color: var(--fg); }
.pl-chip__main:focus-visible, .pl-chip__x:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: -1px; }
</style>
