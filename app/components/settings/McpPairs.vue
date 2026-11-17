<script setup lang="ts">
import { Eye, EyeOff, Plus, X } from 'lucide-vue-next'
import type { McpPair } from '~/types/ipc'

/**
 * Names and values of an MCP server: its command's environment variables, or its HTTP headers.
 * Values are secrets: masked until shown (each row's eye), never logged. Masked with
 * `-webkit-text-security` like the project's .env fields, so password managers leave them alone,
 * and copying a hidden value hands out nothing.
 */
const props = defineProps<{
  modelValue: McpPair[]
  /** 'variable' or 'header': what a row is, for labels and checks. */
  kind: 'variable' | 'header'
}>()
const emit = defineEmits<{ 'update:modelValue': [pairs: McpPair[]]; 'invalid': [count: number] }>()

interface Row { id: number; name: string; value: string; shown: boolean }
let seq = 0
/* Rows that already have a value start hidden; a row the user adds starts shown, to type into. */
const rows = ref<Row[]>(props.modelValue.map(p => ({ id: ++seq, name: p.name, value: p.value, shown: !p.value })))
const list = ref<HTMLElement | null>(null)

const write = () => emit('update:modelValue', rows.value.map(r => ({ name: r.name, value: r.value })))

const noun = computed(() => (props.kind === 'variable' ? 'variable' : 'header'))
const valid = (name: string) => (props.kind === 'variable' ? /^[A-Za-z_]\w*$/ : /^[\w!#$%&'*+.^`|~-]+$/).test(name)

const problems = computed(() => {
  const out: Record<number, string> = {}
  const seen = new Set<string>()
  for (const r of rows.value) {
    const n = r.name.trim()
    if (!n) {
      if (r.value) out[r.id] = 'Give it a name, or it isn\'t saved.'
      continue
    }
    if (!valid(n)) {
      out[r.id] = props.kind === 'variable'
        ? 'Use letters, digits and _, not starting with a digit.'
        : 'A header name has no spaces, colons or quotes.'
    } else if (seen.has(n.toLowerCase())) out[r.id] = `${n} is set twice.`
    seen.add(n.toLowerCase())
  }
  return out
})

/** Names that can't be saved (a nameless row is only left out). */
const invalidCount = computed(() => rows.value.filter(r => problems.value[r.id] && r.name.trim()).length)
watch(invalidCount, n => emit('invalid', n), { immediate: true })

function focusInput(id: number, part: 'name' | 'value') {
  void nextTick(() => list.value?.querySelector<HTMLInputElement>(`[data-row="${id}"][data-part="${part}"]`)?.focus())
}
function addRow() {
  const row: Row = { id: ++seq, name: '', value: '', shown: true }
  rows.value.push(row)
  focusInput(row.id, 'name')
}
function removeRow(i: number) {
  rows.value.splice(i, 1)
  write()
  const next = rows.value[i] ?? rows.value[i - 1]
  if (next) focusInput(next.id, 'name')
  else void nextTick(() => list.value?.parentElement?.querySelector<HTMLElement>('.pairs__add')?.focus())
}
function guardCopy(e: ClipboardEvent, row: Row) {
  if (!row.shown) e.preventDefault()
}
/** `NAME=value` lines pasted into a name become rows (variables only: a header's value may hold `=`). */
function onNamePaste(e: ClipboardEvent, row: Row) {
  const text = e.clipboardData?.getData('text/plain') ?? ''
  const sep = props.kind === 'variable' ? '=' : ':'
  const found = text.split(/\r?\n/).map((l) => {
    const i = l.indexOf(sep)
    return i > 0 ? { name: l.slice(0, i).trim().replace(/^export\s+/, ''), value: l.slice(i + 1).trim() } : null
  }).filter((p): p is McpPair => !!p && !!p.name)
  if (!found.length) return
  e.preventDefault()
  const fresh = found.map(p => ({ id: ++seq, name: p.name, value: p.value, shown: false }))
  if (!row.name.trim() && !row.value) Object.assign(row, { ...fresh.shift()!, id: row.id })
  rows.value.push(...fresh)
  write()
}

const label = computed(() => (props.kind === 'variable' ? 'Environment variables' : 'Headers'))
</script>

<template>
  <div class="pairs" role="group" :aria-label="label">
    <div v-if="rows.length" ref="list" class="pairs__list">
      <div v-for="(row, i) in rows" :key="row.id" class="pairs__item">
        <div class="pairs__row" role="group" :aria-label="row.name.trim() || `New ${noun}`">
          <input
            v-model="row.name"
            class="pairs__in"
            :class="{ 'is-error': problems[row.id] && row.name.trim() }"
            :data-row="row.id"
            data-part="name"
            type="text"
            :aria-label="kind === 'variable' ? 'Variable name' : 'Header name'"
            :placeholder="kind === 'variable' ? 'NAME' : 'Authorization'"
            autocomplete="off"
            autocapitalize="off"
            spellcheck="false"
            :aria-invalid="!!problems[row.id] || undefined"
            :aria-describedby="problems[row.id] ? `pairs-msg-${row.id}` : undefined"
            @input="write"
            @paste="onNamePaste($event, row)"
            @keydown.enter.prevent="focusInput(row.id, 'value')"
          >
          <input
            v-model="row.value"
            class="pairs__in"
            :class="{ 'is-masked': !row.shown }"
            :data-row="row.id"
            data-part="value"
            type="text"
            :aria-label="row.shown ? 'Value' : 'Value, hidden'"
            :placeholder="kind === 'variable' ? 'value' : 'Bearer …'"
            autocomplete="off"
            autocapitalize="off"
            spellcheck="false"
            data-1p-ignore
            data-lpignore="true"
            @copy="guardCopy($event, row)"
            @cut="guardCopy($event, row)"
            @input="write"
          >
          <UiIconButton size="sm" :label="row.shown ? 'Hide value' : 'Show value'" :active="row.shown" @click="row.shown = !row.shown">
            <EyeOff v-if="row.shown" /><Eye v-else />
          </UiIconButton>
          <UiIconButton size="sm" :label="`Remove ${noun}`" @click="removeRow(i)"><X /></UiIconButton>
        </div>
        <p v-if="problems[row.id]" :id="`pairs-msg-${row.id}`" class="pairs__msg">{{ problems[row.id] }}</p>
      </div>
    </div>
    <UiButton size="sm" variant="ghost" class="pairs__add" @click="addRow"><Plus />Add {{ noun }}</UiButton>
  </div>
</template>

<style scoped>
.pairs { display: grid; justify-items: start; gap: var(--space-1); }
.pairs__list { display: grid; gap: var(--space-1); width: 100%; }
.pairs__item { display: grid; gap: 2px; }
.pairs__row {
  display: grid;
  grid-template-columns: minmax(0, 2fr) minmax(0, 3fr) 22px 22px;
  align-items: center;
  gap: var(--space-2);
}
.pairs__in {
  height: 28px;
  width: 100%;
  min-width: 0;
  padding: 0 var(--space-2);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--fg);
  background: var(--bg-inset);
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  transition: border-color var(--dur-fast) var(--ease-out), box-shadow var(--dur-fast) var(--ease-out);
}
.pairs__in::placeholder { color: var(--fg-faint); }
.pairs__in:hover { border-color: var(--line-strong); }
.pairs__in:focus-visible { outline: none; }
.pairs__in:focus { border-color: var(--accent-line); box-shadow: 0 0 0 3px var(--accent-soft); }
.pairs__in.is-masked { -webkit-text-security: disc; }
.pairs__in.is-error { border-color: color-mix(in oklch, var(--ripe-error) 60%, transparent); }
.pairs__msg { margin: 0 0 var(--space-1); font-size: var(--text-xs); line-height: var(--leading-tight); color: var(--ripe-error-fg); }
.pairs__add { margin-left: calc(var(--space-2) * -1); }
.pairs :deep(.btn svg) { width: 14px; height: 14px; }
</style>
