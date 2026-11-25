<script setup lang="ts">
import { computed, provide, watchEffect } from 'vue'
import { PLANNER, readRoute, type Route } from './context.ts'
import type { MangoPluginApi, TabContext } from './host.ts'
import type { PlannerStore } from './store.ts'
import { strings } from './strings.ts'
import { TEMPLATES, type TemplateId } from './templates.ts'

/** The planner's tab. A plain list for now. */
const props = defineProps<{ mango: MangoPluginApi; store: PlannerStore; ctx: TabContext }>()
const { status, error, collections, collection: collectionOf } = props.store
const { Button } = props.mango.ui.components

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
provide(PLANNER, { mango: props.mango, store: props.store, route, go })

watchEffect(() => {
  const id = readRoute(props.ctx.state)?.collectionId
  if (id && collectionOf(id)) props.store.rememberCollection(id)
})

const collection = computed(() => collectionOf(route.value.collectionId))
const list = computed(() => (collection.value ? props.store.items(collection.value.id) : null))

function create(template: TemplateId) {
  const made = props.store.createCollection({ template })
  if (made) go({ collectionId: made.id })
}
async function addItem() {
  if (!collection.value) return
  const title = await props.mango.ui.prompt({ title: strings.newItemIn(collection.value.name) })
  if (title?.trim()) await props.store.createItem(collection.value.id, { title: title.trim() })
}
</script>

<template>
  <div class="planner">
    <p v-if="status === 'error'">
      {{ strings.loadFailed }}: {{ error }}
      <component :is="Button" @click="store.load()">{{ strings.retry }}</component>
    </p>
    <nav class="planner__row">
      <component :is="Button" v-for="c in collections" :key="c.id" variant="ghost" @click="go({ collectionId: c.id })">{{ c.name }}</component>
    </nav>
    <template v-if="collection && list">
      <h2>{{ collection.name }}</h2>
      <p v-if="list.status === 'error'">
        {{ strings.loadFailed }}: {{ list.error }}
        <component :is="Button" @click="store.loadItems(collection.id)">{{ strings.retry }}</component>
      </p>
      <p v-else-if="list.status !== 'ready'">{{ strings.loading }}</p>
      <ul v-else>
        <li v-for="i in list.items" :key="i.id">{{ i.title || strings.untitled }}</li>
      </ul>
      <component :is="Button" @click="addItem">{{ strings.newItemIn(collection.name) }}</component>
    </template>
    <div class="planner__row">
      <component :is="Button" v-for="t in TEMPLATES" :key="t.id" @click="create(t.id)">{{ strings.newCollection }}: {{ t.name }}</component>
    </div>
  </div>
</template>

<style scoped>
.planner { display: flex; flex-direction: column; gap: var(--space-3); padding: var(--space-4); }
.planner__row { display: flex; flex-wrap: wrap; gap: var(--space-2); }
</style>
