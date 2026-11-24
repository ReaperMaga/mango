<script setup lang="ts">
import { SquareArrowOutUpRight, X } from 'lucide-vue-next'
import type { GitCommitDetail } from '~/types/ipc'
import { call } from '~/composables/useBackend'
import { gitLogError, useGitLog } from '~/stores/gitLog'
import { useThreads } from '~/stores/threads'
import { useWorkspace } from '~/stores/workspace'
import { parseCommitDiffTab } from '~/utils/commitDiffTabs'

/**
 * One file's diff in a commit, opened from the Git log as a tab in the main pane. A commit never changes,
 * so it is read once; the tab's id says everything needed to read it.
 */
const props = defineProps<{ tabId: string; paneId: string; split: boolean; active: boolean }>()

const { t } = useI18n()
const ws = useWorkspace()
const threads = useThreads()
const log = useGitLog()

const tab = computed(() => parseCommitDiffTab(props.tabId))
const text = ref<string | null>(null)
const error = ref<string | null>(null)
const detail = shallowRef<GitCommitDetail | null>(null)
const file = computed(() => detail.value?.files.find(f => f.path === tab.value?.file) ?? null)
const fullPath = computed(() => (file.value?.oldPath ? `${file.value.oldPath} → ${file.value.path}` : tab.value?.file ?? ''))
const dir = computed(() => {
  const path = tab.value?.file ?? ''
  return path.slice(0, Math.max(0, path.lastIndexOf('/')))
})
const deleted = computed(() => file.value?.status === 'D')

let token = 0
watch(() => props.tabId, () => {
  const at = tab.value
  const mine = ++token
  text.value = null
  error.value = null
  detail.value = null
  if (!at) return
  call('git_commit_diff', { path: at.projectPath, hash: at.hash, file: at.file })
    .then((diff) => { if (mine === token) text.value = diff })
    .catch((e) => { if (mine === token) error.value = gitLogError(e) })
  // The header's subject and counts; the diff reads fine without them.
  log.loadDetail(at.projectPath, at.hash)
    .then((d) => { if (mine === token) detail.value = d })
    .catch(() => {})
}, { immediate: true })
onBeforeUnmount(() => { token++ })
</script>

<template>
  <section class="cdp" :class="{ 'is-active': active, 'is-split': split }" :aria-label="tab ? t('git.diff.changesAt', { file: tab.file, commit: tab.short }) : t('git.changes')">
    <header v-if="tab" class="cdp__head">
      <h2 class="cdp__name" :title="fullPath">{{ tab.name }}</h2>
      <span v-if="dir" class="cdp__dir"><bdi>{{ dir }}</bdi></span>
      <button type="button" class="cdp__commit" :title="t('git.diff.showInLog', { commit: tab.short })" @click="log.show(tab.projectPath, tab.hash)">
        <span class="cdp__hash">{{ tab.short }}</span>
        <span v-if="detail" class="cdp__subject">{{ detail.subject }}</span>
      </button>
      <span v-if="file?.additions || file?.deletions" class="cdp__counts tabular">
        <span v-if="file.additions" class="cdp__add">+{{ file.additions }}</span>
        <span v-if="file.deletions" class="cdp__del">−{{ file.deletions }}</span>
      </span>
      <span class="cdp__spacer" />
      <GitDiffViewToggle />
      <UiButton
        size="sm"
        :disabled="deleted"
        :title="deleted ? t('git.diff.deletedTitle') : t('git.diff.openFileTitle')"
        @click="log.openFile(tab.projectPath, tab.file)"
      >
        <SquareArrowOutUpRight />{{ t('git.diff.openFile') }}
      </UiButton>
      <UiIconButton v-if="split" size="sm" :label="t('git.closePane')" @click.stop="threads.closePane(paneId)"><X /></UiIconButton>
    </header>

    <div class="cdp__body">
      <GitDiff fill :split="ws.diffView === 'split'" :text="text" :error="error" />
    </div>
  </section>
</template>

<style scoped>
.cdp {
  flex: 1 1 0;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--bg-canvas);
}
.cdp__head {
  flex: none;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  height: 40px;
  padding: 0 var(--space-3) 0 var(--space-4);
  border-bottom: 1px solid var(--line-soft);
}
.cdp.is-split:not(.is-active) .cdp__head { opacity: 0.72; }
.cdp__name {
  margin: 0;
  flex: none;
  max-width: 35%;
  font-size: var(--text-md);
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.cdp__dir {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--fg-subtle);
  /* Keep the end of a long path visible. */
  direction: rtl;
  text-align: left;
}
.cdp__commit {
  flex: 0 1 auto;
  min-width: 60px;
  display: inline-flex;
  align-items: baseline;
  gap: 6px;
  padding: 2px 6px;
  border-radius: var(--radius-xs);
  color: var(--fg-subtle);
  font-size: var(--text-xs);
}
.cdp__commit:hover { background: var(--bg-hover); color: var(--fg); }
.cdp__hash { flex: none; font-family: var(--font-mono); font-size: var(--text-2xs); color: var(--accent-ink); }
.cdp__subject { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cdp__counts { flex: none; display: inline-flex; gap: 6px; font-family: var(--font-mono); font-size: var(--text-xs); }
.cdp__add { color: var(--diff-add-fg); }
.cdp__del { color: var(--diff-del-fg); }
.cdp__spacer { flex: 1; }
.cdp__body { flex: 1; min-height: 0; background: var(--bg-inset); }
.cdp.is-split .cdp__dir, .cdp.is-split .cdp__subject { display: none; }
</style>
