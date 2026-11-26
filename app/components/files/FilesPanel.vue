<script setup lang="ts">
import {
  ChevronRight, ChevronsDownUp, Copy, CopyPlus, EllipsisVertical, FilePlus, FileX, Folder, FolderOpen, FolderPlus, FolderSearch, FolderX,
  LocateFixed, Pencil, RefreshCw, SquareTerminal, Trash2, Undo2,
} from 'lucide-vue-next'
import { companionSuffixes, fileFilters, fileLook, hiddenRule, type FileLook } from '~/plugin-host/fileHooks'
import { useWorkspace } from '~/stores/workspace'
import { useThreads } from '~/stores/threads'
import { useFiles } from '~/stores/files'
import { useGit } from '~/stores/git'
import { parseFileTab } from '~/utils/fileTabs'
import { parseEnvPath } from '~/utils/envPath'
import { sepOf, withTrailingSep } from '~/utils/paths'
import { copyText } from '~/utils/clipboard'
import { nameOf, parentOf } from '~/utils/fileOps'
import { fileManager, useFileActions, type NameEdit } from '~/composables/useFileActions'
import { companionChange, excludedPathsOf, layoutTree, siblingLookup, type FilesView, type TreeEntry, type TreeNote } from '~/utils/fileTree'
import type { MenuItem } from '~/types/ui'
import { pluginMenuItems } from '~/plugin-host/menus'

/**
 * The Files tool window on the right: the active project's folders as a tree,
 * read as it opens (each folder with the next level ahead, see stores/files.ts).
 * A file the pointer rests on, or the keyboard moves to, is read ahead so it opens at once. A click previews a file in the main
 * pane, a double-click (or Enter) keeps its tab. Names carry the same git
 * status colours and letters as the Changes view. A right-click (or F2, Delete)
 * creates, renames and deletes (composables/useFileActions.ts). View options (what shows, in
 * which order) are prefs; what a row is, is worked out in utils/fileTree.ts.
 */

const { t } = useI18n()
const ws = useWorkspace()
const threads = useThreads()
const files = useFiles()
const git = useGit()

/** The working copy in view: the active chat's worktree, or the project. */
const path = computed(() => threads.workdir ?? ws.activeProjectPath)

const tree = computed(() => files.tree(path.value))

watch(path, (p) => { if (p) files.ensureTree(p) }, { immediate: true })

/* ---------- git decoration ---------- */

type Kind = 'modified' | 'added' | 'untracked' | 'conflict'
const kindWord = (kind: Kind) => t(`files.kind.${kind}`)
/** The same letters as the Changes view (GitFileRow). */
const KIND_LETTER: Record<Kind, string> = { modified: 'M', added: 'A', untracked: '?', conflict: 'U' }
const RANK: Record<Kind, number> = { modified: 1, added: 2, untracked: 2, conflict: 3 }

const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '')

/** Changed files by path relative to the project, and folders that hold changes. */
const decorations = computed(() => {
  const fileKinds = new Map<string, Kind>()
  const dirKinds = new Map<string, Kind>()
  const status = git.status(path.value)
  if (!status?.isRepo || !status.root || !path.value) return { fileKinds, dirKinds }
  // A remote project's git root is a folder inside its instance: compare the folders there.
  const folder = (p: string) => norm(parseEnvPath(p)?.dir ?? p)
  const root = folder(status.root)
  const project = folder(path.value)
  // The project may be a folder inside the repository.
  const prefix = project === root ? '' : project.startsWith(`${root}/`) ? `${project.slice(root.length + 1)}/` : null
  if (prefix === null) return { fileKinds, dirKinds }
  for (const f of status.files) {
    if (!f.path.startsWith(prefix)) continue
    const code = f.worktree ?? f.index
    if (code === 'D') continue // not on disk, so not in the tree
    const kind: Kind = f.conflicted ? 'conflict' : code === '?' ? 'untracked' : f.index === 'A' ? 'added' : 'modified'
    const rel = f.path.slice(prefix.length).replace(/\/+$/, '')
    fileKinds.set(rel, kind)
    const parts = rel.split('/')
    for (let i = 1; i < parts.length; i++) {
      const dir = parts.slice(0, i).join('/')
      const had = dirKinds.get(dir)
      if (!had || RANK[kind] > RANK[had]) dirKinds.set(dir, kind)
    }
  }
  return { fileKinds, dirKinds }
})

/* ---------- visible rows ---------- */

/** `via`: the hidden companion whose change the row shows. */
type EntryRow = TreeEntry & { kind: Kind | null, via: string | null }
/** The field a name is typed in: in place of the row being renamed, or first inside the folder it is for. */
interface NameRow { type: 'name'; key: string; depth: number; edit: NameEdit; initial: string; prefix: string }
type Row = EntryRow | TreeNote | NameRow

const actions = useFileActions(path, focusPath)
const editing = actions.edit

/** The project's own exclusions; a worktree of it has the same ones. */
const marks = computed(() => excludedPathsOf(ws.activeProjectPath ? ws.projectPrefs[ws.activeProjectPath]?.excluded : null))

/* Apart from the git marks, so a status change does not sort the tree again. */
const layout = computed(() => {
  const now = tree.value
  if (!now) return null
  const hidden = path.value ? hiddenRule(path.value, ws.filesView.shown) : null
  return layoutTree({ dirs: now.dirs, expanded: now.expanded, view: ws.filesView, marks: marks.value, keep: now.revealed?.file ?? null, hidden })
})

/* Apart from the git marks too: plugins are asked once per row, not on every status refresh. */
const looks = computed(() => {
  const out = new Map<string, FileLook>()
  const project = path.value
  if (!project || !tree.value || !layout.value) return out
  const siblings = siblingLookup(tree.value.dirs)
  for (const r of layout.value.rows) {
    if (r.type !== 'entry') continue
    const { path: rel, name, isDir } = r.entry
    out.set(r.key, fileLook({ projectPath: project, path: rel, name, isDir, open: r.open, hasSibling: siblings(parentOf(rel)) }))
  }
  return out
})
watch(layout, (l) => {
  if (!l || !path.value) return
  files.treeOf(path.value).chained = l.chained
  for (const dir of l.unread) void files.loadDir(path.value, dir)
}, { immediate: true })

const rows = computed<Row[]>(() => {
  const { fileKinds, dirKinds } = decorations.value
  const all = layout.value?.rows ?? []
  const visible = new Set(all.flatMap(r => (r.type === 'entry' ? r.chain : [])))
  const out: Row[] = all.map((r) => {
    if (r.type === 'note') return r
    let kind = (r.entry.isDir ? dirKinds.get(r.key) : fileKinds.get(r.key)) ?? null
    let via: string | null = null
    if (path.value && fileKinds.size) {
      for (const rel of r.chain) {
        const change = companionChange(kind, rel, companionSuffixes(path.value, rel, r.entry.isDir), fileKinds, visible)
        if (change) {
          kind = change.kind
          via = change.suffix
        }
      }
    }
    return { ...r, kind, via }
  })
  const e = editing.value
  if (!e) return out
  const key = `name:${e.id}`
  if (e.mode === 'rename') {
    const at = out.findIndex(r => r.type === 'entry' && r.entry.path === e.path)
    const row = out[at] as EntryRow | undefined
    if (!row) return out
    const initial = nameOf(e.path)
    out[at] = { type: 'name', key, depth: row.depth, edit: e, initial, prefix: row.label.slice(0, row.label.length - initial.length) }
    return out
  }
  // An empty folder's note makes room for the name that will fill it.
  const list = out.filter(r => !(r.type === 'note' && (r.key === `empty:${e.dir}` || r.key === `hidden:${e.dir}`)))
  const at = e.dir ? list.findIndex(r => r.type === 'entry' && r.chain.includes(e.dir)) : -1
  if (e.dir && at < 0) return list
  list.splice(at + 1, 0, { type: 'name', key, depth: e.dir ? list[at]!.depth + 1 : 0, edit: e, initial: '', prefix: '' })
  return list
})
/* The entry being renamed (or the folder being filled) left the tree: nothing to name. */
watch(rows, (all) => {
  const e = editing.value
  if (e && !e.busy && e.mode === 'rename' && !all.some(r => r.type === 'name')) editing.value = null
})

const top = computed(() => tree.value?.dirs[''] ?? null)

/** Files shown in a pane right now, to mark their rows. */
const shownFiles = computed(() => new Set(threads.panes.map(p => parseFileTab(p.threadId)).filter(p => p && p.projectPath === path.value).map(p => p!.file)))
const currentFile = computed(() => {
  const p = parseFileTab(threads.activePane.threadId)
  return p && p.projectPath === path.value ? p.file : null
})

/* ---------- actions ---------- */

/**
 * The folder the user just opened: its rows fade in as they appear (at once, or when the folder has
 * been read). Only an expand by hand sets it, so loading, refreshes and the watcher never animate.
 */
const revealing = ref<string | null>(null)
const isRevealed = (row: Row) => !!revealing.value && row.type === 'entry' && row.key.startsWith(`${revealing.value}/`)
function expand(row: EntryRow, open: boolean) {
  if (!path.value) return
  revealing.value = open ? row.key : null
  for (const dir of row.chain) files.toggleDir(path.value, dir, open)
}
/** The reveal has played: rows that turn up later (a refresh) just appear. */
function onAnimationEnd(e: AnimationEvent) {
  if ((e.target as HTMLElement).classList?.contains('is-revealed')) revealing.value = null
}
watch(path, () => (revealing.value = null))

function activate(row: Row, pin: boolean) {
  if (row.type !== 'entry' || !path.value || files.isDeleting(path.value, row.entry.path)) return
  select(row.key)
  if (row.entry.isDir) expand(row, !row.open)
  else void files.openFile(path.value, row.entry.path, pin)
}

function select(p: string) {
  if (path.value) files.treeOf(path.value).selected = p
}

/* ---------- reading a file ahead of the click ---------- */

/** How long the pointer rests on a file (or the keyboard stays on it) before it is read ahead. */
const PRELOAD_DELAY = 200
let preloadTimer: ReturnType<typeof setTimeout> | undefined

function preloadSoon(row: Row) {
  clearTimeout(preloadTimer)
  if (row.type !== 'entry' || row.entry.isDir || !path.value) return
  const [at, file] = [path.value, row.entry.path]
  preloadTimer = setTimeout(() => files.preload(at, file), PRELOAD_DELAY)
}
function preloadCancel() {
  clearTimeout(preloadTimer)
}
onBeforeUnmount(preloadCancel)

const spun = ref(false)
async function manualRefresh() {
  if (!path.value) return
  spun.value = true
  await Promise.all([files.refresh(path.value), git.refresh(path.value).catch(() => {})])
  spun.value = false
}

/* ---------- keyboard: a tree with one tab stop ---------- */

const list = ref<HTMLElement | null>(null)
const entryRows = computed(() => rows.value.filter((r): r is EntryRow => r.type === 'entry'))
/** The row that takes Tab focus: the selected one, else the first. */
const focusKey = computed(() => {
  const sel = tree.value?.selected
  return entryRows.value.some(r => r.key === sel) ? sel : entryRows.value[0]?.key ?? null
})

function focusRow(key: string) {
  select(key)
  const row = entryRows.value.find(r => r.key === key)
  if (row) preloadSoon(row)
  nextTick(() => list.value?.querySelector<HTMLElement>(`[data-path="${CSS.escape(key)}"]`)?.focus())
}

/** Focus the row showing `rel`: its own, or the one it shares with other folders. */
function focusPath(rel: string) {
  const row = entryRows.value.find(r => r.chain.includes(rel))
  if (row) focusRow(row.key)
  else if (!rel && focusKey.value) focusRow(focusKey.value)
}

const isMac = /Mac|iPhone|iPad/.test(navigator.platform)

function onKey(e: KeyboardEvent) {
  const all = entryRows.value
  // The row with focus. The selected one can be another: "Select open file" moves it without the focus.
  const key = (e.target as HTMLElement).closest<HTMLElement>('[data-path]')?.dataset.path
  const i = all.findIndex(r => r.key === key)
  const row = all[i]
  if (!row || !path.value) return
  switch (e.key) {
    case 'ArrowDown': e.preventDefault(); if (all[i + 1]) focusRow(all[i + 1]!.key); break
    case 'ArrowUp': e.preventDefault(); if (i > 0) focusRow(all[i - 1]!.key); break
    case 'Home': e.preventDefault(); if (all[0]) focusRow(all[0].key); break
    case 'End': e.preventDefault(); if (all.length) focusRow(all[all.length - 1]!.key); break
    case 'ArrowRight':
      e.preventDefault()
      if (row.entry.isDir && !row.open) expand(row, true)
      else if (row.entry.isDir && all[i + 1]?.parent === row.key) focusRow(all[i + 1]!.key)
      break
    case 'ArrowLeft':
      e.preventDefault()
      if (row.entry.isDir && row.open) expand(row, false)
      else if (row.parent) focusRow(row.parent)
      break
    case 'F2': e.preventDefault(); startRename(row); break
    case 'Delete': e.preventDefault(); if (!e.repeat) askDelete(row); break
    case 'Backspace': if (isMac && e.metaKey && !e.repeat) { e.preventDefault(); askDelete(row) } break
    case 'Enter': e.preventDefault(); activate(row, true); break
    case ' ': e.preventDefault(); activate(row, false); break
  }
}

/* ---------- showing the open file ---------- */

function locate() {
  if (path.value && currentFile.value) void files.reveal(path.value, currentFile.value)
}
watch([path, currentFile, () => ws.filesView.follow], () => {
  if (ws.filesView.follow) locate()
}, { immediate: true })

/* A file asked for (here or with "Show in Files") is brought into view, also when the tree only now appears. */
watch([() => tree.value?.revealed, list], ([revealed, el]) => {
  if (revealed && el) el.querySelector(`[data-path="${CSS.escape(revealed.file)}"]`)?.scrollIntoView({ block: 'nearest' })
}, { flush: 'post', immediate: true })

/* ---------- view options ---------- */

const optionsButton = ref<{ $el: HTMLElement } | null>(null)

function setView(patch: Partial<FilesView>) {
  revealing.value = null
  // Hiding is meant: a file that was only showing because it was asked for goes too.
  if (path.value && (patch.excluded === false || patch.dotfiles === false)) files.treeOf(path.value).revealed = null
  ws.setFilesView(patch)
  nextTick(() => optionsButton.value?.$el.focus())
}

function setFilterShown(id: string, shown: boolean) {
  revealing.value = null
  ws.setFileFilterShown(id, shown)
  nextTick(() => optionsButton.value?.$el.focus())
}

const viewItems = computed<MenuItem[]>(() => {
  const v = ws.filesView
  const extra: MenuItem[] = (path.value ? fileFilters(path.value) : []).map((f) => {
    const on = v.shown.includes(f.fullId)
    return { label: f.label, hint: f.hint, check: 'checkbox', checked: on, onSelect: () => setFilterShown(f.fullId, !on) }
  })
  return [
    { group: t('files.view.show'), label: t('files.view.excluded'), hint: t('files.view.excludedHint'), check: 'checkbox', checked: v.excluded, onSelect: () => setView({ excluded: !v.excluded }) },
    { label: t('files.view.dotfiles'), check: 'checkbox', checked: v.dotfiles, onSelect: () => setView({ dotfiles: !v.dotfiles }) },
    ...extra,
    { label: t('files.view.compact'), check: 'checkbox', checked: v.compact, onSelect: () => setView({ compact: !v.compact }) },
    { divider: true, group: t('files.view.sortBy'), label: t('files.view.name'), check: 'radio', checked: v.sort === 'name', onSelect: () => setView({ sort: 'name' }) },
    { label: t('files.view.type'), check: 'radio', checked: v.sort === 'type', onSelect: () => setView({ sort: 'type' }) },
    { divider: true, label: t('files.view.foldersFirst'), check: 'checkbox', checked: v.foldersFirst, onSelect: () => setView({ foldersFirst: !v.foldersFirst }) },
    { label: t('files.view.follow'), check: 'checkbox', checked: v.follow, onSelect: () => setView({ follow: !v.follow }) },
  ]
})
const filtering = computed(() => !ws.filesView.excluded || !ws.filesView.dotfiles)
/** Plugins' filters hide some by default: said in the label, without the tint of a changed view. */
const hidesSome = computed(() => filtering.value || (!!path.value && fileFilters(path.value).some(f => !ws.filesView.shown.includes(f.fullId))))

/* ---------- a row's menu: Mango's items, then plugins' (`ui.menus` 'file') ---------- */

const rowMenu = ref<{ showAt: (x: number, y: number) => void; close: () => void } | null>(null)
/* The folder in view changed (a chat moved to its worktree): the menu's paths would mean other files. */
watch(path, () => rowMenu.value?.close())
/** The row the menu is for; null is the project folder itself. */
const menuRow = ref<EntryRow | null>(null)

function startRename(row: EntryRow) {
  if (path.value && !files.isDeleting(path.value, row.entry.path)) actions.startRename(row.entry)
}

function askDelete(row: EntryRow) {
  if (!path.value || files.isDeleting(path.value, row.entry.path)) return
  const at = entryRows.value.findIndex(r => r.key === row.key)
  actions.askDelete(row.entry, () => {
    // Unless the user is somewhere else by now, focus goes to the row that took its place.
    const active = document.activeElement
    if (active && active !== document.body && !list.value?.contains(active)) return
    const all = entryRows.value
    const next = all[Math.min(Math.max(at, 0), all.length - 1)]
    if (next) focusRow(next.key)
  }, () => { deleteFrom = row.key })
}

/* A question answered with Cancel gives the row its focus back. */
let deleteFrom: string | null = null
watch(() => ws.confirm, (ask) => {
  if (ask || !deleteFrom) return
  const key = deleteFrom
  deleteFrom = null
  nextTick(() => {
    if (entryRows.value.some(r => r.key === key)) focusRow(key)
  })
})

/** Focus goes back to the row, or to the one that took its place when it is gone. */
function keepFocus(key: string, act: () => void) {
  const at = entryRows.value.findIndex(r => r.key === key)
  act()
  nextTick(() => {
    const all = entryRows.value
    const next = all.find(r => r.key === key) ?? all[Math.min(Math.max(at, 0), all.length - 1)]
    if (next) focusRow(next.key)
  })
}

function setExcluded(rel: string, on: boolean) {
  const project = ws.activeProjectPath
  if (!project || !path.value) return
  const next = marks.value.filter(p => p !== rel)
  if (on) next.push(rel)
  files.treeOf(path.value).revealed = null
  ws.setProjectPref(project, { excluded: next.length ? next : null })
}

async function copyPath(text: string) {
  if (!(await copyText(text))) ws.notify(t('files.menu.copyFailed'), text)
}

const rowMenuItems = computed<MenuItem[]>(() => {
  const r = menuRow.value
  const project = path.value
  if (!project) return []
  // New entries and terminals go into a folder itself, or the folder a file is in.
  const dir = !r ? '' : r.entry.isDir ? r.entry.path : parentOf(r.entry.path)
  const here: MenuItem[] = [
    { label: t('files.menu.newFile'), icon: FilePlus, onSelect: () => actions.startNew('file', dir) },
    { label: t('files.menu.newFolder'), icon: FolderPlus, onSelect: () => actions.startNew('folder', dir) },
  ]
  const elsewhere: MenuItem[] = []
  if (!parseEnvPath(project)) {
    elsewhere.push({ label: t(`files.showIn.${fileManager()}`), icon: FolderSearch, onSelect: () => void actions.showInFileManager(r?.entry.path ?? '') })
  }
  elsewhere.push({ label: t('files.menu.terminal'), icon: SquareTerminal, onSelect: () => actions.openTerminal(dir) })
  elsewhere[0] = { ...elsewhere[0]!, divider: true }
  if (!r) {
    const env = parseEnvPath(project)
    return [...here, ...elsewhere, { divider: true, label: t('files.menu.copyPath'), icon: Copy, onSelect: () => void copyPath(env?.dir ?? project) }]
  }
  const { path: rel, isDir } = r.entry
  if (files.isDeleting(project, rel)) return [{ label: t('files.menu.deleting'), disabled: true }]
  const change: MenuItem[] = [{ divider: true, label: t('common.actions.rename'), icon: Pencil, kbd: 'F2', onSelect: () => startRename(r) }]
  if (!isDir) change.push({ label: t('files.menu.duplicate'), icon: CopyPlus, onSelect: () => void actions.duplicate(r.entry) })
  const sep = sepOf(project)
  const local = sep === '\\' ? rel.replace(/\//g, '\\') : rel
  const abs = withTrailingSep(project) + local
  // A remote project's path is the one inside its environment.
  const env = parseEnvPath(project)
  const copied = env ? withTrailingSep(env.dir) + rel : abs
  const items: MenuItem[] = [
    ...here,
    ...change,
    ...elsewhere,
    { divider: true, label: t('files.menu.copyPath'), icon: Copy, onSelect: () => keepFocus(r.key, () => void copyPath(copied)) },
    { label: t('files.menu.copyRelative'), icon: Copy, onSelect: () => keepFocus(r.key, () => void copyPath(rel)) },
  ]
  if (r.marked) items.push({ divider: true, label: t('files.menu.include'), icon: Undo2, onSelect: () => keepFocus(r.key, () => setExcluded(rel, false)) })
  // What git ignores, or a folder above excludes, is excluded already.
  else if (!r.excluded) items.push({ divider: true, label: t('files.menu.exclude'), icon: isDir ? FolderX : FileX, onSelect: () => keepFocus(r.key, () => setExcluded(rel, true)) })
  return [
    ...items,
    ...pluginMenuItems('file', { path: abs, projectPath: project, isDir }),
    { divider: true, label: t('common.actions.delete'), icon: Trash2, danger: true, kbd: isMac ? '⌘⌫' : 'Del', onSelect: () => askDelete(r) },
  ]
})

/** An empty folder's note stands for that folder. */
function noteFolder(note: TreeNote): EntryRow | null {
  const dir = note.key.slice(note.key.indexOf(':') + 1)
  return entryRows.value.find(r => r.chain.includes(dir)) ?? null
}

/** The menu of a row, or with none (the header, the space around the rows) the project folder's. */
function openMenu(row: EntryRow | null, e: MouseEvent) {
  if (!path.value) return
  menuRow.value = row
  if (row) select(row.key)
  e.preventDefault()
  rowMenu.value?.showAt(e.clientX, e.clientY)
}

/* ---------- icons ---------- */

function iconFor({ key, entry, open, marked }: EntryRow) {
  if (marked) return entry.isDir ? FolderX : FileX
  return looks.value.get(key)?.icon ?? (entry.isDir && open ? FolderOpen : Folder)
}
/** A file's type tint; excluded entries, and folders no plugin tints, keep the plain ink. */
function tintFor({ key, excluded }: EntryRow) {
  const tint = excluded ? null : looks.value.get(key)?.tint
  return tint ? { color: tint } : undefined
}
/** What a row's change is, in words. */
function changeWord(row: EntryRow) {
  if (!row.kind) return null
  if (row.via) return t('files.tree.itsFile', { suffix: row.via, change: kindWord(row.kind) })
  return row.entry.isDir ? t('files.tree.containsChanges') : kindWord(row.kind)
}
function titleFor(row: EntryRow) {
  const about = [
    row.entry.path,
    changeWord(row),
    looks.value.get(row.key)?.note,
    row.marked ? t('files.tree.excludedByYou') : row.entry.ignored ? t('files.tree.ignored') : row.excluded && t('files.tree.inExcluded'),
  ]
  return about.filter(Boolean).join(' · ')
}
</script>

<template>
  <!-- Shown in the tool window on the right (see AppToolPanel), which owns width and resizing. -->
  <section class="fp" :aria-label="t('files.tree.title')">
    <header class="fp__head">
      <h2 class="fp__title" :title="path ?? undefined" @contextmenu="openMenu(null, $event)">{{ ws.activeProject?.name ?? t('files.tree.title') }}</h2>
      <div v-if="path" class="fp__tools">
        <UiIconButton :label="t('files.tree.selectOpen')" :disabled="!currentFile" @click="locate"><LocateFixed /></UiIconButton>
        <UiIconButton :label="t('files.tree.collapse')" :disabled="!tree?.expanded.length" @click="files.collapseAll(path)"><ChevronsDownUp /></UiIconButton>
        <UiIconButton :label="t('common.actions.refresh')" :class="{ 'is-spun': spun }" @click="manualRefresh"><RefreshCw /></UiIconButton>
        <UiMenu v-slot="{ open, toggle }" :items="viewItems" placement="bottom-end" :width="248" :label="t('files.view.label')">
          <UiIconButton
            ref="optionsButton"
            :label="hidesSome ? t('files.view.labelHidden') : t('files.view.label')"
            :class="{ 'is-filtering': filtering }"
            aria-haspopup="menu"
            :aria-expanded="open"
            @click="toggle"
          ><EllipsisVertical /></UiIconButton>
        </UiMenu>
      </div>
    </header>

    <div v-if="!path" class="fp__quiet">{{ t('files.tree.noProject') }}</div>
    <div v-else-if="top?.error" class="fp__quiet" role="alert">
      <p class="fp__quiet-title">{{ t('files.tree.unreadable') }}</p>
      <p class="selectable">{{ top.error }}</p>
      <UiButton size="sm" @click="files.loadDir(path, '')">{{ t('common.actions.retry') }}</UiButton>
    </div>
    <div v-else-if="!top?.entries" class="fp__skeleton" aria-busy="true" :aria-label="t('files.tree.reading')">
      <span v-for="w in [58, 46, 70, 52, 38, 64, 44, 56]" :key="w" :style="{ width: `${w}%` }" />
    </div>
    <div v-else-if="!top.entries.length && !editing" class="fp__quiet fp__quiet--fill" @contextmenu="openMenu(null, $event)">
      <p>{{ t('files.tree.emptyProject') }}</p>
      <UiButton size="sm" @click="actions.startNew('file', '')"><FilePlus />{{ t('files.menu.newFile') }}</UiButton>
    </div>

    <div
      v-else
      ref="list"
      class="fp__scroll"
      role="tree"
      :aria-label="t('files.tree.label')"
      @keydown="onKey"
      @animationend="onAnimationEnd"
      @contextmenu.self="openMenu(null, $event)"
    >
      <template v-for="row in rows" :key="row.key">
        <div
          v-if="row.type === 'entry'"
          class="fp__row"
          :class="[
            row.kind ? `fp--${row.kind}` : '',
            {
              'is-dir': row.entry.isDir,
              'is-excluded': row.excluded,
              'is-selected': tree?.selected === row.key,
              'is-shown': shownFiles.has(row.key),
              'is-current': currentFile === row.key,
              'is-revealed': isRevealed(row),
              'is-deleting': !!path && files.isDeleting(path, row.entry.path),
            },
          ]"
          :style="{ '--depth': row.depth }"
          role="treeitem"
          :aria-level="row.depth + 1"
          :aria-expanded="row.entry.isDir ? row.open : undefined"
          :aria-selected="tree?.selected === row.key"
          :tabindex="focusKey === row.key ? 0 : -1"
          :data-path="row.key"
          :title="titleFor(row)"
          :aria-busy="(!!path && files.isDeleting(path, row.entry.path)) || undefined"
          @click="activate(row, false)"
          @pointerenter="preloadSoon(row)"
          @pointerleave="preloadCancel"
          @dblclick="!row.entry.isDir && activate(row, true)"
          @contextmenu="openMenu(row, $event)"
        >
          <ChevronRight v-if="row.entry.isDir" class="fp__caret" :class="{ 'is-open': row.open }" aria-hidden="true" />
          <span v-else class="fp__caret" aria-hidden="true" />
          <component :is="iconFor(row)" class="fp__icon" :style="tintFor(row)" aria-hidden="true" />
          <span class="fp__name">{{ row.label }}</span>
          <span v-if="row.kind && row.entry.isDir" class="fp__dot" aria-hidden="true" />
          <span v-else-if="row.kind" class="fp__letter" aria-hidden="true">{{ KIND_LETTER[row.kind] }}</span>
          <span v-if="row.kind" class="sr-only">, {{ changeWord(row) }}</span>
          <span v-if="looks.get(row.key)?.note" class="sr-only">, {{ looks.get(row.key)?.note }}</span>
          <span v-if="row.excluded" class="sr-only">, {{ t('files.tree.excluded') }}</span>
        </div>
        <FilesNameRow
          v-else-if="row.type === 'name'"
          :project="path"
          :dir="row.edit.dir"
          :initial="row.initial"
          :is-dir="row.edit.isDir"
          :depth="row.depth"
          :prefix="row.prefix"
          :label="row.edit.mode === 'rename' ? t('files.tree.newNameFor', { name: row.initial }) : row.edit.mode === 'folder' ? t('files.tree.folderName') : t('files.tree.fileName')"
          :error="row.edit.error"
          :busy="row.edit.busy"
          @commit="actions.commit"
          @cancel="actions.cancel"
          @edit="actions.clearError"
        />
        <div v-else class="fp__note" :class="{ 'is-error': row.error }" :style="{ '--depth': row.depth }" role="none" @contextmenu="openMenu(noteFolder(row), $event)">{{ row.text }}</div>
      </template>
    </div>
    <UiMenu ref="rowMenu" class="fp__ctx" :items="rowMenuItems" :width="232" :max-height="560" :label="t('files.menu.label')" />
  </section>
</template>

<style scoped>
.fp {
  position: relative;
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}

.fp__head {
  flex: none;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  height: var(--tabbar-h);
  border-bottom: 1px solid var(--line);
  padding: 0 var(--space-2) 0 var(--space-3);
}
.fp__title {
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
.fp__tools { flex: none; display: flex; align-items: center; gap: 2px; }
.fp__tools .is-filtering { color: var(--accent-ink); }
.is-spun :deep(svg) { animation: fp-spin 0.45s var(--ease-out); }
@keyframes fp-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .is-spun :deep(svg) { animation: none; } }

.fp__scroll {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: var(--space-1) var(--space-2) var(--space-3) var(--space-2);
  border-top: 1px solid var(--line-soft);
}

.fp__row {
  display: flex;
  align-items: center;
  gap: 5px;
  height: 26px;
  padding: 0 6px 0 calc(4px + var(--depth) * 14px);
  border-radius: var(--radius-sm);
  font-size: var(--text-sm);
  color: var(--fg-muted);
  cursor: pointer;
  white-space: nowrap;
  transition: background var(--dur-fast) var(--ease-out);
}
.fp__row:hover { background: var(--bg-hover); }
/* Shown in a pane: the thread list's "visible" wash; in the active pane: current. The keyboard cursor is the focus ring. */
.fp__row.is-shown { background: var(--bg-hover); color: var(--fg); }
.fp__row.is-current { background: var(--bg-active); color: var(--fg); }
.fp__row:focus-visible { outline-offset: -2px; }
/* A folder opened by hand: its rows settle in from just above. */
.fp__row.is-revealed { animation: fp-reveal var(--dur-med) var(--ease-out) both; }
@keyframes fp-reveal { from { opacity: 0; transform: translateY(-3px); } }
.fp__row.is-deleting { opacity: 0.45; cursor: default; }
.fp__caret { flex: none; width: 13px; height: 13px; color: var(--fg-faint); transition: transform var(--dur-fast) var(--ease-out); }
.fp__caret.is-open { transform: rotate(90deg); }
.fp__icon { flex: none; width: 14px; height: 14px; stroke-width: 1.75; color: var(--fg-subtle); }
.fp__name { min-width: 0; flex: 1; overflow: hidden; text-overflow: ellipsis; }
.fp__row.is-excluded .fp__name, .fp__row.is-excluded .fp__icon { color: var(--fg-faint); }

/* Git status: the Changes view's colours, with a letter so it is never colour alone. */
.fp--modified { --chip: var(--accent-ink); }
.fp--added { --chip: var(--diff-add-fg); }
.fp--untracked { --chip: var(--ripe-queued-fg); }
.fp--conflict { --chip: var(--ripe-error-fg); }
.fp__row[class*='fp--']:not(.is-dir) .fp__name { color: var(--chip); }
.fp__letter {
  flex: none;
  width: 14px;
  font-family: var(--font-mono);
  font-size: var(--text-2xs);
  font-weight: 650;
  text-align: center;
  color: var(--chip);
}
.fp__dot { flex: none; width: 5px; height: 5px; margin: 0 4px 0 5px; border-radius: 50%; background: var(--chip); opacity: 0.8; }

.fp__note {
  height: 24px;
  line-height: 24px;
  padding-left: calc(4px + var(--depth) * 14px + 18px);
  font-size: var(--text-xs);
  color: var(--fg-faint);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.fp__note.is-error { color: var(--ripe-error-fg); }

.fp__quiet {
  display: grid;
  gap: var(--space-2);
  justify-items: start;
  padding: var(--space-3) var(--space-4);
  border-top: 1px solid var(--line-soft);
  font-size: var(--text-sm);
  color: var(--fg-subtle);
}
.fp__quiet--fill { flex: 1; align-content: start; }
.fp__quiet p { margin: 0; overflow-wrap: anywhere; }
.fp__quiet-title { color: var(--fg); font-weight: 600; }

.fp__skeleton { display: grid; gap: 12px; padding: var(--space-3) var(--space-4); border-top: 1px solid var(--line-soft); }
.fp__skeleton span { height: 10px; border-radius: var(--radius-xs); background: var(--bg-hover); }
</style>
