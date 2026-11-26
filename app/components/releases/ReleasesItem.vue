<script setup lang="ts">
import {
  ArrowRight, ChevronDown, ChevronRight, CircleCheck, CircleDashed, CircleMinus, CircleSlash, CircleX, Clock, Download, Tag,
} from 'lucide-vue-next'
import type { ForgeProvider, GhRun, GhRunJob, GhRunState } from '~/types/ipc'
import type { RunRead } from '~/stores/releases'
import { openExternal } from '~/composables/useBackend'
import { safeHtml } from '~/utils/safeHtml'
import { formatLocale } from '~/i18n'
import { capital } from '~/utils/forge'
import { formatDuration, shortAgo, useNow } from '~/utils/time'
import {
  entryState, firstFailure, formatSize, groupAssets, isActive, jobSummary, runDuration, sortJobs, totalDownloads, typicalDuration,
  type ReleaseEntry,
} from '~/utils/releaseRuns'

/**
 * One release in the Releases tool window, or a release workflow run that has no release: its state,
 * tag and commit, the workflow run (GitLab: pipeline) that builds it with its jobs (a job opens its
 * log), then its files by platform and its notes as GitHub or GitLab renders them. Actions sit in the
 * window's footer.
 */
const props = defineProps<{
  entry: ReleaseEntry
  /** Its run with jobs, as last read. */
  read: RunRead | undefined
  /** The repository's recent runs, to tell how long a build usually takes. */
  runs: GhRun[]
  repo: string
  latest: boolean
  /** Where it lives; GitHub unless said. */
  provider?: ForgeProvider
}>()
const gitlab = computed(() => props.provider === 'gitlab')
/** The run's name before its summary; a GitLab pipeline without a name of its own goes without ("Pipeline" is the label already). */
const flowName = computed(() => (run.value && !(gitlab.value && run.value.workflow === 'Pipeline') ? `${run.value.workflow} · ` : ''))
const emit = defineEmits<{ openJob: [job: GhRunJob] }>()

const { t } = useI18n()
const now = useNow(1000)
const release = computed(() => (props.entry.kind === 'release' ? props.entry.release : null))
/** The run as read with its jobs, else as the list knows it. */
const run = computed<GhRun | null>(() => props.read?.detail?.run ?? props.entry.run)
const jobs = computed(() => sortJobs(props.read?.detail?.jobs ?? []))
const state = computed(() => entryState({ ...props.entry, run: run.value } as ReleaseEntry))
const summary = computed(() => (jobs.value.length ? { tone: jobSummary(jobs.value).tone, text: summaryText(jobs.value) } : null))
/** `jobSummary`'s line, in the interface's language. */
function summaryText(all: GhRunJob[]): string {
  const n = (...s: GhRunState[]) => all.filter(j => s.includes(j.state)).length
  const [failedJobs, activeJobs, passed, skipped] = [n('failure'), n('pending', 'queued'), n('success'), n('skipped', 'neutral')]
  if (activeJobs) {
    return failedJobs
      ? t('releases.summary.failedRunning', { failed: failedJobs, active: activeJobs })
      : t('releases.summary.done', { finished: all.length - activeJobs, total: all.length })
  }
  if (failedJobs) return passed ? t('releases.summary.failedPassed', { failed: failedJobs, passed }) : t('releases.summary.failed', { failed: failedJobs })
  if (n('cancelled')) return t('releases.summary.cancelled')
  return skipped ? t('releases.summary.passedSkipped', { skipped }) : t('releases.summary.passed')
}
/** The toggle's words: the run's name, what its jobs add up to, and how long a finished run took. */
const summaryLine = computed(() => {
  const text = summary.value?.text ?? ''
  const line = flowName.value ? `${flowName.value}${text}` : capital(text)
  return took.value && !active.value ? t('releases.summary.took', { summary: line, took: took.value }) : line
})
const stateWord = computed(() => {
  const r = release.value
  if (state.value.mark !== 'tag' || !r) return t(`releases.state.${state.value.mark}`)
  if (r.draft) return t('releases.draft')
  if (!r.publishedAt) return t('releases.upcoming')
  return r.prerelease ? t('releases.prerelease') : t('releases.state.published')
})
const active = computed(() => !!run.value && isActive(run.value.state))

const title = computed(() => {
  const e = props.entry
  if (e.kind === 'release') return e.release.name
  return e.why === 'trial' ? t('releases.trialBuild') : (e.run.headBranch ?? t('releases.releaseBuild'))
})

const ago = (iso: string | null | undefined) => {
  const at = iso ? Date.parse(iso) : Number.NaN
  if (!Number.isFinite(at)) return null
  const s = Math.max(0, Math.round((now.value - at) / 1000))
  if (s < 45) return t('common.time.justNow')
  const m = Math.round(s / 60)
  if (m < 60) return t('common.time.minAgo', { n: m })
  const h = Math.round(m / 60)
  if (h < 24) return t('releases.hoursAgo', h)
  const d = Math.round(h / 24)
  return d < 7 ? t('common.time.daysAgo', d) : t('releases.onDate', { date: shortAgo(at, now.value) })
}
const byline = computed(() => {
  const r = release.value
  if (r) {
    const who = r.author?.login.replace(/\[bot\]$/, '') ?? t('releases.someone')
    if (r.publishedAt) return { who, key: 'published', ago: ago(r.publishedAt) }
    // GitLab has no drafts: a release without a date gone by is one set to come out later.
    return { who, key: r.draft || !gitlab.value ? 'drafted' : 'created', ago: ago(r.createdAt) }
  }
  const e = props.entry as Extract<ReleaseEntry, { kind: 'run' }>
  return { who: e.run.workflow, key: e.why, ago: ago(e.run.createdAt) }
})
const downloads = computed(() => (release.value ? totalDownloads(release.value.assets) : 0))

/* ---------- the run ---------- */
/** How long the run has gone on, or took. */
const took = computed(() => {
  const r = run.value
  if (!r) return null
  if (!active.value) {
    const d = runDuration(r)
    return d === null ? null : formatDuration(d)
  }
  const start = Date.parse(r.startedAt ?? r.createdAt)
  return Number.isFinite(start) ? formatDuration(Math.max(0, now.value - start)) : null
})
/** About when a running build ends, from how long the last good ones took. */
const eta = computed(() => {
  const r = run.value
  if (!r || !active.value) return null
  const usual = typicalDuration(props.runs, r.workflowId, r.id)
  if (usual === null) return null
  const start = Date.parse(r.startedAt ?? r.createdAt)
  const minutes = Math.max(1, Math.round(usual / 60_000))
  if (now.value - start > usual) return t('releases.etaLonger', { minutes })
  const at = new Date(start + usual).toLocaleTimeString(formatLocale(), { hour: '2-digit', minute: '2-digit' })
  return t('releases.eta', { minutes, time: at })
})
const failed = computed(() => (active.value ? null : firstFailure(jobs.value)))

/** The jobs open by themselves while anything is not green; the user's own choice sticks. */
const listChoice = ref<boolean | null>(null)
const listOpen = computed(() => listChoice.value ?? (!!summary.value && summary.value.tone !== 'done'))
watch(() => props.entry.key, () => { listChoice.value = null })

const ICON = { failure: CircleX, cancelled: CircleSlash, pending: CircleDashed, queued: Clock, success: CircleCheck, neutral: CircleMinus, skipped: CircleSlash }
const word = (s: GhRunState) => (s === 'queued' ? t('releases.waiting') : t(`links.run.${s}`))
const SUMMARY_ICON = { running: CircleDashed, done: CircleCheck, error: CircleX, idle: CircleSlash }
const STATE_ICON = { running: CircleDashed, failed: CircleX, cancelled: CircleSlash, passed: CircleCheck, tag: Tag }

function jobTook(j: GhRunJob): string | null {
  if (j.state === 'queued' || j.state === 'skipped') return word(j.state)
  if (!j.startedAt) return null
  const start = Date.parse(j.startedAt)
  const end = j.completedAt ? Date.parse(j.completedAt) : now.value
  return Number.isFinite(start) && Number.isFinite(end) ? formatDuration(Math.max(0, end - start)) : null
}
const jobTone = (s: GhRunState) => (s === 'pending' ? 'running' : s === 'success' ? 'done' : s === 'failure' ? 'error' : 'idle')

/* ---------- files and notes ---------- */
/** `groupAssets`' groups: the platforms keep their names. */
const platformLabel = (p: string) => (p === 'Updater' ? t('releases.platform.updater') : p === 'Other' ? t('releases.platform.other') : p)
const assets = computed(() => (release.value ? groupAssets(release.value.assets) : null))
/** GitLab's links and uploads from the server's root are read against the release's own server. */
const body = computed(() => safeHtml(release.value?.bodyHtml ?? '', release.value?.url))

/** Links in the notes open in the browser, never inside Mango's window. */
function onBodyClick(e: MouseEvent) {
  const a = (e.target as HTMLElement | null)?.closest?.('a[href]') as HTMLAnchorElement | null
  if (!a) return
  e.preventDefault()
  if (/^(https?:|mailto:)/i.test(a.href)) openExternal(a.href).catch(() => {})
}
function download(url: string) { openExternal(url).catch(() => {}) }
</script>

<template>
  <article class="ri" :aria-label="title">
    <div class="ri__top">
      <span class="ri__state" :class="`is-${state.tone}`">
        <component :is="STATE_ICON[state.mark]" :class="{ 'ri__turn': state.mark === 'running' }" aria-hidden="true" />
        <span>{{ stateWord }}</span>
      </span>
      <span v-if="latest" class="ri__pill is-latest">{{ t('releases.latest') }}</span>
      <span v-if="release?.prerelease" class="ri__pill is-pre">{{ t('releases.prerelease') }}</span>
      <span v-if="release?.draft && state.word !== 'Draft'" class="ri__pill is-draft">{{ t('releases.draft') }}</span>
      <span class="ri__ref" :title="repo">{{ repo }}</span>
    </div>

    <h3 class="ri__title selectable">{{ title }}</h3>

    <p class="ri__meta">
      <img v-if="release?.author?.avatarUrl" class="ri__avatar" :src="release.author.avatarUrl" alt="" referrerpolicy="no-referrer">
      <i18n-t :keypath="`releases.byline.${byline.key}`" tag="span" scope="global" class="ri__by">
        <template #who><strong>{{ byline.who }}</strong></template>
        <template #ago>{{ byline.ago }}</template>
      </i18n-t>
      <span v-if="downloads" class="ri__downloads tabular" :title="t('releases.downloads', downloads)">
        <Download aria-hidden="true" />{{ downloads }}
      </span>
    </p>

    <dl class="ri__facts">
      <div v-if="release" class="ri__fact">
        <dt>{{ t('releases.fact.tag') }}</dt>
        <dd>
          <code class="ri__chip" :title="release.tag">{{ release.tag }}</code>
          <span v-if="release.target" class="ri__soft">{{ t('releases.from', { target: release.target }) }}</span>
        </dd>
      </div>
      <div v-else-if="run?.headBranch" class="ri__fact">
        <dt>{{ entry.kind === 'run' && entry.why === 'trial' ? t('releases.fact.branch') : t('releases.fact.tag') }}</dt>
        <dd><code class="ri__chip" :title="run.headBranch">{{ run.headBranch }}</code></dd>
      </div>
      <div v-if="run?.headSha" class="ri__fact">
        <dt>{{ t('releases.fact.commit') }}</dt>
        <dd>
          <code class="ri__chip" :title="run.headSha">{{ run.headSha.slice(0, 7) }}</code>
          <span v-if="run.title" class="ri__soft" :title="run.title">{{ run.title }}</span>
        </dd>
      </div>
      <div v-if="run" class="ri__fact">
        <dt>{{ gitlab ? t('releases.fact.pipeline') : t('releases.fact.workflow') }}</dt>
        <dd>
          <button
            v-if="summary"
            type="button"
            class="ri__toggle"
            :class="`is-${summary.tone}`"
            :aria-expanded="listOpen"
            aria-controls="ri-jobs"
            @click="listChoice = !listOpen"
          >
            <component :is="SUMMARY_ICON[summary.tone]" class="ri__toggle-icon" :class="{ 'ri__turn': summary.tone === 'running' }" aria-hidden="true" />
            <span>{{ summaryLine }}</span>
            <component :is="listOpen ? ChevronDown : ChevronRight" class="ri__chev" aria-hidden="true" />
          </button>
          <span v-else class="ri__soft">{{ read?.loading ? t('releases.reading', { workflow: run.workflow }) : run.workflow }}</span>
        </dd>
      </div>
    </dl>
    <ul v-if="summary && listOpen" id="ri-jobs" class="ri__jobs" :aria-label="t('releases.jobs')">
      <li v-for="j in jobs" :key="j.id">
        <button type="button" class="ri__job" :title="t('releases.showLog')" @click="emit('openJob', j)">
          <component :is="ICON[j.state]" class="ri__job-icon" :class="[`is-${jobTone(j.state)}`, { 'ri__turn': j.state === 'pending' }]" aria-hidden="true" />
          <span class="sr-only">{{ word(j.state) }}:</span>
          <span class="ri__job-name">{{ j.name }}</span>
          <span class="ri__job-took tabular" :class="{ 'is-running': j.state === 'pending' }">{{ jobTook(j) }}</span>
          <ArrowRight class="ri__job-go" aria-hidden="true" />
        </button>
      </li>
    </ul>
    <p v-if="eta" class="ri__eta">{{ eta }}</p>
    <p v-if="read?.error" class="ri__error selectable" role="alert">{{ t('releases.runError', { error: read.error }) }}</p>

    <p v-if="failed && state.tone === 'error'" class="ri__error selectable">
      <i18n-t keypath="releases.jobFailed" scope="global">
        <template #job><strong>{{ failed.name }}</strong></template>
      </i18n-t>
      <template v-if="release?.draft">{{ ' ' }}{{ t('releases.stillDraft') }}</template>
      {{ ' ' }}{{ t(`releases.rerunHint.${gitlab ? 'gitlab' : 'github'}`) }}
    </p>

    <template v-if="release">
      <h4 class="ri__sub">
        {{ t('releases.filesTitle') }}
        <span v-if="assets && assets.files" class="ri__count tabular">
          {{ t('releases.files', assets.files) }}<template v-if="assets.signatures">, {{ t('releases.signatures', assets.signatures) }}</template>
        </span>
      </h4>
      <ul v-if="assets && assets.groups.length" class="ri__assets" :aria-label="t('releases.filesTitle')">
        <template v-for="g in assets.groups" :key="g.platform">
          <li class="ri__platform">{{ platformLabel(g.platform) }}</li>
          <li v-for="r in g.rows" :key="r.asset.name">
            <button
              type="button"
              class="ri__asset"
              :title="r.asset.downloads ? t('releases.downloadCounted', { name: r.asset.name }, r.asset.downloads) : t('releases.download', { name: r.asset.name })"
              :disabled="r.asset.state !== 'uploaded' || undefined"
              @click="download(r.asset.url)"
            >
              <span class="ri__asset-name">{{ r.asset.name }}</span>
              <CircleCheck v-if="r.signature" class="ri__sig" :aria-label="t('releases.signed')" />
              <span class="ri__size tabular">{{ r.asset.state !== 'uploaded' ? t('releases.uploading') : r.asset.size ? formatSize(r.asset.size) : '' }}</span>
              <Download class="ri__asset-go" aria-hidden="true" />
            </button>
          </li>
        </template>
      </ul>
      <p v-else class="ri__quiet">{{ active ? t('releases.filesComing') : t('releases.noFiles') }}</p>

      <h4 class="ri__sub">{{ t('releases.notes') }}</h4>
      <!-- eslint-disable-next-line vue/no-v-html -- sanitised by safeHtml: allow-listed tags, https links and pictures only -->
      <div v-if="body" class="ri__body selectable" @click="onBodyClick" v-html="body" />
      <p v-else class="ri__quiet">{{ release.draft ? t('releases.noNotesYet') : t('releases.noNotes') }}</p>
    </template>
    <p v-else class="ri__quiet">
      {{ entry.kind === 'run' && entry.why === 'trial'
        ? t('releases.trialNote')
        : t(`releases.soonNote.${gitlab ? 'gitlab' : 'github'}`) }}
    </p>
  </article>
</template>

<style scoped>
.ri { display: flex; flex-direction: column; gap: var(--space-2); padding: var(--space-3) var(--space-4) var(--space-6); }

.ri__top { display: flex; align-items: center; gap: 6px; min-width: 0; font-size: var(--text-xs); }
.ri__state { flex: none; display: inline-flex; align-items: center; gap: 5px; font-weight: 560; }
.ri__state svg { width: 14px; height: 14px; stroke-width: 1.85; }
.ri__ref { min-width: 0; margin-left: auto; color: var(--fg-faint); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

/* Ripeness: building is ripening, done is ripe, failed is bruised, a pre-release is not ripe yet. */
.is-running { color: var(--ripe-running-fg); }
.is-running svg, svg.is-running { color: var(--ripe-running); }
.is-done { color: var(--ripe-done-fg); }
.is-done svg, svg.is-done { color: var(--ripe-done); }
.is-error { color: var(--ripe-error-fg); }
.is-error svg, svg.is-error { color: var(--ripe-error); }
.is-queued { color: var(--ripe-queued-fg); }
.is-queued svg { color: var(--ripe-queued); }
.is-idle, .is-idle svg, svg.is-idle { color: var(--fg-subtle); }
.ri__turn { animation: ri-turn 2.4s linear infinite; }
@keyframes ri-turn { to { transform: rotate(360deg); } }

.ri__pill {
  flex: none;
  display: inline-flex;
  align-items: center;
  height: 17px;
  padding: 0 6px;
  border-radius: var(--radius-pill);
  font-size: var(--text-2xs);
  font-weight: 560;
}
.ri__pill.is-latest { color: var(--ripe-done-fg); border: 1px solid color-mix(in oklch, var(--ripe-done) 45%, transparent); }
.ri__pill.is-pre { color: var(--ripe-queued-fg); border: 1px solid color-mix(in oklch, var(--ripe-queued) 50%, transparent); }
.ri__pill.is-draft { color: var(--fg-subtle); border: 1px dashed var(--line-strong); }

.ri__title {
  margin: 0;
  font-size: var(--text-lg);
  font-weight: 620;
  line-height: var(--leading-tight);
  letter-spacing: -0.01em;
  color: var(--fg);
  overflow-wrap: anywhere;
  text-wrap: balance;
}

.ri__meta { display: flex; align-items: center; gap: var(--space-2); margin: 0; font-size: var(--text-xs); color: var(--fg-subtle); }
.ri__meta strong { font-weight: 560; color: var(--fg-muted); }
.ri__by { min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ri__avatar { width: 16px; height: 16px; border-radius: 50%; flex: none; background: var(--bg-hover); }
.ri__downloads { flex: none; display: inline-flex; align-items: center; gap: 3px; margin-left: auto; color: var(--fg-faint); }
.ri__downloads svg { width: 12px; height: 12px; stroke-width: 1.85; }

.ri__facts { display: grid; gap: 4px; margin: var(--space-1) 0 0; padding: var(--space-2) 0; border-block: 1px solid var(--line-soft); }
.ri__fact { display: grid; grid-template-columns: 64px 1fr; align-items: center; gap: var(--space-2); min-height: 22px; font-size: var(--text-xs); }
.ri__fact dt { color: var(--fg-faint); }
.ri__fact dd { display: flex; align-items: center; gap: 6px; min-width: 0; margin: 0; color: var(--fg-muted); }
.ri__chip {
  flex: none;
  max-width: 60%;
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
.ri__soft { min-width: 0; color: var(--fg-faint); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

.ri__toggle {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
  height: 22px;
  margin-left: -5px;
  padding: 0 5px;
  border-radius: var(--radius-xs);
  font-weight: 540;
  transition: background var(--dur-fast) var(--ease-out);
}
.ri__toggle > span { min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ri__toggle:hover { background: var(--bg-hover); }
.ri__toggle:focus-visible, .ri__job:focus-visible, .ri__asset:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: -2px; }
.ri__toggle-icon { flex: none; width: 13px; height: 13px; stroke-width: 2; }
.ri__chev { flex: none; width: 12px; height: 12px; color: var(--fg-faint); }

.ri__jobs { display: grid; gap: 1px; margin: calc(-1 * var(--space-1)) 0 0 calc(64px + var(--space-2) - 5px); padding: 0; list-style: none; }
.ri__job {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  min-width: 0;
  height: 24px;
  padding: 0 5px;
  border-radius: var(--radius-xs);
  font-size: var(--text-xs);
  text-align: left;
  color: var(--fg-muted);
  transition: background var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out);
}
.ri__job:hover { background: var(--bg-hover); color: var(--fg); }
.ri__job-icon { flex: none; width: 13px; height: 13px; stroke-width: 2; }
.ri__job-name { min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ri__job-took { flex: none; margin-left: auto; color: var(--fg-faint); }
.ri__job-took.is-running { color: var(--ripe-running-fg); }
.ri__job-go { flex: none; width: 12px; height: 12px; color: var(--fg-faint); opacity: 0; transition: opacity var(--dur-fast) var(--ease-out); }
.ri__job:hover .ri__job-go, .ri__job:focus-visible .ri__job-go { opacity: 1; }

.ri__eta { margin: 0 0 0 calc(64px + var(--space-2)); font-size: var(--text-xs); color: var(--fg-subtle); }
.ri__error {
  margin: var(--space-1) 0 0;
  padding: var(--space-2) var(--space-3);
  border: 1px solid color-mix(in oklch, var(--ripe-error) 45%, transparent);
  border-radius: var(--radius-md);
  background: color-mix(in oklch, var(--ripe-error) 10%, transparent);
  font-size: var(--text-xs);
  color: var(--ripe-error-fg);
  overflow-wrap: anywhere;
}
.ri__error strong { font-weight: 600; }

.ri__sub { display: flex; align-items: baseline; gap: 6px; margin: var(--space-3) 0 0; font-size: var(--text-sm); font-weight: 600; color: var(--fg); }
.ri__count { font-size: var(--text-xs); font-weight: 400; color: var(--fg-faint); }
.ri__quiet { margin: 0; font-size: var(--text-sm); color: var(--fg-faint); }

.ri__assets { display: grid; margin: 0; padding: 0; list-style: none; }
.ri__platform { display: flex; align-items: center; height: 24px; margin-top: 2px; font-size: var(--text-xs); font-weight: 560; color: var(--fg-subtle); }
.ri__asset {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: calc(100% + 2 * var(--space-2));
  height: 26px;
  margin: 0 calc(-1 * var(--space-2));
  padding: 0 var(--space-2);
  border-radius: var(--radius-xs);
  font-size: var(--text-xs);
  text-align: left;
  transition: background var(--dur-fast) var(--ease-out);
}
.ri__asset:not(:disabled):hover { background: var(--bg-hover); }
.ri__asset:disabled { cursor: default; }
.ri__asset-name { min-width: 0; font-family: var(--font-mono); font-size: var(--text-2xs); color: var(--fg-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ri__asset:not(:disabled):hover .ri__asset-name { color: var(--fg); }
.ri__asset:disabled .ri__asset-name { color: var(--fg-faint); }
.ri__sig { flex: none; width: 11px; height: 11px; stroke-width: 2; color: var(--fg-faint); }
.ri__size { flex: none; margin-left: auto; color: var(--fg-faint); }
.ri__asset-go { flex: none; width: 13px; height: 13px; stroke-width: 1.85; color: var(--fg-subtle); opacity: 0; transition: opacity var(--dur-fast) var(--ease-out); }
.ri__asset:not(:disabled):hover .ri__asset-go, .ri__asset:focus-visible .ri__asset-go { opacity: 1; }

/* The notes, as GitHub or GitLab renders them: the chat's prose styles, a step smaller for a side panel. */
.ri__body { font-size: var(--text-sm); line-height: var(--leading-chat); color: var(--fg); overflow-wrap: anywhere; }
.ri__body :deep(> *:first-child) { margin-top: 0; }
.ri__body :deep(> *:last-child) { margin-bottom: 0; }
.ri__body :deep(p) { margin: 0 0 0.7em; }
.ri__body :deep(ul), .ri__body :deep(ol) { margin: 0 0 0.8em; padding-left: 1.3em; }
.ri__body :deep(li) { margin: 0.2em 0; }
.ri__body :deep(li::marker) { color: var(--fg-faint); }
.ri__body :deep(h1), .ri__body :deep(h2), .ri__body :deep(h3), .ri__body :deep(h4) { font-size: var(--text-md); font-weight: 640; margin: 1.1em 0 0.35em; letter-spacing: -0.01em; }
.ri__body :deep(h5), .ri__body :deep(h6) { font-size: var(--text-sm); font-weight: 640; margin: 1em 0 0.3em; }
.ri__body :deep(strong), .ri__body :deep(b) { font-weight: 640; }
.ri__body :deep(a) { color: var(--accent-ink); }
.ri__body :deep(code) { font-size: 0.9em; padding: 0.1em 0.35em; border-radius: var(--radius-xs); background: var(--bg-hover); border: 1px solid var(--line-soft); }
.ri__body :deep(pre) { margin: 0 0 0.8em; padding: var(--space-3); background: var(--bg-inset); border: 1px solid var(--line-soft); border-radius: var(--radius-md); overflow-x: auto; font-size: var(--text-xs); line-height: 1.55; }
.ri__body :deep(pre code) { padding: 0; border: 0; background: none; font-size: inherit; }
.ri__body :deep(blockquote) { margin: 0 0 0.8em; padding-left: var(--space-3); border-left: 1px solid var(--line-strong); color: var(--fg-muted); }
.ri__body :deep(hr) { border: 0; height: 1px; background: var(--line-soft); margin: 1.2em 0; }
.ri__body :deep(img) { display: block; max-width: 100%; height: auto; margin: var(--space-1) 0; border: 1px solid var(--line-soft); border-radius: var(--radius-md); background: var(--bg-inset); }
.ri__body :deep(table) { display: block; max-width: 100%; overflow-x: auto; border-collapse: collapse; margin: 0 0 0.8em; font-size: var(--text-xs); }
.ri__body :deep(th), .ri__body :deep(td) { padding: 4px 8px; border-bottom: 1px solid var(--line-soft); text-align: left; }
</style>
