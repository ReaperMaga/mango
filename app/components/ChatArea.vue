<script setup lang="ts">
import { Archive, ArrowRightToLine, CircleCheck, Columns2, Copy, ExternalLink, FileDiff, FileCode, FolderGit2, Globe, ListX, Pin, Plus, RotateCw, Route, X, XCircle, PanelRightClose } from 'lucide-vue-next'
import { useWorkspace } from '~/stores/workspace'
import { useThreads } from '~/stores/threads'
import { modLabel } from '~/composables/useShortcuts'
import { useGit } from '~/stores/git'
import { isDiffTab, parseDiffTab } from '~/utils/diffTabs'
import { isFileTab, parseFileTab } from '~/utils/fileTabs'
import { useFiles } from '~/stores/files'
import { browserTitle, useBrowser, type Browser } from '~/stores/browser'
import { isBrowserTab, isBlank } from '~/utils/browserTabs'
import { openExternal } from '~/composables/useBackend'
import { holdOverlay } from '~/composables/useOverlay'
import { hasUnreadResult, type Thread } from '~/types/chat'
import { isBusy } from '~/stores/threads'
import { copyToClipboard } from '~/utils/agentCli'
import { sepOf, withTrailingSep } from '~/utils/paths'
import type { MenuItem } from '~/types/ui'

const ws = useWorkspace()
const threads = useThreads()
const files = useFiles()
const browsers = useBrowser()
const mod = ref('Ctrl')
onMounted(() => (mod.value = modLabel()))

type Tab =
  | { id: string; kind: 'chat'; title: string; thread: Thread }
  | { id: string; kind: 'diff'; title: string; file: string; staged: boolean }
  | { id: string; kind: 'file'; title: string; file: string }
  | { id: string; kind: 'browser'; title: string; browser: Browser }

/** Tabs belonging to the active project (chats, diffs, files); other projects' tabs stay open but hidden. */
const tabs = computed<Tab[]>(() => {
  const out: Tab[] = []
  for (const id of threads.visibleTabs) {
    const diff = parseDiffTab(id)
    if (diff) { out.push({ id, kind: 'diff', title: diff.name, file: diff.file, staged: diff.staged }); continue }
    const file = parseFileTab(id)
    if (file) { out.push({ id, kind: 'file', title: file.name, file: file.file }); continue }
    if (isBrowserTab(id)) {
      const b = browsers.forTab(id)
      if (b) out.push({ id, kind: 'browser', title: browserTitle(b), browser: b })
      continue
    }
    const t = threads.byId(id)
    if (t) out.push({ id, kind: 'chat', title: t.title, thread: t })
  }
  return out
})

/* A diff tab whose file is no longer changed (committed, discarded, staged away) has nothing to show: close it. */
const git = useGit()
watchEffect(() => {
  for (const id of [...threads.tabs]) {
    const diff = parseDiffTab(id)
    if (!diff) continue
    const repo = git.repos[diff.projectPath]
    if (repo?.status && !repo.expanded.includes(diff.key)) threads.closeTab(id)
  }
})

const paneOf = (id: string) => threads.panes.find(p => p.threadId === id)?.id

function newChat() {
  if (ws.activeProjectPath) threads.create(ws.activeProjectPath)
}

/** A tab's tooltip: what it shows, who opened it, and its shortcut. */
function tabTitle(t: Tab, i: number) {
  const keys = i < 9 ? ` (${mod.value}+${i + 1})` : ''
  if (t.kind === 'diff') return `Changes in ${t.file}${keys}`
  if (t.kind === 'file') return `${t.file}${keys}`
  if (t.kind === 'browser') {
    const owner = threads.byId(t.browser.threadId)
    const where = isBlank(t.browser.url) ? 'New tab' : t.browser.url
    return `${where}${owner ? `\nOpened by ${owner.title}` : ''}${keys}`
  }
  const wt = t.kind === 'chat' ? t.thread.worktree : null
  return `${t.title}${keys}${wt ? `\nWorktree: ${wt}${t.thread.branch ? ` (${t.thread.branch})` : ''}` : ''}`
}

/*
 * A pane only ever shows the active project's tabs. Checked when the project changes and
 * whenever a pane gets something new: a chat of another project would sit there with no tab
 * and no sidebar row, and a message typed into it would run in the other project's folder.
 */
watch([() => ws.activeProjectPath, () => threads.panes.map(p => p.threadId).join('\n')], ([path]) => {
  if (!path) return
  let moved = false
  for (const pane of threads.panes) {
    const owner = threads.projectOf(pane.threadId)
    if (owner && owner !== path) {
      pane.threadId = tabs.value.find(x => !threads.panes.some(p => p.threadId === x.id))?.id ?? null
      moved = true
    }
  }
  if (threads.panes.length > 1 && threads.panes.every(p => !p.threadId)) threads.closePane('pane-b')
  else if (moved) threads.persist()
}, { immediate: true })

/* split resize */
const split = ref(0.5)
const panesEl = ref<HTMLElement | null>(null)
let dragging = false
/* A browser's page would swallow the pointer once it crosses it: the browsers hide during the drag. */
let release = () => {}
function onDown(e: PointerEvent) { dragging = true; release = holdOverlay(); (e.target as HTMLElement).setPointerCapture(e.pointerId) }
function onMove(e: PointerEvent) {
  if (!dragging || !panesEl.value) return
  const r = panesEl.value.getBoundingClientRect()
  split.value = Math.min(0.75, Math.max(0.25, (e.clientX - r.left) / r.width))
}
function onUp() { dragging = false; release() }

function onTabAux(e: MouseEvent, id: string) {
  if (e.button === 1) { e.preventDefault(); threads.closeTab(id) }
}

/* ---------- right-click on a tab: the app's own menu instead of the webview's (Back, Refresh, Save as) ---------- */

const tabMenu = ref<{ showAt: (x: number, y: number) => void } | null>(null)
const menuTabId = ref<string | null>(null)

async function onTabContext(e: MouseEvent, id: string) {
  menuTabId.value = id
  await nextTick()
  tabMenu.value?.showAt(e.clientX, e.clientY)
}

/** Closing several at once leaves files with unsaved edits open: no stack of "save?" questions. */
function closeMany(ids: string[]) {
  for (const id of ids) if (!(isFileTab(id) && files.isDirty(id))) threads.closeTab(id)
}

/** A file's path on disk, in the style of the project's own path. */
function absolutePath(projectPath: string, file: string) {
  const sep = sepOf(projectPath)
  return withTrailingSep(projectPath) + (sep === '\\' ? file.replace(/\//g, '\\') : file)
}

const tabMenuItems = computed<MenuItem[]>(() => {
  const id = menuTabId.value
  const at = tabs.value.findIndex(t => t.id === id)
  const tab = tabs.value[at]
  if (!tab) return []
  const ids = tabs.value.map(t => t.id)
  const items: MenuItem[] = [
    { label: 'Close', icon: X, kbd: `${mod.value}+W`, onSelect: () => threads.closeTab(tab.id) },
    { label: 'Close others', icon: XCircle, disabled: ids.length < 2, onSelect: () => closeMany(ids.filter(x => x !== tab.id)) },
    { label: 'Close to the right', icon: ArrowRightToLine, disabled: at >= ids.length - 1, onSelect: () => closeMany(ids.slice(at + 1)) },
    { label: 'Close all', icon: ListX, onSelect: () => closeMany(ids) },
  ]

  const inOtherPane = threads.isSplit && paneOf(tab.id) !== 'pane-b'
  const splitItem: MenuItem = {
    label: threads.isSplit ? 'Show in the right pane' : 'Split right',
    icon: Columns2,
    divider: true,
    disabled: threads.isSplit && !inOtherPane,
    onSelect: () => threads.split(tab.id),
  }

  if (tab.kind === 'chat') {
    const busy = isBusy(tab.thread)
    items.push(
      splitItem,
      { label: 'Mark as settled', icon: CircleCheck, divider: true, disabled: busy || tab.thread.status === 'done', onSelect: () => threads.setStatus(tab.id, 'done') },
      { label: 'Archive chat', icon: Archive, disabled: busy, hint: busy ? 'Still working' : undefined, onSelect: () => threads.archive(tab.id) },
    )
    return items
  }

  if (tab.kind === 'browser') {
    const b = tab.browser
    const blank = isBlank(b.url)
    items.push(
      splitItem,
      { label: 'Reload', icon: RotateCw, divider: true, disabled: blank, onSelect: () => void browsers.go(b.id, 'reload') },
      { label: 'Copy URL', icon: Copy, disabled: blank, onSelect: () => void copyToClipboard(b.url) },
      { label: 'Open in system browser', icon: ExternalLink, disabled: blank, onSelect: () => void openExternal(b.url).catch(() => {}) },
    )
    return items
  }

  const project = tab.kind === 'file' ? parseFileTab(tab.id)?.projectPath : parseDiffTab(tab.id)?.projectPath
  items.push(splitItem)
  if (tab.kind === 'file' && files.isPreview(tab.id)) {
    items.push({ label: 'Keep open', icon: Pin, divider: true, onSelect: () => files.pin(tab.id) })
  }
  items.push(
    { label: 'Copy path', icon: Copy, divider: !(tab.kind === 'file' && files.isPreview(tab.id)), disabled: !project, onSelect: () => project && void copyToClipboard(absolutePath(project, tab.file)) },
    { label: 'Copy relative path', icon: Route, onSelect: () => void copyToClipboard(tab.file) },
  )
  return items
})
</script>

<template>
  <section class="ca">
    <div class="ca__tabs" role="tablist" aria-label="Open chats">
      <div class="ca__strip">
        <div
          v-for="(t, i) in tabs"
          :key="t.id"
          class="ca__tab"
          :class="{
            'is-active': threads.activePane.threadId === t.id,
            'is-shown': !!paneOf(t.id),
            'is-b': paneOf(t.id) === 'pane-b',
          }"
          role="tab"
          tabindex="0"
          :aria-selected="threads.activePane.threadId === t.id"
          :title="tabTitle(t, i)"
          @click="threads.show(t.id)"
          @keydown.enter.prevent="threads.show(t.id)"
          @auxclick="onTabAux($event, t.id)"
          @contextmenu.prevent="onTabContext($event, t.id)"
          @dblclick="t.kind === 'file' && files.pin(t.id)"
        >
          <template v-if="t.kind === 'chat'">
            <UiRipenessDot :status="t.thread.archived ? 'archived' : t.thread.status" :size="11" :unseen="hasUnreadResult(t.thread) || (!t.thread.archived && !t.thread.seen && t.thread.status === 'waiting')" />
            <span class="ca__tab-title">{{ t.title }}</span>
            <FolderGit2 v-if="t.thread.worktree" class="ca__tab-wt" :aria-label="`In its own worktree${t.thread.branch ? `, branch ${t.thread.branch}` : ''}`" />
          </template>
          <template v-else-if="t.kind === 'diff'">
            <FileDiff class="ca__tab-icon" aria-hidden="true" />
            <span class="ca__tab-title">{{ t.title }}</span>
            <span v-if="t.staged" class="ca__tab-note">staged</span>
          </template>
          <template v-else-if="t.kind === 'browser'">
            <span v-if="t.browser.loading" class="ca__tab-spin" aria-hidden="true" />
            <Globe v-else class="ca__tab-icon" aria-hidden="true" />
            <span class="ca__tab-title">{{ t.title }}</span>
            <span v-if="t.browser.threadId" class="ca__tab-note">agent</span>
          </template>
          <template v-else>
            <FileCode class="ca__tab-icon" aria-hidden="true" />
            <span class="ca__tab-title" :class="{ 'is-preview': files.isPreview(t.id) }">{{ t.title }}</span>
          </template>
          <button
            type="button"
            class="ca__tab-x"
            :class="{ 'is-dirty': files.isDirty(t.id) }"
            :aria-label="files.isDirty(t.id) ? `Close ${t.title}, unsaved changes` : `Close ${t.title}`"
            @click.stop="threads.closeTab(t.id)"
          ><X /><span v-if="files.isDirty(t.id)" class="ca__tab-dot" aria-hidden="true" /></button>
        </div>
        <UiIconButton class="ca__plus" size="sm" label="New chat" :shortcut="`${mod}+N`" @click="newChat"><Plus /></UiIconButton>
      </div>
      <div class="ca__tools">
        <UiIconButton size="sm" label="New browser tab" :shortcut="`${mod}+Shift+B`" @click="browsers.openNew()"><Globe /></UiIconButton>
        <UiIconButton
          size="sm"
          :label="threads.isSplit ? 'Close split' : 'Split chat right'"
          :shortcut="`${mod}+\\`"
          :active="threads.isSplit"
          @click="threads.isSplit ? threads.closePane('pane-b') : threads.split()"
        >
          <PanelRightClose v-if="threads.isSplit" />
          <Columns2 v-else />
        </UiIconButton>
      </div>
    </div>

    <UiMenu ref="tabMenu" class="ca__ctx" :items="tabMenuItems" :width="230" label="Tab actions" />

    <div ref="panesEl" class="ca__panes" :style="{ '--split': split }">
      <template v-for="(pane, i) in threads.panes" :key="pane.id">
        <div
          v-if="i > 0"
          class="ca__divider"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize chats"
          @pointerdown="onDown"
          @pointermove="onMove"
          @pointerup="onUp"
          @dblclick="split = 0.5"
        />
        <GitDiffPane
          v-if="isDiffTab(pane.threadId)"
          :tab-id="pane.threadId"
          :pane-id="pane.id"
          :split="threads.isSplit"
          :active="threads.activePaneId === pane.id"
          :style="threads.isSplit ? { flexBasis: i === 0 ? `calc(${split * 100}% - 0.5px)` : `calc(${(1 - split) * 100}% - 0.5px)` } : undefined"
          @mousedown="threads.focusPane(pane.id)"
          @focusin="threads.focusPane(pane.id)"
        />
        <BrowserPane
          v-else-if="isBrowserTab(pane.threadId)"
          :tab-id="pane.threadId"
          :pane-id="pane.id"
          :split="threads.isSplit"
          :active="threads.activePaneId === pane.id"
          :style="threads.isSplit ? { flexBasis: i === 0 ? `calc(${split * 100}% - 0.5px)` : `calc(${(1 - split) * 100}% - 0.5px)` } : undefined"
          @mousedown="threads.focusPane(pane.id)"
          @focusin="threads.focusPane(pane.id)"
        />
        <FilesEditorPane
          v-else-if="isFileTab(pane.threadId)"
          :tab-id="pane.threadId"
          :pane-id="pane.id"
          :split="threads.isSplit"
          :active="threads.activePaneId === pane.id"
          :style="threads.isSplit ? { flexBasis: i === 0 ? `calc(${split * 100}% - 0.5px)` : `calc(${(1 - split) * 100}% - 0.5px)` } : undefined"
          @mousedown="threads.focusPane(pane.id)"
          @focusin="threads.focusPane(pane.id)"
        />
        <ChatPane
          v-else
          :pane="pane"
          :split="threads.isSplit"
          :active="threads.activePaneId === pane.id"
          :style="threads.isSplit ? { flexBasis: i === 0 ? `calc(${split * 100}% - 0.5px)` : `calc(${(1 - split) * 100}% - 0.5px)` } : undefined"
          @mousedown="threads.focusPane(pane.id)"
          @focusin="threads.focusPane(pane.id)"
        />
      </template>
    </div>
  </section>
</template>

<style scoped>
.ca { display: flex; flex-direction: column; min-width: 0; }
.ca__tabs {
  display: flex;
  align-items: stretch;
  height: var(--tabbar-h);
  border-bottom: 1px solid var(--line-soft);
  background: color-mix(in oklch, var(--bg-app) 35%, var(--bg-canvas));
  flex: none;
}
.ca__strip {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: stretch;
  overflow-x: auto;
  scrollbar-width: none;
  padding-left: var(--space-1);
}
.ca__strip::-webkit-scrollbar { display: none; }
.ca__tab {
  position: relative;
  display: flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
  max-width: 220px;
  padding: 0 4px 0 10px;
  font-size: var(--text-sm);
  color: var(--fg-subtle);
  cursor: pointer;
  flex: 0 1 auto;
  transition: color var(--dur-fast) var(--ease-out), background var(--dur-fast) var(--ease-out);
}
.ca__tab:hover { color: var(--fg-muted); background: var(--bg-hover); }
.ca__tab.is-shown { color: var(--fg-muted); }
.ca__tab.is-active { color: var(--fg); background: var(--bg-canvas); }
/* Active tab: a mango underline, the one place the accent sits in the chrome. */
.ca__tab.is-active::after {
  content: '';
  position: absolute;
  left: 8px;
  right: 8px;
  bottom: -1px;
  height: 2px;
  border-radius: 2px 2px 0 0;
  background: var(--accent);
}
.ca__tab.is-shown:not(.is-active)::after {
  content: '';
  position: absolute;
  left: 8px;
  right: 8px;
  bottom: -1px;
  height: 2px;
  background: var(--line-strong);
}
.ca__tab-icon { width: 14px; height: 14px; flex: none; stroke-width: 1.75; color: var(--fg-subtle); }
.ca__tab-note { flex: none; font-size: var(--text-2xs); color: var(--fg-faint); }
/* A browser tab while its page loads: a small ring in ripening mango where the globe was. */
.ca__tab-spin {
  flex: none;
  width: 12px;
  height: 12px;
  margin: 1px;
  border-radius: 50%;
  border: 1.5px solid var(--line-strong);
  border-top-color: var(--ripe-running);
  animation: ca-spin 0.9s linear infinite;
}
@keyframes ca-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .ca__tab-spin { animation-duration: 2.4s; } }
.ca__tab-wt { flex: none; width: 12px; height: 12px; stroke-width: 1.85; color: var(--fg-faint); }
.ca__tab-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* A file opened with a single click: the next one replaces it until it is edited or double-clicked. */
.ca__tab-title.is-preview { font-style: italic; }
.ca__tab-x {
  display: grid;
  place-items: center;
  width: 20px;
  height: 20px;
  border-radius: var(--radius-xs);
  color: var(--fg-faint);
  opacity: 0;
  flex: none;
  transition: opacity var(--dur-fast) var(--ease-out), background var(--dur-fast) var(--ease-out);
}
.ca__tab-x svg { width: 13px; height: 13px; }
.ca__tab:hover .ca__tab-x, .ca__tab.is-active .ca__tab-x, .ca__tab-x:focus-visible { opacity: 1; }
.ca__tab-x:hover { background: var(--bg-active); color: var(--fg); }
/* Unsaved edits: a dot in place of the close button, which comes back on hover. */
.ca__tab-x.is-dirty { opacity: 1; }
.ca__tab-x.is-dirty svg, .ca__tab-x.is-dirty:hover .ca__tab-dot, .ca__tab-x.is-dirty:focus-visible .ca__tab-dot { display: none; }
.ca__tab-x.is-dirty:hover svg, .ca__tab-x.is-dirty:focus-visible svg { display: block; }
.ca__tab-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--accent); }
.ca__plus { align-self: center; margin-left: var(--space-1); }
.ca__tools { display: flex; align-items: center; gap: 2px; padding: 0 var(--space-2); }

.ca__panes { flex: 1; min-height: 0; display: flex; }
.ca__divider {
  flex: none;
  width: 1px;
  background: var(--line-soft);
  position: relative;
  cursor: col-resize;
}
.ca__divider::before { content: ''; position: absolute; inset: 0 -3px; }
.ca__divider:hover { background: var(--accent-line); }
</style>
