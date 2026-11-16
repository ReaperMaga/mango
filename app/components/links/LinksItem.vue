<script setup lang="ts">
import { ArrowRight, MessageSquare } from 'lucide-vue-next'
import type { LinkedItem } from '~/types/chat'
import type { LinkDetail } from '~/stores/links'
import { openExternal } from '~/composables/useBackend'
import { safeHtml } from '~/utils/safeHtml'
import { shortAgo, useNow } from '~/utils/time'
import { stateOf } from '~/utils/linkState'

/**
 * One pull request or issue in the Pull requests tool window: its state, title, who opened it,
 * branches, checks and labels, then the description as GitHub renders it, pictures included.
 * Its actions sit in the tool window's footer (LinksPanel), so a long description never hides them.
 */
const props = defineProps<{ link: LinkedItem; detail: LinkDetail | undefined }>()

const now = useNow()
const item = computed(() => props.detail?.item ?? null)
const state = computed(() => stateOf(item.value?.kind ?? props.link.kind, item.value?.state ?? props.link.state, item.value?.stateReason))
const title = computed(() => item.value?.title ?? props.link.title ?? `#${props.link.number}`)
const body = computed(() => safeHtml(item.value?.bodyHtml ?? ''))
const opened = computed(() => (item.value?.createdAt ? shortAgo(Date.parse(item.value.createdAt), now.value) : null))

const CHECKS = { success: 'Passed', failure: 'Failed', pending: 'Running' } as const
const REVIEW = { approved: 'Approved', changes_requested: 'Changes requested', review_required: 'Required' } as const
const checks = computed(() => item.value?.checks ?? null)
const review = computed(() => item.value?.reviewDecision ?? null)

const labelColor = (hex: string) => (/^[0-9a-f]{6}$/i.test(hex) ? `#${hex}` : 'var(--fg-faint)')

/** Links in the description open in the browser, never inside Mango's window. */
function onBodyClick(e: MouseEvent) {
  const a = (e.target as HTMLElement | null)?.closest?.('a[href]') as HTMLAnchorElement | null
  if (!a) return
  e.preventDefault()
  if (/^(https?:|mailto:)/i.test(a.href)) openExternal(a.href).catch(() => {})
}
</script>

<template>
  <article class="li" :aria-label="`${state.noun} #${link.number}`">
    <div class="li__top">
      <span class="li__state" :class="`is-${state.tone}`">
        <component :is="state.icon" aria-hidden="true" />
        <span>{{ state.word }}</span>
      </span>
      <span class="li__ref" :title="link.url">{{ link.owner }}/{{ link.repo }} #{{ link.number }}</span>
    </div>

    <h3 class="li__title selectable">{{ title }}</h3>

    <p v-if="item" class="li__meta">
      <img v-if="item.author?.avatarUrl" class="li__avatar" :src="item.author.avatarUrl" alt="" referrerpolicy="no-referrer">
      <span><strong>{{ item.author?.login ?? 'Someone' }}</strong> opened {{ opened === 'now' ? 'just now' : `${opened} ago` }}</span>
      <span v-if="item.comments" class="li__comments tabular" :title="`${item.comments} comment${item.comments === 1 ? '' : 's'}`">
        <MessageSquare aria-hidden="true" />{{ item.comments }}
      </span>
    </p>

    <dl v-if="item?.kind === 'pr'" class="li__facts">
      <div v-if="item.headRef && item.baseRef" class="li__fact">
        <dt>Branch</dt>
        <dd class="li__branches">
          <code class="li__branch" :title="item.headRef">{{ item.headRef }}</code>
          <ArrowRight class="li__into" aria-label="into" />
          <code class="li__branch" :title="item.baseRef">{{ item.baseRef }}</code>
        </dd>
      </div>
      <div v-if="item.changedFiles !== null" class="li__fact">
        <dt>Changes</dt>
        <dd class="tabular">
          <span class="li__add">+{{ item.additions }}</span>
          <span class="li__del">−{{ item.deletions }}</span>
          <span class="li__files">in {{ item.changedFiles }} file{{ item.changedFiles === 1 ? '' : 's' }}</span>
        </dd>
      </div>
      <div v-if="checks" class="li__fact">
        <dt>Checks</dt>
        <dd class="li__status"><span :class="`is-${checks}`">{{ CHECKS[checks] }}</span></dd>
      </div>
      <div v-if="review" class="li__fact">
        <dt>Review</dt>
        <dd class="li__status"><span :class="`is-${review}`">{{ REVIEW[review] }}</span></dd>
      </div>
    </dl>

    <ul v-if="item?.labels.length" class="li__labels" aria-label="Labels">
      <li v-for="l in item.labels" :key="l.name" class="li__label">
        <span class="li__label-dot" :style="{ background: labelColor(l.color) }" aria-hidden="true" />{{ l.name }}
      </li>
    </ul>

    <p v-if="detail?.error" class="li__error selectable" role="alert">
      {{ item ? 'Could not refresh: ' : '' }}{{ detail.error }}
    </p>

    <div v-if="!item && detail?.loading" class="li__skeleton" aria-busy="true" aria-label="Reading from GitHub">
      <span v-for="w in [62, 88, 74, 40, 81, 56]" :key="w" :style="{ width: `${w}%` }" />
    </div>
    <template v-else-if="item">
      <!-- eslint-disable-next-line vue/no-v-html -- sanitised by safeHtml: allow-listed tags, https links and pictures only -->
      <div v-if="body" class="li__body selectable" @click="onBodyClick" v-html="body" />
      <p v-else class="li__empty">No description.</p>
    </template>

  </article>
</template>

<style scoped>
.li { display: flex; flex-direction: column; gap: var(--space-2); padding: var(--space-3) var(--space-4) var(--space-6); }

.li__top { display: flex; align-items: center; gap: var(--space-2); min-width: 0; font-size: var(--text-xs); }
.li__state { flex: none; display: inline-flex; align-items: center; gap: 5px; font-weight: 560; }
.li__state svg { width: 14px; height: 14px; stroke-width: 1.85; }
.li__ref { min-width: 0; margin-left: auto; color: var(--fg-faint); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-variant-numeric: tabular-nums; }

/* Ripeness: an open item is ripening, a draft not yet ripe, merged or done is ripe, closed unmerged is bruised. */
.is-running svg { color: var(--ripe-running); }
.is-running { color: var(--ripe-running-fg); }
.is-queued svg { color: var(--ripe-queued); }
.is-queued { color: var(--ripe-queued-fg); }
.is-done svg { color: var(--ripe-done); }
.is-done { color: var(--ripe-done-fg); }
.is-error svg { color: var(--ripe-error); }
.is-error { color: var(--ripe-error-fg); }
.is-idle, .is-idle svg { color: var(--fg-subtle); }

.li__title {
  margin: 0;
  font-size: var(--text-lg);
  font-weight: 620;
  line-height: var(--leading-tight);
  letter-spacing: -0.01em;
  color: var(--fg);
  overflow-wrap: anywhere;
  text-wrap: balance;
}

.li__meta { display: flex; align-items: center; gap: var(--space-2); margin: 0; font-size: var(--text-xs); color: var(--fg-subtle); }
.li__meta strong { font-weight: 560; color: var(--fg-muted); }
.li__avatar { width: 16px; height: 16px; border-radius: 50%; flex: none; background: var(--bg-hover); }
.li__comments { display: inline-flex; align-items: center; gap: 3px; margin-left: auto; }
.li__comments svg { width: 12px; height: 12px; stroke-width: 1.85; }

.li__facts { display: grid; gap: 4px; margin: var(--space-1) 0 0; padding: var(--space-2) 0; border-block: 1px solid var(--line-soft); }
.li__fact { display: grid; grid-template-columns: 64px 1fr; align-items: center; gap: var(--space-2); min-height: 22px; font-size: var(--text-xs); }
.li__fact dt { color: var(--fg-faint); }
.li__fact dd { display: flex; align-items: center; gap: var(--space-2); min-width: 0; margin: 0; color: var(--fg-muted); }
.li__fact .li__branches { gap: 4px; }
.li__branch {
  min-width: 0;
  max-width: 50%;
  height: 18px;
  padding: 0 5px;
  border-radius: var(--radius-xs);
  background: var(--bg-hover);
  border: 1px solid var(--line-soft);
  font-size: var(--text-2xs);
  line-height: 16px;
  color: var(--fg-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.li__into { flex: none; width: 12px; height: 12px; color: var(--fg-faint); }
.li__add { color: var(--diff-add-fg); }
.li__del { color: var(--diff-del-fg); }
.li__files { color: var(--fg-subtle); }
.li__status > span { min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.li__status .is-success, .li__status .is-approved { color: var(--ripe-done-fg); }
.li__status .is-failure, .li__status .is-changes_requested { color: var(--ripe-error-fg); }
.li__status .is-pending { color: var(--ripe-running-fg); }
.li__status .is-review_required { color: var(--fg-subtle); }

.li__labels { display: flex; flex-wrap: wrap; gap: 4px; margin: 0; padding: 0; list-style: none; }
.li__label {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 20px;
  padding: 0 7px;
  border: 1px solid var(--line);
  border-radius: var(--radius-pill);
  font-size: var(--text-2xs);
  font-weight: 540;
  color: var(--fg-muted);
}
.li__label-dot { width: 7px; height: 7px; border-radius: 50%; flex: none; }

.li__error {
  margin: 0;
  padding: var(--space-2) var(--space-3);
  border: 1px solid color-mix(in oklch, var(--ripe-error) 45%, transparent);
  border-radius: var(--radius-md);
  background: color-mix(in oklch, var(--ripe-error) 10%, transparent);
  font-size: var(--text-xs);
  color: var(--ripe-error-fg);
  overflow-wrap: anywhere;
}

.li__skeleton { display: grid; gap: 12px; padding-top: var(--space-3); }
.li__skeleton span { height: 10px; border-radius: var(--radius-xs); background: var(--bg-hover); }
.li__empty { margin: var(--space-2) 0 0; font-size: var(--text-sm); color: var(--fg-faint); }


/* The description, as GitHub renders it: the chat's prose styles, a step smaller for a side panel. */
.li__body { margin-top: var(--space-2); font-size: var(--text-sm); line-height: var(--leading-chat); color: var(--fg); overflow-wrap: anywhere; }
.li__body :deep(> *:first-child) { margin-top: 0; }
.li__body :deep(> *:last-child) { margin-bottom: 0; }
.li__body :deep(p) { margin: 0 0 0.7em; }
.li__body :deep(ul), .li__body :deep(ol) { margin: 0 0 0.8em; padding-left: 1.3em; }
.li__body :deep(li) { margin: 0.2em 0; }
.li__body :deep(li::marker) { color: var(--fg-faint); }
.li__body :deep(li:has(> input[type='checkbox'])) { list-style: none; margin-left: -1.3em; }
.li__body :deep(input[type='checkbox']) {
  appearance: none;
  position: relative;
  width: 13px;
  height: 13px;
  margin: 0 7px 0 0;
  vertical-align: -2px;
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-xs);
  background: var(--bg-inset);
  opacity: 1;
}
.li__body :deep(input[type='checkbox']:checked) { border-color: var(--accent); background: var(--accent); }
/* The tick: two borders of a small box, turned. */
.li__body :deep(input[type='checkbox']:checked::after) {
  content: '';
  position: absolute;
  left: 3.5px;
  top: 0.5px;
  width: 3.5px;
  height: 7px;
  border: solid var(--accent-fg);
  border-width: 0 1.75px 1.75px 0;
  transform: rotate(45deg);
}
.li__body :deep(h1), .li__body :deep(h2), .li__body :deep(h3), .li__body :deep(h4) { font-size: var(--text-md); font-weight: 640; margin: 1.2em 0 0.4em; letter-spacing: -0.01em; }
.li__body :deep(h5), .li__body :deep(h6) { font-size: var(--text-sm); font-weight: 640; margin: 1em 0 0.3em; }
.li__body :deep(strong), .li__body :deep(b) { font-weight: 640; }
.li__body :deep(a) { color: var(--accent-ink); }
.li__body :deep(code) { font-size: 0.9em; padding: 0.1em 0.35em; border-radius: var(--radius-xs); background: var(--bg-hover); border: 1px solid var(--line-soft); }
.li__body :deep(pre) {
  margin: 0 0 0.8em;
  padding: var(--space-3);
  background: var(--bg-inset);
  border: 1px solid var(--line-soft);
  border-radius: var(--radius-md);
  overflow-x: auto;
  font-size: var(--text-xs);
  line-height: 1.55;
}
.li__body :deep(pre code) { padding: 0; border: 0; background: none; font-size: inherit; }
.li__body :deep(blockquote) { margin: 0 0 0.8em; padding-left: var(--space-3); border-left: 1px solid var(--line-strong); color: var(--fg-muted); }
.li__body :deep(hr) { border: 0; height: 1px; background: var(--line-soft); margin: 1.2em 0; }
.li__body :deep(table) { display: block; max-width: 100%; overflow-x: auto; border-collapse: collapse; margin: 0 0 0.8em; font-size: var(--text-xs); font-variant-numeric: tabular-nums; }
.li__body :deep(th), .li__body :deep(td) { padding: 4px 8px; border-bottom: 1px solid var(--line-soft); text-align: left; }
.li__body :deep(th) { color: var(--fg-muted); font-weight: 600; }
.li__body :deep(img), .li__body :deep(video) {
  display: block;
  max-width: 100%;
  height: auto;
  margin: var(--space-1) 0;
  border: 1px solid var(--line-soft);
  border-radius: var(--radius-md);
  background: var(--bg-inset);
}
.li__body :deep(a:has(img)) { display: inline-block; max-width: 100%; }
.li__body :deep(a:hover img) { border-color: var(--line-strong); }
.li__body :deep(details) { margin: 0 0 0.8em; }
.li__body :deep(summary) { cursor: default; color: var(--fg-muted); }
.li__body :deep(kbd) { font-family: var(--font-mono); font-size: var(--text-2xs); padding: 1px 5px; border: 1px solid var(--line-soft); border-radius: var(--radius-xs); background: var(--bg-hover); }
</style>
