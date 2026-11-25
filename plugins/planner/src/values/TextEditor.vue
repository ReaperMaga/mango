<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { parseNumber } from '../convert.ts'
import { safeUrl, type Property, type Value } from '../model.ts'
import { strings } from './strings.ts'

/** Text, a number or a link. Written once: on Enter or when the user moves on. */
const props = defineProps<{ property: Property; value: Value | null }>()
const emit = defineEmits<{ change: [value: Value | null]; done: [] }>()

const initial = props.value === null ? '' : String(props.value)
const text = ref(initial)
const el = ref<HTMLTextAreaElement | HTMLInputElement | null>(null)
const isNumber = props.property.type === 'number'
const number = computed(() => (text.value.trim() ? parseNumber(text.value) : null))
const invalid = computed(() => isNumber && text.value.trim() !== '' && number.value === null)
const problem = computed(() => {
  if (invalid.value) return strings.notANumber
  return props.property.type === 'url' && text.value.trim() && !safeUrl(text.value) ? strings.badLink : null
})

let settled = false
function commit() {
  if (settled) return
  settled = true
  if (text.value === initial || invalid.value) return
  if (isNumber) emit('change', number.value)
  else emit('change', (props.property.type === 'url' ? text.value.trim() : text.value.trimEnd()) || null)
}
function cancel() {
  settled = true
}
function onKey(e: KeyboardEvent) {
  if (e.key !== 'Enter' || e.isComposing || (e.shiftKey && props.property.type === 'text')) return
  e.preventDefault()
  if (invalid.value) return
  commit()
  emit('done')
}
onMounted(() => el.value?.select())
// A click outside takes the popover away: what was typed counts.
onBeforeUnmount(commit)
defineExpose({ commit, cancel })
</script>

<template>
  <div class="pl-text">
    <div v-if="property.type === 'text'" class="pl-text__grow" :data-text="`${text} `">
      <textarea ref="el" v-model="text" data-autofocus rows="1" :aria-label="property.name" @keydown="onKey" />
    </div>
    <input
      v-else
      ref="el"
      v-model="text"
      data-autofocus
      class="pl-text__input"
      type="text"
      :inputmode="isNumber ? 'decimal' : 'url'"
      spellcheck="false"
      autocomplete="off"
      :placeholder="property.type === 'url' ? 'https://' : undefined"
      :aria-label="property.name"
      :aria-invalid="invalid || undefined"
      @keydown="onKey"
    >
    <p v-if="problem" class="pl-text__note" :class="{ 'is-error': invalid }" role="status">{{ problem }}</p>
  </div>
</template>

<style scoped>
.pl-text__input, .pl-text__grow > textarea, .pl-text__grow::after {
  width: 100%;
  padding: 6px var(--space-2);
  border: 0;
  background: none;
  font: inherit;
  line-height: 20px;
}
.pl-text__input { height: 32px; font-variant-numeric: tabular-nums; }
.pl-text__input::placeholder { color: var(--fg-faint); }
/* The focus is the popover itself: one field, nothing else in it. */
.pl-text__input:focus-visible, textarea:focus-visible { outline: none; }
.pl-text__grow { display: grid; max-height: 240px; overflow-y: auto; }
.pl-text__grow > textarea, .pl-text__grow::after { grid-area: 1 / 1; white-space: pre-wrap; overflow-wrap: anywhere; }
.pl-text__grow::after { content: attr(data-text); visibility: hidden; }
.pl-text__grow > textarea { resize: none; overflow: hidden; }
.pl-text__note { margin: 0; padding: 0 var(--space-2) 6px; font-size: var(--text-xs); color: var(--fg-subtle); }
.pl-text__note.is-error { color: var(--ripe-error-fg); }
</style>
