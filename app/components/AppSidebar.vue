<script setup lang="ts">
import PluginStatusItems from '~/plugin-host/ui/PluginStatusItems.vue'
import { pluginMenuItems } from '~/plugin-host/menus'
import { Archive, ArchiveRestore, ArrowDown, ArrowUp, ChevronDown, ChevronRight, CircleCheck, CircleDot, FolderGit2, FolderMinus, MessageSquarePlus, MoreHorizontal, PanelLeftClose, Plus, X, Pencil, Trash2, Columns2, AppWindow } from 'lucide-vue-next'
import { useWorkspace } from '~/stores/workspace'
import { useThreads } from '~/stores/threads'
import { AGENTS, displayStatus, hasUnreadResult, waitingFor, type Thread } from '~/types/chat'
import { isBusy } from '~/stores/threads'
import { shortAgo, useNow } from '~/utils/time'
import { stateOf } from '~/utils/linkState'
import type { MenuItem } from '~/types/ui'
import { holdOverlay } from '~/composables/useOverlay'
import { worktreeName } from '~/utils/worktrees'
import { vcsTerms } from '~/utils/vcs'
import { useWorktrees } from '~/composables/useWorktrees'
import { useGit } from '~/stores/git'
import { useWindows } from '~/stores/windows'
import { cancelSidebarChat, sidebarChatAt, sidebarChatDrop } from '~/composables/useTabDrag'

const ws = useWorkspace()
const threads = useThreads()
const win = useWindows()
const now = useNow()

const width = computed(() => ws.sidebarWidth)

/**
 * The sidebar lists the chats of the project chosen in the titlebar, grouped by
 * status: what is in play on top (always shown), then Settled and Archived at the bottom,
 * which fold away.
 */
type SectionId = 'active' | 'settled' | 'archived'
const SECTIONS_KEY = 'mango.sidebar.closed.v1'
const closed = ref(new Set<SectionId>(['archived']))
try {
  const saved = JSON.parse(localStorage.getItem(SECTIONS_KEY) || 'null')
  if (Array.isArray(saved)) closed.value = new Set(saved.filter((x: string) => x === 'settled' || x === 'archived'))
} catch { /* default: Archived folded, Settled open */ }
function toggleSection(id: SectionId) {
  if (id === 'active') return
  const next = new Set(closed.value)
  next.has(id) ? next.delete(id) : next.add(id)
  closed.value = next
  try { localStorage.setItem(SECTIONS_KEY, JSON.stringify([...next])) } catch { /* not remembered */ }
}

const sections = computed(() => {
  const path = ws.activeProjectPath
  const live = path ? threads.forProject(path) : []
  const all = [
    { id: 'active' as const, title: 'Working', foldable: false, threads: live.filter(t => t.status !== 'done') },
    { id: 'settled' as const, title: 'Settled', foldable: true, threads: live.filter(t => t.status === 'done') },
    { id: 'archived' as const, title: 'Archived', foldable: true, threads: path ? threads.archivedFor(path) : [] },
  ]
  // The top section is always there (it holds the "start a chat" row); the others only when they have something.
  return all.filter(sec => sec.id === 'active' || sec.threads.length).map(sec => ({
    ...sec,
    open: !sec.foldable || !closed.value.has(sec.id),
    /** Results nobody has looked at yet, so a folded section still says so. */
    unseen: sec.threads.filter(hasUnreadResult).length,
  }))
})

const visibleIds = computed(() => new Set(threads.panes.map(p => p.threadId)))

function newChat(path?: string) {
  const target = path ?? ws.activeProjectPath
  if (!target) return
  ws.setActiveProject(target)
  threads.create(target)
}

/* ---------- the "+" split button: a plain chat, or the menu of where else a new chat can start ---------- */
const wts = useWorktrees()
/** A chat in its own git worktree, or its own Unity VCS workspace: for projects under version control. */
const canWorktree = wts.supported
const newChatItems = computed<MenuItem[]>(() => {
  const path = ws.activeProjectPath
  if (!path) return []
  const items: MenuItem[] = [{ label: 'New chat', icon: Plus, kbd: ws.keyLabel('new-chat'), onSelect: () => newChat() }]
  if (!canWorktree.value) return items
  items.push({ label: `New chat in a ${wts.term.value}`, icon: FolderGit2, kbd: ws.keyLabel('new-chat-worktree'), onSelect: () => threads.createAwaitingWorktree(path) })
  wts.linked.value.forEach((w, i) => items.push({
    label: worktreeName(w.path),
    hint: wts.hint(w),
    icon: FolderGit2,
    disabled: w.prunable,
    group: i === 0 ? 'Continue in' : undefined,
    divider: i === 0,
    // A new chat there, even when chats already work in it (going to those is the sidebar's job).
    onSelect: () => void threads.createInWorktree(path, { existing: w.path }).catch(() => {}),
  }))
  return items
})
function toggleNewChatMenu(toggle: () => void, open: boolean) {
  // The list of worktrees may be stale (made or removed outside Mango): read it again as the menu opens.
  if (!open && canWorktree.value && ws.activeProjectPath) void useGit().loadWorktrees(ws.activeProjectPath)
  toggle()
}

function open(t: Thread) {
  if (justDragged) return // the click that ends a drag is not a click
  if (t.projectPath !== ws.activeProjectPath) ws.setActiveProject(t.projectPath)
  threads.show(t.id)
}

/* ---------- reorder by dragging ----------
 * Pointer events rather than HTML5 drag and drop: the desktop webview takes
 * over native drag and drop (for dropped files), which breaks it on Windows.
 * Past the sidebar the drag becomes a tab drag (useTabDrag): onto the tab strip, a pane, or out of
 * the window into a window of its own.
 */
const drag = reactive({ id: null as string | null, overId: null as string | null, where: 'before' as 'before' | 'after' })
let dragStart: { id: string; group: string; x: number; y: number; el: HTMLElement; pointerId: number } | null = null
let justDragged = false
const rail = ref<HTMLElement | null>(null)

function onRowPointerDown(t: Thread, e: PointerEvent) {
  if (e.button !== 0 || t.archived || renaming.value === t.id) return
  if ((e.target as HTMLElement).closest('.sb__actions, input')) return
  const group = (e.currentTarget as HTMLElement).dataset.group ?? ''
  dragStart = { id: t.id, group, x: e.clientX, y: e.clientY, el: e.currentTarget as HTMLElement, pointerId: e.pointerId }
  window.addEventListener('pointermove', onDragMove)
  window.addEventListener('pointerup', onDragEnd)
  window.addEventListener('pointercancel', onDragEnd)
  window.addEventListener('keydown', onDragKey, true)
}

/** Escape drops nothing: the row stays where it was. */
function onDragKey(e: KeyboardEvent) {
  if (e.key !== 'Escape' || !drag.id) return
  e.preventDefault()
  e.stopPropagation()
  onDragEnd()
}

function onDragMove(e: PointerEvent) {
  if (!dragStart) return
  if (!drag.id) {
    // A few pixels of slack, so an ordinary click never starts a drag.
    if (Math.hypot(e.clientX - dragStart.x, e.clientY - dragStart.y) < 6) return
    drag.id = dragStart.id
    document.body.classList.add('is-reordering')
    // Moves (and the release) outside the window keep coming here.
    try { dragStart.el.setPointerCapture(dragStart.pointerId) } catch { /* the row is gone */ }
  }
  const box = rail.value?.getBoundingClientRect()
  const away = !box || e.clientX < box.left || e.clientX >= box.right || e.clientY < box.top || e.clientY >= box.bottom
  sidebarChatAt(e, drag.id, away)
  if (away) { drag.overId = null; return }
  // Which row of the same section is the pointer over, and on which half?
  const rows = [...document.querySelectorAll<HTMLElement>(`.sb__thread[data-group="${CSS.escape(dragStart.group)}"]`)]
  let over: HTMLElement | null = null
  for (const row of rows) {
    const r = row.getBoundingClientRect()
    if (e.clientY >= r.top && e.clientY < r.bottom) { over = row; break }
  }
  if (!over && rows.length) {
    // Above the first or below the last: snap to that end.
    const first = rows[0]!
    const last = rows[rows.length - 1]!
    over = e.clientY < first.getBoundingClientRect().top ? first : e.clientY >= last.getBoundingClientRect().bottom ? last : null
  }
  if (!over) { drag.overId = null; return }
  const r = over.getBoundingClientRect()
  drag.overId = over.dataset.threadId ?? null
  drag.where = e.clientY < r.top + r.height / 2 ? 'before' : 'after'
  if (drag.overId === drag.id) drag.overId = null
}

function onDragEnd(e?: PointerEvent) {
  window.removeEventListener('pointermove', onDragMove)
  window.removeEventListener('pointerup', onDragEnd)
  window.removeEventListener('pointercancel', onDragEnd)
  window.removeEventListener('keydown', onDragKey, true)
  if (dragStart?.el.hasPointerCapture(dragStart.pointerId)) dragStart.el.releasePointerCapture(dragStart.pointerId)
  if (drag.id) {
    // Let go past the sidebar: the tab drag places it. Escape or a cancelled pointer drops nothing.
    if (e?.type === 'pointerup') {
      if (!sidebarChatDrop(e) && drag.overId) threads.reorder(drag.id, drag.overId, drag.where)
    } else {
      cancelSidebarChat()
    }
    justDragged = true
    setTimeout(() => (justDragged = false), 0)
  }
  drag.id = null
  drag.overId = null
  dragStart = null
  document.body.classList.remove('is-reordering')
}
onBeforeUnmount(() => onDragEnd())

/** Status first when it says something; otherwise who the chat is with. */
/**
 * The pull request (or, without one, the issue) a chat is linked to, for the mark on its row:
 * the newest one, plus how many others there are.
 */
function linkMark(t: Thread) {
  const links = t.links
  if (!links?.length) return null
  const main = [...links].reverse().find(l => l.kind === 'pr') ?? links[links.length - 1]!
  const state = stateOf(main.kind, main.state)
  const others = links.length - 1
  const what = `${main.kind === 'pr' ? 'Pull request' : 'Issue'} #${main.number}${main.state ? `, ${state.word.toLowerCase()}` : ''}`
  return {
    number: main.number,
    icon: state.icon,
    tone: state.tone,
    others,
    label: `${what}${main.title ? `: ${main.title}` : ''}${others ? ` (and ${others} more)` : ''}`,
  }
}

const linkMarks = computed(() => new Map(threads.threads.filter(t => t.links?.length).map(t => [t.id, linkMark(t)!])))

function subtitle(t: Thread) {
  const agent = t.simulated ? `${AGENTS[t.agent].name} · simulated` : AGENTS[t.agent].name
  const live = threads.live[t.id]
  const background = live?.tasks.filter(x => x.status === 'running').length ?? 0
  const tasks = `${background} background task${background === 1 ? '' : 's'}`
  switch (displayStatus(t)) {
    case 'waiting': return `Needs your ${waitingFor(t)}`
    case 'working':
      if (t.status === 'running' && background) return live?.idle ? `Waiting on ${tasks}` : `Working… · ${background} in background`
      return t.status === 'queued' ? 'Starting…' : t.status === 'running' ? 'Working…' : `Working · ${agent}`
    case 'error': return 'Failed'
    case 'done': return `Settled · ${agent}`
    case 'archived': return `Archived · ${agent}`
    default: return agent
  }
}

/* ---------- sub-agent chats, folded under the chat that started them ---------- */
function descendants(id: string): Thread[] {
  const out: Thread[] = []
  for (const c of threads.childrenOf(id)) out.push(c, ...descendants(c.id))
  return out
}
/** The user's own choice per chat; otherwise open while a sub-agent works or one of them is on screen. */
const subsChoice = reactive(new Map<string, boolean>())
function subsOpen(t: Thread) {
  const chosen = subsChoice.get(t.id)
  if (chosen !== undefined) return chosen
  return descendants(t.id).some(c => c.status === 'running' || c.status === 'queued' || visibleIds.value.has(c.id))
}
function subsLabel(t: Thread) {
  const all = descendants(t.id)
  const working = all.filter(c => c.status === 'running' || c.status === 'queued').length
  return { count: `${all.length} sub-agent${all.length === 1 ? '' : 's'}`, working }
}

/* inline rename */
const renaming = ref<string | null>(null)
const renameText = ref('')
async function startRename(t: Thread) {
  renaming.value = t.id
  renameText.value = t.title
  await nextTick()
  document.querySelector<HTMLInputElement>('.sb__rename')?.select()
}
function commitRename() {
  if (renaming.value) threads.rename(renaming.value, renameText.value)
  renaming.value = null
}

/** Each row's menu, so a right-click can open the same one the three dots open. */
const menus = ref<Record<string, { showAt: (x: number, y: number) => void } | null>>({})
function openContextMenu(t: Thread, e: MouseEvent) {
  if (renaming.value === t.id) return
  menus.value[t.id]?.showAt(e.clientX, e.clientY)
}

function threadMenu(t: Thread): MenuItem[] {
  const shown = displayStatus(t)
  const busy = isBusy(t)
  const order = threads.forProject(t.projectPath).map(x => x.id)
  return [
    { label: 'Rename', icon: Pencil, onSelect: () => startRename(t) },
    { label: 'Open to the side', icon: Columns2, onSelect: () => threads.split(t.id) },
    { ...win.moveChatAction(t.id), icon: AppWindow, divider: false },
    ...(t.archived ? [] : [
      { label: 'Move up', icon: ArrowUp, kbd: 'Alt+↑', divider: true, disabled: order.indexOf(t.id) <= 0, onSelect: () => threads.move(t.id, -1) },
      { label: 'Move down', icon: ArrowDown, kbd: 'Alt+↓', disabled: order.indexOf(t.id) === order.length - 1, onSelect: () => threads.move(t.id, 1) },
    ]),
    // Status. Settled is only set with the row's mark.
    { label: 'Working', icon: CircleDot, divider: true, checked: shown === 'working' || shown === 'waiting', disabled: busy, onSelect: () => threads.setStatus(t.id, 'working') },
    { label: 'Archived', icon: Archive, checked: shown === 'archived', disabled: busy, onSelect: () => { if (!t.archived) ws.confirmThen('archive', { title: 'Archive chat?', body: `“${t.title}” moves to Archived. You can bring it back any time.`, label: 'Archive' }, () => threads.archive(t.id)) } },
    ...(t.worktree ? [{ label: `Remove ${termOf(t)}…`, icon: FolderMinus, divider: true, disabled: busy, onSelect: () => askRemoveWorktree(t) }] : []),
    { label: 'Delete chat', icon: Trash2, danger: true, divider: !t.worktree, onSelect: () => ws.confirmThen('delete', { title: 'Delete chat?', body: `“${t.title}” and its messages are deleted for good.`, label: 'Delete chat', danger: true }, () => threads.remove(t.id)) },
    ...pluginMenuItems('thread', { threadId: t.id }),
  ]
}

/* ---------- remove a chat's worktree: asks first, then once more when it has uncommitted work ---------- */

/** "worktree", or "workspace" for a Unity VCS chat. */
const termOf = (t: Thread) => vcsTerms(ws.openProjects.find(p => p.path === t.projectPath)?.vcs).worktree
/** Unity VCS branches are long paths; the chip shows their last part (`/main/task/fix` → `fix`). */
const chipBranch = (b: string) => (b.startsWith('/') ? b.slice(b.lastIndexOf('/') + 1) : b)

const removing = ref<Thread | null>(null)
const removeBusy = ref(false)
const removeError = ref('')
/** The worktree has changes git would throw away: the next press removes it anyway. */
const removeForce = ref(false)
const removeOthers = computed(() => {
  const r = removing.value
  return r ? threads.threads.filter(x => x.worktree === r.worktree && x.id !== r.id && !x.parentId).length : 0
})

const removeTerm = computed(() => (removing.value ? termOf(removing.value) : 'worktree'))
/** "commit", or "changeset" for Unity VCS. */
const removeUnit = computed(() => vcsTerms(ws.openProjects.find(p => p.path === removing.value?.projectPath)?.vcs).unit)

function askRemoveWorktree(t: Thread) {
  removing.value = t
  removeError.value = ''
  removeForce.value = false
}
async function removeWorktree() {
  const t = removing.value
  if (!t || removeBusy.value) return
  removeBusy.value = true
  removeError.value = ''
  try {
    await threads.removeWorktree(t.id, removeForce.value)
    removing.value = null
  } catch (err) {
    const why = (typeof err === 'string' ? err : err instanceof Error ? err.message : String(err)).trim().replace(/\.$/, '')
    removeError.value = `${why}.`
    // Uncommitted work: offer the destructive version, as a second, explicit step.
    if (/uncommitted|untracked|modified|changes/i.test(why)) removeForce.value = true
  } finally {
    removeBusy.value = false
  }
}

/* resize */
let dragging = false
/* A browser's page would swallow the pointer once it crosses it: the browsers hide during the drag. */
let release = () => {}
function startResize(e: PointerEvent) {
  dragging = true
  release = holdOverlay()
  ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
}
function onResize(e: PointerEvent) {
  if (dragging) ws.setSidebarWidth(e.clientX)
}
function endResize() {
  if (!dragging) return
  dragging = false
  release()
  ws.persist()
}
</script>

<template>
  <aside ref="rail" class="sb" :style="{ width: `${width}px`, '--rail-w': `${width}px` }" aria-label="Threads">
    <div class="sb__top">
      <button type="button" class="sb__new" @click="newChat()">
        <MessageSquarePlus />
        <span>New chat</span>
        <kbd v-for="k in ws.keyParts('new-chat')" :key="k">{{ k }}</kbd>
      </button>
      <UiIconButton class="sb__hide" label="Hide sidebar" :shortcut="ws.keyLabel('sidebar')" @click="ws.toggleSidebar()"><PanelLeftClose /></UiIconButton>
    </div>

    <nav class="sb__scroll">
      <section v-for="sec in sections" :key="sec.id" class="sb__group" :class="`sb__group--${sec.id}`">
        <div class="sb__group-head">
          <component
            :is="sec.foldable ? 'button' : 'div'"
            :type="sec.foldable ? 'button' : undefined"
            class="sb__group-toggle"
            :class="{ 'is-static': !sec.foldable }"
            :aria-expanded="sec.foldable ? sec.open : undefined"
            @click="toggleSection(sec.id)"
          >
            <ChevronRight v-if="sec.foldable" class="sb__caret" :class="{ 'is-open': sec.open }" />
            <span class="sb__group-name">{{ sec.title }}</span>
            <span v-if="sec.threads.length" class="sb__count tabular">{{ sec.threads.length }}</span>
            <span v-if="!sec.open && sec.unseen" class="sb__unseen" :title="`${sec.unseen} new result${sec.unseen === 1 ? '' : 's'}`" />
          </component>
          <div v-if="sec.id === 'active'" class="sb__group-actions">
            <UiMenu :items="newChatItems" placement="bottom-end" :width="280" label="New chat">
              <template #default="{ open: menuOpen, toggle }">
                <div class="sb__split" :class="{ 'is-open': menuOpen }">
                  <button type="button" class="sb__split-main" :aria-label="ws.withKey('New chat', 'new-chat')" :title="ws.withKey('New chat', 'new-chat')" @click="newChat()"><Plus /></button>
                  <button
                    type="button"
                    class="sb__split-more"
                    aria-label="More ways to start a chat"
                    aria-haspopup="menu"
                    :aria-expanded="menuOpen"
                    :title="menuOpen ? undefined : 'More ways to start a chat'"
                    @click="toggleNewChatMenu(toggle, menuOpen)"
                  >
                    <ChevronDown />
                  </button>
                </div>
              </template>
            </UiMenu>
          </div>
        </div>

        <!-- Keyed by project, so switching projects swaps the list outright instead of animating every row;
             the move transition is off while a row is being dragged, then the rows ease into place on drop. -->
        <TransitionGroup
          v-show="sec.open"
          :key="ws.activeProjectPath ?? ''"
          tag="ul"
          :name="drag.id ? 'sb-still' : 'sb-row'"
          class="sb__list"
          role="list"
        >
          <li v-for="t in sec.threads" :key="t.id">
            <div
              class="sb__thread"
              :class="{
                'is-archived': t.archived,
                'is-current': t.id === threads.activePane.threadId,
                'is-visible': visibleIds.has(t.id),
                'is-unseen': !t.seen,
                'is-dragging': drag.id === t.id,
                'is-drop-before': drag.overId === t.id && drag.where === 'before',
                'is-drop-after': drag.overId === t.id && drag.where === 'after',
              }"
              role="button"
              tabindex="0"
              :data-thread-id="t.id"
              :data-group="sec.id"
              @pointerdown="onRowPointerDown(t, $event)"
              @keydown.alt.up.prevent="threads.move(t.id, -1)"
              @keydown.alt.down.prevent="threads.move(t.id, 1)"
              @click="open(t)"
              @keydown.enter.prevent="open(t)"
              @dblclick="startRename(t)"
              @contextmenu.prevent="openContextMenu(t, $event)"
            >
              <UiRipenessDot :status="t.archived ? 'archived' : t.status" :unseen="hasUnreadResult(t) || (!t.archived && !t.seen && t.status === 'waiting')" />
              <div class="sb__thread-text">
                <input
                  v-if="renaming === t.id"
                  v-model="renameText"
                  class="sb__rename"
                  aria-label="Chat title"
                  @click.stop
                  @keydown.enter.prevent="commitRename"
                  @keydown.esc.prevent="renaming = null"
                  @blur="commitRename"
                >
                <span v-else class="sb__titleline">
                  <component
                    :is="linkMarks.get(t.id)!.icon"
                    v-if="linkMarks.has(t.id)"
                    class="sb__link-icon"
                    :class="`is-${linkMarks.get(t.id)!.tone}`"
                    aria-hidden="true"
                  />
                  <span class="sb__title">{{ t.title }}</span>
                </span>
                <span class="sb__subline">
                  <span class="sb__sub" :class="`sb__sub--${displayStatus(t)}`">{{ subtitle(t) }}</span>
                  <span v-if="t.worktree" class="sb__wt" :title="`Works in its own ${termOf(t)}: ${t.worktree}${t.branch ? `\nBranch: ${t.branch}` : ''}`">
                    <FolderGit2 aria-hidden="true" /><span class="sb__wt-name">{{ t.branch ? chipBranch(t.branch) : worktreeName(t.worktree) }}</span>
                    <span class="sr-only">, in {{ termOf(t) }} {{ worktreeName(t.worktree) }}</span>
                  </span>
                  <span v-else-if="t.awaitingWorktree" class="sb__wt" :title="`Gets its own ${termOf(t)} and branch when you send the first message`">
                    <FolderGit2 aria-hidden="true" /><span class="sr-only">, {{ termOf(t) }} made on the first message</span>
                  </span>
                  <span v-for="m in linkMarks.has(t.id) ? [linkMarks.get(t.id)!] : []" :key="m.number" class="sb__link tabular" :class="`is-${m.tone}`" :title="m.label">
                    #{{ m.number }}<span v-if="m.others" class="sb__link-more">+{{ m.others }}</span>
                    <span class="sr-only">, {{ m.label }}</span>
                  </span>
                </span>
              </div>
              <span class="sb__time tabular">{{ shortAgo(t.updatedAt, now) }}</span>
              <div class="sb__actions" @click.stop @dblclick.stop>
                <UiIconButton
                  v-if="t.archived"
                  size="sm"
                  label="Unarchive"
                  @click.stop="threads.unarchive(t.id)"
                >
                  <ArchiveRestore />
                </UiIconButton>
                <UiIconButton
                  v-else
                  size="sm"
                  :label="isBusy(t) ? 'Still working' : t.status === 'done' ? 'Mark as working' : 'Mark as settled'"
                  :active="t.status === 'done'"
                  :disabled="isBusy(t)"
                  @click.stop="threads.setStatus(t.id, t.status === 'done' ? 'working' : 'done')"
                >
                  <CircleCheck />
                </UiIconButton>
                <UiMenu :ref="(el: any) => { menus[t.id] = el }" :items="threadMenu(t)" placement="bottom-end" :width="220" label="Chat actions">
                  <template #default="{ toggle }">
                    <UiIconButton size="sm" label="Chat actions" @click.stop="toggle"><MoreHorizontal /></UiIconButton>
                  </template>
                </UiMenu>
              </div>
            </div>
            <template v-if="threads.childrenOf(t.id).length">
              <button type="button" class="sb__subs" :aria-expanded="subsOpen(t)" @click="subsChoice.set(t.id, !subsOpen(t))">
                <ChevronRight class="sb__caret" :class="{ 'is-open': subsOpen(t) }" aria-hidden="true" />
                <span>{{ subsLabel(t).count }}</span>
                <span v-if="subsLabel(t).working" class="sb__subs-live">· {{ subsLabel(t).working }} working</span>
              </button>
              <AppSidebarSubagents v-if="subsOpen(t)" :parent-id="t.id" />
            </template>
          </li>
          <li v-if="sec.id === 'active' && !sec.threads.length" key="sb-empty">
            <button type="button" class="sb__empty" @click="newChat()">
              <Plus /> {{ threads.forProject(ws.activeProjectPath ?? '').length || threads.archivedFor(ws.activeProjectPath ?? '').length ? 'Start a new chat' : 'Start the first chat' }}
            </button>
          </li>
        </TransitionGroup>
      </section>
    </nav>

    <PluginStatusItems location="sidebar" />
    <AppSidebarFoot />

    <UiDialog :open="!!removing" :title="`Remove ${removeTerm}`" :width="440" :dismissible="!removeBusy" @close="removing = null">
      <template v-if="removing">
        <p class="sb__logout">
          Remove the {{ removeTerm }} folder <code class="sb__code selectable">{{ removing.worktree }}</code>?
          The branch{{ removing.branch ? ' ' : '' }}<code v-if="removing.branch" class="sb__code">{{ removing.branch }}</code> and its {{ removeUnit }}s stay.
          {{ removeOthers ? `This chat and ${removeOthers} other${removeOthers === 1 ? '' : 's'} that worked there` : 'The chat' }}
          will work in the project folder from then on.
        </p>
        <p v-if="removeError" class="sb__logout sb__logout--error selectable" role="alert">
          {{ removeError }}<template v-if="removeForce"> Removing it anyway throws those changes away.</template>
        </p>
      </template>
      <template #footer>
        <UiButton variant="ghost" data-autofocus :disabled="removeBusy" @click="removing = null">Cancel</UiButton>
        <UiButton variant="danger" :loading="removeBusy" @click="removeWorktree">{{ removeForce ? 'Remove anyway' : `Remove ${removeTerm}` }}</UiButton>
      </template>
    </UiDialog>


    <div
      class="sb__resize"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      @pointerdown="startResize"
      @pointermove="onResize"
      @pointerup="endResize"
      @pointercancel="endResize"
      @dblclick="ws.setSidebarWidth(264); ws.persist()"
    />
  </aside>
</template>

<style scoped>
.sb {
  position: relative;
  flex: none;
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: var(--bg-app);
}
.sb__top { display: flex; align-items: center; gap: var(--space-1); padding: var(--space-2) var(--space-2) var(--space-2) var(--space-3); }
.sb__hide { width: 32px; height: 32px; }
.sb__new {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex: 1;
  min-width: 0;
  height: 32px;
  padding: 0 6px 0 10px;
  border-radius: var(--radius-sm);
  font-size: var(--text-sm);
  font-weight: 560;
  color: var(--fg);
  background: var(--bg-panel);
  border: 1px solid var(--line-soft);
  transition: background var(--dur-fast) var(--ease-out), border-color var(--dur-fast) var(--ease-out);
}
.sb__new:hover { background: var(--bg-raised); border-color: var(--line); }
.sb__new svg { width: 15px; height: 15px; color: var(--accent-ink); stroke-width: 1.85; }
.sb__new span { flex: 1; text-align: left; }
.sb__new kbd + kbd { margin-left: -4px; }

.sb__scroll { flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; padding: var(--space-1) var(--space-2) var(--space-3) var(--space-3); }
.sb__group { flex: none; }
.sb__group + .sb__group { margin-top: var(--space-3); }
/* The open chats take the free space, so Settled and Archived sit at the bottom of the list. */
.sb__group--active { flex-grow: 1; }
.sb__group-head { display: flex; align-items: center; height: 28px; border-radius: var(--radius-sm); }
.sb__group-toggle {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 4px;
  height: 100%;
  padding: 0 4px;
  font-size: var(--text-xs);
  font-weight: 600;
  color: var(--fg-subtle);
  border-radius: var(--radius-sm);
}
.sb__group-toggle.is-static { cursor: default; padding-left: 8px; }
.sb__group-toggle.is-static:hover { color: var(--fg-subtle); }
.sb__unseen { width: 6px; height: 6px; margin-left: 4px; border-radius: 50%; background: var(--ripe-done); flex: none; }
.sb__group-toggle:hover { color: var(--fg); }
.sb__caret { width: 13px; height: 13px; flex: none; transition: transform var(--dur-fast) var(--ease-out); }
.sb__caret.is-open { transform: rotate(90deg); }
.sb__group-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sb__count { font-weight: 500; color: var(--fg-faint); margin-left: 2px; }
.sb__group-actions { display: flex; opacity: 0; transition: opacity var(--dur-fast) var(--ease-out); }
.sb__group-head:hover .sb__group-actions, .sb__group-head:focus-within .sb__group-actions { opacity: 1; }
/* An open menu keeps its trigger on screen after the pointer leaves the header. */
.sb__group-actions:has(.is-open) { opacity: 1; }
/* New chat with a caret beside it: one small icon button's footprint, split in two. Hovering either
   half washes the whole control and brightens the half under the pointer; pressing it deepens that half. */
.sb__split {
  display: inline-flex;
  align-items: stretch;
  height: 22px;
  border-radius: var(--radius-xs);
  color: var(--fg-subtle);
  transition: background var(--dur-fast) var(--ease-out);
}
.sb__split:hover, .sb__split.is-open { background: var(--bg-hover); }
.sb__split-main, .sb__split-more {
  display: inline-grid;
  place-items: center;
  color: inherit;
  transition: background var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out);
}
.sb__split-main { width: 22px; border-radius: var(--radius-xs) 0 0 var(--radius-xs); }
.sb__split-more { width: 14px; border-radius: 0 var(--radius-xs) var(--radius-xs) 0; }
.sb__split-main svg { width: 14px; height: 14px; stroke-width: 1.75; }
.sb__split-more svg { width: 11px; height: 11px; stroke-width: 2; }
.sb__split-main:hover, .sb__split-more:hover, .sb__split.is-open .sb__split-more { color: var(--fg); }
.sb__split-main:active, .sb__split-more:active, .sb__split.is-open .sb__split-more { background: var(--bg-active); }
/* The seam between the halves shows only while the control is lit. */
.sb__split-more { border-left: 1px solid transparent; }
.sb__split:hover .sb__split-more, .sb__split.is-open .sb__split-more { border-left-color: var(--line-soft); }

/* Block flow, not grid: a leaving row is taken out of flow (absolute) and must stay where it was. */
.sb__list { position: relative; list-style: none; margin: 2px 0 0; padding: 0; }
.sb__list > li + li { margin-top: 1px; }
/* Chats arriving, leaving (archived, deleted, settled) and the rest closing up behind them. */
.sb-row-move { transition: transform var(--dur-med) var(--ease-out); }
.sb-row-enter-active { transition: opacity var(--dur-med) var(--ease-out), transform var(--dur-med) var(--ease-out); }
.sb-row-leave-active { position: absolute; left: 0; right: 0; pointer-events: none; transition: opacity var(--dur-fast) var(--ease-out); }
.sb-row-enter-from { opacity: 0; transform: translateY(-4px); }
.sb-row-leave-to { opacity: 0; }
.sb__thread {
  position: relative;
  display: grid;
  grid-template-columns: 14px 1fr auto;
  justify-items: start;
  align-items: center;
  column-gap: var(--space-2);
  min-height: 44px;
  padding: 6px 6px 6px 8px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: background var(--dur-fast) var(--ease-out);
}
.sb__thread:hover { background: var(--bg-hover); }
/* Reordering: the row being moved fades, an accent line shows where it will land. */
.sb__thread.is-dragging { opacity: 0.45; }
.sb__thread.is-drop-before::before, .sb__thread.is-drop-after::after {
  content: '';
  position: absolute;
  left: 4px;
  right: 4px;
  height: 2px;
  border-radius: 2px;
  background: var(--accent);
  pointer-events: none;
}
.sb__thread.is-drop-before::before { top: -1.5px; }
.sb__thread.is-drop-after::after { bottom: -1.5px; }
.sb__thread.is-visible { background: var(--bg-hover); }
.sb__thread.is-current { background: var(--bg-active); }
.sb__thread .ripe { align-self: start; margin-top: 3px; justify-self: center; }
.sb__thread-text { min-width: 0; width: 100%; display: grid; gap: 1px; }
.sb__title {
  font-size: var(--text-sm);
  color: var(--fg-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  line-height: 1.35;
}
.sb__thread.is-current .sb__title, .sb__thread.is-unseen .sb__title { color: var(--fg); }
.sb__thread.is-unseen .sb__title { font-weight: 560; word-spacing: 0.05em; }
.sb__subline { display: flex; align-items: center; gap: var(--space-2); min-width: 0; width: 100%; }
.sb__subline .sb__sub { flex: 0 1 auto; min-width: 0; }
/* The pull request the chat is linked to: its state as the icon's colour, the number in quiet ink. */
.sb__link {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 3px;
  margin-left: auto;
  font-size: var(--text-2xs);
  line-height: 1.35;
  color: var(--fg-subtle);
}
/* A linked chat leads its title with the pull request's icon, in its state's mark grade. */
.sb__titleline { display: flex; align-items: center; gap: 5px; min-width: 0; width: 100%; }
.sb__titleline .sb__title { min-width: 0; }
.sb__link-icon { flex: none; width: 13px; height: 13px; stroke-width: 1.9; color: var(--fg-faint); }
.sb__link-icon.is-running { color: var(--ripe-running); }
.sb__link-icon.is-queued { color: var(--ripe-queued); }
.sb__link-icon.is-done { color: var(--ripe-done); }
.sb__link-icon.is-error { color: var(--ripe-error); }
.sb__link-more { margin-left: 2px; color: var(--fg-faint); }
/* A chat with its own worktree: its branch at the right of the status line, cut short before the status is. */
.sb__wt {
  flex: 0 1 auto;
  min-width: 0;
  max-width: 55%;
  display: inline-flex;
  align-items: center;
  gap: 3px;
  margin-left: auto;
  font-family: var(--font-mono);
  font-size: var(--text-2xs);
  line-height: 1.35;
  color: var(--fg-subtle);
}
.sb__wt svg { flex: none; width: 11px; height: 11px; stroke-width: 1.9; }
.sb__wt-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sb__wt + .sb__link { margin-left: 0; }
.sb__thread.is-current .sb__wt { color: var(--fg-muted); }
.sb__thread.is-current .sb__link { color: var(--fg-muted); }
.sb__sub { font-size: var(--text-xs); color: var(--fg-faint); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; line-height: 1.35; }
.sb__sub--waiting { color: var(--ripe-waiting-fg); }
.sb__sub--working { color: var(--fg-subtle); }
.sb__sub--error { color: var(--ripe-error-fg); }
.sb__thread.is-visible .sb__sub:not([class*='--waiting']):not([class*='--error']),
.sb__thread.is-visible .sb__time { color: var(--fg-subtle); }
.sb__time { align-self: start; margin-top: 2px; font-size: var(--text-2xs); color: var(--fg-faint); }
.sb__actions {
  position: absolute;
  right: 4px;
  top: 50%;
  transform: translateY(-50%);
  display: flex;
  align-items: center;
  gap: 1px;
  padding: 1px;
  border-radius: var(--radius-sm);
  background: var(--bg-raised);
  box-shadow: 0 0 0 1px var(--line-soft);
  opacity: 0;
}
.sb__thread:hover .sb__actions, .sb__actions:focus-within, .sb__actions:has(.menu.is-open) { opacity: 1; }
.sb__thread:hover .sb__time { visibility: hidden; }
.sb__actions :deep(.icon-btn.is-active) { background: none; color: var(--ripe-done-fg); }
.sb__actions :deep(.icon-btn.is-active:hover) { background: var(--bg-hover); }

.sb__thread.is-archived .sb__title { color: var(--fg-subtle); }

/* The fold line over a chat's sub-agents, lined up with the chat's title. */
.sb__subs {
  display: flex;
  align-items: center;
  gap: 4px;
  width: 100%;
  height: 24px;
  padding: 0 8px 0 26px;
  border-radius: var(--radius-sm);
  font-size: var(--text-xs);
  color: var(--fg-faint);
  text-align: left;
}
.sb__subs:hover { color: var(--fg-muted); background: var(--bg-hover); }
.sb__subs:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: -2px; }
.sb__subs .sb__caret { width: 12px; height: 12px; }
.sb__subs-live { color: var(--ripe-running-fg); }
.sb__rename {
  width: 100%;
  height: 20px;
  padding: 0 4px;
  margin-left: -4px;
  font-size: var(--text-sm);
  background: var(--bg-inset);
  border: 1px solid var(--accent-line);
  border-radius: var(--radius-xs);
}

.sb__empty {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  height: 30px;
  padding: 0 8px;
  font-size: var(--text-xs);
  color: var(--fg-faint);
  border-radius: var(--radius-sm);
}
.sb__empty:hover { color: var(--fg-muted); background: var(--bg-hover); }
.sb__empty svg { width: 13px; height: 13px; }

.sb__logout { margin: 0; font-size: var(--text-sm); color: var(--fg-muted); text-wrap: pretty; }
.sb__logout--error { margin-top: var(--space-2); color: var(--ripe-error-fg); }
.sb__code { font-family: var(--font-mono); font-size: var(--text-xs); color: var(--fg); word-break: break-all; }

.sb__resize {
  position: absolute;
  top: 0;
  right: -3px;
  bottom: 0;
  width: 6px;
  cursor: col-resize;
  z-index: 5;
}
.sb__resize::after {
  content: '';
  position: absolute;
  inset: 0 2px;
  background: transparent;
  transition: background var(--dur-fast) var(--ease-out);
}
.sb__resize:hover::after, .sb__resize:active::after { background: var(--accent-line); }
</style>
