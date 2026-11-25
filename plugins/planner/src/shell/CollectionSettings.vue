<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import { usePlanner } from '../context.ts'
import { hasOptions, propertyOf, type Property } from '../model.ts'
import { strings as shared } from '../strings.ts'
import ColorButton from '../ui/ColorButton.vue'
import { colorVar } from '../ui/colors.ts'
import Icon from '../ui/Icon.vue'
import Popover from '../ui/Popover.vue'
import PropertyIcon from '../ui/PropertyIcon.vue'
import AddProperty from '../values/AddProperty.vue'
import { optionWords } from '../values/optionWords.ts'
import PropertyEditor from '../values/PropertyEditor.vue'
import CollectionIcon from './CollectionIcon.vue'
import IconPicker from './IconPicker.vue'
import { scopeOf } from './repository.ts'
import { dropClass, stepPosition, useReorder } from './reorder.ts'
import ScopeChoice from './ScopeChoice.vue'
import { shell } from './strings.ts'

/**
 * Everything about a collection, in a dialog: every change is kept at once. A property is edited in here, as Mango
 * shows one dialog at a time. `groupBy`: the property of the board at hand.
 */
const props = defineProps<{ collectionId: string; groupBy?: string | null; startAt?: string | null }>()
const emit = defineEmits<{ done: []; remove: [] }>()
const planner = usePlanner()
const { store, mango } = planner
const { Button, Field, IconButton } = mango.ui.components

const collection = computed(() => store.collection(props.collectionId))
watch(collection, (c) => { if (!c) emit('done') })
const readonly = computed(() => store.sourceStatus.value.readonly)
onBeforeUnmount(() => { void store.flush() })

const name = ref(collection.value?.name ?? '')
const description = ref(collection.value?.description ?? '')
const one = ref(collection.value?.itemName?.one ?? '')
const many = ref(collection.value?.itemName?.many ?? '')
function read(e: Event) {
  return (e.target as HTMLInputElement).value
}
function setName() {
  if (name.value.trim()) store.updateCollection(props.collectionId, { name: name.value.trim() }, { defer: true })
}
function restoreName() {
  if (!name.value.trim()) name.value = collection.value?.name ?? ''
}
function setDescription() {
  store.updateCollection(props.collectionId, { description: description.value.trim() }, { defer: true })
}
function setWords() {
  const [a, b] = [one.value.trim(), many.value.trim()]
  store.updateCollection(props.collectionId, { itemName: a || b ? { one: a || b, many: b || a } : null }, { defer: true })
}
const where = computed<'project' | 'everywhere'>({
  get: () => (collection.value?.scope.kind === 'project' ? 'project' : 'everywhere'),
  set(to) {
    if (to !== where.value) store.updateCollection(props.collectionId, { scope: scopeOf(planner, to) })
  },
})
const iconAt = shallowRef<HTMLElement | null>(null)

/* ---------- properties */

const root = ref<HTMLElement | null>(null)
const box = ref<HTMLElement | null>(null)
const addAt = shallowRef<HTMLElement | null>(null)
const editing = ref<string | null>(props.startAt ?? null)
const properties = computed(() => collection.value?.properties ?? [])
const status = computed(() => {
  const c = collection.value
  const p = c && props.groupBy ? propertyOf(c, props.groupBy) : null
  return p && hasOptions(p) ? p : null
})

const reorder = useReorder({
  axis: 'y',
  container: () => box.value,
  hold: () => mango.ui.holdOverlay(),
  onDrop: (id, position) => store.moveProperty(props.collectionId, id, position),
  disabled: () => readonly.value,
})
function step(e: KeyboardEvent, id: string) {
  if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return
  e.preventDefault()
  const position = stepPosition(properties.value.map(p => p.id), id, e.key === 'ArrowUp' ? -1 : 1)
  if (position) store.moveProperty(props.collectionId, id, position)
}
function added(p: Property) {
  if (hasOptions(p)) edit(p.id)
}
function edit(id: string) {
  editing.value = id
  void nextTick(() => root.value?.querySelector<HTMLElement>('.pl-set__back')?.focus())
}
function back() {
  const id = editing.value
  editing.value = null
  void nextTick(() => {
    const el = id ? root.value?.querySelector<HTMLElement>(`[data-rid="${CSS.escape(id)}"] .pl-set__edit`) : null
    el?.focus()
  })
}
/** Backs out of the property, not of the dialog. */
function onKey(e: KeyboardEvent) {
  if (e.key !== 'Escape' || !editing.value || e.defaultPrevented) return
  e.preventDefault()
  e.stopPropagation()
  back()
}
</script>

<template>
  <div v-if="collection" ref="root" :data-own-escape="editing ? '' : undefined" @keydown="onKey">
    <template v-if="editing">
      <button type="button" class="pl-small pl-set__back" @click="back"><Icon name="arrow-left" />{{ shell.backTo(collection.name || shell.unnamed) }}</button>
      <PropertyEditor :key="editing" :collection-id="collectionId" :property-id="editing" @gone="back" />
    </template>

    <div v-else class="pl-set">
      <div class="pl-set__name">
        <button type="button" class="pl-set__icon" :disabled="readonly" :aria-label="shell.icon" :title="shell.icon" aria-haspopup="dialog" :aria-expanded="!!iconAt" @click="iconAt = $event.currentTarget as HTMLElement">
          <CollectionIcon :collection="collection" />
        </button>
        <input :value="name" type="text" class="pl-input" :readonly="readonly" :aria-label="shell.name" autocomplete="off" spellcheck="false" @input="name = read($event); setName()" @blur="restoreName">
        <ColorButton
          :model-value="collection.color"
          :label="shell.colour"
          :disabled="readonly"
          @update:model-value="color => store.updateCollection(collectionId, { color }, { defer: 'hold' })"
          @change="store.flush()"
        />
      </div>
      <component :is="Field" :label="shell.description" for="pl-set-desc">
        <input id="pl-set-desc" :value="description" class="pl-input" type="text" :readonly="readonly" autocomplete="off" @input="description = read($event); setDescription()">
      </component>
      <div class="pl-set__pair">
        <component :is="Field" :label="shell.itemOne" for="pl-set-one">
          <input id="pl-set-one" :value="one" class="pl-input" type="text" :readonly="readonly" :placeholder="shared.item" autocomplete="off" spellcheck="false" @input="one = read($event); setWords()">
        </component>
        <component :is="Field" :label="shell.itemMany" for="pl-set-many">
          <input id="pl-set-many" :value="many" class="pl-input" type="text" :readonly="readonly" :placeholder="shared.items" autocomplete="off" spellcheck="false" @input="many = read($event); setWords()">
        </component>
      </div>
      <div v-if="store.projectPath.value && !readonly" class="pl-set__line">
        <span class="pl-set__label">{{ shell.scope }}</span>
        <ScopeChoice v-model="where" />
      </div>

      <section v-if="status" class="pl-set__part">
        <div class="pl-set__line">
          <h3 class="pl-set__label">{{ shell.heading(optionWords(status).many) }}</h3>
          <button type="button" class="pl-small" :disabled="readonly" @click="edit(status.id)"><Icon name="pencil" />{{ shell.editOptions }}</button>
        </div>
        <p class="pl-set__options">
          <span v-for="o in status.options" :key="o.id" class="pl-set__option" :style="{ color: colorVar(o.color).fg }"><i :style="{ background: colorVar(o.color).dot }" />{{ o.name }}</span>
        </p>
      </section>

      <section class="pl-set__part">
        <div class="pl-set__line">
          <h3 class="pl-set__label">{{ shell.properties }}</h3>
          <button v-if="!readonly" type="button" class="pl-small" aria-haspopup="dialog" @click="addAt = $event.currentTarget as HTMLElement"><Icon name="plus" />{{ shell.addProperty }}</button>
        </div>
        <p v-if="!properties.length" class="pl-panel__note pl-set__none">{{ shell.noProperties }}</p>
        <div ref="box">
          <div
            v-for="(p, i) in properties"
            :key="p.id"
            class="pl-panel__row is-hoverable"
            :class="dropClass(reorder, p.id, i === properties.length - 1)"
            :data-rid="p.id"
            @keydown="step($event, p.id)"
          >
            <span v-if="!readonly" class="pl-panel__grip" :title="shell.reorder(p.name)" @pointerdown="reorder.start($event, p.id)"><Icon name="grip-vertical" /></span>
            <button type="button" class="pl-set__edit" :title="shell.editProperty(p.name)" @click="edit(p.id)">
              <PropertyIcon :type="p.type" />
              <span class="pl-panel__label">{{ p.name || shell.unnamed }}</span>
              <span class="pl-set__type">{{ shared.propertyTypes[p.type] }}</span>
            </button>
            <!-- No question first: it can be undone, and a second dialog would wait behind this one. -->
            <component :is="IconButton" v-if="!readonly" size="sm" :label="shell.deleteProperty(p.name)" @click="store.deleteProperty(collectionId, p.id)"><Icon name="trash-2" /></component>
          </div>
        </div>
      </section>

      <footer class="pl-set__foot">
        <component :is="Button" v-if="!readonly" variant="danger" @click="emit('remove')">{{ shell.deleteCollection }}</component>
        <component :is="Button" variant="primary" class="pl-set__done" @click="emit('done')">{{ shell.done }}</component>
      </footer>
    </div>

    <Popover v-if="iconAt" :anchor="iconAt" :width="288" :label="shell.icon" @close="iconAt = null">
      <IconPicker :icon="collection.icon" @icon="icon => store.updateCollection(collectionId, { icon })" />
    </Popover>
    <AddProperty v-if="addAt" :collection-id="collectionId" :anchor="addAt" @close="addAt = null" @added="added" />
  </div>
</template>

<style scoped>
.pl-set { display: grid; gap: var(--space-4); padding-top: var(--space-1); }
.pl-set :deep(.field + .field) { margin-top: 0; }
.pl-set__name { display: flex; align-items: center; gap: var(--space-2); }
.pl-set__name .pl-input { height: 34px; font-size: var(--text-md); font-weight: 560; }
.pl-set__icon { flex: none; display: grid; place-items: center; width: 34px; height: 34px; border: 1px solid var(--line); border-radius: var(--radius-sm); }
.pl-set__icon:hover:not(:disabled) { background: var(--bg-hover); border-color: var(--line-strong); }
.pl-set__pair { display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-3); }
.pl-set__line { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); min-height: 24px; }
.pl-set__label { margin: 0; font-size: var(--text-xs); font-weight: 560; color: var(--fg-muted); }
.pl-set__part { display: grid; gap: var(--space-1); }
.pl-set__options { display: flex; flex-wrap: wrap; gap: 4px var(--space-4); margin: 0; font-size: var(--text-sm); font-weight: 560; }
.pl-set__option { display: inline-flex; align-items: center; gap: 6px; min-width: 0; overflow-wrap: anywhere; }
.pl-set__option i { flex: none; width: 8px; height: 8px; border-radius: 50%; }
.pl-set__none { padding-left: 0; }
.pl-set__edit { flex: 1; min-width: 0; display: flex; align-items: center; gap: var(--space-2); height: 28px; padding: 0 var(--space-1); text-align: left; border-radius: var(--radius-xs); }
.pl-set__edit > svg { flex: none; width: 15px; height: 15px; stroke-width: 1.75; color: var(--fg-subtle); }
.pl-set__type { flex: none; font-size: var(--text-xs); color: var(--fg-subtle); }
.pl-set__back { margin: 0 0 var(--space-2) -6px; }
.pl-set__foot { display: flex; align-items: center; gap: var(--space-2); padding-top: var(--space-1); }
.pl-set__done { margin-left: auto; }
</style>
