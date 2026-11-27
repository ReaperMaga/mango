<script setup lang="ts">
import { pluginMenuItems } from '~/plugin-host/menus'
import { Archive, ArchiveRestore, ArrowDown, ArrowUp, CircleCheck, CircleDot, FolderGit2, FolderMinus, MoreHorizontal, Pencil, Trash2, Columns2, AppWindow } from 'lucide-vue-next'
import { useWorkspace } from '~/stores/workspace'
import { useThreads, isBusy } from '~/stores/threads'
import { AGENTS, displayStatus, hasUnreadResult, waitingFor, type Thread } from '~/types/chat'
import { shortAgo } from '~/utils/time'
import { stateOf } from '~/utils/linkState'
import { itemNumber } from '~/utils/forge'
import type { MenuItem } from '~/types/ui'
import { worktreeName } from '~/utils/worktrees'
import { vcsTerms } from '~/utils/vcs'
import { useWindows } from '~/stores/windows'

/**
 * One chat's row in the sidebar. Its own component so that a change to one chat (a streamed reply moves its
 * time, its status) re-renders that row only, not the whole list. Dragging is the list's: the row reports
 * the press that may start one, and its opening is the list's to allow (the click that ends a drag is not a click).
 */
const props = defineProps<{
  chat: Thread
  /** The section the row is in: a drag reorders within it. */
  group: string
  current: boolean
  visible: boolean
  dragging: boolean
  drop: 'before' | 'after' | null
  /** The list's clock, so every row's time moves together. */
  now: number
}>()
const emit = defineEmits<{
  open: []
  press: [e: PointerEvent, el: HTMLElement]
  removeWorktree: []
}>()

const { t } = useI18n()
const ws = useWorkspace()
const threads = useThreads()
const win = useWindows()

const shown = computed(() => displayStatus(props.chat))
const busy = computed(() => isBusy(props.chat))

/** "worktree", or "workspace" for a Unity VCS chat. */
const term = computed(() => vcsTerms(ws.openProjects.find(p => p.path === props.chat.projectPath)?.vcs).worktree)
/** Unity VCS branches are long paths; the chip shows their last part (`/main/task/fix` → `fix`). */
const chipBranch = (b: string) => (b.startsWith('/') ? b.slice(b.lastIndexOf('/') + 1) : b)

/**
 * The pull request or merge request (or, without one, the issue) the chat is linked to, for the mark on its row:
 * the newest one, plus how many others there are.
 */
const linkMark = computed(() => {
  const links = props.chat.links
  if (!links?.length) return null
  const main = [...links].reverse().find(l => l.kind === 'pr') ?? links[links.length - 1]!
  const state = stateOf(main.kind, main.state, null, main.provider)
  const others = links.length - 1
  const what = `${state.noun} ${itemNumber(main)}${main.state ? `, ${state.word}` : ''}`
  return {
    number: itemNumber(main),
    icon: state.icon,
    tone: state.tone,
    others,
    label: `${what}${main.title ? `: ${main.title}` : ''}${others ? ` ${t('shell.sidebar.andMore', { n: others })}` : ''}`,
  }
})

/** Status first when it says something; otherwise who the chat is with. */
const subtitle = computed(() => {
  const chat = props.chat
  const agent = chat.simulated ? `${AGENTS[chat.agent].name} · ${t('shell.sidebar.simulated')}` : AGENTS[chat.agent].name
  const live = threads.live[chat.id]
  const background = live?.tasks.filter(x => x.status === 'running').length ?? 0
  switch (shown.value) {
    case 'waiting': return t(waitingFor(chat) === 'answer' ? 'shell.chat.needsAnswer' : 'shell.chat.needsApproval')
    case 'working':
      if (chat.status === 'running' && background) return live?.idle ? t('shell.sidebar.waitingOnTasks', background) : t('shell.sidebar.inBackground', { n: background })
      return chat.status === 'queued' ? t('shell.chat.starting') : chat.status === 'running' ? t('shell.chat.working') : `${t('shell.status.working')} · ${agent}`
    case 'error': return t('shell.status.error')
    case 'done': return `${t('shell.status.done')} · ${agent}`
    case 'archived': return `${t('shell.status.archived')} · ${agent}`
    default: return agent
  }
})

/* ---------- inline rename ---------- */
const renaming = ref(false)
const renameText = ref('')
const renameField = ref<HTMLInputElement | null>(null)
async function startRename() {
  renaming.value = true
  renameText.value = props.chat.title
  await nextTick()
  renameField.value?.select()
}
function commitRename() {
  if (renaming.value) threads.rename(props.chat.id, renameText.value)
  renaming.value = false
}

function onPointerDown(e: PointerEvent) {
  if (renaming.value) return
  emit('press', e, e.currentTarget as HTMLElement)
}

/* ---------- the row's menu: built when it opens, not on every render ---------- */
const menu = ref<{ showAt: (x: number, y: number) => void; toggle: () => void } | null>(null)
const menuOn = ref(false)
const menuItems = computed<MenuItem[]>(() => (menuOn.value ? threadMenu() : []))
async function withMenu(then: (m: NonNullable<typeof menu.value>) => void) {
  menuOn.value = true
  await nextTick()
  if (menu.value) then(menu.value)
}
/** A right-click opens the same menu the three dots open. */
function openContextMenu(e: MouseEvent) {
  if (renaming.value) return
  const { clientX: x, clientY: y } = e
  void withMenu(m => m.showAt(x, y))
}
function toggleMenu(open: boolean, toggle: () => void) {
  if (open) toggle()
  else void withMenu(() => toggle())
}

function threadMenu(): MenuItem[] {
  const chat = props.chat
  const shownNow = displayStatus(chat)
  const busyNow = isBusy(chat)
  const order = threads.forProject(chat.projectPath).map(x => x.id)
  return [
    { label: t('common.actions.rename'), icon: Pencil, onSelect: () => startRename() },
    { label: t('shell.chat.toSide'), icon: Columns2, onSelect: () => threads.split(chat.id) },
    { ...win.moveChatAction(chat.id), icon: AppWindow, divider: false },
    ...(chat.archived ? [] : [
      { label: t('shell.chat.moveUp'), icon: ArrowUp, kbd: 'Alt+↑', divider: true, disabled: order.indexOf(chat.id) <= 0, onSelect: () => threads.move(chat.id, -1) },
      { label: t('shell.chat.moveDown'), icon: ArrowDown, kbd: 'Alt+↓', disabled: order.indexOf(chat.id) === order.length - 1, onSelect: () => threads.move(chat.id, 1) },
    ]),
    // Status. Settled is only set with the row's mark.
    { label: t('shell.status.working'), icon: CircleDot, divider: true, checked: shownNow === 'working' || shownNow === 'waiting', disabled: busyNow, onSelect: () => threads.setStatus(chat.id, 'working') },
    { label: t('shell.status.archived'), icon: Archive, checked: shownNow === 'archived', disabled: busyNow, onSelect: () => { if (!chat.archived) ws.confirmThen('archive', { title: t('shell.chat.archiveTitle'), body: t('shell.chat.archiveBody', { title: chatTitle(chat.title) }), label: t('shell.chat.archiveLabel') }, () => threads.archive(chat.id)) } },
    ...(chat.worktree ? [{ label: t('shell.remove.menu', { term: term.value }), icon: FolderMinus, divider: true, disabled: busyNow, onSelect: () => emit('removeWorktree') }] : []),
    { label: t('shell.chat.delete'), icon: Trash2, danger: true, divider: !chat.worktree, onSelect: () => ws.confirmThen('delete', { title: t('shell.chat.deleteTitle'), body: t('shell.chat.deleteBody', { title: chatTitle(chat.title) }), label: t('shell.chat.delete'), danger: true }, () => threads.remove(chat.id)) },
    ...pluginMenuItems('thread', { threadId: chat.id }),
  ]
}
</script>

<template>
  <div
    class="sb__thread"
    :class="{
      'is-archived': chat.archived,
      'is-current': current,
      'is-visible': visible,
      'is-unseen': !chat.seen,
      'is-dragging': dragging,
      'is-drop-before': drop === 'before',
      'is-drop-after': drop === 'after',
    }"
    role="button"
    tabindex="0"
    :data-thread-id="chat.id"
    :data-group="group"
    @pointerdown="onPointerDown"
    @keydown.alt.up.prevent="threads.move(chat.id, -1)"
    @keydown.alt.down.prevent="threads.move(chat.id, 1)"
    @click="emit('open')"
    @keydown.enter.prevent="emit('open')"
    @dblclick="startRename()"
    @contextmenu.prevent="openContextMenu"
  >
    <UiRipenessDot :status="chat.archived ? 'archived' : chat.status" :unseen="hasUnreadResult(chat) || (!chat.archived && !chat.seen && chat.status === 'waiting')" />
    <div class="sb__thread-text">
      <input
        v-if="renaming"
        ref="renameField"
        v-model="renameText"
        class="sb__rename"
        :aria-label="t('shell.sidebar.chatTitle')"
        @click.stop
        @keydown.enter.prevent="commitRename"
        @keydown.esc.prevent="renaming = false"
        @blur="commitRename"
      >
      <span v-else class="sb__titleline">
        <component
          :is="linkMark.icon"
          v-if="linkMark"
          class="sb__link-icon"
          :class="`is-${linkMark.tone}`"
          aria-hidden="true"
        />
        <span class="sb__title">{{ chatTitle(chat.title) }}</span>
      </span>
      <span class="sb__subline">
        <span class="sb__sub" :class="`sb__sub--${shown}`">{{ subtitle }}</span>
        <span v-if="chat.worktree" class="sb__wt" :title="`${t('shell.sidebar.ownTerm', { term, path: chat.worktree })}${chat.branch ? `\n${t('shell.sidebar.branch', { branch: chat.branch })}` : ''}`">
          <FolderGit2 aria-hidden="true" /><span class="sb__wt-name">{{ chat.branch ? chipBranch(chat.branch) : worktreeName(chat.worktree) }}</span>
          <span class="sr-only">{{ t('shell.sidebar.inTerm', { term, name: worktreeName(chat.worktree) }) }}</span>
        </span>
        <span v-else-if="chat.awaitingWorktree" class="sb__wt" :title="t('shell.sidebar.awaiting', { term })">
          <FolderGit2 aria-hidden="true" /><span class="sr-only">{{ t('shell.sidebar.awaitingShort', { term }) }}</span>
        </span>
        <span v-if="linkMark" :key="linkMark.number" class="sb__link tabular" :class="`is-${linkMark.tone}`" :title="linkMark.label">
          {{ linkMark.number }}<span v-if="linkMark.others" class="sb__link-more">+{{ linkMark.others }}</span>
          <span class="sr-only">, {{ linkMark.label }}</span>
        </span>
      </span>
    </div>
    <span class="sb__time tabular">{{ shortAgo(chat.updatedAt, now) }}</span>
    <div class="sb__actions" @click.stop @dblclick.stop>
      <UiIconButton
        v-if="chat.archived"
        size="sm"
        :label="t('shell.chat.unarchive')"
        @click.stop="threads.unarchive(chat.id)"
      >
        <ArchiveRestore />
      </UiIconButton>
      <UiIconButton
        v-else
        size="sm"
        :label="busy ? t('shell.chat.stillWorking') : chat.status === 'done' ? t('shell.chat.markWorking') : t('shell.chat.markSettled')"
        :active="chat.status === 'done'"
        :disabled="busy"
        @click.stop="threads.setStatus(chat.id, chat.status === 'done' ? 'working' : 'done')"
      >
        <CircleCheck />
      </UiIconButton>
      <UiMenu ref="menu" :items="menuItems" placement="bottom-end" :width="220" :label="t('shell.chat.actions')" @closed="menuOn = false">
        <template #default="{ open, toggle }">
          <UiIconButton size="sm" :label="t('shell.chat.actions')" @click.stop="toggleMenu(open, toggle)"><MoreHorizontal /></UiIconButton>
        </template>
      </UiMenu>
    </div>
  </div>
</template>

<style scoped>
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
</style>
