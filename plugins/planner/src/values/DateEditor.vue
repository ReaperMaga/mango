<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { usePlanner } from '../context.ts'
import { addDays, localDate, type DateValue, type Value } from '../model.ts'
import Icon from '../ui/Icon.vue'
import { addMonths, dateText, firstWeekday, fullDate, monthText, readDate, sameDayIn, weekdayNames } from './dates.ts'
import { strings } from './strings.ts'

/** A typed date or one from the calendar, with an optional end and time. Every step is kept at once. */
const props = defineProps<{ value: DateValue | null }>()
const emit = defineEmits<{ change: [value: Value | null]; done: [] }>()
const { mango, store } = usePlanner()
const { IconButton } = mango.ui.components

const today = computed(() => localDate(store.now.value))
const withEnd = ref(!!props.value?.end)
const withTime = ref(!!props.value?.start.includes('T'))
/** Which of the two the calendar sets. */
const side = ref<'start' | 'end'>('start')

const start = computed(() => props.value?.start ?? null)
const end = computed(() => props.value?.end ?? null)
const day = (d: string | null) => d?.slice(0, 10) ?? null
const time = (d: string | null) => d?.slice(11, 16) || null

function save(s: string, e: string | null) {
  const full = (d: string, t: string) => (withTime.value ? `${d.slice(0, 10)}T${time(d) ?? t}` : d.slice(0, 10))
  let a = full(s, '09:00')
  let b = withEnd.value && e ? full(e, time(a) ?? '09:00') : null
  if (b !== null && b < a) [a, b] = [b, a]
  // As sent: the write shows in `value` at once, and the fields follow it.
  emit('change', b === null ? { start: a } : { start: a, end: b })
}

/** A day for the side being set, keeping that side's time. */
function setDay(d: string) {
  const keep = (old: string | null) => (time(old) ? `${d}T${time(old)}` : d)
  if (side.value === 'end' && start.value) save(start.value, keep(end.value))
  else save(keep(start.value), end.value)
}

/* ---------- typed */

/** The time has a field of its own. */
const text = (d: string | null) => day(d) ?? ''
const drafts = ref({ start: text(start.value), end: text(end.value) })
const bad = ref<'start' | 'end' | null>(null)
watch(() => props.value, () => {
  drafts.value = { start: text(start.value), end: text(end.value) }
  bad.value = null
})
/** Reads what was typed; false when it is no date. */
function commit(which: 'start' | 'end'): boolean {
  const t = drafts.value[which].trim()
  bad.value = null
  if (t === text(which === 'start' ? start.value : end.value)) return true
  if (!t) {
    if (which === 'start') emit('change', null)
    else if (start.value) save(start.value, null)
    return true
  }
  const d = readDate(t, store.now.value)
  if (!d) {
    bad.value = which
    return false
  }
  if (d.start.includes('T')) withTime.value = true
  if (d.end) withEnd.value = true
  const timed = (next: string, old: string | null) => (next.includes('T') || !time(old) ? next : `${next}T${time(old)}`)
  if (which === 'end') save(start.value ?? d.start, timed(d.start, end.value))
  else save(timed(d.start, start.value), d.end ? timed(d.end, end.value) : end.value)
  month.value = d.start.slice(0, 7)
  cursor.value = d.start.slice(0, 10)
  return true
}
function onInputKey(e: KeyboardEvent, which: 'start' | 'end') {
  if (e.isComposing) return
  if (e.key === 'Enter') {
    e.preventDefault()
    if (commit(which)) emit('done')
  } else if (e.key === 'ArrowDown') {
    e.preventDefault()
    if (commit(which)) focusDay()
  }
}

/* ---------- calendar */

const cursor = ref(day(start.value) ?? today.value)
const month = ref(cursor.value.slice(0, 7))
const grid = ref<HTMLElement | null>(null)
const first = firstWeekday()
const names = weekdayNames(first)
const weeks = computed(() => {
  const one = `${month.value}-01`
  const lead = (new Date(`${one}T12:00:00Z`).getUTCDay() - first + 7) % 7
  const from = addDays(one, -lead)
  const count = Math.ceil((lead + Number(addDays(`${addMonths(month.value, 1)}-01`, -1).slice(8))) / 7)
  return Array.from({ length: count }, (_, w) => Array.from({ length: 7 }, (_, d) => addDays(from, w * 7 + d)))
})
/** The day the keyboard is on, always one that shows. */
const tabDay = computed(() => (cursor.value.startsWith(month.value) ? cursor.value : `${month.value}-01`))
const isSelected = (d: string) => d === day(start.value) || (withEnd.value && d === day(end.value))
const inRange = (d: string) => !!start.value && !!end.value && d > day(start.value)! && d < day(end.value)!

async function focusDay(d = tabDay.value) {
  cursor.value = d
  month.value = d.slice(0, 7)
  await nextTick()
  grid.value?.querySelector<HTMLElement>(`[data-day="${d}"]`)?.focus()
}
function turn(by: number) {
  month.value = addMonths(month.value, by)
}
function pick(d: string) {
  cursor.value = d
  setDay(d)
  if (!withEnd.value && !withTime.value) emit('done')
  else if (withEnd.value && side.value === 'start') side.value = 'end'
}
function onGridKey(e: KeyboardEvent) {
  const d = (e.target as HTMLElement).dataset.day
  if (!d) return
  const weekday = (new Date(`${d}T12:00:00Z`).getUTCDay() - first + 7) % 7
  const steps: Record<string, () => string> = {
    ArrowLeft: () => addDays(d, -1),
    ArrowRight: () => addDays(d, 1),
    ArrowUp: () => addDays(d, -7),
    ArrowDown: () => addDays(d, 7),
    Home: () => addDays(d, -weekday),
    End: () => addDays(d, 6 - weekday),
    PageUp: () => sameDayIn(d, e.shiftKey ? -12 : -1),
    PageDown: () => sameDayIn(d, e.shiftKey ? 12 : 1),
  }
  const next = steps[e.key]?.()
  if (!next) return
  e.preventDefault()
  // Years outside of four digits are no dates here.
  if (/^\d{4}-/.test(next)) void focusDay(next)
}

/* ---------- end and time */

function toggleEnd() {
  withEnd.value = !withEnd.value
  side.value = withEnd.value ? 'end' : 'start'
  if (start.value) save(start.value, withEnd.value ? end.value ?? start.value : null)
}
function toggleTime() {
  withTime.value = !withTime.value
  if (start.value) save(start.value, end.value)
}
function setTime(which: 'start' | 'end', e: Event) {
  const t = (e.target as HTMLInputElement).value
  const s = start.value
  if (!/^\d\d:\d\d$/.test(t) || !s) return
  if (which === 'start') save(`${day(s)}T${t}`, end.value)
  else save(s, `${day(end.value) ?? day(s)}T${t}`)
}
</script>

<template>
  <div class="pl-date">
    <div class="pl-date__fields">
      <div v-for="which in (withEnd ? ['start', 'end'] as const : ['start'] as const)" :key="which" class="pl-date__field" :class="{ 'is-on': withEnd && side === which, 'is-bad': bad === which }">
        <input
          v-model="drafts[which]"
          type="text"
          :data-autofocus="which === 'start' ? '' : undefined"
          :aria-label="which === 'start' ? strings.start : strings.end"
          :aria-invalid="bad === which || undefined"
          :placeholder="which === 'start' ? strings.dateHint : strings.end"
          spellcheck="false"
          autocomplete="off"
          @focus="side = which; ($event.target as HTMLInputElement).select()"
          @change="commit(which)"
          @keydown="onInputKey($event, which)"
        >
        <input
          v-if="withTime && (which === 'start' ? start : end)"
          type="time"
          class="pl-date__time"
          :value="time(which === 'start' ? start : end)"
          :aria-label="which === 'start' ? strings.startTime : strings.endTime"
          @focus="side = which"
          @change="setTime(which, $event)"
        >
      </div>
      <p v-if="bad" class="pl-date__bad" role="alert">{{ strings.notADate }}</p>
    </div>

    <div class="pl-date__month">
      <span aria-live="polite">{{ monthText(month) }}</span>
      <component :is="IconButton" size="sm" :label="strings.previousMonth" @click="turn(-1)"><Icon name="chevron-left" /></component>
      <component :is="IconButton" size="sm" :label="strings.nextMonth" @click="turn(1)"><Icon name="chevron-right" /></component>
    </div>
    <div ref="grid" class="pl-date__grid" role="grid" :aria-label="monthText(month)" @keydown="onGridKey">
      <div class="pl-date__week" role="row">
        <span v-for="n in names" :key="n" class="pl-date__name" role="columnheader">{{ n }}</span>
      </div>
      <div v-for="week in weeks" :key="week[0]" class="pl-date__week" role="row">
        <span v-for="d in week" :key="d" role="gridcell" :aria-selected="isSelected(d)" class="pl-date__cell" :class="{ 'is-range': inRange(d) }">
          <button
            type="button"
            class="pl-date__day"
            :class="{ 'is-out': !d.startsWith(month), 'is-today': d === today, 'is-selected': isSelected(d) }"
            :data-day="d"
            :tabindex="d === tabDay ? 0 : -1"
            :aria-label="fullDate(d)"
            :aria-current="d === today ? 'date' : undefined"
            @click="pick(d)"
          >{{ Number(d.slice(8)) }}</button>
        </span>
      </div>
    </div>

    <div class="pl-date__foot">
      <button type="button" class="pl-date__opt" role="switch" :aria-checked="withEnd" @click="toggleEnd"><span>{{ strings.endDate }}</span><i class="pl-date__switch" aria-hidden="true" /></button>
      <button type="button" class="pl-date__opt" role="switch" :aria-checked="withTime" @click="toggleTime"><span>{{ strings.includeTime }}</span><i class="pl-date__switch" aria-hidden="true" /></button>
      <div class="pl-date__acts">
        <button type="button" class="pl-date__act" @click="pick(today)">{{ strings.today }}</button>
        <button v-if="value" type="button" class="pl-date__act" :title="dateText(value, store.now.value)" @click="emit('change', null); emit('done')">{{ strings.clear }}</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.pl-date { padding: var(--space-2); display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--space-2); }
.pl-date__fields { display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--space-1); }
.pl-date__field { display: flex; align-items: center; height: 30px; background: var(--bg-inset); border: 1px solid var(--line); border-radius: var(--radius-sm); }
.pl-date__field:focus-within { border-color: var(--accent-line); box-shadow: 0 0 0 3px var(--accent-soft); }
.pl-date__field.is-on:not(:focus-within) { border-color: var(--line-strong); }
.pl-date__field.is-bad { border-color: color-mix(in oklch, var(--ripe-error) 60%, transparent); }
.pl-date__field input { flex: 1; min-width: 0; height: 100%; padding: 0 var(--space-2); border: 0; background: none; font-size: var(--text-sm); font-variant-numeric: tabular-nums; }
.pl-date__field input:focus-visible { outline: none; }
.pl-date__field input::placeholder { color: var(--fg-faint); }
.pl-date__field .pl-date__time { flex: none; width: 84px; padding-right: 4px; border-left: 1px solid var(--line-soft); }
.pl-date__bad { margin: 0; font-size: var(--text-xs); color: var(--ripe-error-fg); }
.pl-date__month { display: flex; align-items: center; padding-left: var(--space-2); font-weight: 560; }
.pl-date__month span { flex: 1; }
.pl-date__week { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); }
.pl-date__name { height: 22px; line-height: 22px; text-align: center; font-size: var(--text-2xs); color: var(--fg-subtle); overflow: hidden; }
.pl-date__cell { display: grid; padding: 1px 0; }
.pl-date__cell.is-range { background: var(--accent-soft); }
.pl-date__day { height: 28px; border-radius: var(--radius-sm); font-size: var(--text-sm); font-variant-numeric: tabular-nums; color: var(--fg); }
.pl-date__day:hover { background: var(--bg-hover); }
.pl-date__day.is-out { color: var(--fg-faint); }
.pl-date__day.is-today { color: var(--accent-ink); font-weight: 640; }
.pl-date__day.is-selected { background: var(--accent); color: var(--accent-fg); }
.pl-date__foot { display: grid; padding-top: var(--space-1); border-top: 1px solid var(--line-soft); }
.pl-date__opt { display: flex; align-items: center; height: 30px; padding: 0 var(--space-2); border-radius: var(--radius-sm); font-size: var(--text-sm); color: var(--fg); text-align: left; }
.pl-date__opt span { flex: 1; }
.pl-date__opt:hover, .pl-date__act:hover { background: var(--bg-hover); }
.pl-date__switch { position: relative; width: 26px; height: 16px; border-radius: var(--radius-pill); background: var(--line-strong); transition: background var(--dur-fast) var(--ease-out); }
.pl-date__switch::after { content: ''; position: absolute; left: 2px; top: 2px; width: 12px; height: 12px; border-radius: 50%; background: var(--bg-raised); transition: transform var(--dur-fast) var(--ease-out); }
[aria-checked='true'] > .pl-date__switch { background: var(--accent); }
[aria-checked='true'] > .pl-date__switch::after { transform: translateX(10px); }
.pl-date__acts { display: flex; justify-content: space-between; }
.pl-date__act { height: 28px; padding: 0 var(--space-2); border-radius: var(--radius-sm); font-size: var(--text-sm); color: var(--fg-muted); }
.pl-date__act:hover { color: var(--fg); }
</style>
