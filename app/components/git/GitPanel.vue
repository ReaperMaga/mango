<script setup lang="ts">
import {
  ArrowDown, ArrowUp, Check, ChevronDown, ChevronRight, CircleAlert, CloudDownload, CloudUpload,
  GitBranch, Minus, Plus, RefreshCw, Undo2, X,
} from 'lucide-vue-next'
import type { GitFile } from '~/types/ipc'
import type { MenuItem } from '~/types/ui'
import { useWorkspace } from '~/stores/workspace'
import { gitFileKey, useGit, type GitAction } from '~/stores/git'
import { useThreads } from '~/stores/threads'
import { diffTabId, isDiffTab } from '~/utils/diffTabs'
import { isMod, modLabel } from '~/composables/useShortcuts'
import { shortAgo, useNow } from '~/utils/time'
import { resultLines, units, vcsTerms } from '~/utils/vcs'
import { isEnvPath } from '~/utils/envPath'

/** How often the poll timer looks; each system says how often it is worth reading (`pollMs`). */
const TICK_MS = 4000
/** A remote project's every read is a few SSH connections: look less often. */
const REMOTE_POLL_MS = 15000

const ws = useWorkspace()
const git = useGit()
const now = useNow()

const path = computed(() => ws.activeProjectPath)
const repo = computed(() => git.repo(path.value))
const status = computed(() => repo.value?.status ?? null)
const isRepo = computed(() => !!status.value?.isRepo)
/** Words and actions for git or Unity VCS. */
const terms = computed(() => vcsTerms(status.value?.vcs))
const staged = computed(() => git.stagedFiles(path.value))
const changes = computed(() => git.changedFiles(path.value))
const conflicts = computed(() => changes.value.filter(f => f.conflicted).length)
const discardable = computed(() => changes.value.filter(f => !f.conflicted))
const newFiles = computed(() => discardable.value.filter(f => f.worktree === '?').length)
const clean = computed(() => isRepo.value && !staged.value.length && !changes.value.length)

const running = (action: GitAction) => git.isBusy(path.value, action)
/** Staging takes milliseconds; only the slow actions are worth greying controls out for. */
const waiting = computed(() => !!git.busy && !['stage', 'unstage', 'discard'].includes(git.busy))

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/* ---------- keeping it fresh ---------- */

function refresh() {
  if (path.value) return git.refresh(path.value)
}
function onVisible() {
  if (document.visibilityState === 'visible') void refresh()
}
let poll: ReturnType<typeof setInterval> | undefined
let lastPoll = 0
onMounted(() => {
  window.addEventListener('focus', refresh)
  document.addEventListener('visibilitychange', onVisible)
  poll = setInterval(() => {
    const every = isEnvPath(path.value) ? Math.max(terms.value.pollMs, REMOTE_POLL_MS) : terms.value.pollMs
    if (!path.value || document.visibilityState !== 'visible' || Date.now() - lastPoll < every - 100) return
    lastPoll = Date.now()
    git.poll(path.value)
  }, TICK_MS)
})
onBeforeUnmount(() => {
  window.removeEventListener('focus', refresh)
  document.removeEventListener('visibilitychange', onVisible)
  clearInterval(poll)
  clearTimeout(noticeTimer)
})

/** The row (by key) or 'all' that is asking before it discards. */
const confirming = ref<string | null>(null)

const spun = ref(false)
async function manualRefresh() {
  spun.value = true
  await Promise.all([refresh(), new Promise(r => setTimeout(r, 450))])
  spun.value = false
}

/* ---------- result strip ---------- */

const noticeOf = (error: boolean, text: string, dismiss: boolean) => ({ error, dismiss, ...resultLines(text) })
const notice = computed(() => {
  if (git.noticePath === path.value) {
    if (git.lastError) return noticeOf(true, git.lastError, true)
    if (git.lastOutput) return noticeOf(false, git.lastOutput, true)
  }
  // A failed background refresh while older data is still on screen.
  if (repo.value?.error && status.value) return noticeOf(true, `Couldn't refresh.\n${repo.value.error}`, false)
  return null
})
/* Confirmations ("Committed a1b2c3d", "Pulled 3 commits into main.") clear themselves; failures stay until dismissed. */
let noticeTimer: ReturnType<typeof setTimeout> | undefined
watch(() => git.lastOutput, (out) => {
  clearTimeout(noticeTimer)
  if (out) noticeTimer = setTimeout(() => { if (git.lastOutput === out) git.lastOutput = null }, out.includes('\n') ? 8000 : 5000)
})

/* ---------- branch ---------- */

const branchLabel = computed(() => status.value?.branch ?? (status.value?.head ? `${status.value.head} (detached)` : 'No branch'))
const branchItems = computed<MenuItem[]>(() => {
  const current = status.value?.branch ?? null
  const local = repo.value?.branches?.local ?? (current ? [current] : [])
  const items: MenuItem[] = local.map(name => ({
    label: name,
    icon: GitBranch,
    checked: name === current,
    onSelect: () => { if (name !== current && path.value) void git.checkout(path.value, name) },
  }))
  items.push({ label: 'New branch…', icon: Plus, divider: items.length > 0, onSelect: startCreate })
  return items
})
function openBranches(toggle: () => void, open: boolean) {
  if (!open && path.value) void git.loadBranches(path.value)
  toggle()
}

const creating = ref(false)
const newBranch = ref('')
const newBranchInput = ref<HTMLInputElement | null>(null)
async function startCreate() {
  newBranch.value = ''
  creating.value = true
  await nextTick()
  newBranchInput.value?.focus()
}
function onBranchInput(e: Event) {
  // Branch names can't hold spaces; type them as dashes.
  newBranch.value = (e.target as HTMLInputElement).value.replace(/\s+/g, '-')
}
async function createBranch() {
  const name = newBranch.value.trim()
  if (!name || !path.value) return
  if (await git.checkout(path.value, name, true)) creating.value = false
}
function onBranchBlur(e: FocusEvent) {
  const next = e.relatedTarget as Node | null
  if (!newBranch.value.trim() && !(e.currentTarget as HTMLElement).contains(next)) creating.value = false
}

watch(path, () => {
  confirming.value = null
  creating.value = false
  void refresh()
}, { immediate: true })

/* ---------- sync ---------- */

const upstream = computed(() => status.value?.upstream ?? null)
const ahead = computed(() => status.value?.ahead ?? 0)
const behind = computed(() => status.value?.behind ?? 0)
const pullTitle = computed(() => (behind.value ? `Pull ${plural(behind.value, 'commit')} from ${upstream.value}` : `Pull from ${upstream.value}`))
/** Unity VCS: bring the workspace to the newest changeset on its branch. */
const updateTitle = computed(() => (behind.value
  ? `Update: ${units(behind.value, terms.value)} on ${status.value?.branch ?? 'the branch'} you don't have yet`
  : 'Update the workspace to the latest changeset'))
/** Unity VCS: the repository the workspace is bound to, without the server part. */
const repository = computed(() => status.value?.repository ?? null)
const repositoryName = computed(() => repository.value?.split('@')[0] ?? null)
const pushTitle = computed(() => (ahead.value ? `Push ${plural(ahead.value, 'commit')} to ${upstream.value}` : `Push to ${upstream.value} (nothing new)`))
const canPublish = computed(() => !!status.value?.branch && !!status.value?.head)
const publishTitle = computed(() => {
  if (!status.value?.branch) return 'Switch to a branch to publish it'
  if (!status.value.head) return 'Commit something first, then publish'
  return `Push ${status.value.branch} and start tracking it on the remote`
})

/* ---------- commit ---------- */

const mod = ref('Ctrl')
onMounted(() => (mod.value = modLabel()))

const message = computed({
  get: () => repo.value?.message ?? '',
  set: (v: string) => { if (path.value) git.ensure(path.value).message = v },
})
const messageBox = ref<HTMLTextAreaElement | null>(null)
watch([message, messageBox], async () => {
  await nextTick()
  const el = messageBox.value
  if (!el) return
  el.style.height = 'auto'
  el.style.height = `${Math.min(el.scrollHeight + 2, 184)}px`
}, { immediate: true })

/** Nothing staged: the button stages everything first, like "Commit all" elsewhere. */
const commitsAll = computed(() => staged.value.length === 0 && changes.value.length > 0)
const canCommit = computed(() => !git.busy && !!message.value.trim() && conflicts.value === 0 && (staged.value.length > 0 || changes.value.length > 0))
const commitHint = computed(() => {
  if (conflicts.value) return { text: `Resolve ${plural(conflicts.value, 'conflict')} first`, warn: true }
  if (staged.value.length) return { text: `${plural(staged.value.length, 'file')} staged`, warn: false }
  const all = changes.value.length === 1 ? 'the 1 change' : `all ${changes.value.length} changes`
  if (changes.value.length) return { text: terms.value.amend ? `Nothing staged. Stages ${all}.` : `Nothing staged. Checks in ${all}.`, warn: false }
  return { text: `Nothing to ${terms.value.commit.toLowerCase()}`, warn: false }
})
const commitTitle = computed(() => {
  const verb = terms.value.commit.toLowerCase()
  return commitsAll.value ? `Stage everything and ${verb}` : `${terms.value.commit} staged files`
})
const showCommit = computed(() => isRepo.value && (!clean.value || !!message.value))

function commit() {
  if (canCommit.value && path.value) void git.commit(path.value)
}
function onMessageKey(e: KeyboardEvent) {
  if (e.key === 'Enter' && isMod(e)) {
    e.preventDefault()
    commit()
  }
}
const commitMenu = computed<MenuItem[]>(() => [{
  label: 'Amend last commit',
  hint: message.value.trim() ? 'Adds what is staged and replaces its message' : 'Adds what is staged, keeps its message',
  disabled: !status.value?.head || !!git.busy || conflicts.value > 0,
  onSelect: () => { if (path.value) void git.commit(path.value, { amend: true }) },
}])

/* ---------- files ---------- */

const open = reactive({ staged: true, changes: true })

/** Show the file's diff as a tab in the main pane. */
function toggle(file: GitFile, isStaged: boolean) {
  if (!path.value) return
  const key = gitFileKey(file.path, isStaged)
  git.openDiff(path.value, key)
  const threads = useThreads()
  const id = diffTabId(path.value, key)
  const current = threads.activePane.threadId
  // Looking at a diff already: swap it for this one instead of opening yet another tab.
  if (isDiffTab(current) && current !== id) threads.replaceTab(current, id)
  else threads.show(id)
}
function stage(file: GitFile) {
  if (path.value) void git.stage(path.value, [file.path])
}
function unstage(file: GitFile) {
  if (path.value) void git.unstage(path.value, [file.path])
}
function stageAll() {
  if (!path.value) return
  // Staging a conflicted file marks it resolved, so "all" leaves those for a deliberate click.
  if (conflicts.value) {
    if (discardable.value.length) void git.stage(path.value, discardable.value.map(f => f.path))
  } else {
    void git.stage(path.value)
  }
}
function unstageAll() {
  if (path.value) void git.unstage(path.value)
}
function discard(file: GitFile) {
  confirming.value = null
  if (path.value) void git.discard(path.value, [file.path])
}
function discardAll() {
  confirming.value = null
  if (path.value) void git.discard(path.value)
}

const scroller = ref<HTMLElement | null>(null)
/** Up and Down walk the file rows. */
function onListKey(e: KeyboardEvent) {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
  const from = e.target as HTMLElement
  if (!from.classList?.contains('gf__main') || !scroller.value) return
  const rows = [...scroller.value.querySelectorAll<HTMLElement>('.gf__main')]
  const next = rows[rows.indexOf(from) + (e.key === 'ArrowDown' ? 1 : -1)]
  if (next) {
    e.preventDefault()
    next.focus()
  }
}

</script>

<template>
  <!-- Shown in the tool window on the right (see AppToolPanel), which owns width and resizing. -->
  <section class="gp" aria-label="Changes">
    <header class="gp__head">
      <h2 class="gp__title">Changes</h2>
      <div class="gp__tools">
        <template v-if="isRepo && !terms.remotes">
          <button type="button" class="gp__sync" :aria-label="updateTitle" :title="updateTitle" :disabled="waiting" @click="path && git.pull(path)">
            <span v-if="running('pull')" class="gp__spin" aria-hidden="true" />
            <ArrowDown v-else />
            <span v-if="behind" class="gp__sync-n tabular">{{ behind }}</span>
          </button>
        </template>
        <template v-else-if="isRepo">
          <UiIconButton label="Fetch from the remote" :disabled="waiting" @click="path && git.fetch(path)">
            <span v-if="running('fetch')" class="gp__spin" aria-hidden="true" />
            <CloudDownload v-else />
          </UiIconButton>
          <template v-if="upstream">
            <button type="button" class="gp__sync" :aria-label="pullTitle" :title="pullTitle" :disabled="waiting" @click="path && git.pull(path)">
              <span v-if="running('pull')" class="gp__spin" aria-hidden="true" />
              <ArrowDown v-else />
              <span v-if="behind" class="gp__sync-n tabular">{{ behind }}</span>
            </button>
            <button type="button" class="gp__sync" :aria-label="pushTitle" :title="pushTitle" :disabled="waiting" @click="path && git.push(path)">
              <span v-if="running('push')" class="gp__spin" aria-hidden="true" />
              <ArrowUp v-else />
              <span v-if="ahead" class="gp__sync-n tabular">{{ ahead }}</span>
            </button>
          </template>
        </template>
        <UiIconButton label="Refresh" :class="{ 'is-spun': spun }" @click="manualRefresh"><RefreshCw /></UiIconButton>
      </div>
    </header>

    <div v-if="isRepo" class="gp__branch">
      <template v-if="true">
        <GitBranchPopup :path="path">
          <template #default="{ toggle, open: menuOpen }">
            <button
              type="button"
              class="gp__branch-btn"
              :class="{ 'is-open': menuOpen }"
              aria-haspopup="dialog"
              :aria-expanded="menuOpen"
              :title="menuOpen ? undefined : `Branch: ${branchLabel}`"
              @click="toggle"
            >
              <span v-if="running('checkout')" class="gp__spin" aria-hidden="true" />
              <GitBranch v-else aria-hidden="true" />
              <span class="gp__branch-name">{{ branchLabel }}</span>
              <ChevronDown class="gp__chev" aria-hidden="true" />
            </button>
          </template>
        </GitBranchPopup>
        <span v-if="upstream" class="gp__upstream" :title="`Tracks ${upstream}`">{{ upstream }}</span>
        <span v-else-if="repository" class="gp__upstream" :title="`Unity VCS repository ${repository}`">{{ repositoryName }}</span>
        <UiButton
          v-else-if="status?.branch && terms.remotes"
          class="gp__publish"
          size="sm"
          variant="ghost"
          :loading="running('push')"
          :disabled="waiting || !canPublish"
          :title="publishTitle"
          @click="path && git.push(path)"
        >
          <CloudUpload />Publish branch
        </UiButton>
      </template>
    </div>

    <div v-if="notice" class="gp__notice" :class="{ 'is-error': notice.error }" :role="notice.error ? 'alert' : 'status'">
      <CircleAlert v-if="notice.error" class="gp__notice-icon" aria-hidden="true" />
      <Check v-else class="gp__notice-icon" aria-hidden="true" />
      <div class="gp__notice-text selectable">
        <p class="gp__notice-title">{{ notice.title }}</p>
        <p v-if="notice.detail" class="gp__notice-detail">{{ notice.detail }}</p>
      </div>
      <UiIconButton v-if="notice.dismiss" size="sm" label="Dismiss" @click="git.dismiss()"><X /></UiIconButton>
    </div>

    <form v-if="showCommit" class="gp__commit" @submit.prevent="commit">
      <textarea
        ref="messageBox"
        v-model="message"
        class="gp__message"
        rows="2"
        :placeholder="terms.message"
        :aria-label="terms.message"
        spellcheck="true"
        @keydown="onMessageKey"
      />
      <div class="gp__commit-row">
        <span class="gp__commit-hint" :class="{ 'is-warn': commitHint.warn }">{{ commitHint.text }}</span>
        <div class="gp__commit-btns">
          <UiButton
            variant="primary"
            size="sm"
            type="submit"
            :loading="running('commit')"
            :disabled="!canCommit"
            :title="`${commitTitle} (${mod}+Enter)`"
          >
            {{ commitsAll ? terms.commitAll : terms.commit }}
          </UiButton>
          <UiMenu v-if="terms.amend" :items="commitMenu" placement="bottom-end" :width="264" label="More commit options">
            <template #default="{ toggle, open: menuOpen }">
              <UiIconButton size="sm" label="More commit options" :active="menuOpen" class="gp__commit-more" @click="toggle"><ChevronDown /></UiIconButton>
            </template>
          </UiMenu>
        </div>
      </div>
    </form>

    <div ref="scroller" class="gp__scroll" @keydown="onListKey">
      <template v-if="isRepo">
        <section v-if="staged.length" class="gp__sec">
          <div class="gp__sec-head">
            <button type="button" class="gp__sec-toggle" :aria-expanded="open.staged" @click="open.staged = !open.staged">
              <ChevronRight class="gp__caret" :class="{ 'is-open': open.staged }" aria-hidden="true" />
              <span>Staged</span>
              <span class="gp__count tabular">{{ staged.length }}</span>
            </button>
            <div class="gp__sec-actions">
              <UiIconButton size="sm" label="Unstage all" :disabled="waiting" @click="unstageAll"><Minus /></UiIconButton>
            </div>
          </div>
          <ul v-show="open.staged" class="gp__list" role="list">
            <GitFileRow
              v-for="f in staged"
              :key="f.path"
              :file="f"
              staged
              :expanded="git.isExpanded(path!, gitFileKey(f.path, true))"
              :diff="repo?.diffs[gitFileKey(f.path, true)] ?? null"
              :confirming="false"
              :disabled="waiting"
              @toggle="toggle(f, true)"
              @unstage="unstage(f)"
            />
          </ul>
        </section>

        <section v-if="changes.length" class="gp__sec">
          <div class="gp__sec-head">
            <button type="button" class="gp__sec-toggle" :aria-expanded="open.changes" @click="open.changes = !open.changes">
              <ChevronRight class="gp__caret" :class="{ 'is-open': open.changes }" aria-hidden="true" />
              <span>Changes</span>
              <span class="gp__count tabular">{{ changes.length }}</span>
            </button>
            <div class="gp__sec-actions">
              <UiIconButton
                v-if="discardable.length"
                size="sm"
                label="Discard all changes…"
                :active="confirming === 'all'"
                :disabled="waiting"
                @click="confirming = confirming === 'all' ? null : 'all'"
              >
                <Undo2 />
              </UiIconButton>
              <UiIconButton size="sm" label="Stage all" :disabled="waiting || (conflicts > 0 && !discardable.length)" @click="stageAll"><Plus /></UiIconButton>
            </div>
          </div>

          <div v-if="confirming === 'all'" class="gp__ask" role="alertdialog" aria-label="Discard all changes" @keydown.esc.stop.prevent="confirming = null">
            <p>
              Discard {{ discardable.length === 1 ? 'the 1 change' : `all ${discardable.length} changes` }}?
              <template v-if="newFiles">{{ plural(newFiles, 'new file') }} will be deleted.</template>
              This can't be undone.
            </p>
            <div class="gp__ask-btns">
              <UiButton size="sm" variant="ghost" @click="confirming = null">Keep</UiButton>
              <UiButton size="sm" variant="danger" :disabled="!!git.busy" @click="discardAll">Discard all</UiButton>
            </div>
          </div>

          <ul v-show="open.changes" class="gp__list" role="list">
            <GitFileRow
              v-for="f in changes"
              :key="f.path"
              :file="f"
              :staged="false"
              :expanded="git.isExpanded(path!, gitFileKey(f.path, false))"
              :diff="repo?.diffs[gitFileKey(f.path, false)] ?? null"
              :confirming="confirming === gitFileKey(f.path, false)"
              :disabled="waiting"
              @toggle="toggle(f, false)"
              @stage="stage(f)"
              @ask="confirming = gitFileKey(f.path, false)"
              @cancel="confirming === gitFileKey(f.path, false) && (confirming = null)"
              @discard="discard(f)"
            />
          </ul>
        </section>

        <p v-if="clean" class="gp__quiet">No changes</p>

        <section class="gp__sec gp__sec--history">
          <div class="gp__sec-head">
            <button type="button" class="gp__sec-toggle" :aria-expanded="repo?.historyOpen ?? false" @click="path && git.toggleHistory(path)">
              <ChevronRight class="gp__caret" :class="{ 'is-open': repo?.historyOpen }" aria-hidden="true" />
              <span>History</span>
            </button>
          </div>
          <template v-if="repo?.historyOpen">
            <ul v-if="repo.log.length" class="gp__log" role="list">
              <li
                v-for="(c, i) in repo.log"
                :key="c.hash"
                class="gp__commit-item"
                :title="`${c.subject}\n${c.author} · ${new Date(c.time).toLocaleString()}${i < ahead ? '\nNot pushed yet' : ''}`"
              >
                <span class="gp__subject">{{ c.subject || '(no message)' }}</span>
                <ArrowUp v-if="i < ahead" class="gp__unpushed" aria-label="Not pushed yet" />
                <code class="gp__hash">{{ c.shortHash }}</code>
                <span class="gp__when tabular">{{ shortAgo(c.time, now) }}</span>
              </li>
            </ul>
            <p v-else class="gp__quiet">{{ repo.logHead === undefined ? 'Reading history…' : `No ${terms.unit}s yet` }}</p>
          </template>
        </section>
      </template>

      <div v-else-if="status" class="gp__empty">
        <p><strong>{{ ws.activeProject?.name ?? 'This folder' }}</strong> isn't a git repository yet.</p>
        <UiButton size="sm" :loading="running('init')" @click="path && git.init(path)">Initialize repository</UiButton>
      </div>

      <div v-else-if="repo?.error" class="gp__empty">
        <p>Couldn't read this repository.</p>
        <pre class="gp__error selectable">{{ repo.error }}</pre>
        <UiButton size="sm" @click="manualRefresh">Try again</UiButton>
      </div>

      <p v-else-if="path" class="gp__quiet">Reading repository…</p>
    </div>

  </section>
</template>

<style scoped>
.gp {
  position: relative;
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}

/* ---------- header ---------- */
.gp__head {
  flex: none;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  height: var(--tabbar-h);
  padding: 0 var(--space-2) 0 var(--space-3);
}
.gp__title {
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
.gp__tools { flex: none; display: flex; align-items: center; gap: 2px; }

.gp__sync {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 3px;
  min-width: 28px;
  height: 28px;
  padding: 0 6px;
  border-radius: var(--radius-sm);
  color: var(--fg-subtle);
  transition: background var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out);
}
.gp__sync svg { width: 16px; height: 16px; stroke-width: 1.75; flex: none; }
.gp__sync:hover:not(:disabled) { background: var(--bg-hover); color: var(--fg); }
.gp__sync:active:not(:disabled) { background: var(--bg-active); }
.gp__sync:disabled { opacity: 0.4; }
.gp__sync-n { font-size: var(--text-xs); font-weight: 560; color: var(--fg); line-height: 1; }

.gp__spin {
  width: 12px;
  height: 12px;
  flex: none;
  border-radius: 50%;
  border: 1.75px solid var(--ripe-running);
  border-right-color: transparent;
  animation: gp-spin 0.75s linear infinite;
}
@keyframes gp-spin { to { transform: rotate(360deg); } }
.is-spun :deep(svg) { animation: gp-spin 0.45s var(--ease-out); }

/* ---------- branch row ---------- */
.gp__branch {
  flex: none;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-height: 28px;
  padding: 0 var(--space-2) var(--space-1) 6px;
}
.gp__branch-menu { min-width: 0; flex: 0 1 auto; }
.gp__branch-menu :deep(.menu__pop) { max-height: min(60vh, 420px); overflow-y: auto; }
.gp__branch-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  max-width: 100%;
  height: 26px;
  padding: 0 6px;
  border-radius: var(--radius-sm);
  color: var(--fg-muted);
  transition: background var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out);
}
.gp__branch-btn:hover:not(:disabled), .gp__branch-btn.is-open { background: var(--bg-hover); color: var(--fg); }
.gp__branch-btn:disabled { opacity: 0.55; }
.gp__branch-btn svg { width: 13px; height: 13px; flex: none; stroke-width: 1.75; color: var(--fg-subtle); }
.gp__branch-btn .gp__chev { width: 12px; height: 12px; color: var(--fg-faint); }
.gp__branch-name {
  min-width: 0;
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.gp__upstream {
  flex: 1 1 0;
  min-width: 0;
  padding-right: var(--space-1);
  text-align: right;
  font-family: var(--font-mono);
  font-size: var(--text-2xs);
  color: var(--fg-faint);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.gp__publish { flex: none; margin-left: auto; }

.gp__new-branch { flex: 1; min-width: 0; display: flex; align-items: center; gap: var(--space-1); padding-left: 6px; }
.gp__new-branch > svg { width: 13px; height: 13px; flex: none; stroke-width: 1.75; color: var(--fg-subtle); }
.gp__new-input {
  flex: 1;
  min-width: 0;
  height: 26px;
  margin: 0 2px 0 var(--space-1);
  padding: 0 var(--space-2);
  background: var(--bg-inset);
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  transition: border-color var(--dur-fast) var(--ease-out), box-shadow var(--dur-fast) var(--ease-out);
}
.gp__new-input::placeholder { color: var(--fg-faint); font-family: var(--font-ui); }

/* ---------- result strip ---------- */
.gp__notice {
  flex: none;
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  margin: 0 var(--space-2) var(--space-2) var(--space-3);
  padding: 6px 4px 6px var(--space-2);
  border: 1px solid var(--line-soft);
  border-radius: var(--radius-md);
  background: var(--bg-inset);
}
.gp__notice.is-error {
  border-color: color-mix(in oklch, var(--ripe-error) 35%, transparent);
  background: color-mix(in oklch, var(--ripe-error) 10%, transparent);
}
.gp__notice-icon { width: 14px; height: 14px; flex: none; margin-top: 2px; stroke-width: 1.85; color: var(--ripe-queued-fg); }
.gp__notice.is-error .gp__notice-icon { color: var(--ripe-error-fg); }
.gp__notice-text {
  flex: 1;
  min-width: 0;
  max-height: 132px;
  overflow: auto;
  font-size: var(--text-xs);
  line-height: 1.5;
  overflow-wrap: anywhere;
}
.gp__notice-title { margin: 0; font-weight: 560; color: var(--fg); }
.gp__notice-detail { margin: 1px 0 0; color: var(--fg-subtle); white-space: pre-wrap; }
/* Failures keep git's own words (paths, commands), so the detail reads as output. */
.gp__notice.is-error .gp__notice-detail { font-family: var(--font-mono); color: var(--fg-muted); }

/* ---------- commit box ---------- */
.gp__commit { flex: none; padding: 0 var(--space-2) var(--space-2) var(--space-3); }
.gp__message {
  display: block;
  width: 100%;
  min-height: 54px;
  padding: 7px var(--space-2);
  resize: none;
  background: var(--bg-inset);
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  font-size: var(--text-sm);
  line-height: 1.5;
  transition: border-color var(--dur-fast) var(--ease-out), box-shadow var(--dur-fast) var(--ease-out);
}
.gp__message::placeholder { color: var(--fg-faint); }
.gp__message:focus-visible, .gp__new-input:focus-visible { outline: none; }
.gp__message:focus, .gp__new-input:focus { border-color: var(--accent-line); box-shadow: 0 0 0 3px var(--accent-soft); }
.gp__commit-row { display: flex; align-items: center; gap: var(--space-2); margin-top: var(--space-2); }
.gp__commit-hint {
  flex: 1;
  min-width: 0;
  font-size: var(--text-xs);
  color: var(--fg-subtle);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.gp__commit-hint.is-warn { color: var(--ripe-error-fg); }
.gp__commit-btns { flex: none; display: flex; align-items: center; gap: 2px; }
.gp__commit-btns .gp__commit-more { height: 26px; }

/* ---------- lists ---------- */
.gp__scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 0 var(--space-2) var(--space-3) var(--space-2);
  border-top: 1px solid var(--line-soft);
}
.gp__sec { padding-top: var(--space-2); }
.gp__sec + .gp__sec, .gp__quiet + .gp__sec { margin-top: var(--space-1); }
.gp__sec-head { display: flex; align-items: center; height: 28px; padding-right: 3px; }
.gp__sec-toggle {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 4px;
  height: 100%;
  padding: 0 4px;
  border-radius: var(--radius-sm);
  font-size: var(--text-xs);
  font-weight: 600;
  color: var(--fg-muted);
  text-align: left;
}
.gp__sec-toggle:hover { color: var(--fg); }
.gp__caret { width: 13px; height: 13px; flex: none; color: var(--fg-subtle); transition: transform var(--dur-fast) var(--ease-out); }
.gp__caret.is-open { transform: rotate(90deg); }
.gp__count { margin-left: 2px; font-weight: 500; color: var(--fg-faint); }
.gp__sec-actions { flex: none; display: flex; align-items: center; gap: 1px; }
.gp__list { list-style: none; margin: 2px 0 0; padding: 0; display: grid; gap: 1px; }

.gp__ask {
  margin: 2px 0 var(--space-2);
  padding: var(--space-2) var(--space-2) var(--space-2) var(--space-3);
  border: 1px solid color-mix(in oklch, var(--ripe-error) 35%, transparent);
  border-radius: var(--radius-md);
  background: color-mix(in oklch, var(--ripe-error) 8%, transparent);
}
.gp__ask p { margin: 0; font-size: var(--text-xs); line-height: var(--leading-normal); color: var(--fg-muted); }
.gp__ask-btns { display: flex; justify-content: flex-end; gap: var(--space-1); margin-top: var(--space-2); }

.gp__quiet { margin: 0; padding: var(--space-3) var(--space-2) var(--space-2) var(--space-1); font-size: var(--text-sm); color: var(--fg-subtle); }

.gp__log { list-style: none; margin: 2px 0 0; padding: 0; }
.gp__commit-item {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  height: 28px;
  padding: 0 6px 0 var(--space-1);
}
.gp__subject {
  flex: 1;
  min-width: 0;
  font-size: var(--text-sm);
  color: var(--fg-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.gp__unpushed { width: 12px; height: 12px; flex: none; stroke-width: 2; color: var(--accent-ink); }
.gp__hash { flex: none; font-size: var(--text-2xs); color: var(--fg-faint); }
.gp__when { flex: none; min-width: 26px; text-align: right; font-size: var(--text-2xs); color: var(--fg-faint); }

.gp__empty { padding: var(--space-4) var(--space-2) var(--space-3) var(--space-1); display: grid; justify-items: start; gap: var(--space-3); }
.gp__empty p { margin: 0; font-size: var(--text-sm); line-height: var(--leading-normal); color: var(--fg-subtle); }
.gp__empty strong { font-weight: 600; color: var(--fg-muted); }
.gp__error {
  width: 100%;
  max-height: 160px;
  margin: 0;
  padding: var(--space-2) var(--space-3);
  overflow: auto;
  border: 1px solid var(--line-soft);
  border-radius: var(--radius-md);
  background: var(--bg-inset);
  font-size: var(--text-xs);
  line-height: 1.6;
  color: var(--fg-muted);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

</style>
