<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import { usePlanner } from '../context.ts'
import type { PluginMenuRow } from '../host.ts'
import { itemWord, TITLE, propertyOf, type Collection, type View } from '../model.ts'
import Icon from '../ui/Icon.vue'
import Popover from '../ui/Popover.vue'
import PropertyIcon from '../ui/PropertyIcon.vue'
import AddProperty from '../values/AddProperty.vue'
import CollectionIcon from './CollectionIcon.vue'
import { collectionRows, transferRows } from './collectionMenu.ts'
import CollectionSwitcher from './CollectionSwitcher.vue'
import { newCondition, propertyRows, setFilter } from './filters.ts'
import GroupPanel from './GroupPanel.vue'
import { keyLabel } from './keys.ts'
import PickList from './PickList.vue'
import PropertiesPanel from './PropertiesPanel.vue'
import { useRepository } from './repository.ts'
import SortPanel from './SortPanel.vue'
import { shell } from './strings.ts'
import ViewTabs from './ViewTabs.vue'

/** The planner's one row: which collection, which view of it, and what to find in it. */
const props = defineProps<{
  collection: Collection
  view: View
  search: string
  /** How many items the collection has; null while they load. */
  count: number | null
  readonly: boolean
  saving: boolean
  /** The width of the planner. */
  width: number
  /** An item covers the view: nothing to filter or sort. */
  covered: boolean
}>()
const emit = defineEmits<{
  'update:search': [text: string]
  collection: [collection: Collection]
  view: [viewId: string]
  'new-collection': []
  'new-item': []
  /** A filter was added: edit it. */
  filtered: [conditionId: string]
  /** Leave the search field for the view. */
  'to-view': []
}>()
const planner = usePlanner()
const { store, mango } = planner
const { Button, IconButton } = mango.ui.components

type Pop = 'switch' | 'filter' | 'sort' | 'group' | 'properties' | 'addProperty'
const pop = ref<{ name: Pop; anchor: HTMLElement } | null>(null)
const more = ref<HTMLElement | null>(null)
const tabs = ref<InstanceType<typeof ViewTabs> | null>(null)
const searchInput = ref<HTMLInputElement | null>(null)
const searchOpen = ref(false)

/** Less room: the repository goes, then the views fold into one button, then the search field and the words. */
const wide = computed(() => props.width >= 900)
const roomy = computed(() => props.width >= 640)
const compactViews = computed(() => props.width < 820)
const searching = computed(() => roomy.value || searchOpen.value || props.search !== '')
const filters = computed(() => props.view.filter.conditions.length)
/** What "…" has that is in use and not plain to see. */
const marked = computed(() => props.view.sorts.length > 0 || (props.view.type === 'table' && props.view.groupBy !== null) || props.view.hiddenGroups.length > 0)
const many = computed(() => itemWord(props.collection, 2))
const one = computed(() => itemWord(props.collection, 1))
const repository = useRepository(mango, () => props.collection)

function open(name: Pop, anchor: EventTarget | HTMLElement | null) {
  if (anchor) pop.value = { name, anchor: anchor as HTMLElement }
}
const close = () => { pop.value = null }

async function menu(at: HTMLElement | { x: number; y: number }) {
  let next: (() => unknown) | undefined
  const panel = (name: Pop) => () => { next = () => open(name, more.value) }
  const then = (rows: PluginMenuRow[]) => () => { next = () => mango.ui.contextMenu(at, rows) }
  const v = props.view
  const own = collectionRows(planner, props.collection, v.groupBy).map((r, i) => (i ? r : { ...r, divider: true }))
  const rows: PluginMenuRow[] = [
    ...(props.readonly ? [] : [{ label: shell.newNamed(one.value), icon: 'plus', kbd: keyLabel(mango, 'Shift', 'Enter'), onSelect: () => emit('new-item') }]),
    ...(props.readonly || props.covered ? [] : [
      { label: shell.sortMenu, icon: 'arrow-up-down', aside: v.sorts.length ? String(v.sorts.length) : undefined, divider: true, onSelect: panel('sort') },
      { label: shell.groupMenu, icon: 'group', aside: v.groupBy ? propertyOf(props.collection, v.groupBy)?.name : undefined, onSelect: panel('group') },
      { label: shell.propertiesMenu, icon: 'sliders-horizontal', onSelect: panel('properties') },
    ]),
    { label: shell.viewMenu, aside: v.name, icon: v.type === 'board' ? 'square-kanban' : 'table-2', divider: true, onSelect: then(tabs.value?.currentRows() ?? []) },
    ...(props.readonly ? [] : [{ label: shell.addViewMenu, icon: 'plus', onSelect: then(tabs.value?.addRows() ?? []) }]),
    ...own.slice(0, -1),
    { label: shell.transfer, icon: 'arrow-down-up', onSelect: then(transferRows(planner, props.collection)) },
    { label: shell.undo(store.undoLabel.value), icon: 'undo-2', divider: true, kbd: keyLabel(mango, 'Z'), disabled: props.readonly || !store.canUndo.value, onSelect: () => store.undo() },
    { label: shell.redo(store.redoLabel.value), icon: 'redo-2', kbd: keyLabel(mango, 'Shift', 'Z'), disabled: props.readonly || !store.canRedo.value, onSelect: () => store.redo() },
    ...own.slice(-1),
  ]
  await mango.ui.contextMenu(at, rows)
  await next?.()
}

function addFilter(propertyId: string) {
  const c = newCondition(props.collection, propertyId)
  close()
  setFilter(store, props.collection, props.view, { conditions: [...props.view.filter.conditions, c] })
  emit('filtered', c.id)
}
function addProperty() {
  const anchor = pop.value?.anchor
  if (anchor) void nextTick(() => open('addProperty', anchor))
}
const typeOf = (id: string) => (id === TITLE ? 'text' : propertyOf(props.collection, id)?.type ?? 'text')

async function openSearch() {
  searchOpen.value = true
  await nextTick()
  searchInput.value?.focus()
  searchInput.value?.select()
}
function closeSearch(toView: boolean) {
  emit('update:search', '')
  searchOpen.value = false
  if (toView) emit('to-view')
}
function onSearchKey(e: KeyboardEvent) {
  if (e.isComposing) return
  if (e.key === 'Escape') closeSearch(true)
  else if (e.key === 'ArrowDown' || e.key === 'Enter') emit('to-view')
  else return
  e.preventDefault()
  e.stopPropagation()
}
const titleTip = computed(() => (props.collection.description ? `${props.collection.description}\n${shell.switchCollection}` : shell.switchCollection))
defineExpose({ openSearch, openFilter: (anchor: HTMLElement) => open('filter', anchor) })
</script>

<template>
  <header class="pl-head" :class="{ 'is-tight': !roomy }">
    <button
      type="button"
      class="pl-head__title"
      aria-haspopup="dialog"
      :aria-expanded="pop?.name === 'switch'"
      :aria-label="`${collection.name || shell.unnamed}, ${shell.switchCollection.toLowerCase()}`"
      :title="titleTip"
      @click="open('switch', $event.currentTarget)"
      @contextmenu.prevent="menu({ x: $event.clientX, y: $event.clientY })"
    >
      <CollectionIcon :collection="collection" />
      <span class="pl-head__name">{{ collection.name || shell.unnamed }}</span>
      <Icon name="chevron-down" class="pl-head__chev" />
    </button>
    <span v-if="count !== null && roomy" class="pl-head__count tabular">{{ count }} {{ itemWord(collection, count) }}</span>
    <button v-if="repository?.url && wide" type="button" class="pl-head__repo" :title="shell.openRepository(repository.label)" @click="mango.workspace.openBrowser(repository.url)">
      <Icon name="git-branch" /><span>{{ repository.label }}</span>
    </button>
    <span v-else-if="repository && wide" class="pl-head__repo is-plain" :title="shell.projectNamed(repository.label)"><Icon name="folder" /><span>{{ repository.label }}</span></span>
    <span v-if="saving && roomy" class="pl-head__count" role="status">{{ shell.saving }}</span>

    <div class="pl-head__tools">
      <ViewTabs ref="tabs" :collection="collection" :view="view" :compact="compactViews" :readonly="readonly" @pick="id => emit('view', id)" />
      <template v-if="!covered">
        <span class="pl-head__sep" aria-hidden="true" />
        <div v-if="searching" class="pl-search" :class="{ 'is-wide': wide, 'is-narrow': width < 560 }">
          <Icon name="search" />
          <input
            ref="searchInput"
            type="text"
            :value="search"
            :placeholder="shell.filterItems(many)"
            :aria-label="shell.filterItems(many)"
            :title="`${shell.filterItems(many)} (${keyLabel(mango, 'F')})`"
            autocomplete="off"
            spellcheck="false"
            @input="emit('update:search', ($event.target as HTMLInputElement).value)"
            @keydown="onSearchKey"
            @blur="!search && (searchOpen = false)"
          >
          <component :is="IconButton" v-if="search" size="sm" :label="shell.clearSearch" shortcut="Esc" @mousedown.prevent @click="closeSearch(true)"><Icon name="x" /></component>
        </div>
        <component :is="IconButton" v-else :label="shell.filterItems(many)" :shortcut="keyLabel(mango, 'F')" @click="openSearch"><Icon name="search" /></component>
        <component
          :is="Button"
          v-if="!readonly"
          variant="ghost"
          size="sm"
          class="pl-head__filter"
          :class="{ 'is-set': filters }"
          aria-haspopup="dialog"
          :aria-expanded="pop?.name === 'filter'"
          :aria-label="filters ? `${shell.filter}: ${filters}` : shell.filter"
          :title="shell.addFilter"
          @click="open('filter', $event.currentTarget)"
        ><Icon name="list-filter" /><template v-if="roomy">{{ shell.filter }}</template><span v-if="filters" class="tabular">{{ filters }}</span></component>
      </template>
      <span ref="more" class="pl-head__more">
        <component :is="IconButton" :label="shell.more" aria-haspopup="menu" @click="menu($event.currentTarget)"><Icon name="ellipsis" /></component>
        <span v-if="marked" class="pl-head__dot" aria-hidden="true" />
      </span>
    </div>

    <template v-if="pop">
      <Popover v-if="pop.name === 'switch'" :anchor="pop.anchor" :width="280" :label="shell.switchCollection" @close="close">
        <div class="pl-head__pad"><CollectionSwitcher :current-id="collection.id" @pick="(c) => { close(); emit('collection', c) }" @create="close(); emit('new-collection')" @leave="close" /></div>
      </Popover>
      <Popover v-else-if="pop.name === 'filter'" :anchor="pop.anchor" :width="240" placement="bottom-end" :label="shell.filterBy" @close="close">
        <div class="pl-head__pad">
          <PickList :rows="propertyRows(collection)" :label="shell.filterBy" :placeholder="shell.filterBy" @pick="addFilter">
            <template #icon="{ row }"><PropertyIcon :type="typeOf(row.id)" /></template>
          </PickList>
        </div>
      </Popover>
      <Popover v-else-if="pop.name === 'sort'" :anchor="pop.anchor" :width="280" placement="bottom-end" :label="shell.sortBy" @close="close">
        <SortPanel :collection="collection" :view="view" @close="close" />
      </Popover>
      <Popover v-else-if="pop.name === 'group'" :anchor="pop.anchor" :width="260" placement="bottom-end" :label="shell.groupBy" @close="close">
        <GroupPanel :collection="collection" :view="view" @add-property="addProperty" />
      </Popover>
      <Popover v-else-if="pop.name === 'properties'" :anchor="pop.anchor" :width="280" placement="bottom-end" :label="shell.properties" @close="close">
        <PropertiesPanel :collection="collection" :view="view" @add-property="addProperty" />
      </Popover>
      <AddProperty v-else :collection-id="collection.id" :anchor="pop.anchor" @close="close" />
    </template>
  </header>
</template>

<style scoped>
.pl-head { flex: none; display: flex; align-items: center; gap: var(--space-2); height: 44px; padding: 0 var(--space-2); min-width: 0; border-bottom: 1px solid var(--line-soft); }
.pl-head__title { flex: 0 1 auto; display: inline-flex; align-items: center; gap: 7px; min-width: 56px; max-width: 280px; height: 30px; padding: 0 4px 0 var(--space-2); border-radius: var(--radius-sm); font-size: var(--text-lg); font-weight: 620; letter-spacing: -0.01em; color: var(--fg); transition: background var(--dur-fast) var(--ease-out); }
.pl-head__title:hover, .pl-head__title[aria-expanded='true'] { background: var(--bg-hover); }
.pl-head__title:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: -1px; border-radius: var(--radius-sm); }
.pl-head__name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pl-head__title > svg.pl-head__chev { flex: none; width: 13px; height: 13px; stroke-width: 2; color: var(--fg-faint); }
.pl-head__count { flex: none; font-size: var(--text-sm); color: var(--fg-subtle); white-space: nowrap; }
.pl-head__repo { flex: 0 1 auto; display: inline-flex; align-items: center; gap: 5px; min-width: 0; max-width: 190px; height: 22px; padding: 0 var(--space-2); border-radius: var(--radius-xs); background: var(--bg-raised); font-family: var(--font-mono); font-size: var(--text-xs); color: var(--fg-muted); transition: background var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out); }
button.pl-head__repo:hover { background: var(--bg-active); color: var(--fg); }
:root[data-theme='light'] .pl-head__repo { background: var(--bg-hover); }
.pl-head__repo:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 1px; }
.pl-head__repo.is-plain { font-family: inherit; }
.pl-head__repo > svg { flex: none; width: 12px; height: 12px; stroke-width: 1.75; color: var(--fg-subtle); }
.pl-head__repo > span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pl-head__tools { flex: 1 0 auto; display: flex; align-items: center; justify-content: flex-end; gap: var(--space-1); min-width: 0; }
.pl-head__sep { flex: none; width: 1px; height: 18px; margin: 0 var(--space-1); background: var(--line); }
.pl-head__filter { height: 30px; }
.pl-head__filter.is-set { color: var(--accent-ink); }
.pl-head__more { position: relative; flex: none; display: inline-flex; }
.pl-head__dot { position: absolute; top: 4px; right: 3px; width: 5px; height: 5px; border-radius: 50%; background: var(--accent-ink); pointer-events: none; }
.pl-head__pad { padding: var(--space-1); }
.pl-search { display: flex; align-items: center; gap: 6px; width: 150px; height: 30px; padding: 0 3px 0 var(--space-2); background: var(--bg-panel); border: 1px solid var(--line); border-radius: var(--radius-sm); color: var(--fg-faint); }
.pl-search.is-wide { width: 200px; }
.pl-search.is-narrow { width: 110px; }
.pl-search:focus-within { border-color: var(--accent-line); box-shadow: 0 0 0 3px var(--accent-soft); }
.pl-search > svg { flex: none; width: 14px; height: 14px; stroke-width: 1.75; }
.pl-search input { flex: 1; min-width: 0; padding: 0; background: none; border: 0; font-size: var(--text-sm); color: var(--fg); }
.pl-search input:focus-visible { outline: none; }
.pl-search input::placeholder { color: var(--fg-subtle); }
.pl-head.is-tight { gap: 2px; }
.pl-head.is-tight .pl-head__sep { margin: 0 2px; }
@container planner (max-width: 440px) {
  .pl-head__sep { display: none; }
}
</style>
