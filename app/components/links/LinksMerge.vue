<script setup lang="ts">
import { ChevronDown, CircleAlert, CircleCheck, CircleDashed, CircleX, GitMerge } from 'lucide-vue-next'
import type { LinkedItem } from '~/types/chat'
import type { GhItem, GhMergeMethod } from '~/types/ipc'
import type { MenuItem } from '~/types/ui'
import { useLinks } from '~/stores/links'

/**
 * Merging an open pull request from the Pull requests tool window: whether GitHub would take it
 * now, and the merge button with the methods the repository allows. Merging asks once more first:
 * it changes the base branch on GitHub for everyone.
 */
const props = defineProps<{ link: LinkedItem; item: GhItem; projectPath: string }>()
const links = useLinks()

const METHODS: Record<GhMergeMethod, { action: string; label: string; hint: string }> = {
  squash: { action: 'Squash and merge', label: 'Squash and merge', hint: 'All commits become one' },
  merge: { action: 'Merge', label: 'Create a merge commit', hint: 'Keeps every commit, adds a merge commit' },
  rebase: { action: 'Rebase and merge', label: 'Rebase and merge', hint: 'Replays each commit onto the base' },
}

const allowed = computed(() => props.item.mergeMethods)
const pick = () => (props.item.defaultMergeMethod && allowed.value.includes(props.item.defaultMergeMethod)
  ? props.item.defaultMergeMethod
  : allowed.value[0] ?? 'squash')
const method = ref<GhMergeMethod>(pick())
watch(allowed, () => { if (!allowed.value.includes(method.value)) method.value = pick() })

const menu = computed<MenuItem[]>(() => allowed.value.map(m => ({
  label: METHODS[m].label,
  hint: METHODS[m].hint,
  checked: m === method.value,
  onSelect: () => { method.value = m },
})))

type Tone = 'done' | 'running' | 'queued' | 'error' | 'idle'
/** What GitHub says about merging it now, and whether the button may be pressed at all. */
const status = computed<{ tone: Tone; text: string; ready: boolean }>(() => {
  const it = props.item
  const base = it.baseRef ?? 'the base branch'
  const running = it.checkRuns.some(c => c.state === 'pending') || (!it.checkRuns.length && it.checks === 'pending')
  if (it.state === 'draft') return { tone: 'idle', text: 'Still a draft. Mark it ready for review on GitHub to merge it.', ready: false }
  if (it.mergeable === 'conflicting' || it.mergeState === 'dirty') return { tone: 'error', text: `Conflicts with ${base}. Resolve them before merging.`, ready: false }
  if (!it.mergeState || it.mergeState === 'unknown' || it.mergeable === 'unknown') return { tone: 'running', text: 'GitHub is working out whether it can be merged.', ready: false }
  if (it.mergeState === 'blocked') return { tone: 'error', text: running ? 'Blocked until required checks pass.' : 'Blocked by branch protection: it needs approvals or passing required checks.', ready: true }
  if (it.mergeState === 'behind') return { tone: 'queued', text: `Behind ${base}, but it can still be merged.`, ready: true }
  if (it.mergeState === 'unstable') {
    return running
      ? { tone: 'running', text: 'Checks are still running. It can be merged anyway.', ready: true }
      : { tone: 'error', text: 'Some checks failed. It can still be merged.', ready: true }
  }
  return { tone: 'done', text: 'Ready to merge.', ready: true }
})
const ICON = { done: CircleCheck, running: CircleDashed, queued: CircleAlert, error: CircleX, idle: CircleAlert }

const failing = computed(() => props.item.checkRuns.filter(c => c.state === 'failure' || c.state === 'cancelled').length)
const asking = ref(false)
const busy = ref(false)
const error = ref<string | null>(null)
const confirmBtn = ref<{ $el: HTMLElement } | null>(null)

async function ask() {
  error.value = null
  asking.value = true
  await nextTick()
  confirmBtn.value?.$el.focus()
}
async function merge() {
  if (busy.value) return
  busy.value = true
  error.value = null
  try {
    await links.merge(props.link, props.projectPath, method.value)
    asking.value = false
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
    asking.value = false
  } finally {
    busy.value = false
  }
}
// The branch moved or the method changed under an open question: ask again with what is true now.
watch(() => [props.item.headSha, method.value], () => { if (!busy.value) asking.value = false })
</script>

<template>
  <section class="lm" aria-label="Merge">
    <p class="lm__status" :class="`is-${status.tone}`">
      <component :is="ICON[status.tone]" class="lm__icon" aria-hidden="true" />
      <span>{{ status.text }}</span>
    </p>

    <p v-if="!item.canMerge" class="lm__note">The account gh is signed in with cannot merge pull requests in {{ item.owner }}/{{ item.repo }}.</p>
    <p v-else-if="!allowed.length" class="lm__note">GitHub did not say which merge methods this repository allows; merge it on GitHub.</p>

    <div
      v-else-if="asking"
      class="lm__ask"
      role="alertdialog"
      aria-labelledby="lm-ask-text"
      @keydown.esc.stop.prevent="asking = false"
    >
      <p id="lm-ask-text">
        {{ METHODS[method].label }} #{{ item.number }} into <code>{{ item.baseRef ?? 'the base branch' }}</code> on GitHub?
        <template v-if="failing"> {{ failing }} check{{ failing === 1 ? ' has' : 's have' }} not passed.</template>
      </p>
      <div class="lm__btns">
        <UiButton size="sm" variant="ghost" :disabled="busy || undefined" @click="asking = false">Cancel</UiButton>
        <UiButton ref="confirmBtn" size="sm" variant="primary" :loading="busy" @click="merge"><GitMerge v-if="!busy" aria-hidden="true" />{{ METHODS[method].action }}</UiButton>
      </div>
    </div>

    <div v-else class="lm__btns">
      <UiButton size="sm" variant="primary" :disabled="!status.ready || undefined" :title="METHODS[method].hint" @click="ask">
        <GitMerge aria-hidden="true" />{{ METHODS[method].action }}
      </UiButton>
      <UiMenu v-if="allowed.length > 1" :items="menu" placement="top-end" :width="280" label="Merge method">
        <template #default="{ toggle, open: menuOpen }">
          <UiIconButton size="sm" label="Choose the merge method" :active="menuOpen" class="lm__more" @click="toggle"><ChevronDown /></UiIconButton>
        </template>
      </UiMenu>
    </div>

    <p v-if="error" class="lm__error selectable" role="alert">{{ error }}</p>
  </section>
</template>

<style scoped>
.lm {
  flex: none;
  display: grid;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border-top: 1px solid var(--line-soft);
}
.lm__status { display: flex; align-items: flex-start; gap: 6px; margin: 0; font-size: var(--text-xs); line-height: 18px; color: var(--fg-muted); }
.lm__icon { flex: none; width: 13px; height: 13px; margin-top: 2.5px; stroke-width: 2; }
.lm__status.is-done .lm__icon { color: var(--ripe-done); }
.lm__status.is-running .lm__icon { color: var(--ripe-running); animation: lm-turn 2.4s linear infinite; }
.lm__status.is-queued .lm__icon { color: var(--ripe-queued); }
.lm__status.is-error .lm__icon { color: var(--ripe-error); }
.lm__status.is-idle .lm__icon { color: var(--fg-faint); }
@keyframes lm-turn { to { transform: rotate(360deg); } }

.lm__note { margin: 0; font-size: var(--text-xs); color: var(--fg-subtle); }

.lm__btns { display: flex; align-items: center; justify-content: flex-end; gap: 2px; }
.lm__btns :deep(svg) { width: 14px; height: 14px; stroke-width: 1.85; }
.lm__ask .lm__btns { gap: var(--space-1); margin-top: var(--space-2); }
.lm__more { height: 26px; }

.lm__ask {
  padding: var(--space-2) var(--space-2) var(--space-2) var(--space-3);
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
  background: var(--bg-raised);
}
.lm__ask p { margin: 0; font-size: var(--text-xs); line-height: var(--leading-normal); color: var(--fg-muted); overflow-wrap: anywhere; }
.lm__ask code {
  padding: 0 4px;
  border-radius: var(--radius-xs);
  background: var(--bg-hover);
  border: 1px solid var(--line-soft);
  font-size: var(--text-2xs);
  color: var(--fg);
}

.lm__error { margin: 0; font-size: var(--text-xs); color: var(--ripe-error-fg); overflow-wrap: anywhere; }
</style>
