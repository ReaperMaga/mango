<script setup lang="ts">
import {
  ArrowLeft, ChevronDown, ChevronRight, CircleCheck, CircleDashed, CircleMinus, CircleSlash, CircleStop, CircleX, Clock,
  ExternalLink, ListFilter, RefreshCw, RotateCcw,
} from 'lucide-vue-next'
import type { GhRun, GhRunAction, GhRunJob, GhRunState } from '~/types/ipc'
import type { MenuItem } from '~/types/ui'
import { useWorkspace } from '~/stores/workspace'
import { useActions, RUN_PAGE } from '~/stores/actions'
import { useReleases } from '~/stores/releases'
import { useLinks } from '~/stores/links'
import { useGit } from '~/stores/git'
import { useThreads } from '~/stores/threads'
import { useForge } from '~/stores/forge'
import { openExternal } from '~/composables/useBackend'
import { forgeName, siteName } from '~/utils/forge'
import { formatDuration, shortAgo, useNow } from '~/utils/time'
import { isActive, runKey } from '~/utils/releaseRuns'
import { groupRuns, knownEvent, rerunOf, workflowsOf } from '~/utils/actionRuns'
import { vcsTerms } from '~/utils/vcs'

/**
 * The Actions tool window: the project's recent GitHub Actions runs (GitLab: pipelines), all branches'
 * or the current branch's, those going on top. A run opens to its jobs (ActionsRun); a job opens its log
 * (LinksCheckLog, as in the Pull requests and Releases windows). A run can be re-run or cancelled from
 * the footer. useActionsWatch keeps the list current; this keeps the open run current.
 */

const { t } = useI18n()
const ws = useWorkspace()
const actions = useActions()
const releases = useReleases()
const links = useLinks()
const git = useGit()
const threads = useThreads()
const now = useNow(1000)

const forge = useForge()
watch(() => ws.activeProjectPath, p => forge.ensure(p), { immediate: true })
/** Only a project whose remotes name a GitHub (or GitLab) repository has runs to show. */
const noForge = computed(() => {
  const p = ws.activeProjectPath
  if (!vcsTerms(ws.activeProject?.vcs).forge || (p && p in forge.links && !forge.connected(p))) return t('actions.noForge')
  return null
})
const path = computed(() => (noForge.value || !forge.connected(ws.activeProjectPath) ? null : ws.activeProjectPath))
const branch = computed(() => git.status(threads.workdir ?? ws.activeProjectPath)?.branch ?? null)
const shownBranch = computed(() => (actions.scope === 'branch' ? branch.value : null))
const needsBranch = computed(() => actions.scope === 'branch' && !branch.value)
const list = computed(() => (needsBranch.value ? undefined : actions.list(path.value, shownBranch.value)))
const data = computed(() => list.value?.data ?? null)

const provider = computed(() => data.value?.provider ?? forge.providerOf(path.value))
const site = computed(() => siteName(provider.value, data.value?.host))
const title = computed(() => t(`actions.title.${provider.value}`))
const repoName = computed(() => (data.value ? `${data.value.owner}/${data.value.repo}` : ''))
const webBase = computed(() => (data.value ? `https://${data.value.host}/${data.value.owner}/${data.value.repo}` : null))
const siteUrl = computed(() => (webBase.value ? `${webBase.value}${provider.value === 'gitlab' ? '/-/pipelines' : '/actions'}` : null))

/* ---------- filters ---------- */
const workflows = computed(() => workflowsOf(data.value?.runs ?? []))
// A workflow that is not in this list any more (another project, another branch) stops filtering.
watch(workflows, (w) => { if (actions.workflow !== null && data.value && !w.some(x => x.id === actions.workflow)) actions.setWorkflow(null) })
const workflowName = computed(() => workflows.value.find(w => w.id === actions.workflow)?.name ?? null)
const workflowItems = computed<MenuItem[]>(() => [
  { label: t('actions.allWorkflows'), check: 'radio', checked: actions.workflow === null, onSelect: () => actions.setWorkflow(null) },
  ...workflows.value.map((w, i): MenuItem => ({
    label: w.name, aside: String(w.count), check: 'radio', checked: actions.workflow === w.id, divider: i === 0, onSelect: () => actions.setWorkflow(w.id),
  })),
])
const grouped = computed(() => groupRuns(data.value?.runs ?? [], actions.workflow))

/* ---------- the open run ---------- */
const focusedId = computed(() => (actions.focused && actions.focused.path === path.value ? actions.focused.id : null))
const read = computed(() => (path.value && focusedId.value !== null ? releases.run(path.value, runKey(focusedId.value)) : undefined))
/** The open run: as read with its jobs, else as the list knows it. */
const run = computed<GhRun | null>(() => {
  const id = focusedId.value
  if (id === null) return null
  return read.value?.detail?.run ?? data.value?.runs.find(r => r.id === id) ?? null
})

function open(r: GhRun) { if (path.value) actions.open(path.value, r.id) }
function back() { actions.back() }

// Read the open run when it opens, and again when the list sees it change.
const listed = computed(() => (focusedId.value !== null ? data.value?.runs.find(r => r.id === focusedId.value) : undefined))
watch(() => `${path.value}|${focusedId.value}|${listed.value?.state}|${listed.value?.attempt}`, () => {
  if (path.value && focusedId.value !== null) void actions.loadRun(path.value, focusedId.value)
}, { immediate: true })
watch(path, () => { if (actions.focused && actions.focused.path !== path.value) actions.back() })

/** While it runs, read it every 5 seconds; when it ends, read the list too. */
let poller: ReturnType<typeof setTimeout> | undefined
function schedule() {
  clearTimeout(poller)
  const r = read.value
  const p = path.value
  const id = focusedId.value
  if (!p || id === null || !r || r.loading || !r.detail || !isActive(r.detail.run.state)) return
  poller = setTimeout(() => {
    if (document.hidden) { schedule(); return }
    void actions.loadRun(p, id)
  }, Math.max(0, 5_000 - (Date.now() - r.fetchedAt)))
}
watch(() => `${read.value?.loading}|${read.value?.fetchedAt}`, schedule, { immediate: true })
watch(() => read.value?.detail?.run.state, (state, was) => {
  if (path.value && was && isActive(was) && state && !isActive(state)) void actions.load(path.value, shownBranch.value, { force: true, quiet: true })
})
onBeforeUnmount(() => clearTimeout(poller))

/* ---------- the jobs of the runs going, for the steps under each row ---------- */
watch(() => `${path.value}|${list.value?.fetchedAt}|${grouped.value.active.map(r => `${r.id}:${r.state}`).join()}`, () => {
  const p = path.value
  if (!p || focusedId.value !== null) return
  for (const r of grouped.value.active.slice(0, 6)) {
    if (!releases.run(p, runKey(r.id))?.loading) void actions.loadRun(p, r.id)
  }
}, { immediate: true })
function jobsOf(r: GhRun) { return path.value ? releases.run(path.value, runKey(r.id))?.detail?.jobs ?? null : null }

/* ---------- a job's log, over the run ---------- */
const backButton = ref<HTMLElement | null>(null)
async function openJob(j: GhRunJob) {
  actions.openJob(j, run.value?.workflow ?? t('actions.workflow'))
  await nextTick()
  backButton.value?.focus()
}
function closeJob() { actions.closeJob() }
const jobDetail = computed(() => (actions.job ? links.jobs[actions.job.url] : undefined))
const jobRefreshing = computed(() => !!(jobDetail.value?.loading && jobDetail.value.job))
function refreshJob() { if (actions.job) void links.loadJob(actions.job.url, path.value) }

/* ---------- actions on the open run ---------- */
const refreshing = computed(() => !!(list.value?.loading && !list.value.quiet && data.value))
function refresh() {
  if (!path.value || needsBranch.value) return
  void actions.load(path.value, shownBranch.value, { force: true })
  if (focusedId.value !== null) void actions.loadRun(path.value, focusedId.value)
}
const actionError = ref<string | null>(null)
watch(focusedId, () => { actionError.value = null; confirmCancel.value = false })
const acting = computed(() => (run.value ? actions.acting[run.value.id] ?? null : null))
async function act(action: GhRunAction) {
  if (!path.value || !run.value) return
  actionError.value = null
  try {
    await actions.act(path.value, shownBranch.value, run.value.id, action)
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
const rerun = computed(() => (run.value ? rerunOf(run.value) : null))
const rerunLabel = computed(() => (rerun.value === 'rerun-failed' ? t(`releases.rerunFailed.${provider.value}`) : t(`releases.rerun.${provider.value}`)))
/** A finished run can also run again whole, even when it passed. */
const runAgain = computed(() => !!run.value && !isActive(run.value.state) && !rerun.value)

/* ---------- rows ---------- */
const ICON = { failure: CircleX, cancelled: CircleSlash, pending: CircleDashed, queued: Clock, success: CircleCheck, neutral: CircleMinus, skipped: CircleSlash }
const tone = (s: GhRunState) => (s === 'pending' ? 'running' : s === 'success' ? 'done' : s === 'failure' ? 'error' : s === 'queued' ? 'queued' : 'faint')
const shown = reactive({ active: true, done: true })
const rowTitle = (r: GhRun) => r.title || (provider.value === 'gitlab' && r.workflow === 'Pipeline' ? t('actions.noTitle', { n: r.number }) : r.workflow)
const eventWord = (r: GhRun) => { const e = knownEvent(r.event); return e ? t(`actions.event.${e}`) : r.event }
function when(r: GhRun) {
  if (isActive(r.state)) {
    const start = Date.parse(r.startedAt ?? r.createdAt)
    return Number.isFinite(start) ? formatDuration(Math.max(0, now.value - start)) : ''
  }
  return shortAgo(Date.parse(r.updatedAt), now.value)
}
const canShowMore = computed(() => !!data.value && !!list.value && data.value.runs.length >= list.value.count && list.value.count < 100)
const loadingMore = computed(() => !!(list.value?.loading && data.value && list.value.count > RUN_PAGE))
function showMore() { if (path.value) void actions.more(path.value, shownBranch.value) }
const empty = computed(() => !!data.value && !grouped.value.active.length && !grouped.value.done.length)
const backLabel = computed(() => (run.value ? `#${run.value.number}` : ''))
</script>

<template>
  <!-- Shown in the tool window on the right (see AppToolPanel), which owns width and resizing. -->
  <section class="ap" :aria-label="title" @keydown.esc="actions.job ? closeJob() : undefined">
    <header class="ap__head">
      <button
        v-if="actions.job && run"
        ref="backButton"
        type="button"
        class="ap__back"
        :aria-label="t('actions.back', { name: backLabel })"
        :title="`${t('actions.back', { name: backLabel })} (Esc)`"
        @click="closeJob"
      >
        <ArrowLeft aria-hidden="true" />
        <span class="ap__back-tag tabular">{{ backLabel }}</span>
        <span class="ap__back-title">{{ actions.job.name }}</span>
      </button>
      <template v-else>
        <UiIconButton v-if="focusedId !== null" :label="t('actions.all')" size="sm" @click="back"><ArrowLeft /></UiIconButton>
        <h2 class="ap__title" :title="repoName || undefined">{{ title }}</h2>
        <div v-if="path" class="ap__tools">
          <UiIconButton :label="t('actions.readAgain')" :class="{ 'ap__spinning': refreshing }" :disabled="refreshing || needsBranch || undefined" @click="refresh"><RefreshCw /></UiIconButton>
          <UiIconButton v-if="siteUrl && focusedId === null" :label="t('actions.onSite', { site })" @click="openExternal(siteUrl)"><ExternalLink /></UiIconButton>
        </div>
      </template>
    </header>

    <div v-if="noForge" class="ap__quiet"><p>{{ noForge }}</p></div>
    <div v-else-if="!path" class="ap__quiet"><p>{{ t('actions.noProject') }}</p></div>

    <!-- A job's log -->
    <template v-else-if="actions.job && run">
      <div class="ap__scroll">
        <LinksCheckLog :key="actions.job.url" :check="actions.job" :project-path="path" />
      </div>
      <footer class="ap__foot">
        <UiButton size="sm" @click="openExternal(jobDetail?.job?.url || actions.job.url)"><ExternalLink aria-hidden="true" />{{ t('links.openOn', { site }) }}</UiButton>
        <UiButton size="sm" variant="ghost" :loading="jobRefreshing" @click="refreshJob"><RefreshCw v-if="!jobRefreshing" aria-hidden="true" />{{ t('common.actions.refresh') }}</UiButton>
      </footer>
    </template>

    <!-- One run -->
    <template v-else-if="focusedId !== null">
      <div class="ap__scroll">
        <ActionsRun v-if="run" :key="run.id" :run="run" :read="read" :runs="data?.runs ?? []" :repo="repoName" :provider="provider" @open-job="openJob" />
        <div v-else-if="read?.error" class="ap__quiet"><p class="selectable">{{ read.error }}</p></div>
        <div v-else class="ap__skeleton" aria-busy="true"><span v-for="w in [58, 74, 49]" :key="w"><i /><b :style="{ width: `${w}%` }" /></span></div>
      </div>
      <p v-if="actionError" class="ap__action-error selectable" role="alert">{{ actionError }}</p>
      <footer v-if="run" class="ap__foot">
        <UiButton v-if="rerun || runAgain" size="sm" :variant="rerun ? 'secondary' : 'ghost'" :loading="acting === 'rerun-failed' || acting === 'rerun'" @click="act(rerun ?? 'rerun')">
          <RotateCcw v-if="!acting" aria-hidden="true" />{{ rerun ? rerunLabel : t(`releases.rerun.${provider}`) }}
        </UiButton>
        <UiButton size="sm" variant="ghost" @click="openExternal(run.url)"><ExternalLink aria-hidden="true" />{{ t('links.openOn', { site }) }}</UiButton>
        <UiButton
          v-if="isActive(run.state)"
          size="sm"
          :variant="confirmCancel ? 'danger' : 'ghost'"
          class="ap__push"
          :loading="acting === 'cancel'"
          :title="confirmCancel ? t(`releases.stopAgain.${provider}`, { site }) : t(`releases.stop.${provider}`, { site })"
          @click="cancelRun"
        >
          <CircleStop v-if="acting !== 'cancel'" aria-hidden="true" />{{ confirmCancel ? t(`releases.cancelAsk.${provider}`) : t(`releases.cancel.${provider}`) }}
        </UiButton>
      </footer>
    </template>

    <template v-else>
      <!-- Which runs: all branches or this one, and one workflow or all -->
      <div class="ap__filters">
        <div class="ap__seg" role="radiogroup" :aria-label="t('actions.scopeLabel')">
          <button
            v-for="s in (['all', 'branch'] as const)"
            :key="s"
            type="button"
            role="radio"
            class="ap__seg-btn"
            :class="{ 'is-on': actions.scope === s }"
            :aria-checked="actions.scope === s"
            :title="s === 'branch' && branch ? branch : undefined"
            @click="actions.setScope(s)"
          >
            {{ t(`actions.scope.${s}`) }}
          </button>
        </div>
        <UiMenu v-if="workflows.length > 1" :items="workflowItems" placement="bottom-end" :width="220" :max-width="320" :label="t('actions.workflow')">
          <template #default="{ open: menuOpen, toggle }">
            <button
              type="button"
              class="ap__flow"
              :class="{ 'is-open': menuOpen, 'is-set': workflowName }"
              :aria-expanded="menuOpen"
              aria-haspopup="menu"
              :aria-label="`${t('actions.workflow')}: ${workflowName ?? t('actions.allWorkflows')}`"
              :title="workflowName ?? t('actions.allWorkflows')"
              @click="toggle"
            >
              <ListFilter aria-hidden="true" />
              <span v-if="workflowName">{{ workflowName }}</span>
              <ChevronDown class="ap__flow-chev" aria-hidden="true" />
            </button>
          </template>
        </UiMenu>
      </div>

      <div v-if="needsBranch" class="ap__quiet"><p>{{ t('actions.noBranch') }}</p></div>
      <!-- Nothing read yet -->
      <div v-else-if="!data && list?.error" class="ap__quiet">
        <p class="selectable">{{ list.error }}</p>
        <LinksHostingButton :error="list.error" />
        <UiButton size="sm" variant="ghost" @click="refresh"><RefreshCw aria-hidden="true" />{{ t('common.actions.retry') }}</UiButton>
      </div>
      <div v-else-if="!data" class="ap__skeleton" aria-busy="true" :aria-label="t('links.reading', { forge: forgeName(provider) })">
        <span v-for="w in [58, 74, 49, 66, 54]" :key="w"><i /><b :style="{ width: `${w}%` }" /></span>
      </div>

      <!-- No runs -->
      <div v-else-if="empty" class="ap__empty">
        <h3>{{ t(`actions.none.${provider}`) }}</h3>
        <p v-if="shownBranch">{{ t(`actions.noneBranch.${provider}`, { branch: shownBranch }) }}</p>
        <p>{{ t(`actions.noneHint.${provider}`) }}</p>
        <UiButton v-if="siteUrl" size="sm" @click="openExternal(siteUrl)"><ExternalLink aria-hidden="true" />{{ t('actions.onSite', { site }) }}</UiButton>
      </div>

      <!-- The list -->
      <div v-else class="ap__scroll ap__list">
        <p v-if="list?.error" class="ap__stale" role="alert">{{ t('links.couldNotRefresh', { error: list.error }) }}</p>
        <template v-for="group in (['active', 'done'] as const)" :key="group">
          <template v-if="grouped[group].length">
            <button type="button" class="ap__group" :aria-expanded="shown[group]" @click="shown[group] = !shown[group]">
              <component :is="shown[group] ? ChevronDown : ChevronRight" aria-hidden="true" />
              {{ group === 'active' ? t('actions.running') : t('actions.recent') }}
              <span class="ap__group-count tabular">{{ grouped[group].length }}</span>
            </button>
            <ul v-if="shown[group]" class="ap__rows" :aria-label="group === 'active' ? t('actions.running') : t('actions.recent')">
              <li v-for="r in grouped[group]" :key="r.id">
                <button type="button" class="ap__row" @click="open(r)">
                  <component :is="ICON[r.state]" class="ap__icon" :class="[`is-${tone(r.state)}`, { 'ap__turn': r.state === 'pending' }]" aria-hidden="true" />
                  <span class="sr-only">{{ t(`actions.state.${r.state}`) }}:</span>
                  <span class="ap__text">
                    <span class="ap__name">{{ rowTitle(r) }}</span>
                    <span class="ap__sub">
                      <span class="ap__flow-name">{{ r.workflow }}</span>
                      <span class="tabular">#{{ r.number }}</span>
                      <span v-if="r.headBranch && !shownBranch" class="ap__tag">{{ r.headBranch }}</span>
                      <span class="ap__grow">{{ eventWord(r) }}</span>
                    </span>
                    <span v-if="group === 'active' && jobsOf(r)?.length" class="ap__steps" aria-hidden="true">
                      <span v-for="j in jobsOf(r)" :key="j.id" :class="`is-${j.state}`" />
                    </span>
                  </span>
                  <span class="ap__when tabular" :class="{ 'is-running': group === 'active' }">{{ when(r) }}</span>
                </button>
              </li>
            </ul>
          </template>
        </template>
        <UiButton v-if="canShowMore" size="sm" variant="ghost" class="ap__more" :loading="loadingMore" @click="showMore">{{ t('actions.showMore') }}</UiButton>
      </div>
    </template>
  </section>
</template>

<style scoped>
.ap { display: flex; flex-direction: column; flex: 1; min-height: 0; }
.ap__head {
  flex: none;
  display: flex;
  align-items: center;
  gap: var(--space-1);
  height: var(--tabbar-h);
  border-bottom: 1px solid var(--line);
  padding: 0 var(--space-2) 0 var(--space-3);
}
.ap__head:has(> .icon-btn:first-child) { padding-left: var(--space-2); }
.ap__title {
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
.ap__tools { flex: none; display: flex; align-items: center; gap: 2px; }
.ap__spinning :deep(svg) { animation: ap-turn 1s linear infinite; }
.ap__back {
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
.ap__back:hover { background: var(--bg-hover); color: var(--fg); }
.ap__back:active { background: var(--bg-active); }
.ap__back:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: -2px; }
.ap__back svg { flex: none; width: 15px; height: 15px; stroke-width: 1.85; }
.ap__back-tag { flex: none; font-weight: 600; color: var(--fg); }
.ap__back-title { min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

/* ---------- filters ---------- */
.ap__filters {
  flex: none;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
}
.ap__seg {
  display: inline-flex;
  padding: 2px;
  border-radius: var(--radius-md);
  background: var(--bg-hover);
}
.ap__seg-btn {
  height: 22px;
  padding: 0 var(--space-2);
  border-radius: var(--radius-sm);
  font-size: var(--text-xs);
  font-weight: 520;
  color: var(--fg-subtle);
  white-space: nowrap;
  transition: background var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out);
}
.ap__seg-btn:hover { color: var(--fg); }
.ap__seg-btn.is-on { background: var(--bg-raised); color: var(--fg); }
.ap__seg-btn:focus-visible, .ap__flow:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 1px; }
.ap__flow {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
  height: 26px;
  margin-left: auto;
  padding: 0 6px;
  border-radius: var(--radius-sm);
  font-size: var(--text-xs);
  color: var(--fg-subtle);
  transition: background var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out);
}
.ap__flow > span { min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ap__flow svg { flex: none; width: 13px; height: 13px; stroke-width: 1.85; }
.ap__flow-chev { color: var(--fg-faint); }
.ap__flow:hover, .ap__flow.is-open { background: var(--bg-hover); color: var(--fg); }
.ap__flow.is-set { color: var(--accent-ink); }

.ap__quiet {
  display: grid;
  gap: var(--space-2);
  justify-items: start;
  padding: var(--space-3) var(--space-4);
  border-top: 1px solid var(--line-soft);
  font-size: var(--text-sm);
  color: var(--fg-subtle);
}
.ap__quiet p { margin: 0; max-width: 46ch; overflow-wrap: anywhere; }

.ap__scroll { flex: 1; min-height: 0; overflow: auto; border-top: 1px solid var(--line-soft); }
.ap__foot {
  flex: none;
  display: flex;
  align-items: center;
  gap: var(--space-1);
  padding: var(--space-2) var(--space-3);
  border-top: 1px solid var(--line-soft);
}
.ap__foot :deep(svg) { width: 14px; height: 14px; stroke-width: 1.85; }
.ap__push { margin-left: auto; }
.ap__action-error {
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
.ap__list { display: flex; flex-direction: column; padding: var(--space-1) var(--space-2) var(--space-3); }
.ap__stale { margin: var(--space-1) var(--space-2) 0; font-size: var(--text-xs); color: var(--ripe-error-fg); overflow-wrap: anywhere; }
.ap__group {
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
.ap__group:hover { color: var(--fg); }
.ap__group:focus-visible, .ap__row:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: -2px; }
.ap__group svg { width: 12px; height: 12px; color: var(--fg-faint); }
.ap__group-count { font-weight: 500; color: var(--fg-faint); }
.ap__rows { display: grid; gap: 2px; margin: 0; padding: 0; list-style: none; }
.ap__row {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  width: 100%;
  padding: 6px var(--space-2);
  border-radius: var(--radius-sm);
  text-align: left;
  transition: background var(--dur-fast) var(--ease-out);
}
.ap__row:hover { background: var(--bg-hover); }
.ap__row:active { background: var(--bg-active); }
.ap__icon { flex: none; width: 15px; height: 15px; margin-top: 2px; stroke-width: 1.85; }
.ap__icon.is-running { color: var(--ripe-running); }
.ap__icon.is-done { color: var(--ripe-done); }
.ap__icon.is-error { color: var(--ripe-error); }
.ap__icon.is-queued { color: var(--ripe-queued); }
.ap__icon.is-faint { color: var(--fg-faint); }
.ap__turn { animation: ap-turn 2.4s linear infinite; }
@keyframes ap-turn { to { transform: rotate(360deg); } }
.ap__text { flex: 1; min-width: 0; display: grid; gap: 1px; }
.ap__name { min-width: 0; font-size: var(--text-sm); font-weight: 520; color: var(--fg-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ap__row:hover .ap__name { color: var(--fg); }
.ap__sub { display: flex; align-items: center; gap: 6px; min-width: 0; font-size: var(--text-xs); color: var(--fg-faint); white-space: nowrap; }
.ap__flow-name { flex: none; max-width: 40%; font-weight: 540; color: var(--fg-subtle); overflow: hidden; text-overflow: ellipsis; }
.ap__tag { min-width: 0; font-family: var(--font-mono); font-size: var(--text-2xs); overflow: hidden; text-overflow: ellipsis; }
.ap__grow { flex: none; }
.ap__when { flex: none; margin-left: auto; padding-top: 3px; font-size: var(--text-2xs); color: var(--fg-faint); }
.ap__when.is-running { color: var(--ripe-running-fg); }

/* A running run's jobs as a row of steps: done, running (breathing), failed, waiting. */
.ap__steps { display: flex; flex-wrap: wrap; gap: 3px; margin-top: 5px; }
.ap__steps span { width: 14px; height: 3px; border-radius: var(--radius-pill); background: var(--line); }
.ap__steps .is-success { background: var(--ripe-done); }
.ap__steps .is-pending { background: var(--ripe-running); animation: ap-breathe 1.8s var(--ease-in-out) infinite; }
.ap__steps .is-failure { background: var(--ripe-error); }
.ap__steps .is-cancelled, .ap__steps .is-skipped { background: var(--line-strong); }
@keyframes ap-breathe { 50% { opacity: 0.45; } }
.ap__more { align-self: flex-start; margin: var(--space-2) var(--space-2) 0; }

.ap__skeleton { display: grid; gap: 14px; padding: var(--space-4); border-top: 1px solid var(--line-soft); }
.ap__skeleton span { display: flex; align-items: center; gap: var(--space-2); }
.ap__skeleton i { width: 15px; height: 15px; border-radius: var(--radius-xs); background: var(--bg-hover); }
.ap__skeleton b { height: 10px; border-radius: var(--radius-xs); background: var(--bg-hover); }

.ap__empty { display: grid; gap: var(--space-3); justify-items: start; padding: var(--space-4); border-top: 1px solid var(--line-soft); font-size: var(--text-sm); color: var(--fg-subtle); }
.ap__empty h3 { margin: 0; font-size: var(--text-md); font-weight: 600; color: var(--fg); }
.ap__empty p { margin: 0; max-width: 46ch; }
</style>
