<script setup lang="ts">
import { Eye, EyeOff, Plus, X } from 'lucide-vue-next'
import { applyEntries, entriesFromPaste, isValidKey, parseEnv } from '~/utils/dotenv'

/**
 * An env file as rows of name and value. The file's text stays the source of truth: rows are
 * parsed from it, and every edit is written back with `applyEntries` against the text the rows
 * came from, so comments, order and quoting of the lines nobody touched come through unchanged.
 * Values are secrets: masked until shown, never logged. `revealed` is the section's one
 * "Show values" switch (in memory only); each row's eye shows or hides that row on its own.
 */
const props = defineProps<{ text: string; docKey: string; revealed: boolean }>()
const emit = defineEmits<{ 'update:text': [text: string]; 'invalid': [count: number] }>()

interface Row { id: number; key: string; value: string; line: number | null; shown: boolean }

let seq = 0
/** The text the rows were parsed from; their `line`s point into it. */
let base = ''
/** The last text these rows wrote, to tell our own edits from a change made elsewhere (Raw, revert, reload). */
let lastWritten: string | null = null
let lastKey = ''
const rows = ref<Row[]>([])
const list = ref<HTMLElement | null>(null)

function sync(text: string) {
  base = text
  lastWritten = text
  rows.value = parseEnv(text).map(e => ({ id: ++seq, key: e.key, value: e.value, line: e.line, shown: props.revealed }))
}
watch(() => [props.docKey, props.text] as const, ([key, text]) => {
  if (key !== lastKey || text !== lastWritten) sync(text)
  lastKey = key
}, { immediate: true })

/** Rows without a name are left out of the file until they get one. */
function write() {
  const entries = rows.value
    .filter(r => r.key.trim() !== '')
    .map(r => ({ key: r.key.trim(), value: r.value, line: r.line }))
  const text = applyEntries(base, entries)
  lastWritten = text
  emit('update:text', text)
}

/* ---------- checks ---------- */

const problems = computed(() => {
  const out: Record<number, { tone: 'error' | 'warn' | 'note'; text: string }> = {}
  const lastIndex = new Map<string, number>()
  rows.value.forEach((r, i) => { const k = r.key.trim(); if (k) lastIndex.set(k, i) })
  rows.value.forEach((r, i) => {
    const k = r.key.trim()
    if (!k) {
      if (r.value) out[r.id] = { tone: 'note', text: 'Give it a name, or it isn\'t saved.' }
    } else if (!isValidKey(k)) {
      out[r.id] = { tone: 'error', text: '.env loaders can\'t read this name. Start with a letter or underscore, then use letters, digits, _ . or -.' }
    } else if ((lastIndex.get(k) ?? i) > i) {
      out[r.id] = { tone: 'warn', text: `${k} is set again further down, and the later one usually wins.` }
    }
  })
  return out
})
const invalidCount = computed(() => Object.values(problems.value).filter(p => p.tone === 'error').length)
watch(invalidCount, n => emit('invalid', n), { immediate: true })

/**
 * What the rows don't show, so it's clear it is kept: comments, and lines that are not a variable
 * this view can read (an invalid name written in Raw, say). Removing every entry leaves exactly those.
 */
const leftover = computed(() => {
  void rows.value.length
  const rest = applyEntries(base, []).split(/\r?\n/).filter(l => l.trim() !== '')
  const comments = rest.filter(l => /^\s*#/.test(l)).length
  return { comments, stray: rest.length - comments }
})

/* ---------- showing values ---------- */

/* The section's switch shows or hides every row; a row's eye overrides it for that row. */
watch(() => props.revealed, (on) => { for (const r of rows.value) r.shown = on })

/**
 * A hidden value is masked with `-webkit-text-security`, not `type="password"`, so password
 * managers leave it alone; copying or cutting it must not hand out what the mask hides.
 */
function guardCopy(e: ClipboardEvent, row: Row) {
  if (!row.shown) e.preventDefault()
}

/* ---------- editing ---------- */

function focusInput(id: number, which: 'key' | 'value') {
  void nextTick(() => list.value?.querySelector<HTMLInputElement>(`[data-row="${id}"][data-part="${which}"]`)?.focus())
}

function addRow() {
  const row: Row = { id: ++seq, key: '', value: '', line: null, shown: true }
  rows.value.push(row)
  focusInput(row.id, 'key')
}

function removeRow(i: number) {
  const [gone] = rows.value.splice(i, 1)
  if (!gone) return
  write()
  const next = rows.value[i] ?? rows.value[i - 1]
  if (next) focusInput(next.id, 'key')
  else void nextTick(() => list.value?.parentElement?.querySelector<HTMLElement>('.envf__add')?.focus())
}

function onKeyEnter(row: Row) {
  focusInput(row.id, 'value')
}

/** Enter in a value goes on to the next row, or starts a new one after the last. */
function onValueEnter(i: number) {
  const next = rows.value[i + 1]
  if (next) focusInput(next.id, 'value')
  else addRow()
}

/** `KEY=value` lines pasted into a name become rows of their own. */
function onKeyPaste(e: ClipboardEvent, row: Row) {
  const text = e.clipboardData?.getData('text/plain') ?? ''
  if (!text.includes('=') && !/\n/.test(text.trim())) return
  const found = entriesFromPaste(text)
  if (!found.length) return
  e.preventDefault()
  const fresh = found.map(f => ({ id: ++seq, key: f.key, value: f.value, line: null as number | null, shown: props.revealed }))
  // An empty row takes the first pasted variable; the rest go after the last row.
  if (!row.key.trim() && !row.value) {
    const first = fresh.shift()!
    row.key = first.key
    row.value = first.value
  }
  rows.value.push(...fresh)
  write()
  const last = fresh[fresh.length - 1] ?? row
  focusInput(last.id, 'value')
}

defineExpose({ addRow })
</script>

<template>
  <div class="envf">
    <div class="envf__head">
      <span class="envf__col">Name</span>
      <span class="envf__col">Value</span>
    </div>

    <div ref="list" class="envf__list">
      <div v-for="(row, i) in rows" :key="row.id" class="envf__item">
        <div class="envf__row" role="group" :aria-label="row.key.trim() || 'New variable'">
          <input
            v-model="row.key"
            class="envf__in envf__key"
            :class="{ 'is-error': problems[row.id]?.tone === 'error', 'is-warn': problems[row.id]?.tone === 'warn' }"
            :data-row="row.id"
            data-part="key"
            type="text"
            aria-label="Name"
            placeholder="NAME"
            autocomplete="off"
            autocapitalize="off"
            spellcheck="false"
            :aria-invalid="problems[row.id]?.tone === 'error' || undefined"
            :aria-describedby="problems[row.id] ? `envf-msg-${row.id}` : undefined"
            @input="write"
            @paste="onKeyPaste($event, row)"
            @keydown.enter.prevent="onKeyEnter(row)"
          >
          <input
            v-model="row.value"
            class="envf__in envf__value"
            :class="{ 'is-masked': !row.shown }"
            :data-row="row.id"
            data-part="value"
            type="text"
            :aria-label="row.shown ? 'Value' : 'Value, hidden'"
            placeholder="value"
            autocomplete="off"
            autocapitalize="off"
            spellcheck="false"
            data-1p-ignore
            data-lpignore="true"
            @copy="guardCopy($event, row)"
            @cut="guardCopy($event, row)"
            @input="write"
            @keydown.enter.prevent="onValueEnter(i)"
          >
          <UiIconButton size="sm" :label="row.shown ? 'Hide value' : 'Show value'" :active="row.shown" @click="row.shown = !row.shown">
            <EyeOff v-if="row.shown" /><Eye v-else />
          </UiIconButton>
          <UiIconButton size="sm" label="Remove variable" @click="removeRow(i)"><X /></UiIconButton>
        </div>
        <p
          v-if="problems[row.id]"
          :id="`envf-msg-${row.id}`"
          class="envf__msg"
          :class="`is-${problems[row.id]!.tone}`"
        >
          {{ problems[row.id]!.text }}
        </p>
      </div>
    </div>

    <p v-if="!rows.length" class="envf__empty">No variables yet. Add one, or paste <code>NAME=value</code> lines into a name.</p>

    <div class="envf__foot">
      <UiButton size="sm" variant="ghost" class="envf__add" @click="addRow"><Plus />Add variable</UiButton>
      <p v-if="leftover.stray" class="envf__hint is-warn">
        {{ leftover.stray === 1
          ? '1 line isn\'t a variable this view can read. It stays as written; edit it in Raw.'
          : `${leftover.stray} lines aren't variables this view can read. They stay as written; edit them in Raw.` }}
      </p>
      <p v-else-if="leftover.comments" class="envf__hint">Comments and blank lines stay as they are. Edit them in Raw.</p>
    </div>
  </div>
</template>

<style scoped>
.envf { display: grid; gap: var(--space-1); }

.envf__head,
.envf__row {
  display: grid;
  grid-template-columns: minmax(0, 2fr) minmax(0, 3fr) 22px 22px;
  align-items: center;
  gap: var(--space-1) var(--space-2);
}
.envf__head { min-height: 22px; }
.envf__col { font-size: var(--text-xs); font-weight: 560; color: var(--fg-subtle); }

.envf__list { display: grid; gap: var(--space-1); }
.envf__item { display: grid; gap: 2px; }

.envf__in {
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
.envf__in::placeholder { color: var(--fg-faint); }
.envf__in:hover { border-color: var(--line-strong); }
.envf__in:focus-visible { outline: none; }
.envf__in:focus { border-color: var(--accent-line); box-shadow: 0 0 0 3px var(--accent-soft); }
.envf__value.is-masked { -webkit-text-security: disc; }
.envf__key.is-error { border-color: color-mix(in oklch, var(--ripe-error) 60%, transparent); }
.envf__key.is-warn { border-color: color-mix(in oklch, var(--ripe-waiting) 55%, transparent); }

.envf__msg {
  margin: 0 0 var(--space-1);
  font-size: var(--text-xs);
  line-height: var(--leading-tight);
  text-wrap: pretty;
}
.envf__msg.is-error { color: var(--ripe-error-fg); }
.envf__msg.is-warn { color: var(--ripe-waiting-fg); }
.envf__msg.is-note { color: var(--fg-subtle); }

.envf__empty { margin: var(--space-2) 0; font-size: var(--text-sm); color: var(--fg-subtle); }
.envf__empty code { font-size: var(--text-xs); color: var(--fg-muted); }

.envf__foot { display: flex; align-items: center; gap: var(--space-3); margin-top: var(--space-1); }
.envf__add { margin-left: calc(var(--space-2) * -1); }
.envf__hint { margin: 0 0 0 auto; font-size: var(--text-xs); color: var(--fg-subtle); text-align: right; text-wrap: pretty; }
.envf__hint.is-warn { color: var(--ripe-waiting-fg); }
</style>
