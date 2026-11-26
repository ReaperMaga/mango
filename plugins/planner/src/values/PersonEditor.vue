<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { usePlanner } from '../context.ts'
import { valueOf, type Item, type Property, type Value } from '../model.ts'
import Icon from '../ui/Icon.vue'
import { peopleRows, personView } from '../ui/people.ts'
import PersonTag from '../ui/PersonTag.vue'
import { strings } from './strings.ts'

/**
 * Assigns people by typing: the planner server's people, whoever is looking first. Names assigned before that are
 * no longer among them stay listed, to be taken off. Several at once; Backspace takes the last one off.
 */
const props = defineProps<{
  collectionId: string
  property: Property
  items: readonly Item[]
  set: (next: Value | null | ((item: Item) => Value | null)) => void
}>()
const { store } = usePlanner()

const people = computed(() => store.people(props.collectionId))
// Someone may have been given a token since it was last asked.
onMounted(() => store.refreshPeople(props.collectionId))

const query = ref('')
const active = ref(0)
const input = ref<HTMLInputElement | null>(null)
const list = ref<HTMLElement | null>(null)

const namesOf = (item: Item): readonly string[] => {
  const v = valueOf(item, props.property)
  return Array.isArray(v) ? v as readonly string[] : []
}
const counts = computed(() => {
  const out = new Map<string, number>()
  for (const i of props.items) for (const n of namesOf(i)) out.set(n, (out.get(n) ?? 0) + 1)
  return out
})
const has = (name: string) => props.items.length > 0 && counts.value.get(name) === props.items.length
const some = (name: string) => !has(name) && counts.value.has(name)

const all = computed(() => peopleRows(people.value, [...counts.value.keys()]).map(id => personView(id, props.property, people.value)))
const rows = computed(() => {
  const words = query.value.toLowerCase().split(/\s+/).filter(Boolean)
  return all.value.filter(p => words.every(w => p.name.toLowerCase().includes(w))).map(p => p.id)
})
const viewOf = (id: string) => all.value.find(p => p.id === id)!
const canClear = computed(() => counts.value.size > 0)
const note = computed(() => {
  if (rows.value.length) return null
  if (query.value.trim()) return strings.noPeople
  return people.value ? strings.noPeopleYet : strings.noPeopleHere
})

active.value = Math.max(0, all.value.findIndex(p => has(p.id)))
void nextTick(reveal)
watch(query, () => { active.value = 0 })
watch(() => rows.value.length, n => { active.value = Math.max(0, Math.min(active.value, n - 1)) })

const uid = `pl-people-${props.property.id}`
const rowId = (i: number) => `${uid}-${i}`
function reveal() {
  list.value?.querySelector('.is-active')?.scrollIntoView({ block: 'nearest' })
}
function move(by: number) {
  const n = rows.value.length
  if (n) active.value = (active.value + by + n) % n
  void nextTick(reveal)
}

function toggle(name: string | undefined) {
  if (!name || !props.items.length) return
  const remove = has(name)
  props.set((item) => {
    const now = namesOf(item)
    const next = remove ? now.filter(n => n !== name) : now.includes(name) ? now : [...now, name]
    return next.length ? [...next] : null
  })
  query.value = ''
  input.value?.focus()
}
function clear() {
  props.set(null)
  input.value?.focus()
}

function onKey(e: KeyboardEvent) {
  if (e.isComposing) return
  if (e.key === 'ArrowDown') move(1)
  else if (e.key === 'ArrowUp') move(-1)
  else if (e.key === 'Enter') toggle(rows.value[active.value])
  else if (e.key === 'Backspace' && !query.value && props.items.length === 1) {
    const last = namesOf(props.items[0]!).at(-1)
    if (!last) return
    props.set((item) => {
      const next = namesOf(item).filter(n => n !== last)
      return next.length ? next : null
    })
  } else return
  e.preventDefault()
}
</script>

<template>
  <div class="pl-pp">
    <div class="pl-pp__head">
      <input
        ref="input"
        v-model="query"
        class="pl-pp__input"
        data-autofocus
        role="combobox"
        aria-expanded="true"
        aria-autocomplete="list"
        :aria-controls="`${uid}-list`"
        :aria-activedescendant="rows[active] !== undefined ? rowId(active) : undefined"
        :aria-label="property.name"
        :placeholder="strings.findPerson"
        spellcheck="false"
        autocomplete="off"
        @keydown="onKey"
      >
    </div>
    <div :id="`${uid}-list`" ref="list" class="pl-pp__rows" role="listbox" :aria-label="property.name" aria-multiselectable="true">
      <div
        v-for="(name, i) in rows"
        :id="rowId(i)"
        :key="name"
        class="pl-pp__row"
        :class="{ 'is-active': i === active }"
        role="option"
        :aria-selected="has(name)"
        @pointermove="active = i"
        @click="toggle(name)"
      >
        <span class="pl-pp__who">
          <PersonTag :person="viewOf(name)" :you-word="strings.you" :former-word="strings.formerPerson" />
        </span>
        <Icon v-if="has(name)" name="check" class="pl-pp__check" />
        <Icon v-else-if="some(name)" name="minus" class="pl-pp__check is-some" />
      </div>
      <p v-if="note" class="pl-pp__note">{{ note }}</p>
    </div>
    <div v-if="canClear" class="pl-pp__foot">
      <button type="button" class="pl-pp__row" @click="clear"><Icon name="x" />{{ strings.clear }}</button>
    </div>
  </div>
</template>

<style scoped>
.pl-pp__head { position: sticky; top: 0; z-index: 1; display: flex; align-items: center; padding: var(--space-1); background: var(--bg-raised); border-bottom: 1px solid var(--line-soft); }
.pl-pp__input { flex: 1; min-width: 0; height: 28px; padding: 0 var(--space-2); border: 0; background: none; font-size: var(--text-sm); }
.pl-pp__input:focus-visible { outline: none; }
.pl-pp__input::placeholder { color: var(--fg-faint); }
.pl-pp__rows { max-height: 280px; overflow-y: auto; padding: var(--space-1); }
.pl-pp__row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  min-height: 30px;
  padding: 0 var(--space-2);
  border-radius: var(--radius-sm);
  text-align: left;
  font-size: var(--text-sm);
  cursor: pointer;
}
.pl-pp__row.is-active, button.pl-pp__row:hover { background: var(--bg-hover); }
button.pl-pp__row { color: var(--fg); }
button.pl-pp__row > svg { color: var(--fg-subtle); }
.pl-pp__who { flex: 1; min-width: 0; display: flex; }
.pl-pp__who :deep(.pl-person) { font-size: var(--text-sm); }
.pl-pp__check { width: 14px; height: 14px; color: var(--accent-ink); }
.pl-pp__check.is-some { color: var(--fg-subtle); }
.pl-pp__note { margin: 0; padding: var(--space-2); color: var(--fg-subtle); font-size: var(--text-xs); line-height: 1.45; }
.pl-pp__foot { padding: var(--space-1); border-top: 1px solid var(--line-soft); }
</style>
