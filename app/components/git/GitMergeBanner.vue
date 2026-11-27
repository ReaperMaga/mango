<script setup lang="ts">
import { Bot, Cherry, GitBranch, GitMerge, SkipForward, Undo2 } from 'lucide-vue-next'
import type { GitOperation, GitStatus } from '~/types/ipc'
import { useGit } from '~/stores/git'
import { chatForConflicts, solveConflicts } from '~/composables/solveConflicts'
import { openMergeEditor } from '~/composables/mergeEditor'

/**
 * Over the Changes view while a merge, rebase, cherry-pick or revert waits half way: what it is,
 * how many conflicts are left, and the ways on (resolve, ask the agent, continue or skip) or back
 * (abort, asked twice). A merge is finished with the commit box below, its message ready there.
 */
const props = defineProps<{ path: string; status: GitStatus; operation: GitOperation }>()

const { t } = useI18n()
const git = useGit()

const conflicted = computed(() => props.status.files.filter(f => f.conflicted))
const left = computed(() => conflicted.value.length)
const op = computed(() => props.operation)
const lore = computed(() => props.status.vcs === 'lore')

const icon = computed(() => ({ merge: GitMerge, rebase: GitBranch, 'cherry-pick': Cherry, revert: Undo2 })[op.value.kind])

/** The headline's message key and its named parts (shown in mono: branch names and hashes). */
const headline = computed(() => {
  const o = op.value
  switch (o.kind) {
    case 'rebase': return o.branch && o.incoming ? { key: 'git.merge.rebasing', parts: { branch: o.branch, incoming: o.incoming } } : { key: 'git.merge.rebasingPlain', parts: {} }
    case 'cherry-pick': return o.commit ? { key: o.branch ? 'git.merge.picking' : 'git.merge.pickingPlain', parts: { commit: o.commit, branch: o.branch ?? '' } } : { key: 'git.merge.pickingAny', parts: {} }
    case 'revert': return o.commit ? { key: o.branch ? 'git.merge.reverting' : 'git.merge.revertingPlain', parts: { commit: o.commit, branch: o.branch ?? '' } } : { key: 'git.merge.revertingAny', parts: {} }
    default:
      if (o.incoming && o.branch) return { key: 'git.merge.merging', parts: { incoming: o.incoming, branch: o.branch } }
      if (o.branch) return { key: 'git.merge.mergingInto', parts: { branch: o.branch } }
      return { key: 'git.merge.mergingPlain', parts: {} }
  }
})

const headlineKey = computed(() => headline.value.key)

/** The line under it: the conflicts left, a rebase's step, the commit being applied. */
const meta = computed(() => {
  const o = op.value
  const bits: string[] = []
  if (o.kind === 'rebase' && o.step && o.steps) bits.push(t('git.merge.step', { n: o.step, m: o.steps }))
  if (o.kind !== 'merge' && o.subject) bits.push(o.subject)
  return bits.join(' · ')
})
const nextStep = computed(() => {
  if (left.value) return null
  if (op.value.kind === 'merge') return t('git.merge.commitBelow')
  return t('git.merge.continueNow')
})

const busy = computed(() => !!git.busy)
const running = (a: 'abort' | 'continue' | 'skip') => git.isBusy(props.path, a)
const blocked = computed(() => (left.value ? t('git.panel.resolveConflicts', left.value) : null))

/* ---------- agent ---------- */

const target = computed(() => chatForConflicts(props.path))
const solveTitle = computed(() => (target.value
  ? t('git.merge.solveTitle', { chat: target.value.title })
  : t('git.merge.solveNewTitle')))
function solve() {
  void solveConflicts(props.path)
}

/* ---------- ways on and back ---------- */

function resolve() {
  const first = conflicted.value[0]
  if (first) openMergeEditor(props.path, first.path)
}
function proceed() {
  if (!blocked.value) void git.continueOperation(props.path)
}
function skip() {
  void git.skipOperation(props.path)
}

/** Abort asks first: the second press throws the resolutions away. */
const asking = ref(false)
const keepBtn = ref<{ $el: HTMLElement } | null>(null)
const abortBtn = ref<{ $el: HTMLElement } | null>(null)
// The keyboard follows the question, and comes back to Abort when it is withdrawn.
watch(asking, async (on, was) => {
  await nextTick()
  if (on) keepBtn.value?.$el?.focus()
  else if (was && document.activeElement === document.body) abortBtn.value?.$el?.focus()
})
watch(() => props.operation.kind, () => { asking.value = false })
async function abort() {
  asking.value = false
  await git.abortOperation(props.path)
}
const abortAsk = computed(() => t(`git.merge.abortAsk.${op.value.kind === 'cherry-pick' ? 'cherryPick' : op.value.kind}`))
const abortDo = computed(() => t(`git.merge.abortDo.${op.value.kind === 'cherry-pick' ? 'cherryPick' : op.value.kind}`))
</script>

<template>
  <section class="mb" :class="{ 'is-clear': !left }" :aria-label="t('git.merge.region')">
    <div class="mb__top">
      <component :is="icon" class="mb__icon" aria-hidden="true" />
      <div class="mb__text">
        <p class="mb__title">
          <i18n-t :keypath="headlineKey" scope="global">
            <template v-for="(value, name) in headline.parts" :key="name" #[name]><span class="mb__ref" :title="value">{{ value }}</span></template>
          </i18n-t>
        </p>
        <p class="mb__meta">
          <span v-if="left" class="mb__count tabular">{{ t('git.merge.conflicts', left) }}</span>
          <span v-else class="mb__ok">{{ t('git.merge.resolved') }}</span>
          <template v-if="meta"><span class="mb__sep" aria-hidden="true">·</span><span class="mb__sub" :title="meta">{{ meta }}</span></template>
        </p>
        <p v-if="nextStep" class="mb__hint">{{ nextStep }}</p>
      </div>
    </div>

    <div v-if="asking" class="mb__ask" role="alertdialog" :aria-label="abortDo" @keydown.esc.stop.prevent="asking = false">
      <p>{{ abortAsk }}</p>
      <div class="mb__btns">
        <UiButton ref="keepBtn" size="sm" variant="ghost" @click="asking = false">{{ t('git.merge.keepGoing') }}</UiButton>
        <UiButton size="sm" variant="danger" :loading="running('abort')" :disabled="busy" @click="abort">{{ abortDo }}</UiButton>
      </div>
    </div>
    <div v-else class="mb__btns">
      <UiButton v-if="op.kind !== 'merge'" size="sm" :variant="left ? 'secondary' : 'primary'" :loading="running('continue')" :disabled="busy || !!blocked" :title="blocked ?? t('git.merge.continueTitle')" @click="proceed">
        {{ t('git.merge.continue') }}
      </UiButton>
      <UiButton v-if="left" size="sm" :title="t('git.merge.resolveTitle')" @click="resolve">{{ t('git.merge.resolve') }}</UiButton>
      <UiButton v-if="left" size="sm" :disabled="busy" :title="solveTitle" :aria-label="t('git.merge.solve')" @click="solve"><Bot /><span class="mb__wide">{{ t('git.merge.solve') }}</span></UiButton>
      <span class="mb__end">
      <UiIconButton v-if="op.kind === 'rebase' && !lore" size="sm" :label="t('git.merge.skip')" :disabled="busy" :title="op.commit ? t('git.merge.skipTitle', { commit: op.commit }) : t('git.merge.skip')" @click="skip">
        <span v-if="running('skip')" class="mb__spin" aria-hidden="true" />
        <SkipForward v-else />
      </UiIconButton>
      <UiButton ref="abortBtn" size="sm" variant="ghost" :disabled="busy" @click="asking = true">{{ t('git.merge.abort') }}</UiButton>
      </span>
    </div>
  </section>
</template>

<style scoped>
.mb {
  container-type: inline-size;
  flex: none;
  /* Lined up with the commit box below it. */
  margin: var(--space-2) var(--space-2) var(--space-2) var(--space-3);
  padding: var(--space-3);
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  background: var(--bg-panel);
  border: 1px solid color-mix(in oklch, var(--ripe-waiting) 50%, transparent);
  border-radius: var(--radius-md);
}
.mb.is-clear { border-color: var(--line); }
.mb__top { display: flex; gap: var(--space-2); min-width: 0; }
.mb__icon { flex: none; width: 16px; height: 16px; margin-top: 1px; color: var(--ripe-waiting); }
.mb.is-clear .mb__icon { color: var(--ripe-done); }
.mb__text { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.mb__title {
  margin: 0;
  font-size: var(--text-sm);
  font-weight: 560;
  color: var(--fg);
}
/* A branch name never breaks; a long one ends in an ellipsis (its title has it whole). */
.mb__ref {
  display: inline-block;
  max-width: 100%;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  vertical-align: bottom;
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  font-weight: 500;
}
.mb__meta { margin: 0; display: flex; align-items: baseline; gap: 6px; min-width: 0; font-size: var(--text-xs); color: var(--fg-subtle); }
.mb__count { flex: none; color: var(--ripe-waiting-fg); font-weight: 560; }
.mb__ok { flex: none; color: var(--ripe-done-fg); font-weight: 560; }
.mb__sep { flex: none; color: var(--fg-faint); }
.mb__sub { min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.mb__hint { margin: 0; font-size: var(--text-xs); color: var(--fg-subtle); }
.mb__btns { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-1); min-width: 0; }
/* The narrowest tool window: the agent button keeps its icon. */
@container (max-width: 300px) {
  .mb__wide { display: none; }
}
/* Skip and Abort keep to the right, also on a line of their own. */
.mb__end { margin-left: auto; display: flex; align-items: center; gap: var(--space-1); }
.mb__ask { display: flex; flex-direction: column; gap: var(--space-2); }
.mb__ask p { margin: 0; font-size: var(--text-xs); color: var(--fg-muted); line-height: 1.45; }
.mb__ask .mb__btns { justify-content: flex-end; flex-wrap: wrap; }
.mb__spin {
  width: 12px;
  height: 12px;
  border: 1.5px solid var(--line-strong);
  border-top-color: var(--fg-muted);
  border-radius: 50%;
  animation: mb-spin 0.8s linear infinite;
}
@keyframes mb-spin { to { transform: rotate(360deg); } }
</style>
