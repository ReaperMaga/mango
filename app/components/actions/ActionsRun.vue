<script setup lang="ts">
import {
  ArrowRight, CircleCheck, CircleDashed, CircleMinus, CircleSlash, CircleX, Clock,
} from 'lucide-vue-next'
import type { ForgeProvider, GhRun, GhRunJob, GhRunState } from '~/types/ipc'
import type { RunRead } from '~/stores/releases'
import { formatLocale } from '~/i18n'
import { formatDuration, shortAgo, useNow } from '~/utils/time'
import { firstFailure, isActive, runDuration, sortJobs, typicalDuration } from '~/utils/releaseRuns'
import { knownEvent } from '~/utils/actionRuns'

/**
 * One workflow run (GitLab: pipeline) in the Actions tool window: its state, title, branch and commit,
 * what started it and how long it took, then its jobs (a job opens its log). Actions sit in the
 * window's footer.
 */
const props = defineProps<{
  run: GhRun
  /** Its jobs, as last read. */
  read: RunRead | undefined
  /** The runs listed, to tell how long a run of this workflow usually takes. */
  runs: GhRun[]
  repo: string
  provider: ForgeProvider
}>()
const emit = defineEmits<{ openJob: [job: GhRunJob] }>()

const { t } = useI18n()
const now = useNow(1000)
const gitlab = computed(() => props.provider === 'gitlab')
const jobs = computed(() => sortJobs(props.read?.detail?.jobs ?? []))
const active = computed(() => isActive(props.run.state))

const ICON = { failure: CircleX, cancelled: CircleSlash, pending: CircleDashed, queued: Clock, success: CircleCheck, neutral: CircleMinus, skipped: CircleSlash }
const tone = (s: GhRunState) => (s === 'pending' ? 'running' : s === 'success' ? 'done' : s === 'failure' ? 'error' : s === 'queued' ? 'queued' : 'idle')

const title = computed(() => props.run.title || (gitlab.value && props.run.workflow === 'Pipeline' ? t('actions.noTitle', { n: props.run.number }) : props.run.workflow))
const eventWord = computed(() => {
  const e = knownEvent(props.run.event)
  return e ? t(`actions.event.${e}`) : props.run.event
})
const ago = computed(() => {
  const at = Date.parse(props.run.createdAt)
  if (!Number.isFinite(at)) return ''
  const s = Math.max(0, Math.round((now.value - at) / 1000))
  if (s < 45) return t('common.time.justNow')
  const m = Math.round(s / 60)
  if (m < 60) return t('common.time.minAgo', { n: m })
  const h = Math.round(m / 60)
  if (h < 24) return t('releases.hoursAgo', h)
  const d = Math.round(h / 24)
  return d < 7 ? t('common.time.daysAgo', d) : t('releases.onDate', { date: shortAgo(at, now.value) })
})
/** How long it has gone on, or took. */
const took = computed(() => {
  const r = props.run
  if (!active.value) {
    const d = runDuration(r)
    return d === null ? null : formatDuration(d)
  }
  const start = Date.parse(r.startedAt ?? r.createdAt)
  return Number.isFinite(start) ? formatDuration(Math.max(0, now.value - start)) : null
})
/** About when a running run ends, from how long the last good ones of its workflow took. */
const eta = computed(() => {
  const r = props.run
  if (!active.value) return null
  const usual = typicalDuration(props.runs, r.workflowId, r.id)
  if (usual === null) return null
  const start = Date.parse(r.startedAt ?? r.createdAt)
  const minutes = Math.max(1, Math.round(usual / 60_000))
  if (now.value - start > usual) return t('releases.etaLonger', { minutes })
  const at = new Date(start + usual).toLocaleTimeString(formatLocale(), { hour: '2-digit', minute: '2-digit' })
  return t('releases.eta', { minutes, time: at })
})
const failed = computed(() => (active.value ? null : firstFailure(jobs.value)))

function jobTook(j: GhRunJob): string | null {
  if (j.state === 'queued' || j.state === 'skipped') return t(`actions.state.${j.state}`)
  if (!j.startedAt) return null
  const start = Date.parse(j.startedAt)
  const end = j.completedAt ? Date.parse(j.completedAt) : now.value
  return Number.isFinite(start) && Number.isFinite(end) ? formatDuration(Math.max(0, end - start)) : null
}
</script>

<template>
  <article class="ar" :aria-label="title">
    <div class="ar__top">
      <span class="ar__state" :class="`is-${tone(run.state)}`">
        <component :is="ICON[run.state]" :class="{ 'ar__turn': run.state === 'pending' }" aria-hidden="true" />
        <span>{{ t(`actions.state.${run.state}`) }}</span>
      </span>
      <span class="ar__ref" :title="repo">{{ repo }}</span>
    </div>

    <h3 class="ar__title selectable">{{ title }}</h3>
    <p class="ar__meta">
      <strong>{{ run.workflow }}</strong>
      <span class="tabular">#{{ run.number }}</span>
      <span v-if="run.attempt > 1">{{ t('actions.attempt', { n: run.attempt }) }}</span>
    </p>

    <dl class="ar__facts">
      <div v-if="run.headBranch" class="ar__fact">
        <dt>{{ t('releases.fact.branch') }}</dt>
        <dd><code class="ar__chip" :title="run.headBranch">{{ run.headBranch }}</code></dd>
      </div>
      <div v-if="run.headSha" class="ar__fact">
        <dt>{{ t('releases.fact.commit') }}</dt>
        <dd><code class="ar__chip" :title="run.headSha">{{ run.headSha.slice(0, 7) }}</code></dd>
      </div>
      <div class="ar__fact">
        <dt>{{ t('actions.fact.started') }}</dt>
        <dd><span class="ar__soft">{{ eventWord }} · {{ ago }}</span></dd>
      </div>
      <div v-if="took" class="ar__fact">
        <dt>{{ active ? t('actions.fact.running') : t('actions.fact.took') }}</dt>
        <dd><span class="ar__soft tabular" :class="{ 'is-running': active }">{{ took }}</span></dd>
      </div>
    </dl>
    <p v-if="eta" class="ar__eta">{{ eta }}</p>

    <h4 class="ar__sub">{{ t('actions.jobs') }}<span v-if="jobs.length" class="ar__count tabular">{{ jobs.length }}</span></h4>
    <p v-if="read?.error" class="ar__error selectable" role="alert">{{ t('releases.runError', { error: read.error }) }}</p>
    <ul v-if="jobs.length" class="ar__jobs" :aria-label="t('actions.jobs')">
      <li v-for="j in jobs" :key="j.id">
        <button type="button" class="ar__job" :title="t('releases.showLog')" @click="emit('openJob', j)">
          <component :is="ICON[j.state]" class="ar__job-icon" :class="[`is-${tone(j.state)}`, { 'ar__turn': j.state === 'pending' }]" aria-hidden="true" />
          <span class="sr-only">{{ t(`actions.state.${j.state}`) }}:</span>
          <span class="ar__job-name">{{ j.name }}</span>
          <span class="ar__job-took tabular" :class="{ 'is-running': j.state === 'pending' }">{{ jobTook(j) }}</span>
          <ArrowRight class="ar__job-go" aria-hidden="true" />
        </button>
      </li>
    </ul>
    <div v-else-if="!read?.detail && !read?.error" class="ar__skeleton" aria-busy="true" :aria-label="t('actions.reading')">
      <span v-for="w in [62, 48, 70]" :key="w"><i /><b :style="{ width: `${w}%` }" /></span>
    </div>
    <p v-else-if="!read?.error" class="ar__quiet">{{ t('actions.noJobs') }}</p>

    <p v-if="failed && run.state === 'failure'" class="ar__error selectable">
      <i18n-t keypath="releases.jobFailed" scope="global">
        <template #job><strong>{{ failed.name }}</strong></template>
      </i18n-t>
      {{ ' ' }}{{ t(`releases.rerunHint.${gitlab ? 'gitlab' : 'github'}`) }}
    </p>
  </article>
</template>

<style scoped>
.ar { display: flex; flex-direction: column; gap: var(--space-2); padding: var(--space-3) var(--space-4) var(--space-6); }

.ar__top { display: flex; align-items: center; gap: 6px; min-width: 0; font-size: var(--text-xs); }
.ar__state { flex: none; display: inline-flex; align-items: center; gap: 5px; font-weight: 560; }
.ar__state svg { width: 14px; height: 14px; stroke-width: 1.85; }
.ar__ref { min-width: 0; margin-left: auto; color: var(--fg-faint); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

/* Ripeness: running is ripening, passed is ripe, failed is bruised, waiting is not ripe yet. */
.is-running { color: var(--ripe-running-fg); }
.is-running svg, svg.is-running { color: var(--ripe-running); }
.is-done { color: var(--ripe-done-fg); }
.is-done svg, svg.is-done { color: var(--ripe-done); }
.is-error { color: var(--ripe-error-fg); }
.is-error svg, svg.is-error { color: var(--ripe-error); }
.is-queued { color: var(--ripe-queued-fg); }
.is-queued svg, svg.is-queued { color: var(--ripe-queued); }
.is-idle, .is-idle svg, svg.is-idle { color: var(--fg-subtle); }
.ar__turn { animation: ar-turn 2.4s linear infinite; }
@keyframes ar-turn { to { transform: rotate(360deg); } }

.ar__title {
  margin: 0;
  font-size: var(--text-lg);
  font-weight: 620;
  line-height: var(--leading-tight);
  letter-spacing: -0.01em;
  color: var(--fg);
  overflow-wrap: anywhere;
  text-wrap: balance;
}
.ar__meta { display: flex; align-items: center; gap: var(--space-2); margin: 0; font-size: var(--text-xs); color: var(--fg-subtle); }
.ar__meta strong { font-weight: 560; color: var(--fg-muted); }

.ar__facts { display: grid; gap: 4px; margin: var(--space-1) 0 0; padding: var(--space-2) 0; border-block: 1px solid var(--line-soft); }
.ar__fact { display: grid; grid-template-columns: 72px 1fr; align-items: center; gap: var(--space-2); min-height: 22px; font-size: var(--text-xs); }
.ar__fact dt { color: var(--fg-faint); }
.ar__fact dd { display: flex; align-items: center; gap: 6px; min-width: 0; margin: 0; color: var(--fg-muted); }
.ar__chip {
  flex: none;
  max-width: 100%;
  height: 18px;
  padding: 0 5px;
  border-radius: var(--radius-xs);
  background: var(--bg-hover);
  border: 1px solid var(--line-soft);
  font-size: var(--text-2xs);
  line-height: 16px;
  color: var(--fg-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ar__soft { min-width: 0; color: var(--fg-faint); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ar__soft.is-running { flex: none; color: var(--ripe-running-fg); }
.ar__eta { margin: 0; font-size: var(--text-xs); color: var(--fg-subtle); }

.ar__sub { display: flex; align-items: baseline; gap: 6px; margin: var(--space-2) 0 0; font-size: var(--text-sm); font-weight: 600; color: var(--fg); }
.ar__count { font-size: var(--text-xs); font-weight: 400; color: var(--fg-faint); }
.ar__quiet { margin: 0; font-size: var(--text-sm); color: var(--fg-faint); }

.ar__jobs { display: grid; gap: 1px; margin: 0 calc(-1 * var(--space-2)); padding: 0; list-style: none; }
.ar__job {
  display: flex;
  align-items: center;
  gap: var(--space-2);
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
.ar__job:hover { background: var(--bg-hover); color: var(--fg); }
.ar__job:active { background: var(--bg-active); }
.ar__job:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: -2px; }
.ar__job-icon { flex: none; width: 14px; height: 14px; stroke-width: 1.9; }
.ar__job-name { min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ar__job-took { flex: none; margin-left: auto; font-size: var(--text-xs); color: var(--fg-faint); }
.ar__job-took.is-running { color: var(--ripe-running-fg); }
.ar__job-go { flex: none; width: 12px; height: 12px; color: var(--fg-faint); opacity: 0; transition: opacity var(--dur-fast) var(--ease-out); }
.ar__job:hover .ar__job-go, .ar__job:focus-visible .ar__job-go { opacity: 1; }

.ar__error {
  margin: var(--space-1) 0 0;
  padding: var(--space-2) var(--space-3);
  border: 1px solid color-mix(in oklch, var(--ripe-error) 45%, transparent);
  border-radius: var(--radius-md);
  background: color-mix(in oklch, var(--ripe-error) 10%, transparent);
  font-size: var(--text-xs);
  color: var(--ripe-error-fg);
  overflow-wrap: anywhere;
}
.ar__error strong { font-weight: 600; }

.ar__skeleton { display: grid; gap: 12px; padding: var(--space-1) 0; }
.ar__skeleton span { display: flex; align-items: center; gap: var(--space-2); }
.ar__skeleton i { width: 14px; height: 14px; border-radius: var(--radius-xs); background: var(--bg-hover); }
.ar__skeleton b { height: 9px; border-radius: var(--radius-xs); background: var(--bg-hover); }
</style>
