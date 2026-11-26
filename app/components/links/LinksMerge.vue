<script setup lang="ts">
import { ChevronDown, CircleAlert, CircleCheck, CircleDashed, CircleX, GitMerge, LoaderCircle } from 'lucide-vue-next'
import type { LinkedItem } from '~/types/chat'
import type { GhItem, GhMergeMethod } from '~/types/ipc'
import type { MenuItem } from '~/types/ui'
import { useLinks } from '~/stores/links'
import { forgeName, itemNumber, providerOf } from '~/utils/forge'

/**
 * Merging an open pull request (or GitLab merge request) from the Pull requests tool window: whether
 * GitHub or GitLab would take it now, and the merge button with the methods the repository allows
 * (GitLab: merge or squash, never rebase here). Merging asks once more first: it changes the base
 * branch for everyone.
 */
const props = defineProps<{ link: LinkedItem; item: GhItem; projectPath: string }>()
const { t } = useI18n()
const links = useLinks()

const METHODS: GhMergeMethod[] = ['squash', 'merge', 'rebase']

const provider = computed(() => providerOf(props.item))
const forge = computed(() => forgeName(provider.value))
const allowed = computed(() => props.item.mergeMethods.filter(m => METHODS.includes(m) && (provider.value !== 'gitlab' || m !== 'rebase')))
const pick = () => (props.item.defaultMergeMethod && allowed.value.includes(props.item.defaultMergeMethod)
  ? props.item.defaultMergeMethod
  : allowed.value[0] ?? 'squash')
const method = ref<GhMergeMethod>(pick())
watch(allowed, () => { if (!allowed.value.includes(method.value)) method.value = pick() })

const menu = computed<MenuItem[]>(() => allowed.value.map(m => ({
  label: t(`links.merge.method.${m}`),
  hint: t(`links.merge.hint.${m}`),
  checked: m === method.value,
  onSelect: () => { method.value = m },
})))

type Tone = 'done' | 'running' | 'queued' | 'error' | 'idle' | 'checking'
/**
 * What the forge says about merging it now: a short title, the detail under it, and whether the button
 * may be pressed at all.
 */
const status = computed<{ tone: Tone; title: string; detail?: string; ready: boolean }>(() => {
  const it = props.item
  const base = it.baseRef
  const running = it.checkRuns.some(c => c.state === 'pending') || (!it.checkRuns.length && it.checks === 'pending')
  if (it.state === 'draft') return { tone: 'idle', title: t('links.merge.draft'), detail: t('links.merge.draftDetail', { forge: forge.value }), ready: false }
  if (it.mergeable === 'conflicting' || it.mergeState === 'dirty') return { tone: 'error', title: base ? t('links.merge.conflicts', { base }) : t('links.merge.conflictsBase'), detail: t('links.merge.conflictsDetail'), ready: false }
  if (!it.mergeState || it.mergeState === 'unknown' || it.mergeable === 'unknown') return { tone: 'checking', title: t('links.merge.checking'), detail: t('links.merge.checkingDetail', { forge: forge.value }), ready: false }
  if (it.mergeState === 'blocked') return { tone: 'error', title: t('links.merge.blocked'), detail: running ? t('links.merge.blockedRunning') : t(`links.merge.blockedDetail.${provider.value}`), ready: true }
  if (it.mergeState === 'behind') {
    return { tone: 'queued', title: base ? t('links.merge.behind', { base }) : t('links.merge.behindBase'), detail: t(`links.merge.behindDetail.${provider.value}`), ready: true }
  }
  if (it.mergeState === 'unstable') {
    return running
      ? { tone: 'running', title: t('links.merge.running'), detail: t('links.merge.runningDetail'), ready: true }
      : { tone: 'error', title: t('links.merge.failed'), detail: t('links.merge.failedDetail'), ready: true }
  }
  return { tone: 'done', title: t('links.merge.ready'), detail: base ? t('links.merge.readyDetail', { base }) : t('links.merge.readyDetailBase'), ready: true }
})
const ICON = { done: CircleCheck, running: CircleDashed, queued: CircleAlert, error: CircleX, idle: CircleAlert, checking: LoaderCircle }

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
  <section class="lm" :aria-label="t('links.merge.label')">
    <div class="lm__bar">
      <p class="lm__status" :class="`is-${status.tone}`" role="status">
        <component :is="ICON[status.tone]" class="lm__icon" aria-hidden="true" />
        <span class="lm__words">
          <span class="lm__title">{{ status.title }}</span>
          <span v-if="status.detail" class="lm__detail">{{ status.detail }}</span>
        </span>
      </p>

      <!-- One control: the action, and the method beside it when the repository allows more than one. -->
      <div v-if="item.canMerge && allowed.length && !asking" class="lm__split" :class="{ 'is-ready': status.ready, 'is-single': allowed.length < 2 }">
        <button
          type="button"
          class="lm__go"
          :disabled="!status.ready || undefined"
          :title="status.ready ? t(`links.merge.hint.${method}`) : status.title"
          @click="ask"
        >
          <GitMerge aria-hidden="true" />{{ t(`links.merge.action.${method}`) }}
        </button>
        <UiMenu v-if="allowed.length > 1" :items="menu" placement="top-end" :width="280" :label="t('links.merge.methodMenu')">
          <template #default="{ toggle, open: menuOpen }">
            <button
              type="button"
              class="lm__method"
              :class="{ 'is-open': menuOpen }"
              :aria-label="t('links.merge.chooseMethod')"
              :title="t('links.merge.chooseMethod')"
              :aria-expanded="menuOpen"
              @click="toggle"
            ><ChevronDown aria-hidden="true" /></button>
          </template>
        </UiMenu>
      </div>
    </div>

    <p v-if="!item.canMerge" class="lm__note">{{ t(`links.merge.cannot.${provider}`, { repo: `${item.owner}/${item.repo}` }) }}</p>
    <p v-else-if="!allowed.length" class="lm__note">{{ t('links.merge.noMethods', { forge }) }}</p>

    <div
      v-else-if="asking"
      class="lm__ask"
      role="alertdialog"
      aria-labelledby="lm-ask-text"
      @keydown.esc.stop.prevent="asking = false"
    >
      <p id="lm-ask-text">
        <i18n-t :keypath="`links.merge.ask.${method}`" scope="global">
          <template #number>{{ itemNumber(item) }}</template>
          <template #base><code>{{ item.baseRef ?? t('links.merge.baseBranch') }}</code></template>
          <template #forge>{{ forge }}</template>
        </i18n-t>
        <template v-if="failing">{{ ' ' }}{{ t('links.merge.notPassed', failing) }}</template>
      </p>
      <div class="lm__btns">
        <UiButton size="sm" variant="ghost" :disabled="busy || undefined" @click="asking = false">{{ t('common.actions.cancel') }}</UiButton>
        <UiButton ref="confirmBtn" size="sm" variant="primary" :loading="busy" @click="merge"><GitMerge v-if="!busy" aria-hidden="true" />{{ t(`links.merge.action.${method}`) }}</UiButton>
      </div>
    </div>

    <p v-if="error" class="lm__error selectable" role="alert">{{ error }}</p>
  </section>
</template>

<style scoped>
.lm {
  flex: none;
  display: grid;
  gap: var(--space-2);
  padding: var(--space-3);
  border-top: 1px solid var(--line-soft);
}
.lm__bar { display: flex; align-items: center; flex-wrap: wrap; gap: var(--space-2) var(--space-3); }

.lm__status { flex: 1 1 160px; min-width: 0; display: flex; align-items: flex-start; gap: var(--space-2); margin: 0; }
.lm__icon { flex: none; width: 15px; height: 15px; margin-top: 1px; stroke-width: 2; color: var(--fg-subtle); }
.lm__words { display: grid; min-width: 0; }
.lm__title { font-size: var(--text-sm); font-weight: 550; line-height: 18px; color: var(--fg); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lm__detail { font-size: var(--text-xs); line-height: 16px; color: var(--fg-subtle); }
.lm__status.is-done .lm__icon { color: var(--ripe-done); }
.lm__status.is-running .lm__icon { color: var(--ripe-running); }
.lm__status.is-queued .lm__icon { color: var(--ripe-queued); }
.lm__status.is-error .lm__icon { color: var(--ripe-error); }
.lm__status.is-checking .lm__icon { animation: lm-turn 1.1s linear infinite; }
@media (prefers-reduced-motion: reduce) { .lm__status.is-checking .lm__icon { animation: none; } }
@keyframes lm-turn { to { transform: rotate(360deg); } }

/* The split button: neutral until the forge says it can merge, then the accent fill. */
.lm__split {
  flex: none;
  display: flex;
  margin-left: auto;
  height: 28px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--bg-raised);
  overflow: hidden;
}
.lm__go, .lm__method {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 100%;
  color: var(--fg);
  font-size: var(--text-sm);
  font-weight: 550;
  white-space: nowrap;
  transition: background var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out);
}
.lm__go { padding: 0 var(--space-3) 0 10px; }
.lm__method { padding: 0 7px; border-left: 1px solid var(--line); }
.lm__go svg { width: 14px; height: 14px; stroke-width: 1.85; }
.lm__method svg { width: 14px; height: 14px; stroke-width: 2; }
.lm__go:hover:not(:disabled), .lm__method:hover, .lm__method.is-open { background: var(--bg-hover); }
.lm__go:disabled { color: var(--fg-faint); cursor: default; }
.lm__go:focus-visible, .lm__method:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: -2px; border-radius: 0; }

.lm__split.is-ready { border-color: transparent; background: var(--accent); }
.lm__split.is-ready .lm__go, .lm__split.is-ready .lm__method { color: var(--accent-fg); }
.lm__split.is-ready .lm__method { border-left-color: color-mix(in oklch, var(--accent-fg) 22%, transparent); }
.lm__split.is-ready .lm__go:hover, .lm__split.is-ready .lm__method:hover, .lm__split.is-ready .lm__method.is-open { background: var(--accent-strong); }

.lm__note { margin: 0; font-size: var(--text-xs); color: var(--fg-subtle); }

.lm__btns { display: flex; align-items: center; justify-content: flex-end; gap: var(--space-1); margin-top: var(--space-2); }
.lm__btns :deep(svg) { width: 14px; height: 14px; stroke-width: 1.85; }

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
