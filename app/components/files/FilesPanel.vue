<script setup lang="ts">
import { ChevronRight, ChevronsDownUp, Folder, FolderOpen, RefreshCw } from 'lucide-vue-next'
import { fileIcon } from '~/utils/fileIcons'
import type { FsEntry } from '~/types/ipc'
import { useWorkspace } from '~/stores/workspace'
import { useThreads } from '~/stores/threads'
import { useFiles } from '~/stores/files'
import { useGit } from '~/stores/git'
import { parseFileTab } from '~/utils/fileTabs'
import { parseEnvPath } from '~/utils/envPath'

/**
 * The Files tool window on the right: the active project's folders as a tree,
 * read one folder at a time as it opens. A click previews a file in the main
 * pane, a double-click (or Enter) keeps its tab. Names carry the same git
 * status colours and letters as the Changes view.
 */

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
const KIND_WORD: Record<Kind, string> = { modified: 'Modified', added: 'Added', untracked: 'New file, not tracked yet', conflict: 'Merge conflict' }
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

type Row =
  | { type: 'entry'; key: string; entry: FsEntry; depth: number; ignored: boolean; open: boolean; kind: Kind | null; parent: string }
  | { type: 'note'; key: string; depth: number; text: string; error?: boolean; dir: string }

const rows = computed<Row[]>(() => {
  const t = tree.value
  if (!t) return []
  const out: Row[] = []
  const { fileKinds, dirKinds } = decorations.value
  const walk = (dir: string, depth: number, ignoredAbove: boolean) => {
    const state = t.dirs[dir]
    if (!state) return
    if (state.entries === null) {
      if (state.error) out.push({ type: 'note', key: `err:${dir}`, depth, text: state.error, error: true, dir })
      else if (dir) out.push({ type: 'note', key: `load:${dir}`, depth, text: 'Loading…', dir })
      return
    }
    if (dir && !state.entries.length) out.push({ type: 'note', key: `empty:${dir}`, depth, text: 'Empty folder', dir })
    for (const entry of state.entries) {
      const ignored = ignoredAbove || entry.ignored
      const open = entry.isDir && t.expanded.includes(entry.path)
      const kind = (entry.isDir ? dirKinds.get(entry.path) : fileKinds.get(entry.path)) ?? null
      out.push({ type: 'entry', key: entry.path, entry, depth, ignored, open, kind, parent: dir })
      if (open) walk(entry.path, depth + 1, ignored)
    }
    if (state.truncated) out.push({ type: 'note', key: `more:${dir}`, depth, text: 'Only the first 5000 entries are shown', dir })
  }
  walk('', 0, false)
  return out
})

const top = computed(() => tree.value?.dirs[''] ?? null)

/** Files shown in a pane right now, to mark their rows. */
const shownFiles = computed(() => new Set(threads.panes.map(p => parseFileTab(p.threadId)).filter(p => p && p.projectPath === path.value).map(p => p!.file)))
const currentFile = computed(() => {
  const p = parseFileTab(threads.activePane.threadId)
  return p && p.projectPath === path.value ? p.file : null
})

/* ---------- actions ---------- */

function activate(row: Row, pin: boolean) {
  if (row.type !== 'entry' || !path.value) return
  select(row.entry.path)
  if (row.entry.isDir) files.toggleDir(path.value, row.entry.path)
  else void files.openFile(path.value, row.entry.path, pin)
}

function select(p: string) {
  if (path.value) files.treeOf(path.value).selected = p
}

const spun = ref(false)
async function manualRefresh() {
  if (!path.value) return
  spun.value = true
  await Promise.all([files.refresh(path.value), git.refresh(path.value).catch(() => {})])
  spun.value = false
}

/* ---------- keyboard: a tree with one tab stop ---------- */

const list = ref<HTMLElement | null>(null)
const entryRows = computed(() => rows.value.filter((r): r is Extract<Row, { type: 'entry' }> => r.type === 'entry'))
/** The row that takes Tab focus: the selected one, else the first. */
const focusKey = computed(() => {
  const sel = tree.value?.selected
  return entryRows.value.some(r => r.key === sel) ? sel : entryRows.value[0]?.key ?? null
})

function focusRow(key: string) {
  select(key)
  nextTick(() => list.value?.querySelector<HTMLElement>(`[data-path="${CSS.escape(key)}"]`)?.focus())
}

function onKey(e: KeyboardEvent) {
  const all = entryRows.value
  const i = all.findIndex(r => r.key === focusKey.value)
  const row = all[i]
  if (!row || !path.value) return
  switch (e.key) {
    case 'ArrowDown': e.preventDefault(); if (all[i + 1]) focusRow(all[i + 1]!.key); break
    case 'ArrowUp': e.preventDefault(); if (i > 0) focusRow(all[i - 1]!.key); break
    case 'Home': e.preventDefault(); if (all[0]) focusRow(all[0].key); break
    case 'End': e.preventDefault(); if (all.length) focusRow(all[all.length - 1]!.key); break
    case 'ArrowRight':
      e.preventDefault()
      if (row.entry.isDir && !row.open) files.toggleDir(path.value, row.key, true)
      else if (row.entry.isDir && all[i + 1]?.parent === row.key) focusRow(all[i + 1]!.key)
      break
    case 'ArrowLeft':
      e.preventDefault()
      if (row.entry.isDir && row.open) files.toggleDir(path.value, row.key, false)
      else if (row.parent) focusRow(row.parent)
      break
    case 'Enter': e.preventDefault(); activate(row, true); break
    case ' ': e.preventDefault(); activate(row, false); break
  }
}

/* ---------- icons ---------- */

function iconFor(entry: FsEntry, open: boolean) {
  return entry.isDir ? open ? FolderOpen : Folder : fileIcon(entry.name).icon
}
/** A file's language tint; folders and ignored files keep the plain ink. */
function tintFor(entry: FsEntry, ignored: boolean) {
  return entry.isDir || ignored ? undefined : { color: fileIcon(entry.name).tint }
}
</script>

<template>
  <!-- Shown in the tool window on the right (see AppToolPanel), which owns width and resizing. -->
  <section class="fp" aria-label="Files">
    <header class="fp__head">
      <h2 class="fp__title" :title="path ?? undefined">{{ ws.activeProject?.name ?? 'Files' }}</h2>
      <div v-if="path" class="fp__tools">
        <UiIconButton label="Collapse folders" :disabled="!tree?.expanded.length" @click="files.collapseAll(path)"><ChevronsDownUp /></UiIconButton>
        <UiIconButton label="Refresh" :class="{ 'is-spun': spun }" @click="manualRefresh"><RefreshCw /></UiIconButton>
      </div>
    </header>

    <div v-if="!path" class="fp__quiet">Open a project to see its files.</div>
    <div v-else-if="top?.error" class="fp__quiet" role="alert">
      <p class="fp__quiet-title">Could not read this folder</p>
      <p class="selectable">{{ top.error }}</p>
      <UiButton size="sm" @click="files.loadDir(path, '')">Try again</UiButton>
    </div>
    <div v-else-if="!top?.entries" class="fp__skeleton" aria-busy="true" aria-label="Reading files">
      <span v-for="w in [58, 46, 70, 52, 38, 64, 44, 56]" :key="w" :style="{ width: `${w}%` }" />
    </div>
    <div v-else-if="!top.entries.length" class="fp__quiet">This folder is empty.</div>

    <div v-else ref="list" class="fp__scroll" role="tree" aria-label="Project files" @keydown="onKey">
      <template v-for="row in rows" :key="row.key">
        <div
          v-if="row.type === 'entry'"
          class="fp__row"
          :class="[
            row.kind ? `fp--${row.kind}` : '',
            {
              'is-dir': row.entry.isDir,
              'is-ignored': row.ignored,
              'is-selected': tree?.selected === row.key,
              'is-shown': shownFiles.has(row.key),
              'is-current': currentFile === row.key,
            },
          ]"
          :style="{ '--depth': row.depth }"
          role="treeitem"
          :aria-level="row.depth + 1"
          :aria-expanded="row.entry.isDir ? row.open : undefined"
          :aria-selected="tree?.selected === row.key"
          :tabindex="focusKey === row.key ? 0 : -1"
          :data-path="row.key"
          :title="row.kind ? `${row.entry.path} · ${row.entry.isDir ? 'Contains changes' : KIND_WORD[row.kind]}` : row.entry.path"
          @click="activate(row, false)"
          @dblclick="!row.entry.isDir && activate(row, true)"
        >
          <ChevronRight v-if="row.entry.isDir" class="fp__caret" :class="{ 'is-open': row.open }" aria-hidden="true" />
          <span v-else class="fp__caret" aria-hidden="true" />
          <component :is="iconFor(row.entry, row.open)" class="fp__icon" :style="tintFor(row.entry, !!row.ignored)" aria-hidden="true" />
          <span class="fp__name">{{ row.entry.name }}</span>
          <span v-if="row.kind && row.entry.isDir" class="fp__dot" aria-hidden="true" />
          <span v-else-if="row.kind" class="fp__letter" aria-hidden="true">{{ KIND_LETTER[row.kind] }}</span>
          <span v-if="row.kind" class="sr-only">, {{ row.entry.isDir ? 'contains changes' : KIND_WORD[row.kind] }}</span>
        </div>
        <div v-else class="fp__note" :class="{ 'is-error': row.error }" :style="{ '--depth': row.depth }" role="none">{{ row.text }}</div>
      </template>
    </div>
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
.fp__caret { flex: none; width: 13px; height: 13px; color: var(--fg-faint); transition: transform var(--dur-fast) var(--ease-out); }
.fp__caret.is-open { transform: rotate(90deg); }
.fp__icon { flex: none; width: 14px; height: 14px; stroke-width: 1.75; color: var(--fg-subtle); }
.fp__name { min-width: 0; flex: 1; overflow: hidden; text-overflow: ellipsis; }
.fp__row.is-ignored .fp__name, .fp__row.is-ignored .fp__icon { color: var(--fg-faint); }

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
.fp__quiet p { margin: 0; overflow-wrap: anywhere; }
.fp__quiet-title { color: var(--fg); font-weight: 600; }

.fp__skeleton { display: grid; gap: 12px; padding: var(--space-3) var(--space-4); border-top: 1px solid var(--line-soft); }
.fp__skeleton span { height: 10px; border-radius: var(--radius-xs); background: var(--bg-hover); }
</style>
