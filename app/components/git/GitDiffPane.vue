<script setup lang="ts">
import { Minus, Plus, RefreshCw, X } from 'lucide-vue-next'
import { useWorkspace } from '~/stores/workspace'
import { useThreads } from '~/stores/threads'
import { useGit } from '~/stores/git'
import { parseDiffTab } from '~/utils/diffTabs'

/**
 * One changed file's diff, shown in the main pane as a tab beside the chats.
 * The git store keeps the diff loaded and re-reads it whenever status changes,
 * so the pane follows edits an agent makes while it is open.
 */
const props = defineProps<{ tabId: string; paneId: string; split: boolean; active: boolean }>()

const ws = useWorkspace()
const threads = useThreads()
const git = useGit()

const tab = computed(() => parseDiffTab(props.tabId))
const repo = computed(() => (tab.value ? git.repos[tab.value.projectPath] : undefined))
const entry = computed(() => (tab.value ? repo.value?.diffs[tab.value.key] ?? null : null))
const file = computed(() => repo.value?.status?.files.find(f => f.path === tab.value?.file) ?? null)

const dir = computed(() => {
  const f = tab.value?.file ?? ''
  const i = f.lastIndexOf('/')
  return i > 0 ? f.slice(0, i) : ''
})

/** What happened to the file, in a word. */
const state = computed(() => {
  const f = file.value
  if (!f) return ''
  if (f.conflicted) return 'Conflict'
  const code = tab.value?.staged ? f.index : f.worktree
  switch (code) {
    case 'A': return 'Added'
    case '?': return 'New file'
    case 'D': return 'Deleted'
    case 'R': return 'Renamed'
    case 'C': return 'Copied'
    default: return 'Modified'
  }
})

/** Added and removed line counts, from the diff text itself. */
const counts = computed(() => {
  let add = 0
  let del = 0
  let inHunk = false
  for (const line of (entry.value?.text ?? '').split('\n')) {
    if (line.startsWith('@@')) { inHunk = true; continue }
    if (!inHunk) continue
    if (line.startsWith('+')) add++
    else if (line.startsWith('-')) del++
  }
  return { add, del }
})

const busy = computed(() => (tab.value ? git.isBusy(tab.value.projectPath) : false))

function reload() {
  if (tab.value) void git.refresh(tab.value.projectPath)
}
function stage() {
  if (tab.value) void git.stage(tab.value.projectPath, [tab.value.file])
}
function unstage() {
  if (tab.value) void git.unstage(tab.value.projectPath, [tab.value.file])
}

// Opened from a restored tab or another window state: make sure the diff is actually loading.
watch(() => props.tabId, () => { if (tab.value) git.openDiff(tab.value.projectPath, tab.value.key) }, { immediate: true })
</script>

<template>
  <section class="dp" :class="{ 'is-active': active, 'is-split': split }" :aria-label="tab ? `Changes in ${tab.file}` : 'Changes'">
    <header v-if="tab" class="dp__head">
      <h2 class="dp__name" :title="tab.file">{{ tab.name }}</h2>
      <span v-if="dir" class="dp__dir"><bdi>{{ dir }}</bdi></span>
      <span v-if="state" class="dp__state">{{ state }}{{ tab.staged ? ' · staged' : '' }}</span>
      <span v-if="counts.add || counts.del" class="dp__counts tabular">
        <span class="dp__add">+{{ counts.add }}</span>
        <span class="dp__del">−{{ counts.del }}</span>
      </span>
      <span class="dp__spacer" />

      <GitDiffViewToggle />

      <UiButton v-if="tab.staged" size="sm" :disabled="busy" @click="unstage"><Minus />Unstage</UiButton>
      <UiButton v-else size="sm" :disabled="busy || !file" @click="stage"><Plus />Stage</UiButton>
      <UiIconButton size="sm" label="Reload diff" @click="reload"><RefreshCw /></UiIconButton>
      <UiIconButton v-if="split" size="sm" label="Close pane" @click.stop="threads.closePane(paneId)"><X /></UiIconButton>
    </header>

    <div class="dp__body">
      <GitDiff
        fill
        :split="ws.diffView === 'split'"
        :text="entry?.text ?? null"
        :error="entry?.error ?? null"
      />
    </div>
  </section>
</template>

<style scoped>
.dp {
  flex: 1 1 0;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--bg-canvas);
}
.dp__head {
  flex: none;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  height: 40px;
  padding: 0 var(--space-3) 0 var(--space-4);
  border-bottom: 1px solid var(--line-soft);
}
.dp.is-split:not(.is-active) .dp__head { opacity: 0.72; }
.dp__name {
  margin: 0;
  flex: none;
  max-width: 40%;
  font-size: var(--text-md);
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.dp__dir {
  min-width: 0;
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--fg-subtle);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  /* Keep the end of a long path visible. */
  direction: rtl;
  text-align: left;
}
.dp__state { flex: none; font-size: var(--text-xs); color: var(--fg-subtle); white-space: nowrap; }
.dp__counts { flex: none; display: inline-flex; gap: 6px; font-size: var(--text-xs); font-family: var(--font-mono); }
.dp__add { color: var(--diff-add-fg); }
.dp__del { color: var(--diff-del-fg); }
.dp__spacer { flex: 1; }

.dp__body { flex: 1; min-height: 0; background: var(--bg-inset); }
.dp.is-split .dp__dir, .dp.is-split .dp__state { display: none; }
</style>
