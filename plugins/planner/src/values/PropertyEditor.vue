<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import { usePlanner } from '../context.ts'
import { colorAt, hasOptions, itemWord, PROPERTY_TYPES, propertyOf, type Color, type Option, type PropertyType } from '../model.ts'
import { strings as shared } from '../strings.ts'
import ColorButton from '../ui/ColorButton.vue'
import Icon from '../ui/Icon.vue'
import PickPopover, { type PickRow } from '../ui/PickPopover.vue'
import { PROPERTY_ICONS } from '../ui/propertyIcons.ts'
import PropertyIcon from '../ui/PropertyIcon.vue'
import { colorVar } from '../ui/colors.ts'
import DeleteOption from './DeleteOption.vue'
import { optionWords } from './optionWords.ts'
import { strings } from './strings.ts'
import { useOptionCounts } from './useOptionCounts.ts'

/** A property: name, type and, for a select, its options. Every change is kept at once. `gone`: it was deleted. */
const props = defineProps<{ collectionId: string; propertyId: string }>()
const emit = defineEmits<{ gone: [] }>()
const { mango, store } = usePlanner()
const { IconButton } = mango.ui.components

const collection = computed(() => store.collection(props.collectionId))
const property = computed(() => (collection.value && propertyOf(collection.value, props.propertyId)) ?? null)
const readonly = computed(() => store.sourceStatus.value.readonly)
const words = computed(() => optionWords(property.value ?? { name: '' }))
const counts = useOptionCounts(() => props.collectionId, () => props.propertyId)
watch(property, (p) => { if (!p) emit('gone') })
onBeforeUnmount(() => { void store.flush() })

function rename(e: Event) {
  const name = (e.target as HTMLInputElement).value
  if (name.trim()) store.renameProperty(props.collectionId, props.propertyId, name, { defer: true })
}
/** Without spaces around it; an emptied name is taken back. */
function settleName(e: Event, name: string, set: (trimmed: string) => void) {
  const trimmed = name.trim()
  if (trimmed !== name) set(trimmed)
  ;(e.target as HTMLInputElement).value = trimmed
  void store.flush()
}

/* ---------- type and default */

const typeAt = shallowRef<HTMLElement | null>(null)
const typeRows = computed<PickRow[]>(() => PROPERTY_TYPES.map(t => ({ id: t, label: shared.propertyTypes[t], icon: PROPERTY_ICONS[t], checked: t === property.value?.type })))

const defaultAt = shallowRef<HTMLElement | null>(null)
const NONE = '-'
const defaultOption = computed(() => property.value?.options.find(o => o.id === property.value?.defaultOption) ?? null)
const defaultRows = computed<PickRow[]>(() => [
  { id: NONE, label: strings.nothing, color: 'neutral', checked: !defaultOption.value },
  ...(property.value?.options ?? []).map(o => ({ id: o.id, label: o.name, color: o.color, checked: o.id === defaultOption.value?.id })),
])

/* ---------- options */

const list = ref<HTMLElement | null>(null)
const deleting = shallowRef<{ id: string; anchor: HTMLElement } | null>(null)

function setOption(o: Option, change: { name?: string; color?: Color }) {
  store.updateOption(props.collectionId, props.propertyId, o.id, change, { defer: true })
}
function renameOption(o: Option, e: Event) {
  const name = (e.target as HTMLInputElement).value
  if (name.trim()) setOption(o, { name })
}
async function add() {
  const p = property.value
  if (!p) return
  const taken = new Set(p.options.map(o => o.name.trim().toLowerCase()))
  const base = strings.newOption(words.value.one)
  let name = base
  for (let i = 2; taken.has(name.toLowerCase()); i++) name = `${base} ${i}`
  const made = store.addOption(props.collectionId, props.propertyId, name, colorAt(p.options.length))
  if (!made) return
  await nextTick()
  const el = list.value?.querySelector<HTMLInputElement>(`[data-option="${CSS.escape(made.id)}"] input`)
  el?.scrollIntoView({ block: 'nearest' })
  el?.select()
}
function afterDelete(at: number) {
  void nextTick(() => {
    const inputs = list.value?.querySelectorAll<HTMLElement>('.pl-pe__opt input')
    inputs?.[Math.min(at, inputs.length - 1)]?.focus()
  })
}

/* ---------- order: by dragging the handle, or its arrow keys */

const drag = ref<{ id: string; ids: string[] } | null>(null)
const options = computed<Option[]>(() => {
  const all = property.value?.options ?? []
  const d = drag.value
  if (!d) return [...all]
  return d.ids.flatMap(id => all.find(o => o.id === id) ?? [])
})
let stop: (() => void) | null = null
function startDrag(o: Option, e: PointerEvent) {
  if (e.button !== 0 || readonly.value) return
  e.preventDefault()
  const handle = e.currentTarget as HTMLElement
  handle.focus()
  const hold = mango.ui.holdOverlay()
  drag.value = { id: o.id, ids: options.value.map(x => x.id) }
  const move = (m: PointerEvent) => {
    const d = drag.value
    const rows = [...(list.value?.querySelectorAll<HTMLElement>('.pl-pe__opt') ?? [])]
    if (!d || !rows.length) return
    let to = rows.findIndex((r) => {
      const b = r.getBoundingClientRect()
      return m.clientY < b.bottom
    })
    if (to < 0) to = rows.length - 1
    const from = d.ids.indexOf(d.id)
    if (to === from) return
    const ids = d.ids.filter(id => id !== d.id)
    ids.splice(to, 0, d.id)
    drag.value = { id: d.id, ids }
    void nextTick(() => list.value?.querySelector<HTMLElement>(`[data-option="${CSS.escape(d.id)}"] .pl-pe__handle`)?.focus())
  }
  const end = (keep: boolean) => {
    stop?.()
    const d = drag.value
    drag.value = null
    if (keep && d) moveTo(d.id, d.ids.indexOf(d.id))
  }
  const up = () => end(true)
  const cancel = () => end(false)
  const key = (k: KeyboardEvent) => {
    if (k.key !== 'Escape') return
    k.preventDefault()
    k.stopImmediatePropagation()
    end(false)
  }
  // Before Mango's dialog, which listens on the window: it leaves Escape to what says so.
  handle.setAttribute('data-own-escape', '')
  stop = () => {
    stop = null
    hold.dispose()
    handle.removeAttribute('data-own-escape')
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
    window.removeEventListener('pointercancel', cancel)
    window.removeEventListener('keydown', key, true)
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
  window.addEventListener('pointercancel', cancel)
  window.addEventListener('keydown', key, true)
}
onBeforeUnmount(() => stop?.())

function moveTo(id: string, to: number) {
  const all = property.value?.options ?? []
  const from = all.findIndex(o => o.id === id)
  const other = all[to]
  if (from < 0 || !other || from === to) return
  store.moveOption(props.collectionId, props.propertyId, id, to < from ? { before: other.id } : { after: other.id })
}
function onHandleKey(o: Option, i: number, e: KeyboardEvent) {
  const to = ({ ArrowUp: i - 1, ArrowDown: i + 1, Home: 0, End: options.value.length - 1 } as Record<string, number>)[e.key]
  if (to === undefined || drag.value) return
  e.preventDefault()
  const handle = e.currentTarget as HTMLElement
  moveTo(o.id, Math.max(0, Math.min(options.value.length - 1, to)))
  void nextTick(() => handle.focus())
}
</script>

<template>
  <p v-if="!property" class="pl-pe__gone">{{ strings.gone }}</p>
  <div v-else class="pl-pe">
    <div class="pl-pe__top">
      <label class="pl-pe__field">
        <span class="pl-pe__label">{{ strings.name }}</span>
        <input
          class="pl-pe__input"
          :value="property.name"
          :readonly="readonly"
          spellcheck="false"
          autocomplete="off"
          @input="rename"
          @blur="settleName($event, property.name, name => store.renameProperty(collectionId, propertyId, name, { defer: true }))"
        >
      </label>
      <div class="pl-pe__field">
        <span class="pl-pe__label">{{ strings.type }}</span>
        <button type="button" class="pl-pe__pick" aria-haspopup="listbox" :disabled="readonly || property.type === 'unsupported'" @click="typeAt = $event.currentTarget as HTMLElement">
          <PropertyIcon :type="property.type" /><span>{{ shared.propertyTypes[property.type] }}</span><Icon name="chevron-down" />
        </button>
      </div>
    </div>

    <template v-if="hasOptions(property)">
      <div ref="list" class="pl-pe__list" role="list" :aria-label="words.many">
        <div v-for="(o, i) in options" :key="o.id" class="pl-pe__opt" :class="{ 'is-drag': drag?.id === o.id }" role="listitem" :data-option="o.id">
          <button
            type="button"
            class="pl-pe__handle"
            :aria-label="strings.reorder(o.name)"
            :title="strings.reorder(o.name)"
            :disabled="readonly"
            @pointerdown="startDrag(o, $event)"
            @keydown="onHandleKey(o, i, $event)"
          ><Icon name="grip-vertical" /></button>
          <ColorButton :model-value="o.color" :label="strings.colorOf(o.name)" :disabled="readonly" @update:model-value="setOption(o, { color: $event })" @change="store.flush()" />
          <input
            class="pl-pe__name"
            :value="o.name"
            :style="{ color: colorVar(o.color).fg }"
            :readonly="readonly"
            :aria-label="strings.optionName"
            spellcheck="false"
            autocomplete="off"
            @input="renameOption(o, $event)"
            @blur="settleName($event, o.name, name => setOption(o, { name }))"
            @keydown.enter.prevent="add"
          >
          <span v-if="counts" class="pl-pe__count" :title="strings.inUse(counts.get(o.id) ?? 0, itemWord(collection, counts.get(o.id) ?? 0))">{{ counts.get(o.id) ?? 0 }}</span>
          <component
            :is="IconButton"
            v-if="!readonly"
            size="sm"
            :label="strings.deleteNamed(o.name)"
            @click="deleting = { id: o.id, anchor: $event.currentTarget as HTMLElement }"
          ><Icon name="trash-2" /></component>
        </div>
        <button v-if="!readonly" type="button" class="pl-pe__add" @click="add"><Icon name="plus" />{{ strings.addOption(words.one) }}</button>
      </div>

      <div v-if="property.type === 'select'" class="pl-pe__default">
        <span class="pl-pe__label">{{ strings.defaultOption(itemWord(collection, 2)) }}</span>
        <button type="button" class="pl-pe__pick" aria-haspopup="listbox" :disabled="readonly" @click="defaultAt = $event.currentTarget as HTMLElement">
          <i v-if="defaultOption" class="pl-pe__dot" :style="{ background: colorVar(defaultOption.color).dot }" />
          <span>{{ defaultOption?.name ?? strings.nothing }}</span><Icon name="chevron-down" />
        </button>
      </div>
    </template>

    <PickPopover
      v-if="typeAt"
      :rows="typeRows"
      :anchor="typeAt"
      :label="strings.type"
      @close="typeAt = null"
      @pick="store.setPropertyType(collectionId, propertyId, $event as PropertyType)"
    />
    <PickPopover
      v-if="defaultAt"
      :rows="defaultRows"
      :anchor="defaultAt"
      :label="strings.defaultOption(itemWord(collection, 2))"
      @close="defaultAt = null"
      @pick="store.updateProperty(collectionId, propertyId, { defaultOption: $event === NONE ? null : $event })"
    />
    <DeleteOption
      v-if="deleting"
      :key="deleting.id"
      :collection-id="collectionId"
      :property-id="propertyId"
      :option-id="deleting.id"
      :anchor="deleting.anchor"
      @close="deleting = null"
      @deleted="afterDelete(0)"
    />
  </div>
</template>

<style scoped>
.pl-pe { display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--space-4); }
.pl-pe__gone { margin: 0; color: var(--fg-subtle); }
.pl-pe__top { display: grid; grid-template-columns: minmax(0, 1fr) 160px; gap: var(--space-3); }
.pl-pe__field { display: grid; grid-template-columns: minmax(0, 1fr); gap: 6px; }
.pl-pe__label { font-size: var(--text-xs); font-weight: 560; color: var(--fg-muted); }
.pl-pe__input, .pl-pe__pick { height: 32px; width: 100%; padding: 0 var(--space-3); background: var(--bg-inset); border: 1px solid var(--line); border-radius: var(--radius-sm); font-size: var(--text-sm); }
.pl-pe__input:focus-visible { outline: none; border-color: var(--accent-line); box-shadow: 0 0 0 3px var(--accent-soft); border-radius: var(--radius-sm); }
.pl-pe__pick { display: flex; align-items: center; gap: var(--space-2); background: var(--bg-panel); text-align: left; }
.pl-pe__pick:hover:not(:disabled) { border-color: var(--line-strong); }
.pl-pe__pick span { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pl-pe__pick svg { color: var(--fg-subtle); }
.pl-pe__dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
.pl-pe__list { display: grid; grid-template-columns: minmax(0, 1fr); gap: 1px; }
.pl-pe__opt { display: flex; align-items: center; gap: 2px; min-height: 32px; border-radius: var(--radius-sm); }
.pl-pe__opt:hover, .pl-pe__opt:focus-within { background: var(--bg-hover); }
.pl-pe__opt.is-drag { background: var(--bg-active); }
.pl-pe__handle { display: grid; place-items: center; width: 22px; height: 28px; flex: none; border-radius: var(--radius-xs); color: var(--fg-faint); cursor: grab; touch-action: none; }
.pl-pe__handle:hover:not(:disabled) { color: var(--fg); }
.is-drag .pl-pe__handle { cursor: grabbing; }
.pl-pe__name { flex: 1; min-width: 0; height: 28px; padding: 0 var(--space-1); border: 0; background: none; font-size: var(--text-sm); font-weight: 560; }
.pl-pe__name:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: -2px; border-radius: var(--radius-xs); }
.pl-pe__count { padding: 0 var(--space-2); font-size: var(--text-xs); color: var(--fg-subtle); font-variant-numeric: tabular-nums; }
.pl-pe__opt :deep(.icon-btn) { margin-right: var(--space-1); }
.pl-pe__add { display: flex; align-items: center; gap: var(--space-2); height: 32px; padding: 0 var(--space-2) 0 5px; border-radius: var(--radius-sm); font-size: var(--text-sm); color: var(--fg-subtle); text-align: left; }
.pl-pe__add:hover { background: var(--bg-hover); color: var(--fg); }
.pl-pe__default { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 220px); align-items: center; gap: var(--space-3); padding-top: var(--space-3); border-top: 1px solid var(--line-soft); }
</style>
