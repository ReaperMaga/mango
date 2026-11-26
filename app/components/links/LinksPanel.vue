<script setup lang="ts">
import { ArrowLeft, ExternalLink, Link2, RefreshCw, Unlink, X } from 'lucide-vue-next'
import type { LinkedItem } from '~/types/chat'
import type { GhCheck } from '~/types/ipc'
import { useThreads } from '~/stores/threads'
import { useLinks } from '~/stores/links'
import { useGit } from '~/stores/git'
import { useWorkspace } from '~/stores/workspace'
import { openExternal } from '~/composables/useBackend'
import { stateOf } from '~/utils/linkState'
import { useForge } from '~/stores/forge'
import { itemNumber, providerOf, siteName } from '~/utils/forge'

/**
 * The Pull requests tool window (Merge requests for a project on GitLab): the pull requests or merge
 * requests and issues linked to the chat in front of the user. The agent links the ones it opens
 * (`gh pr create`, `glab mr create`); the user can link others by
 * hand. With one linked item it opens straight away, with several the list comes first.
 * With no chat in front it browses the project's open ones: picking one opens it, linked to nothing.
 */

const { t } = useI18n()
const threads = useThreads()
const links = useLinks()
const git = useGit()
const workspace = useWorkspace()

/** A Unity VCS workspace in view has code reviews, not pull requests: LinksReviews takes the window. */
const reviewsPath = computed(() => {
  const dir = threads.workdir
  if (!dir) return null
  const vcs = git.repos[dir]?.status?.vcs ?? (workspace.activeProject?.path === dir ? workspace.activeProject.vcs : null)
  return vcs === 'plastic' ? dir : null
})

/** The chat in the active pane; a sub-agent's chat stands for the chat that started it. */
const chat = computed(() => {
  const id = threads.activePane.threadId
  return id && threads.byId(id) ? threads.rootOf(id) : null
})
const list = computed<LinkedItem[]>(() => chat.value?.links ?? [])
/** Where items are read from: the chat's project, or with no chat the project in view. */
const projectPath = computed(() => chat.value?.projectPath ?? workspace.activeProjectPath ?? null)
/** The project's forge, for the words: GitHub's pull requests or GitLab's merge requests. */
const forge = useForge()
watch(projectPath, p => forge.ensure(p), { immediate: true })
const provider = computed(() => forge.providerOf(projectPath.value))
/** An item's noun, by its key under `links.noun` and `links.panel.back`. */
const nounOf = (l: LinkedItem) => (l.kind === 'issue' ? 'issue' : providerOf(l) === 'gitlab' ? 'mergeRequest' : 'pullRequest')
/** Where the item in front lives, for "Open on …". */
const site = (l: LinkedItem) => siteName(providerOf(l), l.host)
/** With no chat in front: the item opened from the project's open ones (linked to nothing). */
const browsed = ref<LinkedItem | null>(null)
// Another project: what was opened from the last one does not follow.
watch(() => workspace.activeProjectPath, () => { browsed.value = null })
const current = computed(() => (chat.value
  ? list.value.find(l => l.key === links.focused) ?? (list.value.length === 1 ? list.value[0]! : null)
  : browsed.value))

watch(() => current.value?.key, () => {
  if (current.value && projectPath.value) void links.load(current.value, projectPath.value)
}, { immediate: true })
// Titles and states of the list come from the last read; read the ones never read.
watch(list, (items) => {
  if (!chat.value) return
  for (const l of items) if (!l.title && !links.details[l.key]) void links.load(l, chat.value.projectPath)
}, { immediate: true })

function open(l: LinkedItem) { links.focused = l.key }
const currentDetail = computed(() => (current.value ? links.details[current.value.key] : undefined))
const refreshing = computed(() => !!(currentDetail.value?.loading && currentDetail.value.item && !currentDetail.value.quiet))
/** An open pull request (or draft) can be merged from here. */
const mergeable = computed(() => {
  const it = currentDetail.value?.item
  return it?.kind === 'pr' && (it.state === 'open' || it.state === 'draft') ? it : null
})

/* ---------- keeping an open pull request current ---------- */
/** While checks run or the forge works out mergeability, look often; otherwise now and then. */
const POLL_BUSY_MS = 10_000
const POLL_IDLE_MS = 60_000
let poller: ReturnType<typeof setTimeout> | undefined

function pollDelay(): number | null {
  const it = currentDetail.value?.item
  if (!it || it.kind !== 'pr' || it.state === 'merged' || it.state === 'closed') return null
  const busy = it.checkRuns.some(c => c.state === 'pending') || it.checks === 'pending'
    || it.mergeable === 'unknown' || it.mergeState === 'unknown'
  return busy ? POLL_BUSY_MS : POLL_IDLE_MS
}
function schedule() {
  clearTimeout(poller)
  const detail = currentDetail.value
  if (!detail || detail.loading) return
  const delay = pollDelay()
  if (delay === null) return
  // Counted from the last good read, so an item opened again catches up at once; after a failed
  // read, wait the whole interval rather than ask again straight away.
  const wait = detail.error ? delay : Math.max(0, delay - (Date.now() - detail.fetchedAt))
  poller = setTimeout(poll, wait)
}
function poll() {
  // Nobody is looking at a hidden window: try again later rather than spend requests.
  if (document.hidden) { schedule(); return }
  if (current.value && projectPath.value) void links.load(current.value, projectPath.value, true, true)
}
watch(() => [current.value?.key, currentDetail.value?.loading, currentDetail.value?.fetchedAt], schedule, { immediate: true })
onBeforeUnmount(() => clearTimeout(poller))
function back() {
  if (chat.value) links.focused = null
  else browsed.value = null
}
function browse(l: LinkedItem) { browsed.value = l }

/* ---------- a check's log, over its pull request ---------- */
/** The check whose log is open, while its pull request is the one in front. */
const check = computed(() => (links.check && current.value && links.check.linkKey === current.value.key ? links.check : null))
const job = computed(() => (check.value ? links.jobs[check.value.url] : undefined))
const backButton = ref<HTMLElement | null>(null)
async function openCheck(c: GhCheck) {
  if (!current.value) return
  links.openCheck(current.value.key, c)
  await nextTick()
  backButton.value?.focus()
}
function closeCheck() { links.closeCheck() }
// Another item or another chat: the log does not follow.
watch(() => current.value?.key, (key) => { if (links.check && links.check.linkKey !== key) links.closeCheck() })
const jobRefreshing = computed(() => !!(job.value?.loading && job.value.job))
function refreshJob() { if (check.value) void links.loadJob(check.value.url, projectPath.value) }
function refresh() { if (current.value && projectPath.value) void links.load(current.value, projectPath.value, true) }
function unlink(l: LinkedItem) {
  if (!chat.value) return
  threads.unlink(chat.value.id, l.key)
  if (links.focused === l.key) links.focused = null
}

/* ---------- linking by hand ---------- */
/** The link form under the header, for a chat that has links already (an empty chat shows the picker itself). */
const adding = ref(false)

function startAdd() { adding.value = !adding.value }
function cancelAdd() { adding.value = false }
// Another chat, another list: an open link form does not follow.
watch(() => chat.value?.id, cancelAdd)
const linkedKeys = computed(() => list.value.map(l => l.key))
</script>

<template>
  <!-- Shown in the tool window on the right (see AppToolPanel), which owns width and resizing. -->
  <LinksReviews v-if="reviewsPath" :path="reviewsPath" />
  <section v-else class="lp" :aria-label="t(`links.panel.label.${provider}`)" @keydown.esc="check && closeCheck()">
    <header class="lp__head">
      <button
        v-if="check && current"
        ref="backButton"
        type="button"
        class="lp__back"
        :aria-label="t(`links.panel.back.${nounOf(current)}`, { number: itemNumber(current) })"
        :title="`${t(`links.panel.back.${nounOf(current)}`, { number: itemNumber(current) })} (Esc)`"
        @click="closeCheck"
      >
        <ArrowLeft aria-hidden="true" />
        <span class="lp__back-num tabular">{{ itemNumber(current) }}</span>
        <span class="lp__back-title">{{ currentDetail?.item?.title ?? current.title ?? t(`links.noun.${nounOf(current)}`) }}</span>
      </button>
      <template v-else>
        <UiIconButton v-if="current && list.length > 1" :label="t('links.panel.allLinked')" size="sm" @click="back"><ArrowLeft /></UiIconButton>
        <UiIconButton v-else-if="current && !chat" :label="t(`links.panel.allOpen.${provider}`)" size="sm" @click="back"><ArrowLeft /></UiIconButton>
        <h2 class="lp__title" :title="chat ? t('links.panel.linkedTo', { title: chat.title }) : undefined">{{ t(`links.panel.title.${provider}`) }}</h2>
      </template>
      <div v-if="chat && list.length && !check" class="lp__tools">
        <UiIconButton :label="t(`links.panel.link.${provider}`)" :active="adding" @click="startAdd"><Link2 /></UiIconButton>
      </div>
    </header>

    <div v-if="adding && chat && list.length" class="lp__add">
      <LinksPicker
        :key="chat.id"
        :chat-id="chat.id"
        :project-path="chat.projectPath"
        :linked="linkedKeys"
        autofocus
        @linked="cancelAdd"
        @cancel="cancelAdd"
      />
    </div>

    <div v-if="!projectPath" class="lp__quiet">
      <p>{{ t('links.panel.noProject') }}</p>
    </div>

    <LinksPicker
      v-else-if="!current && !list.length"
      :key="chat?.id ?? projectPath"
      :chat-id="chat?.id"
      :project-path="projectPath"
      fill
      @pick="browse"
    />

    <template v-else-if="current && check">
      <div class="lp__scroll">
        <LinksCheckLog :key="check.url" :check="check" :project-path="projectPath" />
      </div>
      <footer class="lp__foot">
        <UiButton size="sm" @click="openExternal(job?.job?.url || check.url)"><ExternalLink aria-hidden="true" />{{ t('links.openOn', { site: site(current) }) }}</UiButton>
        <UiButton size="sm" variant="ghost" :loading="jobRefreshing" @click="refreshJob"><RefreshCw v-if="!jobRefreshing" aria-hidden="true" />{{ t('common.actions.refresh') }}</UiButton>
      </footer>
    </template>

    <template v-else-if="current">
      <div class="lp__scroll">
        <LinksItem :key="current.key" :link="current" :detail="currentDetail" @open-check="openCheck" />
      </div>
      <LinksMerge v-if="mergeable && projectPath" :key="current.key" :link="current" :item="mergeable" :project-path="projectPath" />
      <footer class="lp__foot">
        <UiButton size="sm" @click="openExternal(currentDetail?.item?.url ?? current.url)"><ExternalLink aria-hidden="true" />{{ t('links.openOn', { site: site(current) }) }}</UiButton>
        <UiButton size="sm" variant="ghost" :loading="refreshing" @click="refresh"><RefreshCw v-if="!refreshing" aria-hidden="true" />{{ t('common.actions.refresh') }}</UiButton>
        <UiButton v-if="chat" size="sm" variant="ghost" class="lp__unlink" :title="t('links.panel.unlinkHint', { site: site(current) })" @click="unlink(current)"><Unlink aria-hidden="true" />{{ t('links.panel.unlink') }}</UiButton>
      </footer>
    </template>

    <ul v-else class="lp__scroll lp__list" :aria-label="t('links.panel.linked')">
      <li v-for="l in list" :key="l.key" class="lp__row">
        <button type="button" class="lp__open" :title="l.url" @click="open(l)">
          <component :is="stateOf(l.kind, l.state, null, l.provider).icon" class="lp__icon" :class="`is-${stateOf(l.kind, l.state, null, l.provider).tone}`" aria-hidden="true" />
          <span class="lp__text">
            <span class="lp__name">{{ l.title ?? `${l.owner}/${l.repo} ${itemNumber(l)}` }}</span>
            <span class="lp__sub">
              <span :class="`is-${stateOf(l.kind, l.state, null, l.provider).tone}`">{{ stateOf(l.kind, l.state, null, l.provider).word }}</span>
              <span class="tabular">{{ itemNumber(l) }}</span>
              <span class="lp__repo">{{ l.owner }}/{{ l.repo }}</span>
            </span>
          </span>
        </button>
        <UiIconButton class="lp__remove" size="sm" :label="t('links.panel.unlinkItem', { number: itemNumber(l) })" @click="unlink(l)"><X /></UiIconButton>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.lp { display: flex; flex-direction: column; flex: 1; min-height: 0; }
.lp__head {
  flex: none;
  display: flex;
  align-items: center;
  gap: var(--space-1);
  height: var(--tabbar-h);
  border-bottom: 1px solid var(--line);
  padding: 0 var(--space-2) 0 var(--space-3);
}
.lp__head:has(> .icon-btn:first-child) { padding-left: var(--space-2); }
.lp__title {
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
.lp__back {
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
.lp__back:hover { background: var(--bg-hover); color: var(--fg); }
.lp__back:active { background: var(--bg-active); }
.lp__back:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: -2px; }
.lp__back svg { flex: none; width: 15px; height: 15px; stroke-width: 1.85; }
.lp__back-num { flex: none; font-weight: 600; color: var(--fg); }
.lp__back-title { min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.lp__tools { flex: none; display: flex; align-items: center; gap: 2px; }

.lp__add { flex: none; border-top: 1px solid var(--line-soft); }

.lp__quiet {
  display: grid;
  gap: var(--space-2);
  justify-items: start;
  padding: var(--space-3) var(--space-4);
  border-top: 1px solid var(--line-soft);
  font-size: var(--text-sm);
  color: var(--fg-subtle);
}
.lp__quiet p { margin: 0; max-width: 46ch; }

.lp__foot {
  flex: none;
  display: flex;
  align-items: center;
  gap: var(--space-1);
  padding: var(--space-2) var(--space-3);
  border-top: 1px solid var(--line-soft);
}
.lp__foot :deep(svg) { width: 14px; height: 14px; stroke-width: 1.85; }
.lp__unlink { margin-left: auto; }

.lp__scroll { flex: 1; min-height: 0; overflow: auto; border-top: 1px solid var(--line-soft); }
.lp__list { margin: 0; padding: var(--space-1) var(--space-2); list-style: none; display: grid; align-content: start; gap: 2px; }
.lp__row { position: relative; display: flex; align-items: center; }
.lp__open {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  padding: 6px var(--space-2);
  padding-right: 30px;
  border-radius: var(--radius-sm);
  text-align: left;
  transition: background var(--dur-fast) var(--ease-out);
}
.lp__open:hover { background: var(--bg-hover); }
.lp__open:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: -2px; }
.lp__icon { flex: none; width: 15px; height: 15px; margin-top: 2px; stroke-width: 1.85; }
.lp__text { display: grid; gap: 1px; min-width: 0; }
.lp__name { font-size: var(--text-sm); color: var(--fg-muted); font-weight: 520; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.lp__open:hover .lp__name { color: var(--fg); }
.lp__sub { display: flex; gap: 6px; min-width: 0; font-size: var(--text-xs); color: var(--fg-faint); white-space: nowrap; }
.lp__sub > span:first-child { font-weight: 560; }
.lp__repo { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.lp__remove { position: absolute; right: 4px; top: 8px; opacity: 0; transition: opacity var(--dur-fast) var(--ease-out); }
.lp__row:hover .lp__remove, .lp__remove:focus-visible { opacity: 1; }

.is-running { color: var(--ripe-running-fg); }
.lp__icon.is-running { color: var(--ripe-running); }
.is-queued { color: var(--ripe-queued-fg); }
.lp__icon.is-queued { color: var(--ripe-queued); }
.is-done { color: var(--ripe-done-fg); }
.lp__icon.is-done { color: var(--ripe-done); }
.is-error { color: var(--ripe-error-fg); }
.lp__icon.is-error { color: var(--ripe-error); }
.is-idle { color: var(--fg-subtle); }
</style>
