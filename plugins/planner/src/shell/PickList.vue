<script lang="ts">
export interface PickRow {
  id: string
  label: string
  /** A small heading before the first row of a group. */
  group?: string
  checked?: boolean
  /** Muted, at the end. */
  aside?: string
  /** Stays while searching: an action under the list. */
  always?: boolean
}
let count = 0
</script>

<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import Icon from '../ui/Icon.vue'
import { dropClass, type Reorder } from './reorder.ts'
import { shell } from './strings.ts'

/** A list to choose from with the keyboard: a search field over rows; arrows, Home, End and Enter act on the list. */
const props = withDefaults(defineProps<{
  rows: readonly PickRow[]
  label: string
  placeholder?: string
  /** Choosing toggles a row; the list stays. */
  multi?: boolean
  /** False: no search field; the list itself has the focus. */
  search?: boolean
  /** Rows can be dragged to another place, or moved with Alt+arrows. */
  reorder?: Reorder | null
  maxHeight?: number
  /** Takes the focus when it shows. */
  autofocus?: boolean
}>(), { search: true, maxHeight: 320, autofocus: true, reorder: null })
const emit = defineEmits<{ pick: [id: string]; move: [id: string, by: -1 | 1]; menu: [id: string, at: { x: number; y: number }] }>()

const uid = `pl-pick-${++count}`
const query = ref('')
const active = ref(0)
const input = ref<HTMLInputElement | null>(null)
const list = ref<HTMLElement | null>(null)

const shown = computed(() => {
  const words = query.value.toLowerCase().split(/\s+/).filter(Boolean)
  return props.rows.filter(r => r.always || words.every(w => r.label.toLowerCase().includes(w)))
})
const own = computed(() => shown.value.filter(r => !r.always))
const none = computed(() => query.value.trim() !== '' && !own.value.length)

watch(query, () => { active.value = 0 })
watch(() => shown.value.length, (n) => { active.value = Math.max(0, Math.min(active.value, n - 1)) })

const heading = (i: number) => {
  const g = shown.value[i]?.group
  return g && g !== shown.value[i - 1]?.group ? g : null
}
const divided = (i: number) => !!shown.value[i]?.always && i > 0 && !shown.value[i - 1]!.always
const classes = (r: PickRow) => (props.reorder && !r.always ? dropClass(props.reorder, r.id, r.id === own.value.at(-1)?.id) : {})

function reveal() {
  void nextTick(() => list.value?.querySelector('.is-active')?.scrollIntoView({ block: 'nearest' }))
}
function step(by: number) {
  const n = shown.value.length
  if (n) active.value = (active.value + by + n) % n
  reveal()
}
function moveRow(by: -1 | 1) {
  const row = shown.value[active.value]
  if (!row || row.always || query.value) return
  emit('move', row.id, by)
  void nextTick(() => {
    const at = shown.value.findIndex(r => r.id === row.id)
    if (at >= 0) active.value = at
    reveal()
  })
}
function onKey(e: KeyboardEvent) {
  if (e.isComposing || e.ctrlKey || e.metaKey) return
  if (e.altKey && props.reorder && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) moveRow(e.key === 'ArrowDown' ? 1 : -1)
  else if (e.key === 'ArrowDown') step(1)
  else if (e.key === 'ArrowUp') step(-1)
  else if (e.key === 'Home' && !query.value) {
    active.value = 0
    reveal()
  } else if (e.key === 'End' && !query.value) {
    active.value = Math.max(0, shown.value.length - 1)
    reveal()
  } else if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
    const row = shown.value[active.value]
    const r = list.value?.querySelector('.is-active')?.getBoundingClientRect()
    if (row && r) emit('menu', row.id, { x: r.left + 24, y: r.bottom })
  } else if (e.key === 'Enter' || (e.key === ' ' && !props.search)) {
    const row = shown.value[active.value]
    if (row) emit('pick', row.id)
  } else return
  e.preventDefault()
  e.stopPropagation()
}
function onDown(e: PointerEvent, r: PickRow) {
  if (!r.always && !query.value) props.reorder?.start(e, r.id)
}

const focus = () => (input.value ?? list.value)?.focus({ preventScroll: true })
onMounted(() => {
  const at = props.multi ? -1 : shown.value.findIndex(r => r.checked)
  if (at > 0) active.value = at
  void nextTick(() => {
    if (props.autofocus) focus()
    reveal()
  })
})
defineExpose({ focus })
</script>

<template>
  <div class="pl-pick">
    <div v-if="search" class="pl-pick__search">
      <Icon name="search" />
      <input
        ref="input"
        v-model="query"
        type="text"
        class="pl-pick__input"
        role="combobox"
        aria-expanded="true"
        :aria-controls="uid"
        :aria-activedescendant="shown.length ? `${uid}-${active}` : undefined"
        :aria-label="label"
        :placeholder="placeholder"
        autocomplete="off"
        spellcheck="false"
        @keydown="onKey"
      >
    </div>
    <p v-if="none" class="pl-pick__none">{{ shell.nothingFound }}</p>
    <div
      :id="uid"
      ref="list"
      class="pl-pick__list"
      role="listbox"
      :style="{ maxHeight: `${maxHeight}px` }"
      :aria-label="label"
      :aria-multiselectable="multi || undefined"
      :tabindex="search ? -1 : 0"
      :aria-activedescendant="!search && shown.length ? `${uid}-${active}` : undefined"
      @keydown="!search && onKey($event)"
    >
      <template v-for="(r, i) in shown" :key="r.id">
        <div v-if="divided(i)" class="pl-pick__sep" role="presentation" />
        <div v-if="heading(i)" class="pl-pick__group" role="presentation">{{ heading(i) }}</div>
        <div
          :id="`${uid}-${i}`"
          class="pl-panel__row pl-pick__row"
          :class="[{ 'is-active': i === active }, classes(r)]"
          role="option"
          :aria-selected="!!r.checked"
          :data-rid="r.always ? undefined : r.id"
          :title="r.label"
          @pointermove="active = i"
          @pointerdown="onDown($event, r)"
          @mousedown.prevent
          @click="emit('pick', r.id)"
          @contextmenu.prevent="emit('menu', r.id, { x: $event.clientX, y: $event.clientY })"
        >
          <slot name="icon" :row="r" />
          <slot :row="r">
            <span class="pl-panel__label">{{ r.label }}</span>
          </slot>
          <span v-if="r.aside" class="pl-pick__aside">{{ r.aside }}</span>
          <Icon v-if="r.checked" name="check" class="pl-pick__check" />
          <slot name="end" :row="r" />
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.pl-pick { display: flex; flex-direction: column; min-height: 0; }
.pl-pick__search {
  flex: none;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  height: 32px;
  padding: 0 var(--space-2);
  margin-bottom: var(--space-1);
  border-bottom: 1px solid var(--line-soft);
  color: var(--fg-faint);
}
.pl-pick__search > svg { flex: none; width: 14px; height: 14px; stroke-width: 1.75; }
.pl-pick__input { flex: 1; min-width: 0; padding: 0; background: none; border: 0; font-size: var(--text-sm); color: var(--fg); }
.pl-pick__input:focus-visible { outline: none; }
.pl-pick__input::placeholder { color: var(--fg-faint); }
.pl-pick__none { margin: 0; padding: var(--space-2); font-size: var(--text-sm); color: var(--fg-subtle); }
.pl-pick__list { min-height: 0; overflow-y: auto; padding-block: 1px; }
.pl-pick__list:focus-visible { outline: none; }
.pl-pick__list[tabindex='0']:focus-visible .pl-pick__row.is-active { outline: 2px solid var(--focus-ring); outline-offset: -2px; }
.pl-pick__sep { height: 1px; margin: var(--space-1) var(--space-2); background: var(--line-soft); }
.pl-pick__group { padding: var(--space-2) var(--space-2) 2px; font-size: var(--text-xs); font-weight: 600; color: var(--fg-subtle); }
.pl-pick__row { padding-right: var(--space-2); cursor: default; }
.pl-pick__row.is-active { background: var(--bg-hover); }
.pl-pick__aside { flex: none; font-size: var(--text-xs); color: var(--fg-subtle); }
.pl-pick__row > svg.pl-pick__check { width: 14px; height: 14px; color: var(--accent-ink); }
</style>
