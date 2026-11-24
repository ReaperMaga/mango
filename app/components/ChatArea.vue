<script setup lang="ts">
import { AppWindow, Archive, ArrowDownToLine, ArrowRightToLine, CircleCheck, Columns2, Copy, ExternalLink, FileCode, FileDiff, FolderGit2, GitCommitHorizontal, Globe, ListX, Pin, Plus, RotateCw, Route, Server, SquareTerminal, X, XCircle, PanelRightClose } from 'lucide-vue-next'
import { useWorkspace, type TerminalTab } from '~/stores/workspace'
import { vcsTerms } from '~/utils/vcs'
import { useThreads } from '~/stores/threads'
import { modLabel } from '~/composables/useShortcuts'
import { useGit } from '~/stores/git'
import { isDiffTab, parseDiffTab } from '~/utils/diffTabs'
import { isCommitDiffTab, parseCommitDiffTab } from '~/utils/commitDiffTabs'
import { isFileTab, parseFileTab } from '~/utils/fileTabs'
import { isDecompiledTab, parseDecompiledTab, shortSymbol } from '~/utils/decompiledTabs'
import { decompiledSource } from '~/lsp/decompiled'
import { fileLook } from '~/plugin-host/fileHooks'
import { tabProject } from '~/utils/fileTabs'
import { parseEnvPath } from '~/utils/envPath'
import { nameOf } from '~/utils/fileOps'
import { useFiles } from '~/stores/files'
import { browserTitle, useBrowser, type Browser } from '~/stores/browser'
import { isBrowserTab, isBlank } from '~/utils/browserTabs'
import { isTerminalTab, parseTerminalTab } from '~/utils/terminalTabs'
import { dragJustEnded, pressChatTab, pressPanelTab, pressTerminalTab, tabDrag } from '~/composables/useTabDrag'
import { useWindows } from '~/stores/windows'
import { isEnvPath } from '~/utils/envPath'
import { openExternal } from '~/composables/useBackend'
import { holdOverlay } from '~/composables/useOverlay'
import { hasUnreadResult, type Thread } from '~/types/chat'
import { isBusy } from '~/stores/threads'
import { copyToClipboard } from '~/utils/agentCli'
import { sepOf, withTrailingSep } from '~/utils/paths'
import type { MenuItem } from '~/types/ui'
import { isPanelEditorTab, isPluginTab, parsePanelEditorTab, parsePluginTab } from '~/plugin-host/ids'
import { pluginNames, pluginTabView, pluginTabs } from '~/plugin-host/registry'
import { findPanelTab, panelTabPlugin } from '~/composables/panelTabs'
import type { PluginIcon as PluginIconValue } from '~/plugin-host/types'
import PluginIcon from '~/plugin-host/ui/PluginIcon.vue'
import PluginTabPane from '~/plugin-host/ui/PluginTabPane.vue'
import PanelTabPane from '~/plugin-host/ui/PanelTabPane.vue'

const { t } = useI18n()
const ws = useWorkspace()
const threads = useThreads()
const files = useFiles()
const browsers = useBrowser()
const win = useWindows()
const mod = ref('Ctrl')
onMounted(() => (mod.value = modLabel()))

type Tab =
  | { id: string; kind: 'chat'; title: string; thread: Thread }
  | { id: string; kind: 'diff'; title: string; file: string; staged: boolean }
  | { id: string; kind: 'commit'; title: string; file: string; short: string }
  | { id: string; kind: 'file'; title: string; file: string }
  /** A library's source a language server decompiled (go to definition into a compiled assembly). */
  | { id: string; kind: 'decompiled'; title: string; symbol: string; assembly: string }
  | { id: string; kind: 'browser'; title: string; browser: Browser }
  | { id: string; kind: 'terminal'; title: string; term: TerminalTab }
  | { id: string; kind: 'plugin'; title: string; icon: PluginIconValue | null; plugin: string }
  /** A panel tab moved out of the bottom panel (`plugin`: whose it is, null for Mango's own). */
  | { id: string; kind: 'panel'; title: string; icon: PluginIconValue | null; plugin: string | null; ref: string }

/** Tabs belonging to the active project (chats, diffs, files); other projects' tabs stay open but hidden. */
const tabs = computed<Tab[]>(() => {
  const out: Tab[] = []
  for (const id of threads.visibleTabs) {
    const diff = parseDiffTab(id)
    if (diff) { out.push({ id, kind: 'diff', title: diff.name, file: diff.file, staged: diff.staged }); continue }
    const commit = parseCommitDiffTab(id)
    if (commit) { out.push({ id, kind: 'commit', title: `${commit.name} @ ${commit.short}`, file: commit.file, short: commit.short }); continue }
    const file = parseFileTab(id)
    if (file) { out.push({ id, kind: 'file', title: file.name, file: file.file }); continue }
    const lib = parseDecompiledTab(id)
    if (lib) {
      const source = decompiledSource(id)
      out.push({ id, kind: 'decompiled', title: source ? shortSymbol(source.symbol) : lib.name, symbol: source?.symbol ?? lib.name, assembly: source?.assembly ?? '' })
      continue
    }
    if (isBrowserTab(id)) {
      const b = browsers.forTab(id)
      if (b) out.push({ id, kind: 'browser', title: browserTitle(b), browser: b })
      continue
    }
    const panel = parsePanelEditorTab(id)
    if (panel) {
      const pt = findPanelTab(panel.ref)
      if (pt) out.push({ id, kind: 'panel', title: pt.title, icon: pt.icon, plugin: panelTabPlugin(pt), ref: panel.ref })
      continue
    }
    const plugin = parsePluginTab(id)
    if (plugin) {
      // Shown while its plugin is away too (the pane says so); it closes when the plugin is turned off.
      out.push({ id, kind: 'plugin', title: pluginTabs[id]?.title ?? plugin.viewId, icon: pluginTabView(plugin.pluginId, plugin.viewId)?.icon ?? null, plugin: pluginNames[plugin.pluginId] ?? plugin.pluginId })
      continue
    }
    const term = parseTerminalTab(id)
    if (term) {
      const tab = ws.terminalTabs.find(x => x.id === term.terminalId)
      if (tab) out.push({ id, kind: 'terminal', title: tab.title, term: tab })
      continue
    }
    const chat = threads.byId(id)
    if (chat) out.push({ id, kind: 'chat', title: chatTitle(chat.title), thread: chat })
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

/** One tab strip per pane: each pane's own tabs, in order. */
const strips = computed(() => threads.panes.map(pane => ({ pane, tabs: tabs.value.filter(t => threads.groupOf(t.id) === pane.id) })))
const stripOf = (id: string) => strips.value.find(s => s.tabs.some(t => t.id === id))

/** A new chat in this pane (its strip's + button). */
function newChat(paneId: string) {
  if (!ws.activeProjectPath) return
  threads.focusPane(paneId)
  threads.create(ws.activeProjectPath)
}

/** A tab's tooltip: what it shows, who opened it, and its shortcut. */
/** "worktree", or "workspace" for a Unity VCS project. */
const wtTerm = (projectPath: string) => vcsTerms(ws.openProjects.find(p => p.path === projectPath)?.vcs).worktree

function tabTitle(tab: Tab, i: number) {
  const keys = i < 9 ? ` (${mod.value}+${i + 1})` : ''
  if (tab.kind === 'diff') return `${t('shell.tabs.changesIn', { file: tab.file })}${keys}`
  if (tab.kind === 'file') return `${tab.file}${keys}`
  if (tab.kind === 'commit') return `${t('shell.tabs.changesAt', { file: tab.file, commit: tab.short })}${keys}`
  if (tab.kind === 'decompiled') return `${tab.symbol}${keys}
${tab.assembly ? t('shell.tabs.decompiledFrom', { assembly: tab.assembly }) : t('shell.tabs.decompiledReadOnly')}`
  if (tab.kind === 'plugin' || tab.kind === 'panel') return `${tab.title}${tab.plugin ? `\n${t('shell.tabs.from', { plugin: tab.plugin })}` : ''}${keys}`
  if (tab.kind === 'terminal') {
    const where = [tab.term.shell, tab.term.cwd].filter(Boolean).join(' — ')
    return `${t('shell.tools.terminal')}${where ? ` — ${where}` : ''}${tab.term.exited ? ` ${t('shell.tabs.exited')}` : ''}${keys}`
  }
  if (tab.kind === 'browser') {
    const owner = threads.byId(tab.browser.threadId)
    const where = isBlank(tab.browser.url) ? t('shell.tabs.newTab') : tab.browser.url
    return `${where}${owner ? `\n${t('shell.tabs.openedBy', { title: owner.title })}` : ''}${keys}`
  }
  const wt = tab.kind === 'chat' ? tab.thread.worktree : null
  const term = tab.kind === 'chat' ? wtTerm(tab.thread.projectPath) : ''
  return `${tab.title}${keys}${wt ? `\n${term[0]!.toUpperCase()}${term.slice(1)}: ${wt}${tab.thread.branch ? ` (${tab.thread.branch})` : ''}` : ''}`
}

/*
 * A pane shows the active project's tabs, or a chat of another project put there on purpose
 * ("Open to the side"; it runs in its own project's folder). A diff, file, browser or terminal
 * of another project would have no tab to belong to: checked when the project changes and
 * whenever a pane gets something new.
 */
watch([() => ws.activeProjectPath, () => threads.panes.map(p => p.threadId).join('\n')], ([path]) => {
  if (!path) return
  let moved = false
  const emptied: string[] = []
  const free = (ids: string[]) => ids.find(x => !threads.panes.some(p => p.threadId === x)) ?? null
  for (const pane of threads.panes) {
    const owner = threads.projectOf(pane.threadId)
    // A chat of another project may stay: that is a split of two repos. Its tab sits in its pane's strip.
    if (owner && owner !== path && !threads.byId(pane.threadId)) {
      pane.threadId = null
      // Its own strip first (a project's tabs remember their pane), else any tab no pane shows.
      const next = free(threads.groupTabs(pane.id)) ?? free(threads.visibleTabs)
      if (next) { pane.threadId = next; threads._setGroup(next, pane.id) } else emptied.push(pane.id)
      moved = true
    }
  }
  // A split pane with nothing of this project to show closes.
  for (const id of emptied) if (threads.panes.length > 1) threads.closePane(id)
  if (threads.panes.length > 1 && threads.panes.every(p => !p.threadId)) threads.closePane('pane-b')
  // An empty area while the project has tabs (what it showed moved to another window): show one.
  const first = threads.panes[0]!
  if (!first.threadId && threads.panes.length === 1) {
    const next = tabs.value[0]?.id
    if (next) { first.threadId = next; moved = true }
  }
  if (moved) threads.persistLayout()
}, { immediate: true })

/*
 * Tabs grow in, collapse out and slide over when one is opened, closed or moved. Not on the first
 * render, and not on a project switch, which swaps the whole strip: that is a new set, not a change.
 */
const tabMotion = ref(false)
onMounted(() => requestAnimationFrame(() => (tabMotion.value = true)))
watch(() => ws.activeProjectPath, () => {
  tabMotion.value = false
  nextTick(() => requestAnimationFrame(() => (tabMotion.value = true)))
}, { flush: 'pre' })

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
/** A pane's width while split (its tab strip above it gets the same): its share, less half the 1px divider. */
const paneBasis = (i: number) => threads.isSplit ? { flexBasis: `calc(${(i === 0 ? split.value : 1 - split.value) * 100}% - 0.5px)` } : undefined

function onTabClick(id: string) {
  if (dragJustEnded()) return // the click that ends a drag is not a click
  threads.show(id)
}

/**
 * A terminal's tab can be dragged within the strip, into a pane, or back to the panel; a chat's within
 * the strip, into a pane, or out of the window into a window of its own.
 */
function onTabPress(e: PointerEvent, t: Tab) {
  if (t.kind === 'terminal') pressTerminalTab(e, t.term.id, 'editor')
  else if (t.kind === 'panel') pressPanelTab(e, t.ref, 'editor')
  else if (t.kind === 'chat') pressChatTab(e, t.id)
}
const isDragged = (t: Tab) => !!tabDrag.item && tabDrag.item.id === (t.kind === 'terminal' ? t.term.id : t.kind === 'panel' ? t.ref : t.kind === 'chat' ? t.id : null)

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

/**
 * Closing several at once never stacks "save?" questions: with autosave each file closes once it has
 * saved and one that cannot save stays open; without, files with unsaved edits stay open.
 */
function closeMany(ids: string[]) {
  for (const id of ids) {
    if (isFileTab(id) && files.isUnsaved(id)) {
      if (ws.editorAutoSave) void files.closeWhenSaved(id, false)
    } else {
      threads.closeTab(id)
    }
  }
}

/** A file's path on disk, in the style of the project's own path. */
function absolutePath(projectPath: string, file: string) {
  const sep = sepOf(projectPath)
  return withTrailingSep(projectPath) + (sep === '\\' ? file.replace(/\//g, '\\') : file)
}

const tabMenuItems = computed<MenuItem[]>(() => {
  const id = menuTabId.value
  // Close others, to the right, all: within the tab's own strip, as each pane's tabs are its own.
  const strip = id ? stripOf(id) : undefined
  const at = strip?.tabs.findIndex(t => t.id === id) ?? -1
  const tab = strip?.tabs[at]
  if (!strip || !tab) return []
  const ids = strip.tabs.map(t => t.id)
  const items: MenuItem[] = [
    { label: t('common.actions.close'), icon: X, kbd: ws.keyLabel('close-tab'), onSelect: () => threads.closeTab(tab.id) },
    { label: t('shell.tabs.closeOthers'), icon: XCircle, disabled: ids.length < 2, onSelect: () => closeMany(ids.filter(x => x !== tab.id)) },
    { label: t('shell.tabs.closeRight'), icon: ArrowRightToLine, disabled: at >= ids.length - 1, onSelect: () => closeMany(ids.slice(at + 1)) },
    { label: t('shell.tabs.closeAll'), icon: ListX, onSelect: () => closeMany(ids) },
  ]

  // Split: the tab moves into a new right pane, so something has to stay on the left.
  const other = threads.panes.find(p => p.id !== strip.pane.id)
  const splitItem: MenuItem = {
    label: other ? (other.id === 'pane-b' ? t('shell.tabs.toRight') : t('shell.tabs.toLeft')) : t('shell.tabs.splitRight'),
    icon: Columns2,
    divider: true,
    disabled: !other && ids.length < 2,
    onSelect: () => threads.showOnly(tab.id, other?.id ?? 'split'),
  }

  if (tab.kind === 'chat') {
    const busy = isBusy(tab.thread)
    items.push(
      splitItem,
      { ...win.moveChatAction(tab.id), icon: AppWindow },
      { label: t('shell.chat.markSettled'), icon: CircleCheck, divider: true, disabled: busy || tab.thread.status === 'done', onSelect: () => threads.setStatus(tab.id, 'done') },
      { label: t('shell.chat.archive'), icon: Archive, disabled: busy, hint: busy ? t('shell.chat.stillWorking') : undefined, onSelect: () => ws.confirmThen('archive', { title: t('shell.chat.archiveTitle'), body: t('shell.chat.archiveBody', { title: tab.thread.title }), label: t('shell.chat.archiveLabel') }, () => threads.archive(tab.id)) },
    )
    return items
  }

  if (tab.kind === 'terminal') {
    items.push(
      splitItem,
      { label: t('shell.tabs.toPanel'), icon: ArrowDownToLine, divider: true, onSelect: () => ws.moveTerminalToPanel(tab.term.id) },
    )
    return items
  }

  if (tab.kind === 'decompiled') {
    items.push(
      splitItem,
      { label: t('shell.tabs.copyType'), icon: Copy, divider: true, onSelect: () => void copyToClipboard(tab.symbol) },
    )
    return items
  }

  if (tab.kind === 'plugin') {
    items.push(splitItem)
    return items
  }

  if (tab.kind === 'commit') {
    items.push(
      splitItem,
      { label: t('shell.tabs.copyRelative'), icon: Route, divider: true, onSelect: () => void copyToClipboard(tab.file) },
    )
    return items
  }

  if (tab.kind === 'panel') {
    items.push(
      splitItem,
      { label: t('shell.tabs.toPanel'), icon: ArrowDownToLine, divider: true, onSelect: () => ws.movePanelTabToPanel(tab.ref) },
    )
    return items
  }

  if (tab.kind === 'browser') {
    const b = tab.browser
    const blank = isBlank(b.url)
    items.push(
      splitItem,
      { label: t('shell.tabs.reload'), icon: RotateCw, divider: true, disabled: blank, onSelect: () => void browsers.go(b.id, 'reload') },
      { label: t('shell.tabs.copyUrl'), icon: Copy, disabled: blank, onSelect: () => void copyToClipboard(b.url) },
      { label: t('shell.tabs.systemBrowser'), icon: ExternalLink, disabled: blank, onSelect: () => void openExternal(b.url).catch(() => {}) },
    )
    return items
  }

  const project = tab.kind === 'file' ? parseFileTab(tab.id)?.projectPath : parseDiffTab(tab.id)?.projectPath
  items.push(splitItem)
  if (tab.kind === 'file' && files.isPreview(tab.id)) {
    items.push({ label: t('shell.tabs.keepOpen'), icon: Pin, divider: true, onSelect: () => files.pin(tab.id) })
  }
  items.push(
    { label: t('shell.tabs.copyPath'), icon: Copy, divider: !(tab.kind === 'file' && files.isPreview(tab.id)), disabled: !project, onSelect: () => project && void copyToClipboard(absolutePath(project, tab.file)) },
    { label: t('shell.tabs.copyRelative'), icon: Route, onSelect: () => void copyToClipboard(tab.file) },
  )
  return items
})

/** A diff tab's file is relative to the repository, which the project may be a folder of. */
function inProjectPath(project: string, file: string) {
  const root = git.status(project)?.root
  if (!root) return file
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '')
  const [top, at] = [norm(root), norm(parseEnvPath(project)?.dir ?? project)]
  const prefix = at.startsWith(top + '/') ? at.slice(top.length + 1) + '/' : ''
  return prefix && file.startsWith(prefix) ? file.slice(prefix.length) : file
}

/** A file or diff tab's icon and tint: what the Files view gives that file. */
function lookOf(tab: { id: string, kind: string, file: string }) {
  const projectPath = tabProject(tab.id) ?? ''
  const path = tab.kind === 'diff' ? inProjectPath(projectPath, tab.file) : tab.file
  return fileLook({ projectPath, path, name: nameOf(path), isDir: false, open: false })
}
</script>

<template>
  <section class="ca">
    <!-- One tab strip per pane, each as wide as its pane, so a pane's tabs start at its own left edge. -->
    <div class="ca__tabs">
      <template v-for="(strip, si) in strips" :key="strip.pane.id">
        <div
          v-if="si > 0"
          class="ca__divider ca__divider--bar"
          role="separator"
          aria-orientation="vertical"
          :aria-label="t('shell.tabs.resizePanes')"
          @pointerdown="onDown"
          @pointermove="onMove"
          @pointerup="onUp"
          @dblclick="split = 0.5"
        />
        <div class="ca__group" :style="paneBasis(si)">
          <TransitionGroup
            tag="div"
            class="ca__strip"
            :name="tabMotion ? 'ca-tab' : 'ca-tab-still'"
            role="tablist"
            :aria-label="!threads.isSplit ? t('shell.tabs.open') : si === 0 ? t('shell.tabs.left') : t('shell.tabs.right')"
            data-tab-drop="strip"
            :data-pane-id="strip.pane.id"
          >
            <div
              v-for="(tab, i) in strip.tabs"
              :key="tab.id"
              class="ca__tab"
              :class="{
                'is-active': strip.pane.threadId === tab.id && threads.activePaneId === strip.pane.id,
                'is-shown': strip.pane.threadId === tab.id,
                'is-dragged': isDragged(tab),
              }"
              role="tab"
              tabindex="0"
              :data-tab-id="tab.id"
              :aria-selected="strip.pane.threadId === tab.id"
              :title="tabTitle(tab, i)"
              @click="onTabClick(tab.id)"
              @pointerdown="onTabPress($event, tab)"
              @keydown.enter.prevent="threads.show(tab.id)"
              @auxclick="onTabAux($event, tab.id)"
              @contextmenu.prevent="onTabContext($event, tab.id)"
              @dblclick="tab.kind === 'file' && files.pin(tab.id)"
            >
              <template v-if="tab.kind === 'chat'">
                <UiRipenessDot :status="tab.thread.archived ? 'archived' : tab.thread.status" :size="11" :unseen="hasUnreadResult(tab.thread) || (!tab.thread.archived && !tab.thread.seen && tab.thread.status === 'waiting')" />
                <span class="ca__tab-title">{{ tab.title }}</span>
                <FolderGit2 v-if="tab.thread.worktree" class="ca__tab-wt" :aria-label="tab.thread.branch ? t('shell.tabs.ownTermBranch', { term: wtTerm(tab.thread.projectPath), branch: tab.thread.branch }) : t('shell.tabs.ownTerm', { term: wtTerm(tab.thread.projectPath) })" />
              </template>
              <template v-else-if="tab.kind === 'diff'">
                <FileDiff class="ca__tab-icon" :style="{ color: lookOf(tab).tint ?? undefined }" aria-hidden="true" />
                <span class="ca__tab-title">{{ tab.title }}</span>
                <span v-if="tab.staged" class="ca__tab-note">{{ t('shell.tabs.staged') }}</span>
              </template>
              <template v-else-if="tab.kind === 'commit'">
                <GitCommitHorizontal class="ca__tab-icon" aria-hidden="true" />
                <span class="ca__tab-title">{{ tab.title }}</span>
              </template>
              <template v-else-if="tab.kind === 'decompiled'">
                <FileCode class="ca__tab-icon" aria-hidden="true" />
                <span class="ca__tab-title">{{ tab.title }}</span>
                <span class="ca__tab-note">{{ t('shell.tabs.decompiled') }}</span>
              </template>
              <template v-else-if="tab.kind === 'terminal'">
                <component :is="isEnvPath(tab.term.cwd) ? Server : SquareTerminal" class="ca__tab-icon" :class="{ 'is-exited': tab.term.exited }" aria-hidden="true" />
                <span class="ca__tab-title">{{ tab.title }}</span>
                <span v-if="tab.term.shell" class="ca__tab-note">{{ tab.term.shell }}</span>
              </template>
              <template v-else-if="tab.kind === 'plugin' || tab.kind === 'panel'">
                <PluginIcon :icon="tab.icon" class="ca__tab-icon" />
                <span class="ca__tab-title">{{ tab.title }}</span>
              </template>
              <template v-else-if="tab.kind === 'browser'">
                <span v-if="tab.browser.loading" class="ca__tab-spin" aria-hidden="true" />
                <Globe v-else class="ca__tab-icon" aria-hidden="true" />
                <span class="ca__tab-title">{{ tab.title }}</span>
                <span v-if="tab.browser.threadId" class="ca__tab-note">{{ t('shell.tabs.agent') }}</span>
              </template>
              <template v-else>
                <component :is="lookOf(tab).icon" class="ca__tab-icon" :style="{ color: lookOf(tab).tint ?? undefined }" aria-hidden="true" />
                <span class="ca__tab-title" :class="{ 'is-preview': files.isPreview(tab.id) }">{{ tab.title }}</span>
              </template>
              <button
                type="button"
                class="ca__tab-x"
                :class="{ 'is-dirty': files.showsUnsaved(tab.id) }"
                :aria-label="files.showsUnsaved(tab.id) ? t('shell.tabs.closeUnsaved', { title: tab.title }) : t('shell.tabs.closeTab', { title: tab.title })"
                @click.stop="threads.closeTab(tab.id)"
              ><X /><span v-if="files.showsUnsaved(tab.id)" class="ca__tab-dot" aria-hidden="true" /></button>
            </div>
            <UiIconButton v-if="win.spec.kind !== 'chat'" key="ca-plus" class="ca__plus" size="sm" :label="t('shell.chat.new')" :shortcut="ws.keyLabel('new-chat')" @click="newChat(strip.pane.id)"><Plus /></UiIconButton>
          </TransitionGroup>
          <div v-if="si === strips.length - 1" class="ca__tools">
            <UiIconButton size="sm" :label="t('shell.tabs.newBrowser')" :shortcut="ws.keyLabel('new-browser')" @click="browsers.openNew()"><Globe /></UiIconButton>
            <UiIconButton
              size="sm"
              :label="threads.isSplit ? t('shell.tabs.closeSplit') : t('shell.tabs.splitRight')"
              :shortcut="ws.keyLabel('split')"
              :active="threads.isSplit"
              @click="threads.isSplit ? threads.closePane('pane-b') : threads.split()"
            >
              <PanelRightClose v-if="threads.isSplit" />
              <Columns2 v-else />
            </UiIconButton>
          </div>
        </div>
      </template>
    </div>

    <UiMenu ref="tabMenu" class="ca__ctx" :items="tabMenuItems" :width="230" :label="t('shell.tabs.actions')" />

    <div ref="panesEl" class="ca__panes" :style="{ '--split': split }">
      <template v-for="(pane, i) in threads.panes" :key="pane.id">
        <div
          v-if="i > 0"
          class="ca__divider"
          role="separator"
          aria-orientation="vertical"
          :aria-label="t('shell.tabs.resizeChats')"
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
          :style="paneBasis(i)"
          data-tab-drop="pane"
          :data-pane-id="pane.id"
          @mousedown="threads.focusPane(pane.id)"
          @focusin="threads.focusPane(pane.id)"
        />
        <GitCommitDiffPane
          v-else-if="isCommitDiffTab(pane.threadId)"
          :tab-id="pane.threadId"
          :pane-id="pane.id"
          :split="threads.isSplit"
          :active="threads.activePaneId === pane.id"
          :style="paneBasis(i)"
          data-tab-drop="pane"
          :data-pane-id="pane.id"
          @mousedown="threads.focusPane(pane.id)"
          @focusin="threads.focusPane(pane.id)"
        />
        <TerminalPane
          v-else-if="isTerminalTab(pane.threadId)"
          :tab-id="pane.threadId"
          :pane-id="pane.id"
          :split="threads.isSplit"
          :active="threads.activePaneId === pane.id"
          :style="paneBasis(i)"
          data-tab-drop="pane"
          :data-pane-id="pane.id"
          @mousedown="threads.focusPane(pane.id)"
          @focusin="threads.focusPane(pane.id)"
        />
        <BrowserPane
          v-else-if="isBrowserTab(pane.threadId)"
          :tab-id="pane.threadId"
          :pane-id="pane.id"
          :split="threads.isSplit"
          :active="threads.activePaneId === pane.id"
          :style="paneBasis(i)"
          data-tab-drop="pane"
          :data-pane-id="pane.id"
          @mousedown="threads.focusPane(pane.id)"
          @focusin="threads.focusPane(pane.id)"
        />
        <PanelTabPane
          v-else-if="isPanelEditorTab(pane.threadId)"
          :tab-id="pane.threadId"
          :pane-id="pane.id"
          :split="threads.isSplit"
          :active="threads.activePaneId === pane.id"
          :style="paneBasis(i)"
          data-tab-drop="pane"
          :data-pane-id="pane.id"
          @mousedown="threads.focusPane(pane.id)"
          @focusin="threads.focusPane(pane.id)"
        />
        <PluginTabPane
          v-else-if="isPluginTab(pane.threadId)"
          :tab-id="pane.threadId"
          :pane-id="pane.id"
          :split="threads.isSplit"
          :active="threads.activePaneId === pane.id"
          :style="paneBasis(i)"
          data-tab-drop="pane"
          :data-pane-id="pane.id"
          @mousedown="threads.focusPane(pane.id)"
          @focusin="threads.focusPane(pane.id)"
        />
        <FilesDecompiledPane
          v-else-if="isDecompiledTab(pane.threadId)"
          :tab-id="pane.threadId"
          :pane-id="pane.id"
          :split="threads.isSplit"
          :active="threads.activePaneId === pane.id"
          :style="paneBasis(i)"
          data-tab-drop="pane"
          :data-pane-id="pane.id"
          @mousedown="threads.focusPane(pane.id)"
          @focusin="threads.focusPane(pane.id)"
        />
        <FilesEditorPane
          v-else-if="isFileTab(pane.threadId)"
          :tab-id="pane.threadId"
          :pane-id="pane.id"
          :split="threads.isSplit"
          :active="threads.activePaneId === pane.id"
          :style="paneBasis(i)"
          data-tab-drop="pane"
          :data-pane-id="pane.id"
          @mousedown="threads.focusPane(pane.id)"
          @focusin="threads.focusPane(pane.id)"
        />
        <ChatPane
          v-else
          :pane="pane"
          :split="threads.isSplit"
          :active="threads.activePaneId === pane.id"
          :style="paneBasis(i)"
          data-tab-drop="pane"
          :data-pane-id="pane.id"
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
  border-bottom: 1px solid var(--line);
  background: var(--bg-app);
  flex: none;
}
/* A pane's tab strip: as wide as the pane under it (paneBasis), so the two line up at the divider. */
.ca__group { flex: 1 1 0; min-width: 0; display: flex; align-items: stretch; }
.ca__strip {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 2px;
  overflow-x: auto;
  scrollbar-width: none;
  padding-left: var(--space-2);
}
.ca__strip::-webkit-scrollbar { display: none; }
/* Tabs are flat pills: the active one is lifted onto the raised ground and ringed in mango. */
.ca__tab {
  position: relative;
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  max-width: 220px;
  height: 28px;
  padding: 0 6px 0 var(--space-3);
  border: 0;
  border-radius: var(--radius-md);
  font-size: var(--text-sm);
  color: var(--fg-subtle);
  cursor: pointer;
  flex: 0 1 auto;
  transition: color var(--dur-fast) var(--ease-out), background var(--dur-fast) var(--ease-out);
}
.ca__tab:hover { color: var(--fg-muted); background: var(--bg-hover); }
/* Opening and closing: the width (and so the neighbours' place) follows max-width; reordering slides by transform. */
.ca-tab-enter-active, .ca-tab-leave-active {
  overflow: hidden;
  transition:
    max-width var(--dur-med) var(--ease-out),
    padding var(--dur-med) var(--ease-out),
    margin var(--dur-med) var(--ease-out),
    opacity var(--dur-fast) var(--ease-out);
}
.ca-tab-leave-active { pointer-events: none; }
/* margin-right cancels the strip's 2px gap, so a closing tab leaves no step behind. */
.ca-tab-enter-from, .ca-tab-leave-to { max-width: 0; padding-left: 0; padding-right: 0; margin-right: -2px; opacity: 0; }
.ca-tab-move { transition: transform var(--dur-med) var(--ease-out); }
.ca__tab:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: -1px; }
/* Shown in the other split pane: a quiet ring, no fill. */
.ca__tab.is-shown { color: var(--fg-muted); box-shadow: inset 0 0 0 1px var(--line); }
.ca__tab.is-active { color: var(--fg); background: var(--bg-canvas); box-shadow: inset 0 0 0 1px var(--line); }
.ca__tab-icon { width: 14px; height: 14px; flex: none; stroke-width: 1.75; color: var(--fg-subtle); }
.ca__tab-icon.is-exited { color: var(--fg-faint); }
/* A terminal's tab while it is dragged: it stays put, faded, until it is dropped. */
.ca__tab.is-dragged { opacity: 0.45; }
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
/* The close button always takes its room (every tab keeps its width) but shows on hover and on the active tab. */
.ca__tab-x {
  display: grid;
  place-items: center;
  width: 18px;
  height: 18px;
  border-radius: var(--radius-xs);
  color: var(--fg-subtle);
  opacity: 0;
  flex: none;
  transition: opacity var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out), background var(--dur-fast) var(--ease-out);
}
.ca__tab-x svg { width: 12px; height: 12px; }
.ca__tab:hover .ca__tab-x, .ca__tab.is-active .ca__tab-x, .ca__tab-x:focus-visible, .ca__tab-x.is-dirty { opacity: 1; }
.ca__tab-x:hover { background: var(--bg-active); color: var(--fg); }
/* Unsaved edits: a dot in place of the close button, which comes back on hover. */
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
/* The divider carries on through the tab bar, as one line from the top of the strips to the bottom of the panes. */
.ca__divider--bar { margin-bottom: -1px; z-index: 1; }
</style>
