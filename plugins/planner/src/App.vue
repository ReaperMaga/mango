<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, provide, ref, watch, watchEffect } from 'vue'
import { PLANNER, readRoute, VIEW_ID, type Planner, type Route } from './context.ts'
import type { MangoPluginApi, TabContext } from './host.ts'
import ItemPage from './item/ItemPage.vue'
import { itemWord, viewOf, type Collection } from './model.ts'
import { isActive, runQuery } from './query.ts'
import { askNewCollection } from './shell/dialogs.ts'
import FilterBar from './shell/FilterBar.vue'
import ItemPane from './shell/ItemPane.vue'
import { inTextField, isMod } from './shell/keys.ts'
import PlannerHeader from './shell/PlannerHeader.vue'
import PlannerSkeleton from './shell/PlannerSkeleton.vue'
import StartScreen from './shell/StartScreen.vue'
import { shell } from './shell/strings.ts'
import type { PlannerStore } from './store.ts'
import { strings } from './strings.ts'
import Icon from './ui/Icon.vue'
import { anyLayerOpen } from './ui/layers.ts'
import BoardView from './views/board/BoardView.vue'
import TableView from './views/table/TableView.vue'

/** The planner's tab: a header, the filters in use, the view, and the item that is open. */
const props = defineProps<{ mango: MangoPluginApi; store: PlannerStore; ctx: TabContext }>()
const { status, error, collections, collection: collectionOf, sourceStatus, saving } = props.store
const { Button } = props.mango.ui.components

/* ---------- where it is */

const route = computed<Route>(() => {
  const r = readRoute(props.ctx.state)
  if (r?.collectionId && collectionOf(r.collectionId)) return r
  const last = collections.value.find(c => c.id === props.store.lastCollection())
  return { collectionId: (last ?? collections.value[0])?.id ?? null }
})
function go(next: Partial<Route>) {
  const elsewhere = next.collectionId !== undefined && next.collectionId !== route.value.collectionId
  props.ctx.setState({ ...(elsewhere ? {} : route.value), ...next })
}
const planner: Planner = { mango: props.mango, store: props.store, route, go }
provide(PLANNER, planner)

const collection = computed(() => collectionOf(route.value.collectionId))
const view = computed(() => {
  const c = collection.value
  return c && (viewOf(c, route.value.viewId) ?? viewOf(c, props.store.lastView(c.id)) ?? c.views[0] ?? null)
})
const list = computed(() => (collection.value ? props.store.items(collection.value.id) : null))
const readonly = computed(() => sourceStatus.value.readonly)

// The one shown for want of another too: it stays when the list changes.
watchEffect(() => {
  const id = route.value.collectionId
  if (id && props.store.lastCollection() !== id) props.store.rememberCollection(id)
})
function show(c: Collection) {
  go({ collectionId: c.id })
  void nextTick(focusView)
}
function showView(viewId: string) {
  const c = collection.value
  if (!c) return
  props.store.rememberView(c.id, viewId)
  go({ viewId, ...(covered.value ? { itemId: undefined } : {}) })
}
async function newCollection() {
  const made = await askNewCollection(planner)
  if (made) show(made)
}

/* ---------- what it shows */

const search = ref('')
const applied = ref('')
let searchTimer: ReturnType<typeof setTimeout> | undefined
watch(search, (text) => {
  clearTimeout(searchTimer)
  if (!text) applied.value = ''
  else searchTimer = setTimeout(() => { applied.value = text }, 80)
})
watch(() => route.value.collectionId, () => { search.value = '' })

const DAYS = new Set(['today', 'overdue', 'nextDays', 'pastDays'])
const result = computed(() => {
  const c = collection.value
  const v = view.value
  if (!c || !v || !list.value) return null
  // Only a filter about today has to follow the clock.
  const now = v.filter.conditions.some(x => DAYS.has(x.operator)) ? props.store.now.value : undefined
  return runQuery(c, list.value.items, v, { search: applied.value, now })
})
const filtering = computed(() => !!view.value?.filter.conditions.some(isActive))
const hasBar = computed(() => !!view.value && view.value.filter.conditions.length + view.value.sorts.length > 0)
const noMatches = computed(() => !!result.value && result.value.total > 0 && !result.value.items.length && (filtering.value || applied.value.trim() !== ''))
function clearAll() {
  search.value = ''
  if (filtering.value && collection.value && view.value) {
    props.store.updateView(collection.value.id, view.value.id, { filter: { match: view.value.filter.match, conditions: [] } })
  }
}

/* ---------- the item */

const MODE_KEY = 'itemMode'
const mode = ref<'side' | 'full'>(props.mango.storage.get(MODE_KEY) === 'full' ? 'full' : 'side')
const item = computed(() => {
  const id = route.value.itemId
  return id && collection.value && list.value?.items.some(i => i.id === id) ? id : null
})
const full = computed(() => item.value !== null && mode.value === 'full')
function toggleMode() {
  mode.value = mode.value === 'side' ? 'full' : 'side'
  props.mango.storage.set(MODE_KEY, mode.value)
}
function closeItem() {
  go({ itemId: undefined })
  void nextTick(focusView)
}

/* ---------- parts */

const root = ref<HTMLElement | null>(null)
const head = ref<InstanceType<typeof PlannerHeader> | null>(null)
const bar = ref<InstanceType<typeof FilterBar> | null>(null)
const viewRef = ref<{ newItem(): void; focus(): void } | null>(null)
const width = ref(1000)
const sideOver = computed(() => width.value < 760)
/** The item is all there is to see. */
const covered = computed(() => full.value || (item.value !== null && width.value < 560))

function focusView() {
  viewRef.value?.focus()
}
async function newItem() {
  if (readonly.value || list.value?.status !== 'ready') return
  if (covered.value || (item.value && sideOver.value)) go({ itemId: undefined })
  // What is added would not show under a search it does not match.
  search.value = ''
  await nextTick()
  viewRef.value?.newItem()
}
async function editFilter(id: string) {
  await nextTick()
  void bar.value?.edit(id)
}

/** Not for a moment's write: only when it takes long. */
const slow = ref(false)
let slowTimer: ReturnType<typeof setTimeout> | undefined
watch(saving, (on) => {
  clearTimeout(slowTimer)
  if (on) slowTimer = setTimeout(() => { slow.value = true }, 900)
  else slow.value = false
})

const banner = computed(() => {
  const s = sourceStatus.value
  if (!s.online) return { icon: 'cloud-off', title: shell.offline, body: s.message || shell.offlineBody }
  if (s.readonly) return { icon: 'lock', title: shell.readonly, body: s.message || shell.readonlyBody }
  return null
})

/* ---------- keys */

function onKey(e: KeyboardEvent) {
  if (e.defaultPrevented || !isMod(props.mango, e) || e.altKey || anyLayerOpen()) return
  const target = e.target as Node | null
  const inside = !!root.value?.contains(target)
  // Nothing has the focus, and the planner is what is in view.
  const bare = target === document.body && props.mango.ui.tabs.active()?.viewId === VIEW_ID
  if (!inside && !bare) return
  const key = e.key.toLowerCase()
  if (key === 'f' && !e.shiftKey) {
    if (!collection.value || covered.value) return
    void head.value?.openSearch()
  } else if (key === 'z' || (key === 'y' && !e.shiftKey)) {
    if (inTextField(target)) return
    if (key === 'y' || e.shiftKey) props.store.redo()
    else props.store.undo()
  } else if (key === 'enter' && e.shiftKey) void newItem()
  else return
  e.preventDefault()
  e.stopPropagation()
}

let sizes: ResizeObserver | null = null
onMounted(() => {
  window.addEventListener('keydown', onKey)
  sizes = new ResizeObserver(() => { width.value = root.value?.clientWidth ?? width.value })
  if (root.value) {
    width.value = root.value.clientWidth
    sizes.observe(root.value)
  }
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey)
  sizes?.disconnect()
  clearTimeout(searchTimer)
  clearTimeout(slowTimer)
})
</script>

<template>
  <div ref="root" class="pl-app" data-own-find tabindex="-1">
    <div v-if="status === 'error'" class="pl-fail" role="alert">
      <p class="pl-fail__title">{{ strings.loadFailed }}</p>
      <p v-if="error" class="pl-fail__body selectable">{{ error }}</p>
      <component :is="Button" size="sm" @click="store.load()">{{ strings.retry }}</component>
    </div>
    <PlannerSkeleton v-else-if="status !== 'ready' && !collection" head />
    <StartScreen v-else-if="!collection || !view" @made="show" />

    <template v-else>
      <PlannerHeader
        ref="head"
        v-model:search="search"
        :collection="collection"
        :view="view"
        :readonly="readonly"
        :saving="slow"
        :count="list?.status === 'ready' ? list.items.length : null"
        :width="width"
        :covered="covered"
        @collection="show"
        @view="showView"
        @new-collection="newCollection"
        @new-item="newItem"
        @filtered="editFilter"
        @to-view="focusView"
      />
      <div v-if="banner" class="pl-note" role="status">
        <Icon :name="banner.icon" /><strong>{{ banner.title }}</strong><span>{{ banner.body }}</span>
      </div>
      <FilterBar v-if="hasBar && !covered" ref="bar" :collection="collection" :view="view" :readonly="readonly" @add="el => head?.openFilter(el)" />

      <div v-if="list?.status === 'error'" class="pl-fail" role="alert">
        <p class="pl-fail__title">{{ shell.itemsFailed }}</p>
        <p v-if="list.error" class="pl-fail__body selectable">{{ list.error }}</p>
        <component :is="Button" size="sm" @click="store.loadItems(collection.id)">{{ strings.retry }}</component>
      </div>
      <PlannerSkeleton v-else-if="list?.status !== 'ready' || !result" />
      <div v-else class="pl-body">
        <div v-show="!full" class="pl-view" :inert="full">
          <div v-if="noMatches" class="pl-note" role="status">
            <Icon name="search-x" />
            <span>{{ applied.trim() ? shell.noMatchesSearch(applied.trim(), itemWord(collection, 2)) : shell.noMatches(itemWord(collection, 2)) }}</span>
            <button type="button" class="pl-small pl-note__act" @click="clearAll">{{ applied.trim() && filtering ? shell.clearAll : filtering ? shell.clearFilters : shell.clearSearch }}</button>
          </div>
          <component
            :is="view.type === 'board' ? BoardView : TableView"
            :key="`${collection.id}/${view.id}/${view.type}`"
            ref="viewRef"
            class="pl-view__in"
            :collection="collection"
            :view="view"
            :result="result"
            :search="applied"
            :readonly="readonly"
            :open-item-id="item"
            @open="(id: string) => go({ itemId: id })"
          />
        </div>
        <ItemPage v-if="item && full" :collection="collection" :item-id="item" mode="full" class="pl-full" @close="closeItem" @toggle-mode="toggleMode" />
        <ItemPane v-else-if="item" :available="width" :overlay="sideOver">
          <ItemPage :collection="collection" :item-id="item" mode="side" class="pl-full" @close="closeItem" @toggle-mode="toggleMode" />
        </ItemPane>
      </div>
    </template>
  </div>
</template>

<style scoped>
.pl-app { flex: 1; min-width: 0; min-height: 0; height: 100%; display: flex; flex-direction: column; overflow: hidden; container: planner / inline-size; background: var(--bg-canvas); }
.pl-app:focus-visible { outline: none; }
.pl-body { position: relative; flex: 1; min-height: 0; display: flex; }
.pl-view { flex: 1; min-width: 0; min-height: 0; display: flex; flex-direction: column; }
.pl-view__in { flex: 1; min-height: 0; min-width: 0; }
.pl-full { flex: 1; min-width: 0; min-height: 0; }
.pl-note { flex: none; display: flex; align-items: center; gap: var(--space-2); min-height: 32px; padding: 4px var(--space-4); border-bottom: 1px solid var(--line-soft); font-size: var(--text-sm); color: var(--fg-muted); }
.pl-note > svg { flex: none; width: 14px; height: 14px; stroke-width: 1.75; color: var(--fg-subtle); }
.pl-note strong { font-weight: 600; color: var(--fg); }
.pl-note > span { min-width: 0; overflow-wrap: anywhere; }
.pl-note__act { color: var(--accent-ink); }
.pl-fail { display: grid; justify-items: start; gap: var(--space-2); padding: var(--space-6) var(--space-5); font-size: var(--text-sm); }
.pl-fail__title { margin: 0; font-weight: 600; }
.pl-fail__body { margin: 0; max-width: 70ch; color: var(--fg-muted); overflow-wrap: anywhere; }
</style>
