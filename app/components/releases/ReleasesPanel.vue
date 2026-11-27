<script setup lang="ts">
import {
  ArrowLeft, ChevronDown, ChevronRight, CircleCheck, CircleDashed, CircleSlash, CircleStop, CircleX, ExternalLink, RefreshCw, RotateCcw, Tag,
} from 'lucide-vue-next'
import type { GhRunAction, GhRunJob } from '~/types/ipc'
import { useWorkspace } from '~/stores/workspace'
import { useReleases, PAGE } from '~/stores/releases'
import { useLinks } from '~/stores/links'
import { openExternal } from '~/composables/useBackend'
import { useForge } from '~/stores/forge'
import { forgeName, siteName } from '~/utils/forge'
import { formatDuration, shortAgo, useNow } from '~/utils/time'
import {
  entryState, groupAssets, isActive, isBad, latestRelease, totalDownloads, type ReleaseEntry,
} from '~/utils/releaseRuns'
import { vcsTerms } from '~/utils/vcs'

/**
 * The Releases tool window: the project's GitHub or GitLab releases, newest first, with the builds
 * that run (and drafts whose build failed) on top. A release opens to its workflow run (GitLab: its
 * pipeline), files and notes; a job of the run opens its log (LinksCheckLog, as in the Pull requests
 * window). Read through the GitHub or GitLab CLI; useReleaseWatch keeps the list current, this keeps
 * the open entry's run current.
 */

const { t } = useI18n()
const ws = useWorkspace()
const releases = useReleases()
const links = useLinks()
const now = useNow(1000)

/** A project with no GitHub or GitLab behind it (Unity VCS, Lore): what to say instead of a list. */
const forge = useForge()
watch(() => ws.activeProjectPath, p => forge.ensure(p), { immediate: true })
const noForge = computed(() => {
  const vcs = ws.activeProject?.vcs
  const p = ws.activeProjectPath
  if (!vcsTerms(vcs).forge) return vcs === 'lore' ? t('releases.lore') : t('releases.plastic')
  // A git project whose remotes name no GitHub or GitLab repository has no releases to read.
  return p && p in forge.links && !forge.connected(p) ? t('releases.noRemote') : null
})
const path = computed(() => (noForge.value || !forge.connected(ws.activeProjectPath) ? null : ws.activeProjectPath))
const list = computed(() => (path.value ? releases.lists[path.value] : undefined))
const data = computed(() => list.value?.data ?? null)
const sorted = computed(() => releases.sorted(path.value))
const latestTag = computed(() => (data.value ? latestRelease(data.value.releases)?.tag ?? null : null))
const repoName = computed(() => (data.value ? `${data.value.owner}/${data.value.repo}` : ''))
const webBase = computed(() => (data.value ? `https://${data.value.host}/${data.value.owner}/${data.value.repo}` : null))
/** GitHub or GitLab: from the list once read, from the project's remotes before. */
const provider = computed(() => data.value?.provider ?? forge.providerOf(path.value))
const gitlab = computed(() => provider.value === 'gitlab')
const site = computed(() => siteName(provider.value, data.value?.host))
/** The releases pages: GitLab keeps them under `/-/`. */
const releasesUrl = computed(() => (webBase.value ? `${webBase.value}${gitlab.value ? '/-' : ''}/releases` : null))
/** A run's actions: GitLab retries a pipeline's failed jobs, or runs the ref again. */
const rerunLabel = (failed: boolean) => (failed ? t(`releases.rerunFailed.${provider.value}`) : t(`releases.rerun.${provider.value}`))

/* ---------- the open entry ---------- */
const focusedKey = computed(() => (releases.focused && releases.focused.path === path.value ? releases.focused.key : null))
const read = computed(() => (path.value && focusedKey.value ? releases.run(path.value, focusedKey.value) : undefined))
/** The entry open: from the list, or for a finished trial build that left the list, from its own read. */
const entry = computed<ReleaseEntry | null>(() => {
  const key = focusedKey.value
  const s = sorted.value
  if (!key) return null
  const found = s && [...s.inProgress, ...s.releases].find(e => e.key === key)
  if (found) return found
  const run = read.value?.detail?.run
  return key.startsWith('run:') && run ? { kind: 'run', key, run, why: run.event === 'workflow_dispatch' ? 'trial' : 'tag' } : null
})
const run = computed(() => read.value?.detail?.run ?? entry.value?.run ?? null)

function open(e: ReleaseEntry) { if (path.value) releases.open(path.value, e.key) }
function back() { releases.back() }

// Read the open entry's run when it opens, and again when the list sees it change. (Watched as one
// string: an array would count as changed on every read, and reading changes what is read here.)
watch(() => `${path.value}|${focusedKey.value}|${entry.value?.run?.id}|${entry.value?.run?.state}|${entry.value?.run?.attempt}`, () => {
  if (path.value && focusedKey.value) void releases.loadRun(path.value, focusedKey.value)
}, { immediate: true })
// Another project: its own list.
watch(path, () => { if (releases.focused && releases.focused.path !== path.value) releases.back() })

/** While its run builds, read it every 10 seconds; when it ends, read the list too (files, published). */
let poller: ReturnType<typeof setTimeout> | undefined
function schedule() {
  clearTimeout(poller)
  const r = read.value
  if (!path.value || !focusedKey.value || !r || r.loading || !r.detail || !isActive(r.detail.run.state)) return
  const p = path.value
  const key = focusedKey.value
  poller = setTimeout(() => {
    if (document.hidden) { schedule(); return }
    void releases.loadRun(p, key)
  }, Math.max(0, 10_000 - (Date.now() - r.fetchedAt)))
}
watch(() => `${read.value?.loading}|${read.value?.fetchedAt}`, schedule, { immediate: true })
watch(() => read.value?.detail?.run.state, (state, was) => {
  if (path.value && was && isActive(was) && state && !isActive(state)) void releases.load(path.value, { force: true, quiet: true })
})
onBeforeUnmount(() => clearTimeout(poller))

/* ---------- the rows' builds: their jobs, for the steps under each ---------- */
watch(() => `${path.value}|${list.value?.fetchedAt}|${sorted.value?.inProgress.map(e => `${e.key}:${e.run?.state}`).join()}`, () => {
  const p = path.value
  if (!p || focusedKey.value) return
  for (const e of sorted.value?.inProgress ?? []) {
    const r = releases.run(p, e.key)
    if (!r?.loading) void releases.loadRun(p, e.key)
  }
}, { immediate: true })

/* ---------- a job's log, over the entry ---------- */
const backButton = ref<HTMLElement | null>(null)
async function openJob(j: GhRunJob) {
  releases.openJob(j, run.value?.workflow ?? t('releases.workflow'))
  await nextTick()
  backButton.value?.focus()
}
function closeJob() { releases.closeJob() }
const jobDetail = computed(() => (releases.job ? links.jobs[releases.job.url] : undefined))
const jobRefreshing = computed(() => !!(jobDetail.value?.loading && jobDetail.value.job))
function refreshJob() { if (releases.job) void links.loadJob(releases.job.url, path.value) }

/* ---------- actions ---------- */
const refreshing = computed(() => !!(list.value?.loading && !list.value.quiet && data.value))
function refresh() {
  if (!path.value) return
  void releases.load(path.value, { force: true })
  if (focusedKey.value) void releases.loadRun(path.value, focusedKey.value)
}
const actionError = ref<string | null>(null)
watch(focusedKey, () => { actionError.value = null; confirmCancel.value = false })
const acting = computed(() => (run.value ? releases.acting[run.value.id] ?? null : null))
async function act(action: GhRunAction) {
  if (!path.value || !focusedKey.value || !run.value) return
  actionError.value = null
  try {
    await releases.act(path.value, focusedKey.value, run.value.id, action)
  } catch (e) {
    actionError.value = e instanceof Error ? e.message : String(e)
  }
}
/** Cancelling stops work: the button asks once more first. */
const confirmCancel = ref(false)
let confirmTimer: ReturnType<typeof setTimeout> | undefined
function cancelRun() {
  if (!confirmCancel.value) {
    confirmCancel.value = true
    clearTimeout(confirmTimer)
    confirmTimer = setTimeout(() => { confirmCancel.value = false }, 4000)
    return
  }
  confirmCancel.value = false
  void act('cancel')
}
onBeforeUnmount(() => clearTimeout(confirmTimer))
const runActive = computed(() => !!run.value && isActive(run.value.state))
const runBad = computed(() => !!run.value && isBad(run.value.state))
const pageUrl = computed(() => (entry.value?.kind === 'release' ? entry.value.release.url : run.value?.url ?? null))

/* ---------- rows ---------- */
const MARK = { running: CircleDashed, failed: CircleX, cancelled: CircleSlash, passed: CircleCheck, tag: Tag }
const shown = reactive({ inProgress: true, releases: true })

function rowTone(e: ReleaseEntry) {
  const s = entryState(e)
  // A column of green tags would say nothing: only Latest takes the ripe colour.
  if (s.mark === 'tag') return e.kind === 'release' && e.release.tag === latestTag.value ? 'done' : s.tone === 'queued' ? 'queued' : 'faint'
  return s.tone
}
function rowTitle(e: ReleaseEntry) {
  if (e.kind === 'release') return e.release.name
  return e.why === 'trial' ? t('releases.trialBuild') : (e.run.headBranch ?? t('releases.releaseBuild'))
}
/** The state's word of a row in progress. */
function stateWord(e: ReleaseEntry) {
  const { mark } = entryState(e)
  return mark === 'tag' ? t('releases.draft') : t(`releases.state.${mark}`)
}
function jobsOf(e: ReleaseEntry) { return path.value ? releases.run(path.value, e.key)?.detail?.jobs ?? null : null }
function jobsLine(e: ReleaseEntry) {
  const jobs = jobsOf(e)
  if (!jobs?.length) return null
  const done = jobs.filter(j => !isActive(j.state)).length
  return t('releases.jobsDone', { done, total: jobs.length })
}
function elapsed(e: ReleaseEntry) {
  const r = e.run
  if (!r) return null
  const start = Date.parse(r.startedAt ?? r.createdAt)
  if (!Number.isFinite(start)) return null
  return isActive(r.state) ? formatDuration(Math.max(0, now.value - start)) : shortAgo(Date.parse(r.updatedAt), now.value)
}
function filesLine(e: ReleaseEntry) {
  if (e.kind !== 'release') return null
  const n = groupAssets(e.release.assets).files
  return n ? t('releases.files', n) : null
}
function downloadsLine(e: ReleaseEntry) {
  if (e.kind !== 'release') return null
  const n = totalDownloads(e.release.assets)
  return n ? t('releases.downloads', n) : null
}
const when = (e: ReleaseEntry) => (e.kind === 'release' ? shortAgo(Date.parse(e.release.publishedAt ?? e.release.createdAt), now.value) : null)
const canShowOlder = computed(() => !!data.value && !!list.value && data.value.releases.length >= list.value.count && list.value.count < 100)
const loadingOlder = computed(() => !!(list.value?.loading && data.value && data.value.releases.length < list.value.count && list.value.count > PAGE))
function showOlder() { if (path.value) void releases.more(path.value) }
const empty = computed(() => !!sorted.value && !sorted.value.inProgress.length && !sorted.value.releases.length)
const backLabel = computed(() => {
  const e = entry.value
  if (!e) return ''
  return e.kind === 'release' ? e.release.tag : e.why === 'trial' ? t('releases.trialBuild') : e.run.headBranch ?? ''
})
</script>

<template>
  <!-- Shown in the tool window on the right (see AppToolPanel), which owns width and resizing. -->
  <section class="rp" :aria-label="t('releases.title')" @keydown.esc="releases.job ? closeJob() : undefined">
    <header class="rp__head">
      <button
        v-if="releases.job && entry"
        ref="backButton"
        type="button"
        class="rp__back"
        :aria-label="t('releases.back', { name: backLabel })"
        :title="`${t('releases.back', { name: backLabel })} (Esc)`"
        @click="closeJob"
      >
        <ArrowLeft aria-hidden="true" />
        <span class="rp__back-tag" :class="{ 'is-ref': !(entry.kind === 'run' && entry.why === 'trial') }">{{ backLabel }}</span>
        <span class="rp__back-title">{{ releases.job.name }}</span>
      </button>
      <template v-else>
        <UiIconButton v-if="entry" :label="t('releases.all')" size="sm" @click="back"><ArrowLeft /></UiIconButton>
        <h2 class="rp__title" :title="repoName || undefined">{{ t('releases.title') }}</h2>
        <div v-if="path" class="rp__tools">
          <UiIconButton :label="t('releases.readAgain')" :class="{ 'rp__spinning': refreshing }" :disabled="refreshing || undefined" @click="refresh"><RefreshCw /></UiIconButton>
          <UiIconButton v-if="releasesUrl && !entry" :label="t('releases.onSite', { site })" @click="openExternal(releasesUrl)"><ExternalLink /></UiIconButton>
        </div>
      </template>
    </header>

    <div v-if="noForge" class="rp__quiet"><p>{{ noForge }}</p></div>
    <div v-else-if="!path" class="rp__quiet"><p>{{ t('releases.noProject') }}</p></div>

    <!-- A job's log -->
    <template v-else-if="releases.job && entry">
      <div class="rp__scroll">
        <LinksCheckLog :key="releases.job.url" :check="releases.job" :project-path="path" />
      </div>
      <footer class="rp__foot">
        <UiButton size="sm" @click="openExternal(jobDetail?.job?.url || releases.job.url)"><ExternalLink aria-hidden="true" />{{ t('links.openOn', { site }) }}</UiButton>
        <UiButton size="sm" variant="ghost" :loading="jobRefreshing" @click="refreshJob"><RefreshCw v-if="!jobRefreshing" aria-hidden="true" />{{ t('common.actions.refresh') }}</UiButton>
      </footer>
    </template>

    <!-- One release -->
    <template v-else-if="entry && data">
      <div class="rp__scroll">
        <ReleasesItem :key="entry.key" :entry="entry" :read="read" :runs="data.runs" :repo="repoName" :provider="provider" :latest="entry.kind === 'release' && entry.release.tag === latestTag" @open-job="openJob" />
      </div>
      <p v-if="actionError" class="rp__action-error selectable" role="alert">{{ actionError }}</p>
      <footer class="rp__foot">
        <template v-if="runBad && run">
          <UiButton size="sm" :loading="acting === 'rerun-failed' || acting === 'rerun'" @click="act(run.state === 'failure' ? 'rerun-failed' : 'rerun')">
            <RotateCcw v-if="!acting" aria-hidden="true" />{{ rerunLabel(run.state === 'failure') }}
          </UiButton>
          <UiButton v-if="pageUrl" size="sm" variant="ghost" @click="openExternal(pageUrl)"><ExternalLink aria-hidden="true" />{{ t('links.openOn', { site }) }}</UiButton>
        </template>
        <UiButton v-else-if="pageUrl" size="sm" @click="openExternal(pageUrl)"><ExternalLink aria-hidden="true" />{{ t('links.openOn', { site }) }}</UiButton>
        <UiButton
          v-if="runActive"
          size="sm"
          :variant="confirmCancel ? 'danger' : 'ghost'"
          class="rp__push"
          :loading="acting === 'cancel'"
          :title="confirmCancel ? t(`releases.stopAgain.${provider}`, { site }) : t(`releases.stop.${provider}`, { site })"
          @click="cancelRun"
        >
          <CircleStop v-if="acting !== 'cancel'" aria-hidden="true" />{{ confirmCancel ? t(`releases.cancelAsk.${provider}`) : t(`releases.cancel.${provider}`) }}
        </UiButton>
      </footer>
    </template>

    <!-- Nothing read yet -->
    <div v-else-if="!data && list?.error" class="rp__quiet">
      <p class="selectable">{{ list.error }}</p>
      <LinksHostingButton :error="list.error" />
      <UiButton size="sm" variant="ghost" @click="refresh"><RefreshCw aria-hidden="true" />{{ t('common.actions.retry') }}</UiButton>
    </div>
    <div v-else-if="!data" class="rp__skeleton" aria-busy="true" :aria-label="t('links.reading', { forge: forgeName(provider) })">
      <span v-for="w in [58, 74, 49, 66, 54]" :key="w"><i /><b :style="{ width: `${w}%` }" /></span>
    </div>

    <!-- No releases -->
    <div v-else-if="empty" class="rp__empty">
      <h3>{{ t('releases.none') }}</h3>
      <p>{{ t(`releases.noneHint.${provider}`, { site }) }}</p>
      <pre class="rp__cmd selectable"><span class="rp__prompt" aria-hidden="true">$ </span>git tag v1.0.0 &amp;&amp; git push origin v1.0.0</pre>
      <p>{{ t('releases.noneStart', { site }) }}</p>
      <UiButton v-if="releasesUrl" size="sm" @click="openExternal(`${releasesUrl}/new`)"><ExternalLink aria-hidden="true" />{{ t('releases.new', { site }) }}</UiButton>
    </div>

    <!-- The list -->
    <div v-else class="rp__scroll rp__list">
      <p v-if="list?.error" class="rp__stale" role="alert">{{ t('links.couldNotRefresh', { error: list.error }) }}</p>
      <template v-for="group in (['inProgress', 'releases'] as const)" :key="group">
        <template v-if="sorted && sorted[group].length">
          <button type="button" class="rp__group" :aria-expanded="shown[group]" @click="shown[group] = !shown[group]">
            <component :is="shown[group] ? ChevronDown : ChevronRight" aria-hidden="true" />
            {{ group === 'inProgress' ? t('releases.inProgress') : t('releases.title') }}
            <span class="rp__group-count tabular">{{ sorted[group].length }}</span>
          </button>
          <ul v-if="shown[group]" class="rp__rows" :aria-label="group === 'inProgress' ? t('releases.inProgress') : t('releases.title')">
            <li v-for="e in sorted[group]" :key="e.key">
              <button type="button" class="rp__row" @click="open(e)">
                <component
                  :is="MARK[entryState(e).mark]"
                  class="rp__icon"
                  :class="[`is-${rowTone(e)}`, { 'rp__turn': entryState(e).mark === 'running' }]"
                  aria-hidden="true"
                />
                <span class="rp__text">
                  <span class="rp__line">
                    <span class="rp__name">{{ rowTitle(e) }}</span>
                    <span v-if="e.kind === 'release' && e.release.tag === latestTag" class="rp__pill is-latest">{{ t('releases.latest') }}</span>
                    <span v-if="e.kind === 'release' && e.release.prerelease" class="rp__pill is-pre">{{ t('releases.prerelease') }}</span>
                    <span v-if="e.kind === 'release' && e.release.draft" class="rp__pill is-draft">{{ t('releases.draft') }}</span>
                    <span v-else-if="e.kind === 'release' && !e.release.publishedAt" class="rp__pill is-pre" :title="t('releases.upcomingHint')">{{ t('releases.upcoming') }}</span>
                  </span>
                  <span class="rp__sub">
                    <span v-if="group === 'inProgress'" class="rp__word" :class="`is-${entryState(e).tone}`">{{ stateWord(e) }}</span>
                    <span v-if="e.kind === 'release'" class="rp__tag">{{ e.release.tag }}</span>
                    <span v-else-if="e.run.headBranch" class="rp__tag">{{ e.run.headBranch }}</span>
                    <template v-if="group === 'inProgress'">
                      <span v-if="jobsLine(e)" class="tabular">{{ jobsLine(e) }}</span>
                      <span v-else-if="e.kind === 'run' && e.why === 'trial'" class="rp__grow">{{ t('releases.byHand') }}</span>
                    </template>
                    <template v-else>
                      <span v-if="filesLine(e)">{{ filesLine(e) }}</span>
                      <span v-if="downloadsLine(e)" class="tabular rp__grow">{{ downloadsLine(e) }}</span>
                    </template>
                  </span>
                  <span v-if="group === 'inProgress' && jobsOf(e)?.length" class="rp__steps" aria-hidden="true">
                    <span v-for="j in jobsOf(e)" :key="j.id" :class="`is-${j.state}`" />
                  </span>
                </span>
                <span class="rp__when tabular">{{ group === 'inProgress' ? elapsed(e) : when(e) }}</span>
              </button>
            </li>
          </ul>
        </template>
      </template>
      <UiButton v-if="canShowOlder" size="sm" variant="ghost" class="rp__older" :loading="loadingOlder" @click="showOlder">{{ t('releases.showOlder') }}</UiButton>
    </div>
  </section>
</template>

<style scoped>
.rp { display: flex; flex-direction: column; flex: 1; min-height: 0; }
.rp__head {
  flex: none;
  display: flex;
  align-items: center;
  gap: var(--space-1);
  height: var(--tabbar-h);
  border-bottom: 1px solid var(--line);
  padding: 0 var(--space-2) 0 var(--space-3);
}
.rp__head:has(> .icon-btn:first-child) { padding-left: var(--space-2); }
.rp__title {
  flex: 1;
  min-width: 0;
  margin: 0;
  font-size: var(--text-sm);
  font-weight: 600;
  color: var(--fg);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.rp__tools { flex: none; display: flex; align-items: center; gap: 2px; }
.rp__spinning :deep(svg) { animation: rp-turn 1s linear infinite; }
.rp__back {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  height: 26px;
  margin-left: calc(-1 * var(--space-1));
  padding: 0 var(--space-2) 0 6px;
  border-radius: var(--radius-sm);
  font-size: var(--text-sm);
  text-align: left;
  color: var(--fg-muted);
  transition: background var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out);
}
.rp__back:hover { background: var(--bg-hover); color: var(--fg); }
.rp__back:active { background: var(--bg-active); }
.rp__back:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: -2px; }
.rp__back svg { flex: none; width: 15px; height: 15px; stroke-width: 1.85; }
.rp__back-tag { flex: none; max-width: 45%; font-weight: 600; color: var(--fg); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.rp__back-tag.is-ref { font-family: var(--font-mono); font-size: var(--text-xs); }
.rp__back-title { min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

.rp__quiet {
  display: grid;
  gap: var(--space-2);
  justify-items: start;
  padding: var(--space-3) var(--space-4);
  border-top: 1px solid var(--line-soft);
  font-size: var(--text-sm);
  color: var(--fg-subtle);
}
.rp__quiet p { margin: 0; max-width: 46ch; overflow-wrap: anywhere; }

.rp__scroll { flex: 1; min-height: 0; overflow: auto; border-top: 1px solid var(--line-soft); }
.rp__foot {
  flex: none;
  display: flex;
  align-items: center;
  gap: var(--space-1);
  padding: var(--space-2) var(--space-3);
  border-top: 1px solid var(--line-soft);
}
.rp__foot :deep(svg) { width: 14px; height: 14px; stroke-width: 1.85; }
.rp__push { margin-left: auto; }
.rp__action-error {
  flex: none;
  margin: 0;
  padding: var(--space-2) var(--space-3);
  border-top: 1px solid color-mix(in oklch, var(--ripe-error) 45%, transparent);
  background: color-mix(in oklch, var(--ripe-error) 10%, transparent);
  font-size: var(--text-xs);
  color: var(--ripe-error-fg);
  overflow-wrap: anywhere;
}

/* ---------- the list ---------- */
.rp__list { display: flex; flex-direction: column; padding: var(--space-1) var(--space-2) var(--space-3); }
.rp__stale { margin: var(--space-1) var(--space-2) 0; font-size: var(--text-xs); color: var(--ripe-error-fg); overflow-wrap: anywhere; }
.rp__group {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  margin-top: var(--space-1);
  padding: 0 var(--space-2);
  border-radius: var(--radius-sm);
  font-size: var(--text-xs);
  font-weight: 600;
  color: var(--fg-subtle);
  text-align: left;
}
.rp__group:hover { color: var(--fg); }
.rp__group:focus-visible, .rp__row:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: -2px; }
.rp__group svg { width: 12px; height: 12px; color: var(--fg-faint); }
.rp__group-count { font-weight: 500; color: var(--fg-faint); }
.rp__rows { display: grid; gap: 2px; margin: 0; padding: 0; list-style: none; }
.rp__row {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  width: 100%;
  padding: 6px var(--space-2);
  border-radius: var(--radius-sm);
  text-align: left;
  transition: background var(--dur-fast) var(--ease-out);
}
.rp__row:hover { background: var(--bg-hover); }
.rp__row:active { background: var(--bg-active); }
.rp__icon { flex: none; width: 15px; height: 15px; margin-top: 2px; stroke-width: 1.85; }
.rp__icon.is-running { color: var(--ripe-running); }
.rp__icon.is-done { color: var(--ripe-done); }
.rp__icon.is-error { color: var(--ripe-error); }
.rp__icon.is-queued { color: var(--ripe-queued); }
.rp__icon.is-idle { color: var(--fg-subtle); }
.rp__icon.is-faint { color: var(--fg-faint); }
.rp__turn { animation: rp-turn 2.4s linear infinite; }
@keyframes rp-turn { to { transform: rotate(360deg); } }
.rp__text { flex: 1; min-width: 0; display: grid; gap: 1px; }
.rp__line { display: flex; align-items: center; gap: 6px; min-width: 0; }
.rp__name { min-width: 0; font-size: var(--text-sm); font-weight: 520; color: var(--fg-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.rp__row:hover .rp__name { color: var(--fg); }
.rp__sub { display: flex; align-items: center; gap: 6px; min-width: 0; font-size: var(--text-xs); color: var(--fg-faint); white-space: nowrap; }
.rp__word { flex: none; font-weight: 560; }
.rp__word.is-running { color: var(--ripe-running-fg); }
.rp__word.is-error { color: var(--ripe-error-fg); }
.rp__word.is-done { color: var(--ripe-done-fg); }
.rp__word.is-idle { color: var(--fg-subtle); }
.rp__tag { min-width: 0; font-family: var(--font-mono); font-size: var(--text-2xs); overflow: hidden; text-overflow: ellipsis; }
.rp__grow { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.rp__when { flex: none; margin-left: auto; padding-top: 3px; font-size: var(--text-2xs); color: var(--fg-faint); }

.rp__pill {
  flex: none;
  display: inline-flex;
  align-items: center;
  height: 17px;
  padding: 0 6px;
  border-radius: var(--radius-pill);
  font-size: var(--text-2xs);
  font-weight: 560;
}
.rp__pill.is-latest { color: var(--ripe-done-fg); border: 1px solid color-mix(in oklch, var(--ripe-done) 45%, transparent); }
.rp__pill.is-pre { color: var(--ripe-queued-fg); border: 1px solid color-mix(in oklch, var(--ripe-queued) 50%, transparent); }
.rp__pill.is-draft { color: var(--fg-subtle); border: 1px dashed var(--line-strong); }

/* A running build's jobs as a row of steps: done, running (breathing), failed, waiting. */
.rp__steps { display: flex; gap: 3px; margin-top: 5px; }
.rp__steps span { width: 14px; height: 3px; border-radius: var(--radius-pill); background: var(--line); }
.rp__steps .is-success { background: var(--ripe-done); }
.rp__steps .is-pending { background: var(--ripe-running); animation: rp-breathe 1.8s var(--ease-in-out) infinite; }
.rp__steps .is-failure { background: var(--ripe-error); }
.rp__steps .is-cancelled, .rp__steps .is-skipped { background: var(--line-strong); }
@keyframes rp-breathe { 50% { opacity: 0.45; } }
.rp__older { align-self: flex-start; margin: var(--space-2) var(--space-2) 0; }

.rp__skeleton { display: grid; gap: 14px; padding: var(--space-4); border-top: 1px solid var(--line-soft); }
.rp__skeleton span { display: flex; align-items: center; gap: var(--space-2); }
.rp__skeleton i { width: 15px; height: 15px; border-radius: var(--radius-xs); background: var(--bg-hover); }
.rp__skeleton b { height: 10px; border-radius: var(--radius-xs); background: var(--bg-hover); }

.rp__empty { display: grid; gap: var(--space-3); justify-items: start; padding: var(--space-4); border-top: 1px solid var(--line-soft); font-size: var(--text-sm); color: var(--fg-subtle); }
.rp__empty h3 { margin: 0; font-size: var(--text-md); font-weight: 600; color: var(--fg); }
.rp__empty p { margin: 0; max-width: 46ch; }
.rp__cmd {
  width: 100%;
  margin: 0;
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--line-soft);
  border-radius: var(--radius-md);
  background: var(--bg-inset);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--fg-muted);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.rp__prompt { color: var(--fg-faint); }
</style>
