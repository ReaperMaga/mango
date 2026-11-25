<script setup lang="ts">
import { computed, ref, shallowRef } from 'vue'
import { usePlanner } from '../context.ts'
import { isReadonly, propertyOf, safeUrl, valueOf, type Collection, type Item, type Property } from '../model.ts'
import Icon from '../ui/Icon.vue'
import PropertyIcon from '../ui/PropertyIcon.vue'
import AddProperty from '../values/AddProperty.vue'
import { propertyMenu } from '../values/PropertyMenu.ts'
import ValuePopover from '../values/ValuePopover.vue'
import ValueView from '../values/ValueView.vue'
import { strings } from './strings.ts'

/** An item's properties: click a value to change it, a name for the property's menu. */
const props = defineProps<{ collection: Collection; item: Item; readonly: boolean }>()
const planner = usePlanner()
const { mango, store } = planner

const rows = computed(() => props.collection.properties.map((p) => {
  const value = valueOf(props.item, p)
  const unsupported = p.type === 'unsupported' && props.item.values[p.id] !== undefined
  return {
    property: p,
    empty: value === null && !unsupported,
    fixed: props.readonly || isReadonly(p),
    url: p.type === 'url' && typeof value === 'string' ? safeUrl(value) : null,
  }
}))

const editing = shallowRef<{ propertyId: string; anchor: HTMLElement } | null>(null)
const editedProperty = computed(() => (editing.value ? propertyOf(props.collection, editing.value.propertyId) : null))
function edit(p: Property, e: Event) {
  if (props.readonly || isReadonly(p)) return
  if (p.type === 'checkbox') {
    store.updateItem(props.collection.id, props.item.id, { values: { [p.id]: valueOf(props.item, p) !== true } })
    return
  }
  editing.value = { propertyId: p.id, anchor: e.currentTarget as HTMLElement }
}
function onValueKey(p: Property, e: KeyboardEvent) {
  if (e.target !== e.currentTarget) return
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault()
    edit(p, e)
  } else if ((e.key === 'Delete' || e.key === 'Backspace') && !props.readonly && !isReadonly(p)) {
    e.preventDefault()
    store.updateItem(props.collection.id, props.item.id, { values: { [p.id]: null } })
  }
}

function menu(p: Property, at: HTMLElement | { x: number; y: number }) {
  if (!props.readonly) void propertyMenu(planner, props.collection, p, at)
}

const addAnchor = shallowRef<HTMLElement | null>(null)
const list = ref<HTMLElement | null>(null)
/** On to its value, if it has one to fill in. */
function onAdded(p: Property) {
  setTimeout(() => {
    list.value?.querySelector<HTMLElement>(`[data-value="${CSS.escape(p.id)}"]`)?.focus()
  })
}
</script>

<template>
  <div ref="list" class="pl-props" role="group" :aria-label="strings.properties">
    <div v-for="row in rows" :key="row.property.id" class="pl-props__row" @contextmenu.prevent="menu(row.property, { x: $event.clientX, y: $event.clientY })">
      <button
        type="button"
        class="pl-props__name"
        :title="row.property.name"
        :disabled="readonly"
        aria-haspopup="menu"
        @click="menu(row.property, $event.currentTarget as HTMLElement)"
      >
        <PropertyIcon :type="row.property.type" />
        <span>{{ row.property.name }}</span>
      </button>
      <div class="pl-props__cell">
        <!-- Not a button: a link in it is pressed on its own. -->
        <div
          class="pl-props__value"
          :class="{ 'is-fixed': row.fixed, 'is-open': editing?.propertyId === row.property.id }"
          :role="row.fixed ? undefined : row.property.type === 'checkbox' ? 'checkbox' : 'button'"
          :aria-checked="row.property.type === 'checkbox' ? valueOf(item, row.property) === true : undefined"
          :aria-label="row.fixed ? undefined : row.empty ? `${row.property.name}: ${strings.empty}` : row.property.type === 'checkbox' ? row.property.name : undefined"
          :aria-haspopup="row.fixed || row.property.type === 'checkbox' ? undefined : 'dialog'"
          :tabindex="row.fixed ? undefined : 0"
          :data-value="row.property.id"
          @click="edit(row.property, $event)"
          @keydown="onValueKey(row.property, $event)"
        >
          <span v-if="row.empty" class="pl-props__empty">{{ strings.empty }}</span>
          <ValueView v-else :property="row.property" :item="item" wrap />
        </div>
        <component
          :is="mango.ui.components.IconButton"
          v-if="row.url"
          size="sm"
          :label="strings.openLink"
          @click="mango.workspace.openBrowser(row.url)"
        ><Icon name="external-link" /></component>
      </div>
    </div>
    <button v-if="!readonly" type="button" class="pl-props__add" aria-haspopup="dialog" @click="addAnchor = $event.currentTarget as HTMLElement">
      <Icon name="plus" />{{ strings.addProperty }}
    </button>

    <ValuePopover
      v-if="editing && editedProperty"
      :key="editing.propertyId"
      :collection-id="collection.id"
      :property="editedProperty"
      :item-ids="[item.id]"
      :anchor="editing.anchor"
      @close="editing = null"
    />
    <AddProperty v-if="addAnchor" :collection-id="collection.id" :anchor="addAnchor" @close="addAnchor = null" @added="onAdded" />
  </div>
</template>

<style scoped>
.pl-props { display: grid; gap: 1px; }
.pl-props__row { display: grid; grid-template-columns: minmax(96px, 148px) minmax(0, 1fr); gap: var(--space-1); align-items: start; }
.pl-props__name, .pl-props__add {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
  height: 30px;
  padding: 0 var(--space-2);
  border-radius: var(--radius-sm);
  font-size: var(--text-sm);
  color: var(--fg-subtle);
  text-align: left;
  transition: background var(--dur-fast) var(--ease-out);
}
.pl-props__name span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pl-props__name:hover:not(:disabled), .pl-props__add:hover { background: var(--bg-hover); color: var(--fg); }
.pl-props__name:disabled { cursor: default; }
.pl-props__cell { display: flex; align-items: center; gap: var(--space-1); min-width: 0; }
.pl-props__value {
  flex: 1;
  display: flex;
  align-items: center;
  min-width: 0;
  min-height: 30px;
  padding: 4px var(--space-2);
  border-radius: var(--radius-sm);
  font-size: var(--text-sm);
  cursor: pointer;
  transition: background var(--dur-fast) var(--ease-out);
}
.pl-props__value.is-fixed { cursor: default; color: var(--fg-muted); }
.pl-props__value:hover:not(.is-fixed), .pl-props__value.is-open { background: var(--bg-hover); }
.pl-props__value:focus-visible { outline-offset: -2px; border-radius: var(--radius-sm); }
.pl-props__empty { color: var(--fg-faint); }
.pl-props__add { justify-self: start; }
</style>
