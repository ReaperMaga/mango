<script setup lang="ts">
import { Columns2, FileDiff, FileCode, Plus, X, PanelRightClose } from 'lucide-vue-next'
import { useWorkspace } from '~/stores/workspace'
import { useThreads } from '~/stores/threads'
import { modLabel } from '~/composables/useShortcuts'
import { useGit } from '~/stores/git'
import { isDiffTab, parseDiffTab } from '~/utils/diffTabs'
import { isFileTab, parseFileTab, tabProject } from '~/utils/fileTabs'
import { useFiles } from '~/stores/files'
import { hasUnreadResult, type Thread } from '~/types/chat'

const ws = useWorkspace()
const threads = useThreads()
const files = useFiles()
const mod = ref('Ctrl')
onMounted(() => (mod.value = modLabel()))

type Tab =
  | { id: string; kind: 'chat'; title: string; thread: Thread }
  | { id: string; kind: 'diff'; title: string; file: string; staged: boolean }
  | { id: string; kind: 'file'; title: string; file: string }

/** Tabs belonging to the active project (chats and diffs); other projects' tabs stay open but hidden. */
const tabs = computed<Tab[]>(() => {
  const out: Tab[] = []
  for (const id of threads.tabs) {
    const diff = parseDiffTab(id)
    if (diff) {
      if (diff.projectPath === ws.activeProjectPath) out.push({ id, kind: 'diff', title: diff.name, file: diff.file, staged: diff.staged })
      continue
    }
    const file = parseFileTab(id)
    if (file) {
      if (file.projectPath === ws.activeProjectPath) out.push({ id, kind: 'file', title: file.name, file: file.file })
      continue
    }
    const t = threads.byId(id)
    if (t && t.projectPath === ws.activeProjectPath) out.push({ id, kind: 'chat', title: t.title, thread: t })
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

/* When the project changes, make sure the active pane shows one of its threads. */
watch(() => ws.activeProjectPath, (path) => {
  if (!path) return
  for (const pane of threads.panes) {
    const owner = tabProject(pane.threadId) ?? threads.byId(pane.threadId)?.projectPath
    if (owner && owner !== path) pane.threadId = tabs.value.find(x => !threads.panes.some(p => p.threadId === x.id))?.id ?? null
  }
  if (threads.panes.length > 1 && threads.panes.every(p => !p.threadId)) threads.closePane('pane-b')
}, { immediate: true })

/* split resize */
const split = ref(0.5)
const panesEl = ref<HTMLElement | null>(null)
let dragging = false
function onDown(e: PointerEvent) { dragging = true; (e.target as HTMLElement).setPointerCapture(e.pointerId) }
function onMove(e: PointerEvent) {
  if (!dragging || !panesEl.value) return
  const r = panesEl.value.getBoundingClientRect()
  split.value = Math.min(0.75, Math.max(0.25, (e.clientX - r.left) / r.width))
}
function onUp() { dragging = false }

function onTabAux(e: MouseEvent, id: string) {
  if (e.button === 1) { e.preventDefault(); threads.closeTab(id) }
}
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
          :title="`${t.kind === 'diff' ? `Changes in ${t.file}` : t.kind === 'file' ? t.file : t.title}${i < 9 ? ` (${mod}+${i + 1})` : ''}`"
          @click="threads.show(t.id)"
          @keydown.enter.prevent="threads.show(t.id)"
          @auxclick="onTabAux($event, t.id)"
          @dblclick="t.kind === 'file' && files.pin(t.id)"
        >
          <template v-if="t.kind === 'chat'">
            <UiRipenessDot :status="t.thread.archived ? 'archived' : t.thread.status" :size="11" :unseen="hasUnreadResult(t.thread) || (!t.thread.archived && !t.thread.seen && t.thread.status === 'waiting')" />
            <span class="ca__tab-title">{{ t.title }}</span>
          </template>
          <template v-else-if="t.kind === 'diff'">
            <FileDiff class="ca__tab-icon" aria-hidden="true" />
            <span class="ca__tab-title">{{ t.title }}</span>
            <span v-if="t.staged" class="ca__tab-note">staged</span>
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
