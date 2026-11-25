<script setup lang="ts">
import { computed } from 'vue'
import { usePlanner } from '../context.ts'
import { safeUrl, valueOf, type DateValue, type Item, type Option, type Property } from '../model.ts'
import Icon from '../ui/Icon.vue'
import OptionTag from '../ui/OptionTag.vue'
import { personView } from '../ui/people.ts'
import PersonTag from '../ui/PersonTag.vue'
import { dateText, fullDate } from './dates.ts'
import { strings } from './strings.ts'

/** An item's value, to read. Nothing for an empty one (a checkbox is never empty). `wrap`: over several lines. */
const props = defineProps<{ property: Property; item: Item; wrap?: boolean }>()
const { mango, store } = usePlanner()

const value = computed(() => valueOf(props.item, props.property))
const options = computed<Option[]>(() => {
  const v = value.value
  const ids: readonly string[] = props.property.type === 'select' && typeof v === 'string' ? [v] : Array.isArray(v) ? v as readonly string[] : []
  return ids.flatMap(id => props.property.options.find(o => o.id === id) ?? [])
})
const persons = computed(() => {
  if (props.property.type !== 'person' || !Array.isArray(value.value)) return []
  const people = store.people(props.item.collectionId)
  return (value.value as readonly string[]).map(id => personView(id, props.property, people))
})
const date = computed(() => {
  const v = value.value
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? v as DateValue : null
})
/** A newer version's value: as much of it as can be read. */
const raw = computed(() => {
  if (props.property.type !== 'unsupported') return ''
  const v = props.item.values[props.property.id]
  return typeof v === 'string' ? v : v === undefined || v === null ? '' : JSON.stringify(v)
})
const href = computed(() => (props.property.type === 'url' && typeof value.value === 'string' ? safeUrl(value.value) : null))
/** Without what every address has. */
const shortUrl = computed(() => String(value.value).replace(/^https?:\/\/(www\.)?/i, '').replace(/\/$/, ''))

function open() {
  if (href.value) mango.workspace.openBrowser(href.value)
}
</script>

<template>
  <span
    v-if="property.type === 'checkbox'"
    class="pl-value pl-value--check"
    :class="{ 'is-on': value === true }"
    role="img"
    :aria-label="value === true ? strings.yes : strings.no"
  >
    <Icon :name="value === true ? 'square-check' : 'square'" />
  </span>
  <span v-else-if="options.length" class="pl-value pl-value--tags" :class="{ 'is-wrap': wrap }">
    <OptionTag v-for="o in options" :key="o.id" :option="o" />
  </span>
  <span v-else-if="persons.length" class="pl-value pl-value--people" :class="{ 'is-wrap': wrap }">
    <PersonTag v-for="p in persons" :key="p.id" :person="p" :former-word="strings.formerPerson" />
  </span>
  <span v-else-if="date" class="pl-value pl-value--date" :title="fullDate(date.start)">{{ dateText(date, store.now.value) }}</span>
  <span
    v-else-if="href"
    class="pl-value pl-value--url"
    :title="`${strings.openLink}: ${href}`"
    @click.stop.prevent="open"
    @pointerdown.stop
  >{{ shortUrl }}</span>
  <span v-else-if="property.type === 'number' && value !== null" class="pl-value pl-value--number">{{ value }}</span>
  <span
    v-else-if="(property.type === 'text' || property.type === 'url') && value !== null"
    class="pl-value"
    :class="{ 'is-wrap': wrap }"
    :title="property.type === 'url' ? strings.badLink : wrap ? undefined : String(value)"
  >{{ value }}</span>
  <span v-else-if="raw" class="pl-value pl-value--raw" :title="strings.unsupported">{{ raw }}</span>
</template>

<style scoped>
.pl-value { display: inline-block; min-width: 0; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; vertical-align: middle; }
.pl-value.is-wrap { white-space: pre-wrap; overflow-wrap: anywhere; }
.pl-value--tags { display: inline-flex; gap: var(--space-1); }
.pl-value--tags.is-wrap { flex-wrap: wrap; white-space: normal; }
.pl-value--people { display: inline-flex; gap: var(--space-2); }
/* Out of room, the last name gives way first: the others stay readable. */
.pl-value--people > :not(:last-child) { flex-shrink: 0; }
.pl-value--people.is-wrap { flex-wrap: wrap; row-gap: var(--space-1); white-space: normal; }
.pl-value--date, .pl-value--number { font-variant-numeric: tabular-nums; }
.pl-value--url { color: var(--accent-ink); cursor: pointer; }
.pl-value--url:hover { text-decoration: underline; text-underline-offset: 3px; }
.pl-value--check { display: inline-flex; color: var(--fg-faint); overflow: visible; }
.pl-value--check.is-on { color: var(--accent-ink); }
.pl-value--raw { color: var(--fg-subtle); }
</style>
