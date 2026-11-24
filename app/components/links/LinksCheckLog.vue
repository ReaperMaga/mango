<script setup lang="ts">
import { ChevronDown, ChevronRight, Circle, CircleCheck, CircleDashed, CircleMinus, CircleSlash, CircleX } from 'lucide-vue-next'
import type { GhJobStep, GhRunState } from '~/types/ipc'
import { jobProvider, useLinks, type OpenCheck } from '~/stores/links'
import { formatLocale } from '~/i18n'
import { forgeName } from '~/utils/forge'
import { parseStepLog, type LogEntry, type LogLine, type LogSpan } from '~/utils/actionsLog'
import { formatDuration, useNow } from '~/utils/time'

/**
 * A GitHub Actions job's (or GitLab pipeline job's) log in the Pull requests tool window, laid out
 * like GitHub's own job page: the job's steps in order (GitLab: its sections), each opening to its
 * log, where `##[group]` sections fold and errors stand out. A failed step opens by itself and the
 * first error scrolls into view. While the job runs, its steps update every few seconds; the forge
 * hands out the log once the job has finished.
 */
const props = defineProps<{ check: OpenCheck }>()

const { t } = useI18n()
const links = useLinks()
const now = useNow(1000)
const detail = computed(() => links.jobs[props.check.url])
const job = computed(() => detail.value?.job ?? null)
const running = (s: GhRunState) => s === 'pending' || s === 'queued'
const finished = computed(() => !!job.value && !running(job.value.state))
/** Where the job runs, known from its link before it is read. */
const forge = computed(() => forgeName(job.value?.provider ?? jobProvider(props.check.url)))

/* ---------- reading, and keeping a running job current ---------- */
const POLL_MS = 5_000
/** Just after a job ends GitHub may not have its log yet: ask again for this long. */
const LOG_GRACE_MS = 120_000
let poller: ReturnType<typeof setTimeout> | undefined

function wantsMore(): boolean {
  const j = job.value
  if (!j) return false
  if (running(j.state)) return true
  if (j.logReady) return false
  const ended = j.completedAt ? Date.parse(j.completedAt) : 0
  return Date.now() - ended < LOG_GRACE_MS
}
function schedule() {
  clearTimeout(poller)
  const d = detail.value
  if (!d || d.loading || !wantsMore()) return
  poller = setTimeout(() => {
    if (document.hidden) { schedule(); return }
    void links.loadJob(props.check.url)
  }, d.error ? POLL_MS * 3 : POLL_MS)
}
onMounted(() => {
  // A finished job's log never changes (a re-run is another job), so what was read stays good.
  if (!(job.value?.logReady && finished.value)) void links.loadJob(props.check.url)
})
watch(() => [detail.value?.loading, detail.value?.fetchedAt], schedule, { immediate: true })
onBeforeUnmount(() => clearTimeout(poller))

/* ---------- states and times ---------- */
const ICON = { failure: CircleX, cancelled: CircleSlash, pending: CircleDashed, queued: Circle, success: CircleCheck, neutral: CircleMinus, skipped: CircleSlash }
const word = (s: GhRunState) => t(`links.run.${s}`)

function took(from: string | null, to: string | null): string | null {
  if (!from) return null
  const start = Date.parse(from)
  const end = to ? Date.parse(to) : now.value
  return Number.isFinite(start) && Number.isFinite(end) ? formatDuration(Math.max(0, end - start)) : null
}
const jobTook = computed(() => (job.value ? took(job.value.startedAt, job.value.completedAt) : null))
const state = computed<GhRunState | null>(() => job.value?.state ?? null)

/* ---------- steps and their logs ---------- */
/** Parsed once per read: the arrays only change when the job is read again. */
const parsed = computed(() => {
  const out = new Map<number, LogEntry[]>()
  for (const s of job.value?.steps ?? []) if (s.lines.length) out.set(s.number, parseStepLog(s.lines, s.omitted + 1))
  return out
})

/** The user's own open/closed choice per step and per group; otherwise failures open by themselves. */
const stepChoice = ref(new Map<number, boolean>())
const groupChoice = ref(new Map<string, boolean>())
const hasLog = (s: GhJobStep) => s.lines.length > 0 || s.omitted > 0
const stepOpen = (s: GhJobStep) => hasLog(s) && (stepChoice.value.get(s.number) ?? s.state === 'failure')
function toggleStep(s: GhJobStep) {
  if (hasLog(s)) stepChoice.value.set(s.number, !stepOpen(s))
}
const groupKey = (s: GhJobStep, head: LogLine) => `${s.number}:${head.n}`
const groupHasError = (lines: LogLine[]) => lines.some(l => l.level === 'error')
function groupOpen(s: GhJobStep, e: Extract<LogEntry, { kind: 'group' }>) {
  return groupChoice.value.get(groupKey(s, e.head)) ?? groupHasError(e.lines)
}
function toggleGroup(s: GhJobStep, e: Extract<LogEntry, { kind: 'group' }>) {
  groupChoice.value.set(groupKey(s, e.head), !groupOpen(s, e))
}
/** The gutter fits the step's largest line number. */
const gutter = (s: GhJobStep) => `${String(s.omitted + s.lines.length).length + 1}ch`

const spanClass = (s: LogSpan) => [
  s.fg && `fg-${s.fg}`,
  { 'is-bold': s.bold, 'is-dim': s.dim, 'is-italic': s.italic, 'is-underline': s.underline },
]

/* ---------- the first error, in view once the log arrives ---------- */
const root = ref<HTMLElement | null>(null)
let scrolled = false
watch(() => job.value?.logReady, async (ready) => {
  if (!ready || scrolled) return
  scrolled = true
  await nextTick()
  const line = root.value?.querySelector<HTMLElement>('.cl__line.is-error')
  // Only the tool window's own scroll area moves: scrollIntoView would also scroll the window's frame.
  let box = line?.parentElement ?? null
  while (box && !/(auto|scroll)/.test(getComputedStyle(box).overflowY)) box = box.parentElement
  if (line && box) box.scrollTop += line.getBoundingClientRect().top - box.getBoundingClientRect().top - box.clientHeight / 2
}, { immediate: true })
</script>

<template>
  <article ref="root" class="cl" :aria-label="t('links.log.label', { name: check.name })" :aria-busy="detail?.loading || undefined">
    <div class="cl__top">
      <span v-if="state" class="cl__state" :class="`is-${state}`">
        <component :is="ICON[state]" class="cl__icon" aria-hidden="true" />
        <span>{{ word(state) }}</span>
      </span>
      <span class="cl__ref">
        <span v-if="job?.workflow ?? check.workflow">{{ job?.workflow ?? check.workflow }}</span>
        <span v-if="jobTook" class="tabular">{{ jobTook }}</span>
      </span>
    </div>
    <h3 class="cl__title selectable">{{ job?.name || check.name }}</h3>

    <p v-if="detail?.error" class="cl__error selectable" role="alert">
      {{ job ? t('links.couldNotRefresh', { error: detail.error }) : detail.error }}
    </p>
    <LinksHostingButton :error="detail?.error" />

    <div v-if="!job && detail?.loading !== false && !detail?.error" class="cl__skeleton" :aria-label="t('links.reading', { forge })">
      <span v-for="w in [44, 70, 58, 66, 38, 52]" :key="w" :style="{ width: `${w}%` }" />
    </div>

    <template v-if="job">
      <p v-if="!finished" class="cl__note">
        {{ t('links.log.running') }}
      </p>
      <p v-else-if="job.logError" class="cl__note">{{ job.logError }}</p>

      <ol class="cl__steps" :aria-label="t('links.log.steps')">
        <li v-for="s in job.steps" :key="s.number" class="cl__step-item">
          <button
            type="button"
            class="cl__step"
            :class="{ 'is-open': stepOpen(s) }"
            :disabled="!hasLog(s) || undefined"
            :aria-expanded="hasLog(s) ? stepOpen(s) : undefined"
            @click="toggleStep(s)"
          >
            <component :is="stepOpen(s) ? ChevronDown : ChevronRight" class="cl__chev" :class="{ 'is-hidden': !hasLog(s) }" aria-hidden="true" />
            <component :is="ICON[s.state]" class="cl__icon" :class="`is-${s.state}`" aria-hidden="true" />
            <span class="sr-only">{{ word(s.state) }}:</span>
            <span class="cl__step-name">{{ s.name }}</span>
            <span v-if="s.state !== 'skipped' && took(s.startedAt, s.completedAt)" class="cl__step-took tabular">{{ took(s.startedAt, s.completedAt) }}</span>
          </button>

          <div v-if="stepOpen(s)" class="cl__log selectable" :style="{ '--gutter': gutter(s) }">
            <p v-if="s.omitted" class="cl__omitted">
              {{ t('links.log.omitted', { lines: s.omitted.toLocaleString(formatLocale()), forge }, s.omitted) }}
            </p>
            <template v-for="e in parsed.get(s.number) ?? []" :key="e.kind === 'line' ? e.line.n : e.head.n">
              <div v-if="e.kind === 'line'" class="cl__line" :class="e.line.level && `is-${e.line.level}`">
                <span class="cl__n" aria-hidden="true">{{ e.line.n }}</span>
                <span class="cl__t"><span v-for="(sp, i) in e.line.spans" :key="i" :class="spanClass(sp)">{{ sp.text }}</span></span>
              </div>
              <template v-else>
                <div class="cl__line is-group">
                  <span class="cl__n" aria-hidden="true">{{ e.head.n }}</span>
                  <button type="button" class="cl__t cl__fold" :aria-expanded="groupOpen(s, e)" @click="toggleGroup(s, e)">
                    <component :is="groupOpen(s, e) ? ChevronDown : ChevronRight" class="cl__fold-chev" aria-hidden="true" />
                    <span><span v-for="(sp, i) in e.head.spans" :key="i" :class="spanClass(sp)">{{ sp.text }}</span></span>
                  </button>
                </div>
                <template v-if="groupOpen(s, e)">
                  <div v-for="l in e.lines" :key="l.n" class="cl__line is-inner" :class="l.level && `is-${l.level}`">
                    <span class="cl__n" aria-hidden="true">{{ l.n }}</span>
                    <span class="cl__t"><span v-for="(sp, i) in l.spans" :key="i" :class="spanClass(sp)">{{ sp.text }}</span></span>
                  </div>
                </template>
              </template>
            </template>
          </div>
        </li>
      </ol>

      <p v-if="job.logTruncated" class="cl__note">{{ t('links.log.truncated', { forge }) }}</p>
    </template>
  </article>
</template>

<style scoped>
.cl { display: flex; flex-direction: column; gap: var(--space-2); padding: var(--space-3) var(--space-4) var(--space-6); }

.cl__top { display: flex; align-items: center; gap: var(--space-2); min-width: 0; font-size: var(--text-xs); }
.cl__state { flex: none; display: inline-flex; align-items: center; gap: 5px; font-weight: 560; }
.cl__ref { display: flex; gap: var(--space-2); min-width: 0; margin-left: auto; color: var(--fg-faint); white-space: nowrap; }
.cl__ref > span { min-width: 0; overflow: hidden; text-overflow: ellipsis; }

.cl__title {
  margin: 0;
  font-size: var(--text-lg);
  font-weight: 620;
  line-height: var(--leading-tight);
  letter-spacing: -0.01em;
  color: var(--fg);
  overflow-wrap: anywhere;
  text-wrap: balance;
}

/* State colours: the mark grade on icons, the text grade on words. */
.cl__icon { flex: none; width: 14px; height: 14px; stroke-width: 1.9; }
.is-success .cl__icon, .cl__icon.is-success { color: var(--ripe-done); }
.is-failure .cl__icon, .cl__icon.is-failure { color: var(--ripe-error); }
.is-pending .cl__icon, .cl__icon.is-pending { color: var(--ripe-running); animation: cl-turn 2.4s linear infinite; }
.is-queued .cl__icon, .cl__icon.is-queued,
.is-cancelled .cl__icon, .cl__icon.is-cancelled,
.is-skipped .cl__icon, .cl__icon.is-skipped,
.is-neutral .cl__icon, .cl__icon.is-neutral { color: var(--fg-faint); }
.cl__state.is-success { color: var(--ripe-done-fg); }
.cl__state.is-failure { color: var(--ripe-error-fg); }
.cl__state.is-pending { color: var(--ripe-running-fg); }
.cl__state.is-queued, .cl__state.is-cancelled, .cl__state.is-skipped, .cl__state.is-neutral { color: var(--fg-subtle); }
@keyframes cl-turn { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .cl__icon { animation: none !important; } }

.cl__error {
  margin: 0;
  padding: var(--space-2) var(--space-3);
  border: 1px solid color-mix(in oklch, var(--ripe-error) 45%, transparent);
  border-radius: var(--radius-md);
  background: color-mix(in oklch, var(--ripe-error) 10%, transparent);
  font-size: var(--text-xs);
  color: var(--ripe-error-fg);
  overflow-wrap: anywhere;
}
.cl__note { margin: 0; font-size: var(--text-xs); color: var(--fg-subtle); max-width: 60ch; }
.cl__skeleton { display: grid; gap: 12px; padding-top: var(--space-3); }
.cl__skeleton span { height: 10px; border-radius: var(--radius-xs); background: var(--bg-hover); }

/* Steps: one row each, the log opening underneath. */
.cl__steps { display: grid; gap: 1px; margin: var(--space-1) calc(-1 * var(--space-2)) 0; padding: var(--space-2) 0 0; border-top: 1px solid var(--line-soft); list-style: none; }
.cl__step {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  min-width: 0;
  height: 28px;
  padding: 0 var(--space-2);
  border-radius: var(--radius-sm);
  font-size: var(--text-sm);
  text-align: left;
  color: var(--fg-muted);
  transition: background var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out);
}
.cl__step:not(:disabled):hover { background: var(--bg-hover); color: var(--fg); }
.cl__step.is-open { color: var(--fg); }
.cl__step:disabled { cursor: default; }
.cl__step:focus-visible, .cl__fold:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: -2px; }
.cl__chev { flex: none; width: 12px; height: 12px; color: var(--fg-faint); }
.cl__chev.is-hidden { visibility: hidden; }
.cl__step-name { min-width: 0; flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.cl__step-took { flex: none; font-size: var(--text-xs); color: var(--fg-faint); }

/* The log: monospace, numbered, wrapped to the window rather than scrolled sideways. */
.cl__log {
  margin: 2px 0 var(--space-2);
  padding: var(--space-2) 0;
  border-radius: var(--radius-md);
  background: var(--bg-inset);
  font-family: var(--font-mono);
  font-size: var(--text-2xs);
  line-height: 1.6;
  color: var(--fg-muted);
}
.cl__omitted { margin: 0 0 var(--space-1); padding: 0 var(--space-3); font-family: var(--font-ui); font-size: var(--text-xs); color: var(--fg-subtle); }
.cl__line { display: grid; grid-template-columns: var(--gutter, 4ch) minmax(0, 1fr); column-gap: var(--space-2); padding: 0 var(--space-2) 0 0; }
.cl__line:hover { background: var(--bg-hover); }
.cl__n { text-align: right; color: var(--fg-faint); font-variant-numeric: tabular-nums; user-select: none; }
.cl__t { min-width: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.cl__line.is-inner .cl__t { padding-left: 16px; }

.cl__fold { display: flex; align-items: flex-start; gap: 4px; width: 100%; text-align: left; font: inherit; color: var(--fg); border-radius: var(--radius-xs); }
.cl__fold > span { min-width: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.cl__fold-chev { flex: none; width: 12px; height: 12px; margin-top: 0.3em; color: var(--fg-faint); }

.cl__line.is-error { background: color-mix(in oklch, var(--ripe-error) 12%, transparent); }
.cl__line.is-error .cl__t { color: var(--ripe-error-fg); }
.cl__line.is-warning { background: color-mix(in oklch, var(--term-yellow) 9%, transparent); }
.cl__line.is-warning .cl__t { color: var(--term-yellow); }
.cl__line.is-notice .cl__t { color: var(--term-blue); }
.cl__line.is-command .cl__t { color: var(--term-blue); }
.cl__line.is-debug .cl__t { color: var(--fg-faint); }

/* ANSI colours, from the terminal's palette. */
.fg-black, .fg-gray { color: var(--term-bright-black); }
.fg-red { color: var(--term-red); }
.fg-green { color: var(--term-green); }
.fg-yellow { color: var(--term-yellow); }
.fg-blue { color: var(--term-blue); }
.fg-magenta { color: var(--term-magenta); }
.fg-cyan { color: var(--term-cyan); }
.fg-white { color: var(--fg); }
.is-bold { font-weight: 600; }
.is-dim { opacity: 0.7; }
.is-italic { font-style: italic; }
.is-underline { text-decoration: underline; text-underline-offset: 2px; }
</style>
