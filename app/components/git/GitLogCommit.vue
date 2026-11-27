<script setup lang="ts">
import { ArrowLeft, Copy } from 'lucide-vue-next'
import type { GitCommitDetail, GitCommitFile, GitRef } from '~/types/ipc'
import { gitLogError, useGitLog } from '~/stores/gitLog'
import { useThreads } from '~/stores/threads'
import { commitDiffTabId } from '~/utils/commitDiffTabs'
import { fullDateTime } from '~/utils/time'

/** The commit selected in the Git log: its message, facts and changed files. A file opens its diff in a tab. */
const props = defineProps<{
  path: string
  hash: string
  /** The log's refs for this commit: the details are cached, and branches move. */
  refs?: GitRef[]
  /** It stands in for the list (a narrow panel): show the way back. */
  back?: boolean
}>()
const emit = defineEmits<{ jump: [hash: string]; back: [] }>()

const { t } = useI18n()
const log = useGitLog()
const threads = useThreads()

const statusNames = computed<Record<string, string>>(() => ({
  A: t('git.state.added'),
  M: t('git.state.modified'),
  D: t('git.state.deleted'),
  R: t('git.state.renamed'),
  C: t('git.state.copied'),
  T: t('git.state.typeChanged'),
}))

const detail = shallowRef<GitCommitDetail | null>(null)
const error = ref('')
const loading = ref(false)
const active = ref<string | null>(null)
const fileList = ref<HTMLElement | null>(null)
const listId = useId()

let token = 0
let timer: ReturnType<typeof setTimeout> | undefined

function take(next: GitCommitDetail) {
  detail.value = next
  active.value = next.files[0]?.path ?? null
}

function load() {
  clearTimeout(timer)
  const mine = ++token
  error.value = ''
  const cached = log.cachedDetail(props.path, props.hash)
  loading.value = !cached
  if (cached) return take(cached)
  // Arrowing through the log asks only for the commit it stops on.
  timer = setTimeout(async () => {
    try {
      const next = await log.loadDetail(props.path, props.hash)
      if (mine === token) take(next)
    } catch (e) {
      if (mine !== token) return
      detail.value = null
      error.value = gitLogError(e)
    } finally {
      if (mine === token) loading.value = false
    }
  }, 120)
}
watch(() => `${props.path}\n${props.hash}`, load, { immediate: true })
onBeforeUnmount(() => {
  clearTimeout(timer)
  token++
})

const shownRefs = computed(() => (detail.value?.hash === props.hash && props.refs) || detail.value?.refs || [])
const total = computed(() => ({
  add: detail.value?.files.reduce((n, f) => n + (f.additions ?? 0), 0) ?? 0,
  del: detail.value?.files.reduce((n, f) => n + (f.deletions ?? 0), 0) ?? 0,
}))
const sameCommitter = computed(() => {
  const d = detail.value
  return !!d && d.committer === d.author && Math.abs(d.commitTime - d.time) < 60_000
})

const dirOf = (file: string) => file.slice(0, file.lastIndexOf('/') + 1)
const nameOf = (file: string) => file.slice(file.lastIndexOf('/') + 1)
const activeIndex = computed(() => detail.value?.files.findIndex(f => f.path === active.value) ?? -1)

function openDiff(file: GitCommitFile) {
  if (!detail.value) return
  active.value = file.path
  threads.show(commitDiffTabId(props.path, detail.value.hash, file.path))
}

function onFilesKey(e: KeyboardEvent) {
  const files = detail.value?.files ?? []
  const at = activeIndex.value
  let next: number
  if (e.key === 'ArrowDown') next = Math.min(files.length - 1, at + 1)
  else if (e.key === 'ArrowUp') next = Math.max(0, at - 1)
  else if (e.key === 'Home') next = 0
  else if (e.key === 'End') next = files.length - 1
  else {
    const file = files[at]
    if (e.key === 'Enter' && file) {
      e.preventDefault()
      openDiff(file)
    }
    return
  }
  e.preventDefault()
  active.value = files[next]?.path ?? null
  void nextTick(() => fileList.value?.querySelector('.is-selected')?.scrollIntoView({ block: 'nearest' }))
}

defineExpose({ focusFiles: () => fileList.value?.focus({ preventScroll: true }) })
</script>

<template>
  <div class="commit" :class="{ 'is-stale': loading && detail }" :aria-busy="loading || undefined">
    <UiButton v-if="back" size="sm" variant="ghost" class="commit__back" @click="emit('back')"><ArrowLeft />{{ t('git.commit.backToLog') }}</UiButton>

    <div v-if="error" class="commit__error" role="alert">
      <p class="commit__error-title">{{ t('git.commit.couldNotRead') }}</p>
      <p class="commit__error-text selectable">{{ error }}</p>
      <UiButton size="sm" @click="load">{{ t('common.actions.retry') }}</UiButton>
    </div>
    <p v-else-if="!detail" class="commit__quiet">{{ t('git.commit.reading') }}</p>
    <template v-else>
      <div class="commit__head">
        <h2 class="commit__subject selectable">{{ detail.subject || t('git.noMessage') }}</h2>
        <GitLogRefs v-if="shownRefs.length" :refs="shownRefs" wrap />
        <p v-if="detail.body" class="commit__body selectable">{{ detail.body }}</p>
        <dl class="commit__facts">
          <dt>{{ t('git.log.author') }}</dt>
          <dd class="selectable" :title="[detail.authorEmail ? `${detail.author} <${detail.authorEmail}>` : detail.author, fullDateTime(detail.time)].filter(Boolean).join(', ')">
            {{ detail.author }}<span class="commit__soft">{{ detail.author ? ', ' : '' }}{{ fullDateTime(detail.time) }}</span>
          </dd>
          <template v-if="!sameCommitter">
            <dt>{{ t('git.commit.committer') }}</dt>
            <dd class="selectable" :title="`${detail.committer}, ${fullDateTime(detail.commitTime)}`">
              {{ detail.committer }}<span class="commit__soft">, {{ fullDateTime(detail.commitTime) }}</span>
            </dd>
          </template>
          <dt>{{ t('git.log.commit') }}</dt>
          <dd class="commit__line">
            <span class="commit__hash selectable" :title="detail.hash">{{ detail.hash }}</span>
            <UiIconButton size="sm" :label="t('git.commit.copyHash')" @click="log.copy(detail.hash, 'hash')"><Copy /></UiIconButton>
          </dd>
          <dt>{{ t('git.commit.parents', detail.parents.length || 1) }}</dt>
          <dd class="commit__line">
            <button v-for="p in detail.parents" :key="p" type="button" class="commit__parent" :title="t('git.commit.goToParent', { commit: p.slice(0, 7) })" @click="emit('jump', p)">{{ p.slice(0, 7) }}</button>
            <span v-if="!detail.parents.length" class="commit__soft">{{ t('git.commit.first') }}</span>
          </dd>
        </dl>
      </div>

      <h3 class="commit__count tabular">
        {{ t('git.commit.filesChanged', detail.files.length) }}
        <span v-if="total.add" class="commit__add">+{{ total.add }}</span>
        <span v-if="total.del" class="commit__del">−{{ total.del }}</span>
      </h3>
      <div
        v-if="detail.files.length"
        ref="fileList"
        class="commit__files"
        role="listbox"
        tabindex="0"
        :aria-label="t('git.commit.files')"
        :aria-activedescendant="activeIndex >= 0 ? `${listId}-${activeIndex}` : undefined"
        @keydown="onFilesKey"
      >
        <div
          v-for="(f, i) in detail.files"
          :id="`${listId}-${i}`"
          :key="f.path"
          class="commit__file"
          :class="{ 'is-selected': f.path === active }"
          role="option"
          :aria-selected="f.path === active"
          :title="`${f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}\n${t('git.commit.clickToOpen')}`"
          @click="openDiff(f)"
        >
          <span class="commit__status" :class="`is-${f.status[0]}`" :title="statusNames[f.status.charAt(0)] ?? f.status">{{ f.status[0] }}</span>
          <span class="commit__path">
            <!-- The bdi keeps "docs/" reading left to right inside the box that truncates from the left. -->
            <span v-if="dirOf(f.path)" class="commit__dir"><bdi>{{ dirOf(f.path) }}</bdi></span>
            <span class="commit__name">{{ nameOf(f.path) }}</span>
          </span>
          <span v-if="f.additions === null" class="commit__binary">{{ t('git.commit.binary') }}</span>
          <span v-else class="commit__counts tabular">
            <span v-if="f.additions" class="commit__add">+{{ f.additions }}</span>
            <span v-if="f.deletions" class="commit__del">−{{ f.deletions }}</span>
          </span>
        </div>
      </div>
      <p v-else class="commit__quiet">
        {{ detail.parents.length > 1 ? t('git.commit.emptyMerge') : t('git.commit.empty') }}
      </p>
    </template>
  </div>
</template>

<style scoped>
.commit {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding-bottom: var(--space-3);
  transition: opacity var(--dur-fast) var(--ease-out);
}
.commit.is-stale { opacity: 0.6; }
.commit__back { margin: var(--space-2) 0 0 var(--space-2); }
.commit__quiet { margin: 0; padding: var(--space-4); color: var(--fg-subtle); font-size: var(--text-sm); }
.commit__error { display: grid; justify-items: start; gap: var(--space-1); padding: var(--space-5) var(--space-4); }
.commit__error-title { margin: 0; color: var(--fg-muted); font-size: var(--text-md); font-weight: 560; }
.commit__error-text { margin: 0 0 var(--space-1); color: var(--fg-subtle); font-size: var(--text-sm); overflow-wrap: anywhere; }

.commit__head { display: flex; flex-direction: column; gap: var(--space-2); padding: var(--space-3) var(--space-4) var(--space-2); }
.commit__subject {
  margin: 0;
  color: var(--fg);
  font-size: var(--text-md);
  font-weight: 600;
  line-height: var(--leading-tight);
  overflow-wrap: anywhere;
}
.commit__body {
  margin: 0;
  color: var(--fg-muted);
  font-size: var(--text-sm);
  line-height: var(--leading-normal);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.commit__facts {
  display: grid;
  grid-template-columns: max-content minmax(0, 1fr);
  column-gap: var(--space-3);
  row-gap: 1px;
  margin: 0;
  font-size: var(--text-xs);
}
.commit__facts dt { color: var(--fg-subtle); line-height: 22px; }
.commit__facts dd { margin: 0; min-width: 0; color: var(--fg); line-height: 22px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.commit__soft { color: var(--fg-subtle); }
.commit__facts .commit__line { display: flex; align-items: center; gap: var(--space-1); flex-wrap: wrap; }
.commit__hash { min-width: 0; overflow: hidden; text-overflow: ellipsis; font-family: var(--font-mono); font-size: var(--text-2xs); color: var(--fg-muted); }
.commit__parent {
  padding: 0 var(--space-1);
  border-radius: var(--radius-xs);
  color: var(--accent-ink);
  font-family: var(--font-mono);
  font-size: var(--text-2xs);
  line-height: 20px;
}
.commit__parent:hover { background: var(--bg-hover); text-decoration: underline; text-underline-offset: 2px; }

.commit__count {
  display: flex;
  gap: var(--space-1);
  margin: 0;
  padding: var(--space-2) var(--space-4) var(--space-1);
  border-top: 1px solid var(--line-soft);
  color: var(--fg-subtle);
  font-size: var(--text-xs);
  font-weight: 560;
}
.commit__files { padding: 2px var(--space-2); }
.commit__files:focus-visible { outline: none; }
.commit__file {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  height: 26px;
  padding: 0 var(--space-2);
  border-radius: var(--radius-sm);
}
.commit__file + .commit__file { margin-top: 1px; }
.commit__file:hover { background: var(--bg-hover); }
.commit__file.is-selected { background: var(--bg-active); }
.commit__files:focus-visible .commit__file.is-selected { box-shadow: inset 0 0 0 1px var(--focus-ring); }
.commit__status {
  flex: none;
  width: 12px;
  color: var(--fg-subtle);
  font-family: var(--font-mono);
  font-size: var(--text-2xs);
  font-weight: 600;
  text-align: center;
}
.commit__status.is-A { color: var(--diff-add-fg); }
.commit__status.is-D { color: var(--diff-del-fg); }
.commit__status.is-R, .commit__status.is-C { color: var(--fg-muted); }
.commit__path { flex: 1; min-width: 0; display: flex; font-family: var(--font-mono); font-size: var(--text-xs); white-space: nowrap; }
.commit__dir { min-width: 0; overflow: hidden; text-overflow: ellipsis; color: var(--fg-faint); direction: rtl; text-align: left; }
.commit__name { flex: none; max-width: 100%; overflow: hidden; text-overflow: ellipsis; color: var(--fg); }
.commit__counts { flex: none; display: flex; gap: var(--space-1); font-size: var(--text-2xs); }
.commit__binary { flex: none; color: var(--fg-faint); font-size: var(--text-2xs); }
.commit__add { color: var(--diff-add-fg); }
.commit__del { color: var(--diff-del-fg); }
</style>
