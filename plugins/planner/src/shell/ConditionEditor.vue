<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue'
import { usePlanner } from '../context.ts'
import {
  conditionValueKind, localDate, ME, operatorsFor, propertyOf, TITLE, type Collection, type Condition, type Operator,
} from '../model.ts'
import { strings } from '../strings.ts'
import Icon from '../ui/Icon.vue'
import OptionTag from '../ui/OptionTag.vue'
import { peopleRows, personView } from '../ui/people.ts'
import PersonTag from '../ui/PersonTag.vue'
import { operatorText, propertyName } from './filters.ts'
import PickList, { type PickRow } from './PickList.vue'
import { shell } from './strings.ts'

/** One filter: how it compares, and with what. */
const props = defineProps<{ collection: Collection; condition: Condition }>()
const emit = defineEmits<{ change: [change: Partial<Condition>, typing?: boolean]; remove: []; done: [] }>()
const { store } = usePlanner()

const property = computed(() => propertyOf(props.collection, props.condition.propertyId))
const type = computed(() => property.value?.type ?? TITLE)
const operators = computed<PickRow[]>(() => operatorsFor(type.value).map(o => ({ id: o, label: operatorText(o), checked: o === props.condition.operator })))
const kind = computed(() => conditionValueKind(type.value, props.condition.operator))
const choosing = ref(false)
const field = ref<HTMLInputElement | null>(null)

const value = computed(() => props.condition.value)
/** A number as it is typed: `-` and `1.` are on the way to one. */
const draft = ref(typeof props.condition.value === 'number' ? String(props.condition.value) : '')
const chosen = computed(() => (Array.isArray(value.value) ? (value.value as readonly string[]) : []))
const options = computed<PickRow[]>(() => (property.value?.options ?? []).map(o => ({ id: o.id, label: o.name, checked: chosen.value.includes(o.id) })))
const optionOf = (id: string) => property.value!.options.find(o => o.id === id)!
/** Me first: a view that shows "my" items shows each person theirs. Then the people, and any named that are not now. */
const people = computed(() => (kind.value === 'people' ? store.people(props.collection.id) : null))
const persons = computed<PickRow[]>(() => [
  ...(people.value?.me ? [{ id: ME, label: shell.me, checked: chosen.value.includes(ME) }] : []),
  ...peopleRows(people.value, chosen.value.filter(n => n !== ME))
    .map(id => ({ id, label: personView(id, property.value!, people.value).name, checked: chosen.value.includes(id) })),
])
const personOf = (id: string) => personView(id, property.value!, people.value)
const checks = computed<PickRow[]>(() => [
  { id: 'true', label: strings.checked, checked: value.value === true },
  { id: 'false', label: strings.unchecked, checked: value.value === false },
])

function setOperator(id: string) {
  const operator = id as Operator
  choosing.value = false
  const next = conditionValueKind(type.value, operator)
  if (next !== kind.value) draft.value = ''
  emit('change', next === kind.value ? { operator } : { operator, value: next === 'checkbox' ? true : null })
  void nextTick(() => field.value?.focus())
}
function toggle(id: string) {
  const now = chosen.value
  const next = now.includes(id) ? now.filter(i => i !== id) : [...now, id]
  emit('change', { value: next.length ? next : null })
}
function setText(text: string) {
  emit('change', { value: text === '' ? null : text }, true)
}
function setNumber(text: string) {
  draft.value = text
  const n = Number(text.trim().replace(',', '.'))
  emit('change', { value: text.trim() === '' || !Number.isFinite(n) ? null : n }, true)
}
function setDate(text: string) {
  emit('change', { value: text || null }, true)
}
onMounted(() => void nextTick(() => field.value?.select()))
</script>

<template>
  <div class="pl-cond">
    <div class="pl-cond__head">
      <span class="pl-cond__name">{{ propertyName(collection, condition.propertyId) }}</span>
      <button
        type="button"
        class="pl-small pl-cond__op"
        :aria-label="`${shell.condition}: ${operatorText(condition.operator)}`"
        :aria-expanded="choosing"
        :data-autofocus="kind === 'none' ? '' : undefined"
        @click="choosing = !choosing"
      >
        <span>{{ operatorText(condition.operator) }}</span><Icon name="chevron-down" />
      </button>
      <button type="button" class="pl-small pl-cond__remove" :aria-label="shell.removeFilter" :title="shell.removeFilter" @click="emit('remove')"><Icon name="trash-2" /></button>
    </div>

    <PickList v-if="choosing" :rows="operators" :label="shell.condition" :search="false" @pick="setOperator" />

    <template v-else-if="kind === 'options'">
      <p v-if="!options.length" class="pl-panel__note">{{ shell.noOptions }}</p>
      <PickList v-else :rows="options" :label="shell.value" :placeholder="shell.findOption" :search="options.length > 7" :max-height="260" multi @pick="toggle">
        <template #default="{ row }"><span class="pl-cond__option"><OptionTag :option="optionOf(row.id)" /></span></template>
      </PickList>
    </template>

    <template v-else-if="kind === 'people'">
      <p v-if="!persons.length" class="pl-panel__note">{{ shell.noPeople }}</p>
      <PickList v-else :rows="persons" :label="shell.value" :placeholder="shell.findPerson" :search="persons.length > 7" :max-height="260" multi @pick="toggle">
        <template #default="{ row }">
          <span class="pl-cond__option">
            <span v-if="row.id === ME" class="pl-cond__me"><Icon name="circle-user" />{{ row.label }}</span>
            <PersonTag v-else :person="personOf(row.id)" :former-word="shell.formerPerson" />
          </span>
        </template>
      </PickList>
    </template>

    <PickList v-else-if="kind === 'checkbox'" :rows="checks" :label="shell.value" :search="false" @pick="id => emit('change', { value: id === 'true' })" />

    <div v-else-if="kind !== 'none'" class="pl-cond__field">
      <input
        v-if="kind === 'date'"
        ref="field"
        type="date"
        class="pl-input"
        data-autofocus
        :value="typeof value === 'string' ? value.slice(0, 10) : ''"
        :aria-label="shell.value"
        @input="setDate(($event.target as HTMLInputElement).value)"
        @keydown.enter.prevent="emit('done')"
      >
      <input
        v-else-if="kind === 'number'"
        ref="field"
        type="text"
        inputmode="decimal"
        class="pl-input"
        data-autofocus
        :value="draft"
        :placeholder="type === 'number' ? shell.value : shell.days"
        :aria-label="type === 'number' ? shell.value : shell.days"
        @input="setNumber(($event.target as HTMLInputElement).value)"
        @keydown.enter.prevent="emit('done')"
      >
      <input
        v-else
        ref="field"
        type="text"
        class="pl-input"
        data-autofocus
        :value="value ?? ''"
        :placeholder="shell.value"
        :aria-label="shell.value"
        autocomplete="off"
        spellcheck="false"
        @input="setText(($event.target as HTMLInputElement).value)"
        @keydown.enter.prevent="emit('done')"
      >
      <button v-if="kind === 'date'" type="button" class="pl-small" @click="setDate(localDate(store.now.value))">{{ shell.today }}</button>
    </div>
  </div>
</template>

<style scoped>
.pl-cond { display: grid; gap: var(--space-1); padding: var(--space-1); }
.pl-cond__head { display: flex; align-items: center; gap: 2px; min-width: 0; padding-left: var(--space-2); }
.pl-cond__name { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--text-xs); font-weight: 600; color: var(--fg-muted); }
.pl-cond__op { color: var(--fg); }
.pl-cond__remove { margin-left: auto; }
.pl-cond__field { display: flex; align-items: center; gap: var(--space-1); padding: 0 var(--space-1) var(--space-1); }
.pl-cond__option { flex: 1; min-width: 0; display: flex; }
.pl-cond__me { display: inline-flex; align-items: center; gap: 6px; font-size: var(--text-xs); }
.pl-cond__me > svg { width: 18px; height: 18px; color: var(--fg-subtle); }
</style>
