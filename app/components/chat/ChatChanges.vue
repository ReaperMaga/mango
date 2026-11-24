<script setup lang="ts">
import { ChevronRight, ChevronsDownUp, ChevronsUpDown, FileText, Folder, FolderOpen, GitCompareArrows } from 'lucide-vue-next'
import type { Message, Thread } from '~/types/chat'
import { useThreads } from '~/stores/threads'
import { useGit, gitFileKey } from '~/stores/git'
import { useFiles } from '~/stores/files'
import { useWorkspace } from '~/stores/workspace'
import { diffTabId } from '~/utils/diffTabs'
import { changeTree, folderPaths, turnChanges, type ChangeNode, type ChangedFile } from '~/utils/turnChanges'

/**
 * The files an agent reply changed, as a small tree under the reply: counts per file and folder,
 * a click opens the file's diff (or the file, once it is committed), "Review" opens Changes.
 */
const props = defineProps<{ message: Message; thread: Thread }>()
const { t } = useI18n()
const threads = useThreads()
const git = useGit()
const files = useFiles()
const ws = useWorkspace()

const changed = computed(() => turnChanges(props.message.parts, id => threads.byId(id)?.messages ?? []))
const tree = computed(() => changeTree(changed.value))
const folders = computed(() => folderPaths(tree.value))
const total = computed(() => changed.value.reduce((sum, f) => ({ add: sum.add + f.add, del: sum.del + f.del }), { add: 0, del: 0 }))

/** Folders start open while the list stays short; a long one starts at its top level. */
const SHORT = 12
const closed = ref(new Set<string>())
watch(folders, (now, before) => {
  if (before) return
  if (changed.value.length > SHORT) closed.value = new Set(now)
}, { immediate: true })

const allOpen = computed(() => closed.value.size === 0)
function toggleAll() {
  closed.value = allOpen.value ? new Set(folders.value) : new Set()
}
function toggle(path: string) {
  const next = new Set(closed.value)
  if (!next.delete(path)) next.add(path)
  closed.value = next
}

interface Row { node: ChangeNode; depth: number; open: boolean }
const rows = computed<Row[]>(() => {
  const out: Row[] = []
  const walk = (nodes: ChangeNode[], depth: number) => {
    for (const node of nodes) {
      const open = !node.file && !closed.value.has(node.path)
      out.push({ node, depth, open })
      if (open) walk(node.children, depth + 1)
    }
  }
  walk(tree.value, 0)
  return out
})

const workdir = computed(() => threads.workdirFor(props.thread.id))

/** Show the file's diff beside the chat when it still has one, else the file itself. */
async function openFile(f: ChangedFile) {
  const dir = workdir.value
  if (!dir || !f.inside) return
  if (!git.repos[dir]?.status) await git.refresh(dir)
  const status = git.repos[dir]?.status
  // Status paths are relative to the repository root, which may sit above the chat's folder.
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '')
  const root = status?.root ? norm(status.root) : null
  const prefix = root && norm(dir).startsWith(`${root}/`) ? `${norm(dir).slice(root.length + 1)}/` : ''
  const gitFile = status?.isRepo ? status.files.find(s => s.path === prefix + f.path) : undefined
  if (gitFile) {
    const key = gitFileKey(gitFile.path, !gitFile.worktree && !!gitFile.index)
    git.openDiff(dir, key)
    threads.show(diffTabId(dir, key))
  } else {
    await files.openFile(dir, f.path)
  }
}

const plural = (n: number) => t('chat.changes.count', n)
</script>

<template>
  <section v-if="changed.length" class="changes" :aria-label="plural(changed.length)">
    <header class="changes__head">
      <span class="changes__title">{{ plural(changed.length) }}</span>
      <span class="changes__counts tabular">
        <span class="changes__add">+{{ total.add }}</span>
        <span class="changes__del">−{{ total.del }}</span>
      </span>
      <span class="changes__actions">
        <UiIconButton
          v-if="folders.length"
          size="sm"
          :label="allOpen ? t('chat.changes.collapse') : t('chat.changes.expand')"
          @click="toggleAll"
        >
          <ChevronsDownUp v-if="allOpen" /><ChevronsUpDown v-else />
        </UiIconButton>
        <button type="button" class="changes__review" :title="t('chat.changes.reviewTitle')" @click="ws.openTool('changes')">
          <GitCompareArrows aria-hidden="true" />
          <span>{{ t('chat.changes.review') }}</span>
        </button>
      </span>
    </header>
    <ul class="changes__list" role="tree">
      <li
        v-for="r in rows"
        :key="r.node.path"
        role="treeitem"
        :aria-level="r.depth + 1"
        :aria-expanded="r.node.file ? undefined : r.open"
      >
        <button
          type="button"
          class="changes__row"
          :class="{ 'is-file': r.node.file, 'is-outside': r.node.file && !r.node.file.inside }"
          :style="{ '--depth': r.depth }"
          :title="r.node.file ? (r.node.file.inside ? t('chat.changes.open', { path: r.node.path }) : t('chat.changes.outside', { path: r.node.path })) : r.node.path"
          :disabled="r.node.file ? !r.node.file.inside : undefined"
          @click="r.node.file ? openFile(r.node.file) : toggle(r.node.path)"
        >
          <span class="changes__caret" aria-hidden="true">
            <ChevronRight v-if="!r.node.file" :class="{ 'is-open': r.open }" />
          </span>
          <FileText v-if="r.node.file" class="changes__icon" aria-hidden="true" />
          <FolderOpen v-else-if="r.open" class="changes__icon" aria-hidden="true" />
          <Folder v-else class="changes__icon" aria-hidden="true" />
          <span class="changes__name">{{ r.node.name }}</span>
          <span class="changes__counts tabular">
            <span class="changes__add">+{{ r.node.add }}</span>
            <span class="changes__del">−{{ r.node.del }}</span>
          </span>
        </button>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.changes {
  margin: var(--space-3) 0 var(--space-1);
  border: 1px solid var(--line-soft);
  border-radius: var(--radius-md);
  background: var(--bg-panel);
  font-size: var(--text-sm);
  overflow: hidden;
}
.changes__head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-height: 36px;
  padding: 0 var(--space-2) 0 var(--space-3);
  border-bottom: 1px solid var(--line-soft);
}
.changes__title { font-weight: 560; color: var(--fg); white-space: nowrap; }
.changes__counts { display: inline-flex; gap: 6px; flex: none; font-size: var(--text-xs); }
.changes__add { color: var(--diff-add-fg); }
.changes__del { color: var(--diff-del-fg); }
.changes__actions { display: flex; align-items: center; gap: 2px; margin-left: auto; }
.changes__review {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 22px;
  padding: 0 8px 0 6px;
  border-radius: var(--radius-xs);
  font-size: var(--text-xs);
  font-weight: 540;
  color: var(--fg-subtle);
  transition: background var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out);
}
.changes__review:hover { background: var(--bg-hover); color: var(--fg); }
.changes__review:active { background: var(--bg-active); }
.changes__review:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 1px; }
.changes__review svg { width: 14px; height: 14px; stroke-width: 1.85; }

.changes__list {
  margin: 0;
  padding: var(--space-1);
  list-style: none;
  max-height: 320px;
  overflow-y: auto;
}
.changes__row {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  height: 26px;
  padding: 0 var(--space-2) 0 calc(var(--space-1) + var(--depth) * 16px);
  border-radius: var(--radius-sm);
  color: var(--fg-muted);
  text-align: left;
  transition: background var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out);
}
.changes__row:hover { background: var(--bg-hover); color: var(--fg); }
.changes__row:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: -2px; }
.changes__row:disabled { background: none; color: var(--fg-subtle); }
.changes__caret { display: grid; place-items: center; width: 14px; height: 14px; flex: none; color: var(--fg-faint); }
.changes__caret svg { width: 13px; height: 13px; transition: transform var(--dur-fast) var(--ease-out); }
.changes__caret svg.is-open { transform: rotate(90deg); }
.changes__icon { width: 14px; height: 14px; flex: none; stroke-width: 1.75; color: var(--fg-subtle); }
.changes__name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-mono);
  font-size: var(--text-xs);
}
.changes__row .changes__counts { margin-left: auto; padding-left: var(--space-2); }
</style>
