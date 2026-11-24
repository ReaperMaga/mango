<script setup lang="ts">
import {
  Archive, ArrowDown, ArrowUp, Check, ChevronDown, ChevronRight, CircleAlert, CloudDownload, CloudUpload,
  FolderGit2, FolderMinus, FolderOpen, GitBranch, GitCompareArrows, GitMerge, GitPullRequestArrow, Lock, LockOpen, Minus, MoreHorizontal, Plus, RefreshCw, SquareTerminal, Undo2, X,
} from 'lucide-vue-next'
import type { GitFile, VcsLock } from '~/types/ipc'
import type { MenuItem } from '~/types/ui'
import { useWorkspace } from '~/stores/workspace'
import { gitFileKey, useGit, type GitAction } from '~/stores/git'
import { useThreads } from '~/stores/threads'
import { useFiles } from '~/stores/files'
import { useLinks } from '~/stores/links'
import { call } from '~/composables/useBackend'
import { linkFromItem } from '~/utils/githubLinks'
import { useForge } from '~/stores/forge'
import { siteName } from '~/utils/forge'
import { formatLocale } from '~/i18n'
import { diffTabId, isDiffTab } from '~/utils/diffTabs'
import { isMod, modLabel } from '~/composables/useShortcuts'
import { shortAgo, useNow } from '~/utils/time'
import { lockHolder, lockSummary, resultLines, vcsTerms } from '~/utils/vcs'
import { isEnvPath } from '~/utils/envPath'
import { worktreeName } from '~/utils/worktrees'

/** How often the poll timer looks; each system says how often it is worth reading (`pollMs`). */
const TICK_MS = 4000
/** A remote project's every read is a few SSH connections: look less often. */
const REMOTE_POLL_MS = 15000

const { t } = useI18n()
const ws = useWorkspace()
const git = useGit()
const now = useNow()

/** The working copy in view: the active chat's worktree, or the project. */
const path = computed(() => useThreads().workdir ?? ws.activeProjectPath)
/** Set when that is a linked worktree (a chat's own, or a project opened from one): named in the header. */
const linkedWorktree = computed(() => (path.value && (path.value !== ws.activeProjectPath || repo.value?.status?.mainRoot) ? path.value : null))
const repo = computed(() => git.repo(path.value))
const status = computed(() => repo.value?.status ?? null)
const isRepo = computed(() => !!status.value?.isRepo)
/** Words and actions for git or Unity VCS. */
const terms = computed(() => vcsTerms(status.value?.vcs))
const isUnity = computed(() => status.value?.vcs === 'plastic')
const staged = computed(() => git.stagedFiles(path.value))
const changes = computed(() => git.changedFiles(path.value))
const conflicts = computed(() => changes.value.filter(f => f.conflicted).length)
const discardable = computed(() => changes.value.filter(f => !f.conflicted))
const newFiles = computed(() => discardable.value.filter(f => f.worktree === '?').length)
const clean = computed(() => isRepo.value && !staged.value.length && !changes.value.length)

const running = (action: GitAction) => git.isBusy(path.value, action)
/** Staging takes milliseconds; only the slow actions are worth greying controls out for. */
const waiting = computed(() => !!git.busy && !['stage', 'unstage', 'discard'].includes(git.busy))

const reason = (e: unknown) => (typeof e === 'string' ? e : e instanceof Error ? e.message : String(e)).trim()

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
  if (path.value) git.staleLocks(path.value)
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
  if (repo.value?.error && status.value) return noticeOf(true, `${t('git.panel.couldNotRefresh')}\n${repo.value.error}`, false)
  return null
})
/* Confirmations ("Committed a1b2c3d", "Pulled 3 commits into main.") clear themselves; failures stay until dismissed. */
let noticeTimer: ReturnType<typeof setTimeout> | undefined
watch(() => git.lastOutput, (out) => {
  clearTimeout(noticeTimer)
  if (out) noticeTimer = setTimeout(() => { if (git.lastOutput === out) git.lastOutput = null }, out.includes('\n') ? 8000 : 5000)
})

/* ---------- branch ---------- */

const branchLabel = computed(() => status.value?.branch ?? (status.value?.head ? t('git.panel.detached', { head: status.value.head }) : t('git.panel.noBranch')))
const branchItems = computed<MenuItem[]>(() => {
  const current = status.value?.branch ?? null
  const local = repo.value?.branches?.local ?? (current ? [current] : [])
  const items: MenuItem[] = local.map(name => ({
    label: name,
    icon: GitBranch,
    checked: name === current,
    onSelect: () => { if (name !== current && path.value) void git.checkout(path.value, name) },
  }))
  items.push({ label: t('git.newBranch'), icon: Plus, divider: items.length > 0, onSelect: startCreate })
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

/* ---------- worktree strip: a linked worktree against the project's main folder ---------- */

const threads = useThreads()
/** Shown for a linked git worktree only (Unity VCS has none). */
const showStrip = computed(() => !!linkedWorktree.value && isRepo.value && status.value?.vcs === 'git')
/** The main working tree's folder, in the form the backend takes (an `env://` path for a remote project). */
const mainFolder = computed(() => git.worktrees(path.value).find(w => w.isMain)?.path
  ?? (path.value !== ws.activeProjectPath ? ws.activeProjectPath : null))
const wtBranch = computed(() => status.value?.branch ?? null)
/** The branch checked out in the main folder: what this worktree merges into. */
const base = computed(() => repo.value?.vsMain?.base ?? git.worktrees(path.value).find(w => w.isMain)?.branch ?? null)
/** Commits here that the base lacks; null when it can't be read. */
const aheadOfBase = computed(() => repo.value?.vsMain?.ahead ?? null)
const vsTitle = computed(() => {
  if (aheadOfBase.value === null || !base.value) return null
  const names = { name: wtBranch.value ?? t('git.panel.thisWorktree'), base: base.value }
  return aheadOfBase.value === 0 ? t('git.panel.upToDateTitle', names) : t('git.panel.aheadOfTitle', names, aheadOfBase.value)
})

const mergeBlocked = computed(() => {
  if (!wtBranch.value) return t('git.panel.detachedMerge')
  if (!base.value || !mainFolder.value) return t('git.panel.mainNoBranch')
  if (wtBranch.value === base.value) return t('git.panel.onBase', { base: base.value })
  if (!clean.value) return t('git.panel.dirty')
  if (aheadOfBase.value === 0) return t('git.panel.nothingToMerge', { base: base.value })
  return null
})
const mergeTitle = computed(() => mergeBlocked.value ?? t('git.panel.mergeTitle', { branch: wtBranch.value, base: base.value }))
function mergeIntoBase() {
  if (mergeBlocked.value || !path.value || !mainFolder.value || !wtBranch.value) return
  void git.mergeWorktree(path.value, mainFolder.value, wtBranch.value)
}

/** GitHub's pull request or GitLab's merge request, by the remotes of the folder in view. */
const forge = useForge()
watch(path, p => forge.ensure(p), { immediate: true })
const forgeLink = computed(() => (path.value ? forge.links[path.value] ?? null : null))
const onGitlab = computed(() => forgeLink.value?.provider === 'gitlab')
const prLabel = computed(() => (onGitlab.value ? t('git.panel.mergeRequest') : t('git.panel.pullRequest')))
const prBlocked = computed(() => {
  if (!terms.value.remotes) return onGitlab.value ? t('git.panel.mrNeedRemote') : t('git.panel.prNeedRemote')
  if (!wtBranch.value) return t('git.panel.detachedPr')
  if (!base.value) return t('git.panel.mainNoBranch')
  if (wtBranch.value === base.value) return t('git.panel.onBase', { base: base.value })
  if (aheadOfBase.value === 0) return t('git.panel.noProposal', { base: base.value })
  return null
})
const prTitle = computed(() => prBlocked.value ?? t(onGitlab.value ? 'git.panel.mrTitle' : 'git.panel.prTitle', {
  branch: wtBranch.value, base: base.value, site: siteName(forgeLink.value?.provider, forgeLink.value?.host),
}))
/** Open the pull request (merge request) and link it to the chats that work in this worktree. */
async function openPullRequest() {
  const folder = path.value
  if (prBlocked.value || !folder || !base.value) return
  const item = await git.openPullRequest(folder, base.value)
  if (!item) return
  const users = threads.threads.filter(x => x.worktree === folder && !x.parentId)
  if (!users.length) return
  const links = useLinks()
  const link = linkFromItem(item, 'user')
  links.details[link.key] = { item, loading: false, quiet: false, error: null, fetchedAt: Date.now(), bodyAt: Date.now() }
  for (const x of users) threads.link(x.id, link)
  links.show(link.key)
}

const stripMenu = computed<MenuItem[]>(() => [
  { label: t('git.panel.revealInFiles'), icon: FolderOpen, onSelect: () => ws.openTool('files') },
  { label: t('git.panel.openTerminal'), icon: SquareTerminal, onSelect: () => { if (path.value) ws.newTerminal(path.value) } },
  { label: t('git.panel.removeWorktreeItem'), icon: FolderMinus, danger: true, divider: true, disabled: !!git.busy, onSelect: askRemove },
])

/* Remove: asks first, then once more when the worktree has uncommitted work (as the sidebar does). */
/** The worktree folder being asked about. */
const removing = ref<string | null>(null)
const removeBusy = ref(false)
const removeError = ref('')
/** The worktree has changes git would throw away: the next press removes it anyway. */
const removeForce = ref(false)
/** The chats that work in the folder; they go back to the project folder. */
const removeUsers = computed(() => threads.threads.filter(x => x.worktree === removing.value && !x.parentId))
watch(path, () => { if (!removeBusy.value) removing.value = null })
function askRemove() {
  removing.value = linkedWorktree.value
  removeError.value = ''
  removeForce.value = false
}
async function removeWorktree() {
  const folder = removing.value
  if (!folder || removeBusy.value) return
  removeBusy.value = true
  removeError.value = ''
  try {
    const user = removeUsers.value[0]
    if (user) {
      await threads.removeWorktree(user.id, removeForce.value)
    } else {
      const main = mainFolder.value
      if (!main) throw new Error(t('git.panel.noMainFolder'))
      const force = removeForce.value
      await useFiles().aroundChange([folder], () => call('git_worktree_remove', { path: main, worktree: folder, force }))
      delete git.repos[folder]
      await git.loadWorktrees(main)
    }
    removing.value = null
  } catch (err) {
    const why = reason(err).replace(/\.$/, '')
    removeError.value = `${why}.`
    // Uncommitted work: offer the destructive version, as a second, explicit step.
    if (/uncommitted|untracked|modified|changes/i.test(why)) removeForce.value = true
  } finally {
    removeBusy.value = false
  }
}

/* ---------- sync ---------- */

const upstream = computed(() => status.value?.upstream ?? null)
const ahead = computed(() => status.value?.ahead ?? 0)
const behind = computed(() => status.value?.behind ?? 0)
const pullTitle = computed(() => (behind.value ? t('git.panel.pullN', { upstream: upstream.value }, behind.value) : t('git.panel.pull', { upstream: upstream.value })))
/** Unity VCS: bring the workspace to the newest changeset on its branch. */
const updateTitle = computed(() => (behind.value
  ? t('git.panel.updateN', { branch: status.value?.branch ?? t('git.panel.theBranch') }, behind.value)
  : t('git.panel.update')))
/** Unity VCS: the repository the workspace is bound to, without the server part. */
const repository = computed(() => status.value?.repository ?? null)
const repositoryName = computed(() => repository.value?.split('@')[0] ?? null)
const pushTitle = computed(() => (ahead.value ? t('git.panel.pushN', { upstream: upstream.value }, ahead.value) : t('git.panel.pushNothing', { upstream: upstream.value })))
const canPublish = computed(() => !!status.value?.branch && !!status.value?.head)
const publishTitle = computed(() => {
  if (!status.value?.branch) return t('git.panel.publishNoBranch')
  if (!status.value.head) return t('git.panel.publishNoCommit')
  return t('git.panel.publishTitle', { branch: status.value.branch })
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
/** Unity VCS: files the next checkin takes that someone else has locked. It will likely be refused; warn, don't block. */
const lockedOut = computed(() => (terms.value.locks
  ? (staged.value.length ? staged.value : changes.value).map(f => lockOf(f.path)).filter((l): l is VcsLock => !!l && !l.mine)
  : []))
const commitHint = computed<{ text: string; warn: boolean; lock?: boolean; title?: string }>(() => {
  if (conflicts.value) return { text: t('git.panel.resolveConflicts', conflicts.value), warn: true }
  const out = lockedOut.value
  if (out.length) {
    const first = out[0]!
    const name = first.path.slice(first.path.lastIndexOf('/') + 1)
    return {
      text: out.length === 1 ? t('git.panel.lockedBy', { name, who: lockHolder(first) }) : t('git.panel.lockedByOthers', out.length),
      warn: false,
      lock: true,
      title: `${out.map(l => `${l.path}: ${lockSummary(l)}`).join('\n')}\n${t('git.panel.refused')}`,
    }
  }
  if (staged.value.length) return { text: t('git.panel.stagedFiles', staged.value.length), warn: false }
  if (changes.value.length) return { text: terms.value.amend ? t('git.panel.stagesAll', changes.value.length) : t('git.panel.checksInAll', changes.value.length), warn: false }
  return { text: isUnity.value ? t('git.panel.nothingToCheckIn') : t('git.panel.nothingToCommit'), warn: false }
})
const commitTitle = computed(() => {
  if (isUnity.value) return commitsAll.value ? t('git.panel.stageAndCheckIn') : t('git.panel.checkInStaged')
  return commitsAll.value ? t('git.panel.stageAndCommit') : t('git.panel.commitStaged')
})
const showCommit = computed(() => isRepo.value && (!clean.value || !!message.value))

function commit() {
  if (canCommit.value && path.value) animated(git.commit(path.value))
}
function onMessageKey(e: KeyboardEvent) {
  if (e.key === 'Enter' && isMod(e)) {
    e.preventDefault()
    commit()
  }
}
/** Unity VCS: the Shelves section, whose form the commit menu opens with the comment typed so far. */
const shelvesView = ref<{ start: (comment?: string) => void } | null>(null)
const shelveMenu = computed<MenuItem[]>(() => [{
  label: t('git.shelves.shelveItem'),
  icon: Archive,
  hint: t('git.panel.shelveHint'),
  disabled: !!git.busy || (!staged.value.length && !changes.value.length),
  onSelect: () => shelvesView.value?.start(message.value),
}])
const commitMenu = computed<MenuItem[]>(() => [{
  label: t('git.panel.amend'),
  hint: message.value.trim() ? t('git.panel.amendReplace') : t('git.panel.amendKeep'),
  disabled: !status.value?.head || !!git.busy || conflicts.value > 0,
  onSelect: () => { if (path.value) animated(git.commit(path.value, { amend: true })) },
}])

/* ---------- files ---------- */

const open = reactive({ staged: true, changes: true, locks: true })

/**
 * File rows animate (fade out, the rest sliding up) only while an action started here is running and
 * its refresh lands: polling, focus refreshes and switching chats change the lists without motion.
 */
const acting = ref(new Set<Promise<unknown>>())
const listMotion = computed(() => (acting.value.size ? 'gp-row' : 'gp-still'))
function animated(work: Promise<unknown>) {
  acting.value.add(work)
  void work.finally(async () => {
    await nextTick() // the refreshed lists are on screen, their transitions under way
    acting.value.delete(work)
  })
}
/* Another chat's folder: its lists replace these without motion. */
watch(path, () => acting.value.clear(), { flush: 'sync' })

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
  if (path.value) animated(git.stage(path.value, [file.path]))
}
function unstage(file: GitFile) {
  if (path.value) animated(git.unstage(path.value, [file.path]))
}
function stageAll() {
  if (!path.value) return
  // Staging a conflicted file marks it resolved, so "all" leaves those for a deliberate click.
  if (conflicts.value) {
    if (discardable.value.length) animated(git.stage(path.value, discardable.value.map(f => f.path)))
  } else {
    animated(git.stage(path.value))
  }
}
function unstageAll() {
  if (path.value) animated(git.unstage(path.value))
}
function discard(file: GitFile) {
  confirming.value = null
  if (path.value) animated(git.discard(path.value, [file.path]))
}
function discardAll() {
  confirming.value = null
  if (path.value) animated(git.discard(path.value))
}

/* ---------- locks (Unity VCS) ---------- */

/** The repository's locks: other people's first (they are what stops you), then yours. */
const locks = computed(() => (terms.value.locks
  ? [...git.locks(path.value)].sort((a, b) => Number(a.mine) - Number(b.mine) || a.path.localeCompare(b.path))
  : []))
const othersLocks = computed(() => locks.value.filter(l => !l.mine).length)
function lockOf(file: string): VcsLock | null {
  return terms.value.locks ? git.lockOf(path.value, file) : null
}
const fileName = (p: string) => p.slice(p.lastIndexOf('/') + 1)
const fileDir = (p: string) => (p.lastIndexOf('/') > 0 ? p.slice(0, p.lastIndexOf('/')) : '')
function lockFile(file: string) {
  if (path.value) void git.lock(path.value, [file])
}
function unlockFile(file: string) {
  if (path.value) void git.unlock(path.value, [file])
}

/** A file row's context menu: open, stage, and (Unity VCS) lock or release it. */
function fileMenu(file: GitFile, isStaged: boolean): MenuItem[] | null {
  if (!terms.value.locks) return null
  const code = isStaged ? file.index : file.worktree
  const lock = lockOf(file.path)
  const items: MenuItem[] = [
    { label: t('git.panel.openDiff'), onSelect: () => toggle(file, isStaged) },
    isStaged
      ? { label: t('git.unstage'), icon: Minus, disabled: waiting.value, onSelect: () => unstage(file) }
      : { label: t('git.stage'), icon: Plus, disabled: waiting.value, onSelect: () => stage(file) },
  ]
  if (lock?.mine) {
    items.push({ label: t('git.panel.releaseLock'), icon: LockOpen, hint: t('git.panel.releaseLockHint'), divider: true, disabled: !!git.busy, onSelect: () => unlockFile(file.path) })
  } else if (lock) {
    items.push({ label: t('git.panel.lock'), icon: Lock, hint: t('git.panel.heldBy', { owner: lock.owner }), divider: true, disabled: true })
  } else {
    const cannot = code === '?' || code === 'A' ? t('git.panel.lockNew')
      : code === 'D' ? t('git.panel.lockDeleted')
        : null
    items.push({
      label: t('git.panel.lock'),
      icon: Lock,
      hint: cannot ?? t('git.panel.lockHint'),
      divider: true,
      disabled: !!cannot || !!git.busy,
      onSelect: () => lockFile(file.path),
    })
  }
  return items
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
  <section class="gp" :aria-label="t('git.changes')">
    <header class="gp__head">
      <h2 class="gp__title">
        {{ t('git.changes') }}<span v-if="linkedWorktree" class="gp__wt" :title="t('git.panel.worktreePath', { path: linkedWorktree })"><FolderGit2 aria-hidden="true" /><span class="gp__wt-name">{{ worktreeName(linkedWorktree) }}</span></span>
      </h2>
      <div class="gp__tools">
        <template v-if="isRepo && !terms.remotes">
          <button type="button" class="gp__sync" :aria-label="updateTitle" :title="updateTitle" :disabled="waiting" @click="path && git.pull(path)">
            <span v-if="running('pull')" class="gp__spin" aria-hidden="true" />
            <ArrowDown v-else />
            <span v-if="behind" class="gp__sync-n tabular">{{ behind }}</span>
          </button>
        </template>
        <template v-else-if="isRepo">
          <UiIconButton :label="t('git.panel.fetch')" :disabled="waiting" @click="path && git.fetch(path)">
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
        <UiIconButton :label="t('common.actions.refresh')" :class="{ 'is-spun': spun }" @click="manualRefresh"><RefreshCw /></UiIconButton>
      </div>
    </header>

    <div v-if="showStrip" class="gp__wtstrip" role="group" :aria-label="t('git.panel.worktree', { name: worktreeName(linkedWorktree!) })">
      <!-- The branch is in the row below; this line only says how it stands against the base. -->
      <p v-if="vsTitle" class="gp__wtline tabular" :title="vsTitle">
        <GitCompareArrows aria-hidden="true" />
        <i18n-t :keypath="aheadOfBase ? 'git.panel.aheadOf' : 'git.panel.upToDate'" :plural="aheadOfBase ?? 0" scope="global">
          <template #base><code class="gp__wtbase">{{ base }}</code></template>
        </i18n-t>
      </p>
      <div class="gp__wtbtns">
        <UiButton
          size="sm"
          :variant="showCommit ? 'secondary' : 'primary'"
          class="gp__wtmerge"
          :loading="running('merge')"
          :disabled="waiting || !!mergeBlocked"
          :title="mergeTitle"
          @click="mergeIntoBase"
        >
          <GitMerge v-if="!running('merge')" /><i18n-t keypath="git.panel.mergeInto" tag="span" class="gp__wtmerge-label" scope="global"><template #base><span class="gp__wtmerge-base">{{ base ?? t('git.panel.base') }}</span></template></i18n-t>
        </UiButton>
        <UiButton
          size="sm"
          class="gp__wtpr"
          :loading="running('pr')"
          :disabled="waiting || !!prBlocked"
          :title="prTitle"
          :aria-label="prLabel"
          @click="openPullRequest"
        >
          <GitPullRequestArrow v-if="!running('pr')" /><span class="gp__wtpr-label">{{ prLabel }}</span>
        </UiButton>
        <span class="gp__wtgap" />
        <UiMenu :items="stripMenu" placement="bottom-end" :width="220" :label="t('git.panel.moreWorktree')">
          <template #default="{ toggle: toggleMenu, open: menuOpen }">
            <UiIconButton size="sm" :label="t('git.panel.moreWorktree')" :active="menuOpen" @click="toggleMenu"><MoreHorizontal /></UiIconButton>
          </template>
        </UiMenu>
      </div>
    </div>

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
              :title="menuOpen ? undefined : t('git.panel.branch', { name: branchLabel })"
              @click="toggle"
            >
              <span v-if="running('checkout')" class="gp__spin" aria-hidden="true" />
              <GitBranch v-else aria-hidden="true" />
              <span class="gp__branch-name">{{ branchLabel }}</span>
              <ChevronDown class="gp__chev" aria-hidden="true" />
            </button>
          </template>
        </GitBranchPopup>
        <span v-if="upstream" class="gp__upstream" :title="t('git.panel.tracks', { name: upstream })">{{ upstream }}</span>
        <span v-else-if="repository" class="gp__upstream" :title="t('git.panel.repository', { name: repository })">{{ repositoryName }}</span>
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
          <CloudUpload />{{ t('git.panel.publish') }}
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
      <UiIconButton v-if="notice.dismiss" size="sm" :label="t('git.panel.dismiss')" @click="git.dismiss()"><X /></UiIconButton>
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
        <span class="gp__commit-hint" :class="{ 'is-warn': commitHint.warn, 'is-lock': commitHint.lock }" :title="commitHint.title">
          <Lock v-if="commitHint.lock" class="gp__hint-icon" aria-hidden="true" />{{ commitHint.text }}
        </span>
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
          <UiMenu v-if="terms.amend || terms.shelves" :items="terms.amend ? commitMenu : shelveMenu" placement="bottom-end" :width="264" :label="t('git.panel.moreCommit')">
            <template #default="{ toggle, open: menuOpen }">
              <UiIconButton size="sm" :label="t('git.panel.moreCommit')" :active="menuOpen" class="gp__commit-more" @click="toggle"><ChevronDown /></UiIconButton>
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
              <span>{{ t('git.panel.staged') }}</span>
              <span class="gp__count tabular">{{ staged.length }}</span>
            </button>
            <div class="gp__sec-actions">
              <UiIconButton size="sm" :label="t('git.panel.unstageAll')" :disabled="waiting" @click="unstageAll"><Minus /></UiIconButton>
            </div>
          </div>
          <TransitionGroup v-show="open.staged" tag="ul" :name="listMotion" class="gp__list gp__files" role="list">
            <GitFileRow
              v-for="f in staged"
              :key="f.path"
              :file="f"
              staged
              :expanded="git.isExpanded(path!, gitFileKey(f.path, true))"
              :diff="repo?.diffs[gitFileKey(f.path, true)] ?? null"
              :confirming="false"
              :disabled="waiting"
              :lock="lockOf(f.path)"
              :menu="fileMenu(f, true)"
              @toggle="toggle(f, true)"
              @unstage="unstage(f)"
            />
          </TransitionGroup>
        </section>

        <section v-if="changes.length" class="gp__sec">
          <div class="gp__sec-head">
            <button type="button" class="gp__sec-toggle" :aria-expanded="open.changes" @click="open.changes = !open.changes">
              <ChevronRight class="gp__caret" :class="{ 'is-open': open.changes }" aria-hidden="true" />
              <span>{{ t('git.changes') }}</span>
              <span class="gp__count tabular">{{ changes.length }}</span>
            </button>
            <div class="gp__sec-actions">
              <UiIconButton
                v-if="discardable.length"
                size="sm"
                :label="t('git.panel.discardAllItem')"
                :active="confirming === 'all'"
                :disabled="waiting"
                @click="confirming = confirming === 'all' ? null : 'all'"
              >
                <Undo2 />
              </UiIconButton>
              <UiIconButton size="sm" :label="t('git.panel.stageAll')" :disabled="waiting || (conflicts > 0 && !discardable.length)" @click="stageAll"><Plus /></UiIconButton>
            </div>
          </div>

          <div v-if="confirming === 'all'" class="gp__ask" role="alertdialog" :aria-label="t('git.panel.discardAllTitle')" @keydown.esc.stop.prevent="confirming = null">
            <p>
              {{ t('git.panel.discardAsk', discardable.length) }}
              <template v-if="newFiles">{{ t('git.panel.newFilesDeleted', newFiles) }}</template>
              {{ t('git.panel.cantUndo') }}
            </p>
            <div class="gp__ask-btns">
              <UiButton size="sm" variant="ghost" @click="confirming = null">{{ t('git.panel.keep') }}</UiButton>
              <UiButton size="sm" variant="danger" :disabled="!!git.busy" @click="discardAll">{{ t('git.panel.discardAll') }}</UiButton>
            </div>
          </div>

          <TransitionGroup v-show="open.changes" tag="ul" :name="listMotion" class="gp__list gp__files" role="list">
            <GitFileRow
              v-for="f in changes"
              :key="f.path"
              :file="f"
              :staged="false"
              :expanded="git.isExpanded(path!, gitFileKey(f.path, false))"
              :diff="repo?.diffs[gitFileKey(f.path, false)] ?? null"
              :confirming="confirming === gitFileKey(f.path, false)"
              :disabled="waiting"
              :lock="lockOf(f.path)"
              :menu="fileMenu(f, false)"
              @toggle="toggle(f, false)"
              @stage="stage(f)"
              @ask="confirming = gitFileKey(f.path, false)"
              @cancel="confirming === gitFileKey(f.path, false) && (confirming = null)"
              @discard="discard(f)"
            />
          </TransitionGroup>
        </section>

        <p v-if="clean" class="gp__quiet">{{ t('git.panel.noChanges') }}</p>

        <section v-if="locks.length" class="gp__sec">
          <div class="gp__sec-head">
            <button
              type="button"
              class="gp__sec-toggle"
              :aria-expanded="open.locks"
              :title="t('git.panel.locksTitle', { repo: repositoryName ?? t('git.panel.theRepository'), mine: locks.length - othersLocks }, othersLocks)"
              @click="open.locks = !open.locks"
            >
              <ChevronRight class="gp__caret" :class="{ 'is-open': open.locks }" aria-hidden="true" />
              <span>{{ t('git.panel.locks') }}</span>
              <span class="gp__count tabular">{{ locks.length }}</span>
            </button>
          </div>
          <ul v-show="open.locks" class="gp__list" role="list">
            <li
              v-for="l in locks"
              :key="l.path"
              class="gp__lock"
              :class="{ 'is-mine': l.mine }"
              :title="`${l.path}\n${lockSummary(l)}${l.time ? ` · ${new Date(l.time).toLocaleString(formatLocale())}` : ''}`"
            >
              <Lock class="gp__lock-icon" aria-hidden="true" />
              <span class="gp__lock-name">{{ fileName(l.path) }}</span>
              <span v-if="fileDir(l.path)" class="gp__lock-dir"><bdi>{{ fileDir(l.path) }}</bdi></span>
              <span class="gp__lock-who">{{ lockHolder(l) }}<template v-if="l.status === 'retained'"> · {{ t('git.panel.kept') }}</template></span>
              <span class="sr-only">{{ lockSummary(l) }}</span>
              <UiIconButton
                v-if="l.mine"
                size="sm"
                class="gp__lock-release"
                :label="t('git.panel.releaseLockOn', { name: fileName(l.path) })"
                :disabled="!!git.busy"
                @click="unlockFile(l.path)"
              >
                <LockOpen />
              </UiIconButton>
            </li>
          </ul>
        </section>
        <GitShelves v-if="terms.shelves && path" ref="shelvesView" :path="path" />

        <section class="gp__sec gp__sec--history">
          <div class="gp__sec-head">
            <button type="button" class="gp__sec-toggle" :aria-expanded="repo?.historyOpen ?? false" @click="path && git.toggleHistory(path)">
              <ChevronRight class="gp__caret" :class="{ 'is-open': repo?.historyOpen }" aria-hidden="true" />
              <span>{{ t('git.panel.history') }}</span>
            </button>
          </div>
          <template v-if="repo?.historyOpen">
            <ul v-if="repo.log.length" class="gp__log" role="list">
              <li
                v-for="(c, i) in repo.log"
                :key="c.hash"
                class="gp__commit-item"
                :title="`${c.subject}\n${c.author} · ${new Date(c.time).toLocaleString(formatLocale())}${i < ahead ? `\n${t('git.panel.notPushed')}` : ''}`"
              >
                <span class="gp__subject">{{ c.subject || t('git.noMessage') }}</span>
                <ArrowUp v-if="i < ahead" class="gp__unpushed" :aria-label="t('git.panel.notPushed')" />
                <code class="gp__hash">{{ c.shortHash }}</code>
                <span class="gp__when tabular">{{ shortAgo(c.time, now) }}</span>
              </li>
            </ul>
            <p v-else class="gp__quiet">{{ repo.logHead === undefined ? t('git.panel.readingHistory') : isUnity ? t('git.panel.noChangesets') : t('git.noCommits') }}</p>
          </template>
        </section>
      </template>

      <div v-else-if="status" class="gp__empty">
        <i18n-t keypath="git.panel.notRepo" tag="p" scope="global"><template #name><strong>{{ ws.activeProject?.name ?? t('git.panel.thisFolder') }}</strong></template></i18n-t>
        <UiButton size="sm" :loading="running('init')" @click="path && git.init(path)">{{ t('git.panel.init') }}</UiButton>
      </div>

      <div v-else-if="repo?.error" class="gp__empty">
        <p>{{ t('git.panel.couldNotRead') }}</p>
        <pre class="gp__error selectable">{{ repo.error }}</pre>
        <UiButton size="sm" @click="manualRefresh">{{ t('common.actions.retry') }}</UiButton>
      </div>

      <p v-else-if="path" class="gp__quiet">{{ t('git.panel.readingRepo') }}</p>
    </div>

    <UiDialog :open="!!removing" :title="t('git.panel.removeTitle')" :width="440" :dismissible="!removeBusy" @close="removing = null">
      <template v-if="removing">
        <p class="gp__dlg">
          <i18n-t keypath="git.panel.removeAsk" scope="global"><template #folder><code class="gp__code selectable">{{ removing }}</code></template></i18n-t>
          {{ ' ' }}
          <i18n-t v-if="wtBranch" keypath="git.panel.branchStays" scope="global"><template #branch><code class="gp__code">{{ wtBranch }}</code></template></i18n-t>
          <template v-else>{{ t('git.panel.branchStaysUnnamed') }}</template>
          <template v-if="removeUsers.length">{{ ' ' }}{{ t('git.panel.chatsMove', removeUsers.length) }}</template>
        </p>
        <p v-if="removeError" class="gp__dlg gp__dlg--error selectable" role="alert">
          {{ removeError }}<template v-if="removeForce">{{ ' ' }}{{ t('git.panel.removeLoses') }}</template>
        </p>
      </template>
      <template #footer>
        <UiButton variant="ghost" data-autofocus :disabled="removeBusy" @click="removing = null">{{ t('common.actions.cancel') }}</UiButton>
        <UiButton variant="danger" :loading="removeBusy" @click="removeWorktree">{{ removeForce ? t('git.panel.removeAnyway') : t('git.panel.removeTitle') }}</UiButton>
      </template>
    </UiDialog>
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
  border-bottom: 1px solid var(--line);
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
.gp__title { display: flex; align-items: center; gap: var(--space-2); }
.gp__wt {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
  font-family: var(--font-mono);
  font-size: var(--text-2xs);
  font-weight: 400;
  color: var(--fg-subtle);
}
.gp__wt svg { width: 12px; height: 12px; flex: none; stroke-width: 1.85; color: var(--accent-ink); }
.gp__wt-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
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

/* ---------- worktree strip ---------- */
.gp__wtstrip {
  flex: none;
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 6px;
  margin: 0 var(--space-2) var(--space-2) var(--space-3);
  container-type: inline-size;
  padding: 6px var(--space-2) var(--space-2);
  border: 1px solid var(--line-soft);
  border-radius: var(--radius-md);
  background: var(--bg-panel);
}
.gp__wtline {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  margin: 0;
  font-size: var(--text-xs);
  color: var(--fg-subtle);
  white-space: nowrap;
}
.gp__wtline > svg { width: 13px; height: 13px; flex: none; stroke-width: 1.75; color: var(--fg-subtle); }
.gp__wtbase { min-width: 0; overflow: hidden; text-overflow: ellipsis; font-family: var(--font-mono); font-size: var(--text-xs); color: var(--fg-muted); }
.gp__wtbtns { display: flex; align-items: center; gap: var(--space-1); min-width: 0; }
.gp__wtbtns :deep(svg) { flex: none; }
/* At narrow widths the base name truncates; the buttons keep their row. */
.gp__wtmerge { flex: 0 1 auto; min-width: 0; }
.gp__wtmerge-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gp__wtmerge-base { font-family: var(--font-mono); font-size: var(--text-xs); }
.gp__wtpr { flex: none; }
.gp__wtgap { flex: 1 1 0; min-width: 0; }
/* A narrow tool window: Pull request gives up its words first, then Merge's base name truncates. */
@container (max-width: 270px) {
  .gp__wtpr-label { display: none; }
}

.gp__dlg { margin: 0; font-size: var(--text-sm); line-height: var(--leading-normal); color: var(--fg-muted); }
.gp__dlg + .gp__dlg { margin-top: var(--space-3); }
.gp__dlg--error { color: var(--ripe-error-fg); }
.gp__code { font-family: var(--font-mono); font-size: var(--text-xs); color: var(--fg); word-break: break-all; }

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
/* Someone else's lock: a word with them, not an error. */
.gp__commit-hint.is-lock { color: var(--ripe-waiting-fg); }
.gp__hint-icon { width: 12px; height: 12px; margin-right: 4px; vertical-align: -1.5px; stroke-width: 1.85; }
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
/* Staged, unstaged, discarded or committed from here: the row folds away in place while its new row
   unfolds in the other list, so the lists trade the height and nothing below jumps. */
.gp__files { display: block; }
.gp__files > .gf + .gf { margin-top: 1px; }
.gp-row-enter-active, .gp-row-leave-active {
  overflow: hidden;
  transition: height var(--dur-med) var(--ease-out), margin-top var(--dur-med) var(--ease-out), opacity var(--dur-med) var(--ease-out);
}
.gp-row-leave-active { pointer-events: none; }
.gp__files > .gp-row-enter-from, .gp__files > .gp-row-leave-to { height: 0; margin-top: 0; opacity: 0; }
.gp-row-enter-to, .gp-row-leave-from { height: var(--gf-row-h); }
.gp-row-move { transition: transform var(--dur-med) var(--ease-out); }

/* ---------- locks ---------- */
.gp__lock {
  position: relative;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  height: 28px;
  padding: 0 3px 0 var(--space-1);
  border-radius: var(--radius-sm);
  font-size: var(--text-sm);
  transition: background var(--dur-fast) var(--ease-out);
}
.gp__lock:hover, .gp__lock:has(:focus-visible) { background: var(--bg-hover); }
.gp__lock-icon { width: 13px; height: 13px; flex: none; margin: 0 1.5px; stroke-width: 1.85; color: var(--ripe-waiting-fg); }
.gp__lock.is-mine .gp__lock-icon { color: var(--accent-ink); }
.gp__lock-name { flex: 0 1 auto; min-width: 0; color: var(--fg-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.gp__lock-dir {
  flex: 1 1 0;
  min-width: 0;
  direction: rtl;
  text-align: left;
  font-family: var(--font-mono);
  font-size: var(--text-2xs);
  color: var(--fg-faint);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.gp__lock-who {
  flex: none;
  max-width: 40%;
  margin-left: auto;
  padding-right: 3px;
  font-size: var(--text-2xs);
  color: var(--fg-subtle);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
/* Your own lock: the release button takes the holder's place on hover or focus, so every row keeps one right edge. */
.gp__lock-release { position: absolute; right: 3px; top: 3px; opacity: 0; transition: opacity var(--dur-fast) var(--ease-out); }
.gp__lock:hover .gp__lock-release, .gp__lock:has(:focus-visible) .gp__lock-release { opacity: 1; }
.gp__lock.is-mine:hover .gp__lock-who, .gp__lock.is-mine:has(:focus-visible) .gp__lock-who { visibility: hidden; }

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
