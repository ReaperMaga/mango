<script setup lang="ts">
import PluginStatusItems from '~/plugin-host/ui/PluginStatusItems.vue'
import { ChevronDown, ChevronRight, FolderGit2, MessageSquarePlus, PanelLeftClose, Plus } from 'lucide-vue-next'
import { useWorkspace } from '~/stores/workspace'
import { useThreads } from '~/stores/threads'
import { hasUnreadResult, type Thread } from '~/types/chat'
import { useNow } from '~/utils/time'
import type { MenuItem } from '~/types/ui'
import { holdOverlay } from '~/composables/useOverlay'
import { worktreeName } from '~/utils/worktrees'
import { vcsTerms } from '~/utils/vcs'
import { useWorktrees } from '~/composables/useWorktrees'
import { useGit } from '~/stores/git'
import { cancelSidebarChat, sidebarChatAt, sidebarChatDrop } from '~/composables/useTabDrag'

const { t } = useI18n()
const ws = useWorkspace()
const threads = useThreads()
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
    { id: 'active' as const, title: t('shell.status.working'), foldable: false, threads: live.filter(t => t.status !== 'done') },
    { id: 'settled' as const, title: t('shell.status.done'), foldable: true, threads: live.filter(t => t.status === 'done') },
    { id: 'archived' as const, title: t('shell.status.archived'), foldable: true, threads: path ? threads.archivedFor(path) : [] },
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
  const items: MenuItem[] = [{ label: t('shell.chat.new'), icon: Plus, kbd: ws.keyLabel('new-chat'), onSelect: () => newChat() }]
  if (!canWorktree.value) return items
  items.push({ label: t('shell.chat.newInTerm', { term: wts.term.value }), icon: FolderGit2, kbd: ws.keyLabel('new-chat-worktree'), onSelect: () => threads.createAwaitingWorktree(path) })
  wts.linked.value.forEach((w, i) => items.push({
    label: worktreeName(w.path),
    hint: wts.hint(w),
    icon: FolderGit2,
    disabled: w.prunable,
    group: i === 0 ? t('shell.sidebar.continueIn') : undefined,
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

/** A press on a row (not while it is being renamed: the row does not report those) may start a drag. */
function onRowPointerDown(t: Thread, e: PointerEvent, el: HTMLElement) {
  if (e.button !== 0 || t.archived) return
  if ((e.target as HTMLElement).closest('.sb__actions, input')) return
  const group = el.dataset.group ?? ''
  dragStart = { id: t.id, group, x: e.clientX, y: e.clientY, el, pointerId: e.pointerId }
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

/** Chats with sub-agent chats or forks under them, found in one pass rather than once per row. */
const hasChildren = computed(() => {
  const out = new Set<string>()
  for (const c of threads.threads) {
    if (c.parentId) out.add(c.parentId)
    if (c.forkOf) out.add(c.forkOf)
  }
  return out
})

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
function subsLabel(chat: Thread) {
  const all = descendants(chat.id)
  const working = all.filter(c => c.status === 'running' || c.status === 'queued').length
  const forks = all.filter(c => c.forkOf).length
  const agents = all.length - forks
  const count = [
    forks ? t('shell.sidebar.forks', forks) : '',
    agents ? t('shell.sidebar.subAgents', agents) : '',
  ].filter(Boolean).join(' · ')
  return { count, working }
}

/* ---------- remove a chat's worktree: asks first, then once more when it has uncommitted work ---------- */

/** "worktree", or "workspace" for a Unity VCS chat. */
const termOf = (t: Thread) => vcsTerms(ws.openProjects.find(p => p.path === t.projectPath)?.vcs).worktree

const removing = ref<Thread | null>(null)
const removeBusy = ref(false)
const removeError = ref('')
/** The worktree has changes git would throw away: the next press removes it anyway. */
const removeForce = ref(false)
const removeOthers = computed(() => {
  const r = removing.value
  return r ? threads.threads.filter(x => x.worktree === r.worktree && x.id !== r.id && !x.parentId).length : 0
})

const removeTerm = computed(() => (removing.value ? termOf(removing.value) : vcsTerms('git').worktree))
/** "commits", or "changesets" for Unity VCS. */
const removeUnits = computed(() => vcsTerms(ws.openProjects.find(p => p.path === removing.value?.projectPath)?.vcs).units)

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
  <aside ref="rail" class="sb" :style="{ width: `${width}px`, '--rail-w': `${width}px` }" :aria-label="t('shell.sidebar.label')">
    <div class="sb__top">
      <button type="button" class="sb__new" @click="newChat()">
        <MessageSquarePlus />
        <span>{{ t('shell.chat.new') }}</span>
        <kbd v-for="k in ws.keyParts('new-chat')" :key="k">{{ k }}</kbd>
      </button>
      <UiIconButton class="sb__hide" :label="t('shell.sidebar.hide')" :shortcut="ws.keyLabel('sidebar')" @click="ws.toggleSidebar()"><PanelLeftClose /></UiIconButton>
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
            <span v-if="!sec.open && sec.unseen" class="sb__unseen" :title="t('shell.sidebar.newResults', sec.unseen)" />
          </component>
          <div v-if="sec.id === 'active'" class="sb__group-actions">
            <UiMenu :items="newChatItems" placement="bottom-end" :width="280" :label="t('shell.chat.new')">
              <template #default="{ open: menuOpen, toggle }">
                <div class="sb__split" :class="{ 'is-open': menuOpen }">
                  <button type="button" class="sb__split-main" :aria-label="ws.withKey(t('shell.chat.new'), 'new-chat')" :title="ws.withKey(t('shell.chat.new'), 'new-chat')" @click="newChat()"><Plus /></button>
                  <button
                    type="button"
                    class="sb__split-more"
                    :aria-label="t('shell.sidebar.moreWays')"
                    aria-haspopup="menu"
                    :aria-expanded="menuOpen"
                    :title="menuOpen ? undefined : t('shell.sidebar.moreWays')"
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
          <li v-for="chat in sec.threads" :key="chat.id">
            <AppSidebarThread
              :chat="chat"
              :group="sec.id"
              :current="chat.id === threads.activePane.threadId"
              :visible="visibleIds.has(chat.id)"
              :dragging="drag.id === chat.id"
              :drop="drag.overId === chat.id ? drag.where : null"
              :now="now"
              @press="(e, el) => onRowPointerDown(chat, e, el)"
              @open="open(chat)"
              @remove-worktree="askRemoveWorktree(chat)"
            />
            <template v-if="hasChildren.has(chat.id)">
              <button type="button" class="sb__subs" :aria-expanded="subsOpen(chat)" @click="subsChoice.set(chat.id, !subsOpen(chat))">
                <ChevronRight class="sb__caret" :class="{ 'is-open': subsOpen(chat) }" aria-hidden="true" />
                <span>{{ subsLabel(chat).count }}</span>
                <span v-if="subsLabel(chat).working" class="sb__subs-live">{{ t('shell.sidebar.subsWorking', { n: subsLabel(chat).working }) }}</span>
              </button>
              <AppSidebarSubagents v-if="subsOpen(chat)" :parent-id="chat.id" />
            </template>
          </li>
          <li v-if="sec.id === 'active' && !sec.threads.length" key="sb-empty">
            <button type="button" class="sb__empty" @click="newChat()">
              <Plus /> {{ threads.forProject(ws.activeProjectPath ?? '').length || threads.archivedFor(ws.activeProjectPath ?? '').length ? t('shell.sidebar.startNew') : t('shell.sidebar.startFirst') }}
            </button>
          </li>
        </TransitionGroup>
      </section>
    </nav>

    <PluginStatusItems location="sidebar" />
    <AppSidebarFoot />

    <UiDialog :open="!!removing" :title="t('shell.remove.title', { term: removeTerm })" :width="440" :dismissible="!removeBusy" @close="removing = null">
      <template v-if="removing">
        <p class="sb__logout">
          <i18n-t keypath="shell.remove.folder" scope="global">
            <template #term>{{ removeTerm }}</template>
            <template #path><code class="sb__code selectable">{{ removing.worktree }}</code></template>
          </i18n-t>
          {{ ' ' }}
          <i18n-t v-if="removing.branch" keypath="shell.remove.keepsBranch" scope="global">
            <template #branch><code class="sb__code">{{ removing.branch }}</code></template>
            <template #units>{{ removeUnits }}</template>
          </i18n-t>
          <template v-else>{{ t('shell.remove.keeps', { units: removeUnits }) }}</template>
          {{ removeOthers ? t('shell.remove.chats', removeOthers) : t('shell.remove.chat') }}
        </p>
        <p v-if="removeError" class="sb__logout sb__logout--error selectable" role="alert">
          {{ removeError }}<template v-if="removeForce"> {{ t('shell.remove.force') }}</template>
        </p>
      </template>
      <template #footer>
        <UiButton variant="ghost" data-autofocus :disabled="removeBusy" @click="removing = null">{{ t('common.actions.cancel') }}</UiButton>
        <UiButton variant="danger" :loading="removeBusy" @click="removeWorktree">{{ removeForce ? t('shell.remove.anyway') : t('shell.remove.title', { term: removeTerm }) }}</UiButton>
      </template>
    </UiDialog>


    <div
      class="sb__resize"
      role="separator"
      aria-orientation="vertical"
      :aria-label="t('shell.sidebar.resize')"
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
.sb__new span { flex: 1; min-width: 0; text-align: left; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sb__new kbd { flex: none; white-space: nowrap; }
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
