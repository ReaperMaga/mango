<script setup lang="ts">
import { Archive, ArchiveRestore, ArrowDown, ArrowUp, ChevronRight, CircleCheck, CircleDot, MessageSquarePlus, MoreHorizontal, Plus, Settings, X, Pencil, Trash2, Columns2 } from 'lucide-vue-next'
import { useWorkspace } from '~/stores/workspace'
import { useThreads } from '~/stores/threads'
import { AGENTS, displayStatus, hasUnreadResult, type Thread } from '~/types/chat'
import { isBusy } from '~/stores/threads'
import { modLabel } from '~/composables/useShortcuts'
import { shortAgo, useNow } from '~/utils/time'
import type { MenuItem } from '~/types/ui'

const ws = useWorkspace()
const threads = useThreads()
const now = useNow()
const mod = ref('Ctrl')
onMounted(() => (mod.value = modLabel()))

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

function open(t: Thread) {
  if (justDragged) return // the click that ends a drag is not a click
  if (t.projectPath !== ws.activeProjectPath) ws.setActiveProject(t.projectPath)
  threads.show(t.id)
}

/* ---------- reorder by dragging ----------
 * Pointer events rather than HTML5 drag and drop: the desktop webview takes
 * over native drag and drop (for dropped files), which breaks it on Windows.
 */
const drag = reactive({ id: null as string | null, overId: null as string | null, where: 'before' as 'before' | 'after' })
let dragStart: { id: string; group: string; x: number; y: number } | null = null
let justDragged = false

function onRowPointerDown(t: Thread, e: PointerEvent) {
  if (e.button !== 0 || t.archived || renaming.value === t.id) return
  if ((e.target as HTMLElement).closest('.sb__actions, input')) return
  const group = (e.currentTarget as HTMLElement).dataset.group ?? ''
  dragStart = { id: t.id, group, x: e.clientX, y: e.clientY }
  window.addEventListener('pointermove', onDragMove)
  window.addEventListener('pointerup', onDragEnd)
  window.addEventListener('pointercancel', onDragEnd)
}

function onDragMove(e: PointerEvent) {
  if (!dragStart) return
  if (!drag.id) {
    // A few pixels of slack, so an ordinary click never starts a drag.
    if (Math.hypot(e.clientX - dragStart.x, e.clientY - dragStart.y) < 6) return
    drag.id = dragStart.id
    document.body.classList.add('is-reordering')
  }
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

function onDragEnd() {
  window.removeEventListener('pointermove', onDragMove)
  window.removeEventListener('pointerup', onDragEnd)
  window.removeEventListener('pointercancel', onDragEnd)
  if (drag.id) {
    if (drag.overId) threads.reorder(drag.id, drag.overId, drag.where)
    justDragged = true
    setTimeout(() => (justDragged = false), 0)
  }
  drag.id = null
  drag.overId = null
  dragStart = null
  document.body.classList.remove('is-reordering')
}
onBeforeUnmount(onDragEnd)

/** Status first when it says something; otherwise who the chat is with. */
function subtitle(t: Thread) {
  const agent = t.simulated ? `${AGENTS[t.agent].name} · simulated` : AGENTS[t.agent].name
  switch (displayStatus(t)) {
    case 'waiting': return 'Needs your approval'
    case 'working': return t.status === 'queued' ? 'Starting…' : t.status === 'running' ? 'Working…' : `Working · ${agent}`
    case 'error': return 'Failed'
    case 'done': return `Settled · ${agent}`
    case 'archived': return `Archived · ${agent}`
    default: return agent
  }
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
    { label: 'Open to the side', icon: Columns2, onSelect: () => { ws.setActiveProject(t.projectPath); threads.split(t.id) } },
    ...(t.archived ? [] : [
      { label: 'Move up', icon: ArrowUp, kbd: 'Alt+↑', divider: true, disabled: order.indexOf(t.id) <= 0, onSelect: () => threads.move(t.id, -1) },
      { label: 'Move down', icon: ArrowDown, kbd: 'Alt+↓', disabled: order.indexOf(t.id) === order.length - 1, onSelect: () => threads.move(t.id, 1) },
    ]),
    // Status. Settled is only set with the row's mark.
    { label: 'Working', icon: CircleDot, divider: true, checked: shown === 'working' || shown === 'waiting', disabled: busy, onSelect: () => threads.setStatus(t.id, 'working') },
    { label: 'Archived', icon: Archive, checked: shown === 'archived', disabled: busy, onSelect: () => { if (!t.archived) threads.archive(t.id) } },
    { label: 'Delete chat', icon: Trash2, danger: true, divider: true, onSelect: () => threads.remove(t.id) },
  ]
}

/* resize */
let dragging = false
function startResize(e: PointerEvent) {
  dragging = true
  ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
}
function onResize(e: PointerEvent) {
  if (dragging) ws.setSidebarWidth(e.clientX)
}
function endResize() {
  if (!dragging) return
  dragging = false
  ws.persist()
}

/** Only speak up in the footer when an agent needs setting up; details live in Settings. */
const agentsNeedingAttention = computed(() => {
  if (!ws.agents.length) return ''
  const missing = ws.agents.filter(a => !a.installed)
  return missing.length === ws.agents.length ? 'No agent installed' : ''
})
</script>

<template>
  <aside class="sb" :style="{ width: `${width}px`, '--rail-w': `${width}px` }" aria-label="Threads">
    <div class="sb__top">
      <button type="button" class="sb__new" @click="newChat()">
        <MessageSquarePlus />
        <span>New chat</span>
        <kbd>{{ mod }}</kbd><kbd>N</kbd>
      </button>
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
            <UiIconButton size="sm" label="New chat" @click="newChat()"><Plus /></UiIconButton>
          </div>
        </div>

        <ul v-show="sec.open" class="sb__list" role="list">
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
                <span v-else class="sb__title">{{ t.title }}</span>
                <span class="sb__sub" :class="`sb__sub--${displayStatus(t)}`">{{ subtitle(t) }}</span>
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
          </li>
          <li v-if="sec.id === 'active' && !sec.threads.length">
            <button type="button" class="sb__empty" @click="newChat()">
              <Plus /> {{ threads.forProject(ws.activeProjectPath ?? '').length || threads.archivedFor(ws.activeProjectPath ?? '').length ? 'Start a new chat' : 'Start the first chat' }}
            </button>
          </li>
        </ul>
      </section>
    </nav>

    <footer class="sb__foot">
      <button type="button" class="sb__settings" :title="`Settings (${mod}+,)`" @click="ws.openSettings()">
        <Settings />
        <span>Settings</span>
        <span v-if="agentsNeedingAttention" class="sb__settings-note">{{ agentsNeedingAttention }}</span>
      </button>
    </footer>

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
.sb__top { padding: var(--space-2) var(--space-2) var(--space-2) var(--space-3); }
.sb__new {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
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

.sb__list { list-style: none; margin: 2px 0 0; padding: 0; display: grid; gap: 1px; }
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

.sb__foot {
  display: flex;
  align-items: center;
  gap: 2px;
  height: 40px;
  padding: 0 var(--space-2) 0 var(--space-4);
  border-top: 1px solid var(--line-soft);
  gap: var(--space-1);
}
.sb__settings {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  height: 28px;
  padding: 0 var(--space-2);
  margin-left: calc(var(--space-2) * -1);
  border-radius: var(--radius-sm);
  font-size: var(--text-sm);
  color: var(--fg-subtle);
  text-align: left;
  transition: background var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out);
}
.sb__settings:hover { background: var(--bg-hover); color: var(--fg); }
.sb__settings svg { width: 15px; height: 15px; stroke-width: 1.75; flex: none; }
.sb__settings-note { margin-left: auto; font-size: var(--text-2xs); color: var(--ripe-waiting-fg); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

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
