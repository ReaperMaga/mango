<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { usePlanner } from '../context.ts'
import { colorAt, valueOf, type Color, type Item, type Option, type Property, type Value } from '../model.ts'
import ColorPicker from '../ui/ColorPicker.vue'
import Icon from '../ui/Icon.vue'
import OptionTag from '../ui/OptionTag.vue'
import DeleteOption from './DeleteOption.vue'
import { strings } from './strings.ts'

/** Picks options by typing, makes new ones, and edits them (F2 or the dots). */
const props = defineProps<{
  collectionId: string
  property: Property
  items: readonly Item[]
  set: (next: Value | null | ((item: Item) => Value | null)) => void
}>()
const emit = defineEmits<{ done: [] }>()
const { store } = usePlanner()
const deleting = ref<HTMLElement | null>(null)

const multi = computed(() => props.property.type === 'multiSelect')
const query = ref('')
const active = ref(0)
const input = ref<HTMLInputElement | null>(null)
const list = ref<HTMLElement | null>(null)

const idsOf = (item: Item): readonly string[] => {
  const v = valueOf(item, props.property)
  return typeof v === 'string' ? [v] : Array.isArray(v) ? v as readonly string[] : []
}
/** Options every item has, and those only some have. */
const counts = computed(() => {
  const out = new Map<string, number>()
  for (const i of props.items) for (const id of idsOf(i)) out.set(id, (out.get(id) ?? 0) + 1)
  return out
})
const has = (o: Option) => props.items.length > 0 && counts.value.get(o.id) === props.items.length
const some = (o: Option) => !has(o) && counts.value.has(o.id)

const matches = computed(() => {
  const q = query.value.trim().toLowerCase()
  return q ? props.property.options.filter(o => o.name.toLowerCase().includes(q)) : props.property.options
})
const createName = computed(() => {
  const q = query.value.trim()
  return q && !props.property.options.some(o => o.name.trim().toLowerCase() === q.toLowerCase()) ? q : null
})
type Row = { key: string; option?: Option; create?: string }
const rows = computed<Row[]>(() => [
  ...matches.value.map(o => ({ key: o.id, option: o })),
  ...(createName.value ? [{ key: 'create', create: createName.value }] : []),
])
const canClear = computed(() => counts.value.size > 0)

// Opens on the value there is.
active.value = Math.max(0, props.property.options.findIndex(has))
void nextTick(reveal)
watch(query, () => { active.value = 0 })
watch(() => rows.value.length, n => { active.value = Math.max(0, Math.min(active.value, n - 1)) })

const rowId = (key: string) => `pl-opt-${props.property.id}-${key}`
function reveal() {
  list.value?.querySelector('.is-active')?.scrollIntoView({ block: 'nearest' })
}
function move(by: number) {
  const n = rows.value.length
  if (n) active.value = (active.value + by + n) % n
  void nextTick(reveal)
}

function pick(row: Row | undefined) {
  if (!row) return
  const option = row.option ?? store.addOption(props.collectionId, props.property.id, row.create ?? '', colorAt(props.property.options.length))
  if (!option) return
  if (multi.value) {
    const remove = has(option)
    props.set((item) => {
      const ids = idsOf(item)
      const next = remove ? ids.filter(id => id !== option.id) : ids.includes(option.id) ? ids : [...ids, option.id]
      return next.length ? [...next] : null
    })
    query.value = ''
    input.value?.focus()
  } else {
    if (props.items.length) {
      props.set(option.id)
      emit('done')
    }
    query.value = ''
  }
}
function clear() {
  props.set(null)
  if (multi.value) input.value?.focus()
  else emit('done')
}

function onKey(e: KeyboardEvent) {
  if (e.isComposing) return
  const row = rows.value[active.value]
  if (e.key === 'ArrowDown') move(1)
  else if (e.key === 'ArrowUp') move(-1)
  else if (e.key === 'Enter') pick(row)
  else if (e.key === 'F2') { if (row?.option) startEdit(row.option) }
  else if (e.key === 'Backspace' && !query.value && multi.value && props.items.length === 1) {
    const last = idsOf(props.items[0]!).at(-1)
    if (!last) return
    props.set((item) => {
      const next = idsOf(item).filter(id => id !== last)
      return next.length ? next : null
    })
  } else return
  e.preventDefault()
}

/* ---------- one option */

const editing = ref<string | null>(null)
const edited = computed(() => props.property.options.find(o => o.id === editing.value) ?? null)
const editIndex = computed(() => props.property.options.findIndex(o => o.id === editing.value))
const nameInput = ref<HTMLInputElement | null>(null)
async function startEdit(o: Option) {
  editing.value = o.id
  await nextTick()
  nameInput.value?.select()
}
async function stopEdit() {
  const id = editing.value
  tidyName()
  editing.value = null
  await nextTick()
  const at = rows.value.findIndex(r => r.option?.id === id)
  if (at >= 0) active.value = at
  input.value?.focus()
}
watch(edited, (o) => { if (!o && editing.value) void stopEdit() })
/** Spaces are kept while typing. */
function tidyName() {
  const o = edited.value
  if (o && o.name !== o.name.trim()) store.updateOption(props.collectionId, props.property.id, o.id, { name: o.name.trim() }, { defer: true })
}
onBeforeUnmount(() => {
  tidyName()
  void store.flush()
})
function rename(e: Event) {
  const name = (e.target as HTMLInputElement).value
  if (edited.value && name.trim()) store.updateOption(props.collectionId, props.property.id, edited.value.id, { name }, { defer: true })
}
function moveOption(by: number) {
  const o = edited.value
  const other = props.property.options[editIndex.value + by]
  if (o && other) store.moveOption(props.collectionId, props.property.id, o.id, by < 0 ? { before: other.id } : { after: other.id })
}
function recolor(color: Color) {
  if (edited.value) store.updateOption(props.collectionId, props.property.id, edited.value.id, { color }, { defer: true })
}
</script>

<template>
  <div v-if="edited" class="pl-oe">
    <div class="pl-oe__head">
      <button type="button" class="pl-oe__icon" :aria-label="strings.back" :title="strings.back" @click="stopEdit"><Icon name="arrow-left" /></button>
      <input
        ref="nameInput"
        class="pl-oe__input"
        data-autofocus
        :value="edited.name"
        :aria-label="strings.optionName"
        spellcheck="false"
        @input="rename"
        @keydown.enter.prevent="stopEdit"
      >
    </div>
    <div class="pl-oe__colors">
      <ColorPicker :model-value="edited.color" :label="strings.color" @update:model-value="recolor" @change="store.flush()" />
    </div>
    <div class="pl-oe__rows is-plain">
      <button type="button" class="pl-oe__row" :disabled="editIndex <= 0" @click="moveOption(-1)"><Icon name="arrow-up" />{{ strings.moveUp }}</button>
      <button type="button" class="pl-oe__row" :disabled="editIndex >= property.options.length - 1" @click="moveOption(1)"><Icon name="arrow-down" />{{ strings.moveDown }}</button>
      <button type="button" class="pl-oe__row is-danger" @click="deleting = $event.currentTarget as HTMLElement"><Icon name="trash-2" />{{ strings.deleteOption }}</button>
    </div>
    <DeleteOption
      v-if="deleting"
      :collection-id="collectionId"
      :property-id="property.id"
      :option-id="edited.id"
      :anchor="deleting"
      @close="deleting = null"
    />
  </div>

  <div v-else class="pl-oe">
    <div class="pl-oe__head">
      <input
        ref="input"
        v-model="query"
        class="pl-oe__input"
        data-autofocus
        role="combobox"
        aria-expanded="true"
        aria-autocomplete="list"
        :aria-controls="rowId('list')"
        :aria-activedescendant="rows[active] ? rowId(rows[active]!.key) : undefined"
        :aria-label="property.name"
        :placeholder="strings.findOption"
        spellcheck="false"
        autocomplete="off"
        @keydown="onKey"
      >
    </div>
    <div :id="rowId('list')" ref="list" class="pl-oe__rows" role="listbox" :aria-label="property.name" :aria-multiselectable="multi || undefined">
      <div
        v-for="(row, i) in rows"
        :id="rowId(row.key)"
        :key="row.key"
        class="pl-oe__row"
        :class="{ 'is-active': i === active }"
        role="option"
        :aria-selected="row.option ? has(row.option) : false"
        @pointermove="active = i"
        @click="pick(row)"
      >
        <template v-if="row.option">
          <span class="pl-oe__tag"><OptionTag :option="row.option" /></span>
          <Icon v-if="has(row.option)" name="check" class="pl-oe__check" />
          <Icon v-else-if="some(row.option)" name="minus" class="pl-oe__check is-some" />
          <button
            type="button"
            class="pl-oe__icon pl-oe__dots"
            tabindex="-1"
            :aria-label="strings.editOption(row.option.name)"
            :title="`${strings.editOption(row.option.name)} (F2)`"
            @click.stop="startEdit(row.option)"
          ><Icon name="ellipsis" /></button>
        </template>
        <template v-else>
          <Icon name="plus" class="pl-oe__plus" />
          <span class="pl-oe__new">{{ strings.create(row.create ?? '') }}</span>
        </template>
      </div>
      <p v-if="!rows.length" class="pl-oe__note">{{ strings.noOptions }}</p>
    </div>
    <div v-if="canClear" class="pl-oe__foot">
      <button type="button" class="pl-oe__row" @click="clear"><Icon name="x" />{{ strings.clear }}</button>
    </div>
  </div>
</template>

<style scoped>
.pl-oe__head { position: sticky; top: 0; z-index: 1; display: flex; align-items: center; gap: var(--space-1); padding: var(--space-1); background: var(--bg-raised); border-bottom: 1px solid var(--line-soft); }
.pl-oe__input { flex: 1; min-width: 0; height: 28px; padding: 0 var(--space-2); border: 0; background: none; font-size: var(--text-sm); }
.pl-oe__input:focus-visible { outline: none; }
.pl-oe__input::placeholder { color: var(--fg-faint); }
.pl-oe__rows { padding: var(--space-1); }
.pl-oe__row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  min-height: 30px;
  padding: 0 var(--space-1) 0 var(--space-2);
  border-radius: var(--radius-sm);
  text-align: left;
  font-size: var(--text-sm);
  cursor: pointer;
}
.pl-oe__row.is-active, button.pl-oe__row:hover:not(:disabled) { background: var(--bg-hover); }
button.pl-oe__row { color: var(--fg); }
button.pl-oe__row > svg { color: var(--fg-subtle); }
button.pl-oe__row:disabled { color: var(--fg-faint); }
.pl-oe__row.is-danger, .pl-oe__row.is-danger > svg { color: var(--ripe-error-fg) !important; }
.pl-oe__tag { flex: 1; min-width: 0; display: flex; }
.pl-oe__check { width: 14px; height: 14px; color: var(--accent-ink); }
.pl-oe__check.is-some { color: var(--fg-subtle); }
.pl-oe__icon { display: grid; place-items: center; width: 24px; height: 24px; flex: none; border-radius: var(--radius-xs); color: var(--fg-subtle); }
.pl-oe__icon:hover { background: var(--bg-active); color: var(--fg); }
.pl-oe__dots { visibility: hidden; }
.pl-oe__row:hover .pl-oe__dots, .pl-oe__row.is-active .pl-oe__dots { visibility: visible; }
.pl-oe__plus { color: var(--fg-subtle); }
.pl-oe__new { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pl-oe__note { margin: 0; padding: var(--space-2); color: var(--fg-subtle); font-size: var(--text-xs); }
.pl-oe__foot { padding: var(--space-1); border-top: 1px solid var(--line-soft); }
.pl-oe__colors { border-bottom: 1px solid var(--line-soft); }
</style>
