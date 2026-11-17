<script setup lang="ts">
import { CircleCheck, Eye, MessageSquarePlus, MessagesSquare, RefreshCw, RotateCcw } from 'lucide-vue-next'
import type { Component } from 'vue'
import type { PlasticReview, PlasticReviewStatus } from '~/types/ipc'
import { useReviews } from '~/stores/reviews'
import { shortAgo, useNow } from '~/utils/time'

/**
 * The Pull requests tool window for a Unity VCS workspace: its code reviews instead of GitHub's
 * pull requests. The reviews of the branch in view come first, then the repository's open ones;
 * "Request a review" asks Unity VCS for a review of the branch (`cm codereview`). Reviews are read
 * here and worked on in Unity VCS itself.
 */

const props = defineProps<{ path: string }>()

const reviews = useReviews()
const state = computed(() => reviews.byPath[props.path])
const data = computed(() => state.value?.data ?? null)
const refreshing = computed(() => !!(state.value?.loading && data.value))
const now = useNow()

watch(() => props.path, (path) => { void reviews.load(path) }, { immediate: true })
function refresh() { void reviews.load(props.path, true) }

/* A review's status in the ripening scale: under review is ripening, rework needs the owner, reviewed is ripe. */
const STATUS: Record<PlasticReviewStatus, { word: string; tone: 'running' | 'waiting' | 'done'; icon: Component }> = {
  underReview: { word: 'Under review', tone: 'running', icon: Eye },
  reworkRequired: { word: 'Rework required', tone: 'waiting', icon: RotateCcw },
  reviewed: { word: 'Reviewed', tone: 'done', icon: CircleCheck },
}
/** Reviewers, or the single assignee older reviews have. */
const people = (r: PlasticReview) =>
  r.reviewers.length ? r.reviewers : r.assignee ? [{ name: r.assignee, status: r.status }] : []
/** A Unity Cloud user name is an email: the part before `@` is enough in a narrow list. */
const short = (name: string) => (name.includes('@') ? name.slice(0, name.indexOf('@')) : name)
const when = (r: PlasticReview) => r.modified ?? r.created
const tooltip = (r: PlasticReview) => [
  `${r.title || 'Untitled review'} (#${r.id})`,
  `${STATUS[r.status].word}, asked by ${r.owner || 'unknown'}`,
  r.target ? `For ${r.target}` : null,
  ...people(r).map(p => `${p.name}: ${STATUS[p.status].word}`),
].filter(Boolean).join('\n')

/* ---------- requesting a review ---------- */
const asking = ref(false)
const title = ref('')
const who = ref('')
const askError = ref<string | null>(null)
const askBusy = ref(false)
const titleInput = ref<HTMLInputElement | null>(null)

/** A first title from the branch's last part: `/main/feature/inventory` reads "Inventory". */
function titleFor(branch: string | null) {
  const leaf = branch?.split('/').filter(Boolean).pop() ?? ''
  const words = leaf.replace(/[-_]+/g, ' ').trim()
  return words ? words[0]!.toUpperCase() + words.slice(1) : ''
}
async function startAsk() {
  asking.value = !asking.value
  askError.value = null
  if (asking.value) {
    if (!title.value) title.value = titleFor(data.value?.branch ?? null)
    await nextTick()
    titleInput.value?.select()
  }
}
function cancelAsk() {
  asking.value = false
  title.value = ''
  who.value = ''
  askError.value = null
}
async function submitAsk() {
  if (!title.value.trim() || askBusy.value) return
  askBusy.value = true
  askError.value = null
  try {
    await reviews.request(props.path, title.value, who.value)
    cancelAsk()
  } catch (e) {
    askError.value = e instanceof Error ? e.message : String(e)
  } finally {
    askBusy.value = false
  }
}
// Another workspace: a half-typed request does not follow.
watch(() => props.path, cancelAsk)
</script>

<template>
  <section class="lr" aria-label="Code reviews">
    <header class="lr__head">
      <h2 class="lr__title" :title="data?.repository ?? undefined">Code reviews</h2>
      <div class="lr__tools">
        <UiIconButton label="Refresh" :disabled="state?.loading || undefined" @click="refresh"><RefreshCw :class="{ 'is-spinning': refreshing }" /></UiIconButton>
        <UiIconButton v-if="data?.branch" label="Request a review of this branch" :active="asking" @click="startAsk"><MessageSquarePlus /></UiIconButton>
      </div>
    </header>

    <form v-if="asking && data?.branch" class="lr__ask" @submit.prevent="submitAsk">
      <label class="lr__label" for="lr-title">Title</label>
      <input
        id="lr-title"
        ref="titleInput"
        v-model="title"
        class="lr__input"
        maxlength="200"
        autocomplete="off"
        @keydown.esc.prevent="cancelAsk"
      >
      <label class="lr__label" for="lr-who">Reviewers <span class="lr__optional">optional</span></label>
      <input
        id="lr-who"
        v-model="who"
        class="lr__input"
        :class="{ 'is-invalid': askError }"
        placeholder="maria, leads"
        spellcheck="false"
        autocomplete="off"
        :aria-invalid="!!askError || undefined"
        :aria-describedby="askError ? 'lr-ask-error' : 'lr-ask-hint'"
        @keydown.esc.prevent="cancelAsk"
      >
      <p v-if="askError" id="lr-ask-error" class="lr__ask-error selectable" role="alert">{{ askError }}</p>
      <p v-else id="lr-ask-hint" class="lr__ask-hint">Unity VCS users or groups, separated by commas. The review is for <code>{{ data.branch }}</code>.</p>
      <div class="lr__ask-row">
        <UiButton type="submit" variant="primary" size="sm" :loading="askBusy" :disabled="!title.trim() || undefined">Request review</UiButton>
        <UiButton size="sm" variant="ghost" @click="cancelAsk">Cancel</UiButton>
      </div>
    </form>

    <div class="lr__scroll">
      <p v-if="state?.error" class="lr__error selectable" role="alert">{{ state.error }}</p>

      <div v-if="!data && state?.loading" class="lr__skeleton" aria-busy="true" aria-label="Reading code reviews from Unity VCS">
        <span style="width: 70%" /><span style="width: 45%" /><span style="width: 80%" /><span style="width: 55%" />
      </div>

      <template v-else-if="data">
        <section class="lr__group" aria-labelledby="lr-branch">
          <h3 id="lr-branch" class="lr__group-title">
            This branch
            <code v-if="data.branch" class="lr__branch" :title="data.branch">{{ data.branch }}</code>
          </h3>
          <p v-if="!data.branch" class="lr__empty">The workspace is on a changeset or label, not a branch.</p>
          <div v-else-if="!data.branchReviews.length" class="lr__empty">
            <p>No review of this branch yet. When the work is ready, ask for one and it shows up here.</p>
            <UiButton v-if="!asking" size="sm" @click="startAsk"><MessageSquarePlus aria-hidden="true" />Request a review</UiButton>
          </div>
          <ul v-else class="lr__list">
            <li v-for="r in data.branchReviews" :key="r.id" class="lr__row" :title="tooltip(r)">
              <component :is="STATUS[r.status].icon" class="lr__icon" :class="`is-${STATUS[r.status].tone}`" aria-hidden="true" />
              <div class="lr__text">
                <span class="lr__name selectable">{{ r.title || 'Untitled review' }}</span>
                <span class="lr__sub">
                  <span class="lr__state" :class="`is-${STATUS[r.status].tone}`">{{ STATUS[r.status].word }}</span>
                  <span class="tabular">#{{ r.id }}</span>
                  <span v-if="r.targetType === 'changeset' && r.target"><code>{{ r.target }}</code></span>
                  <span v-if="when(r)" class="tabular">{{ shortAgo(when(r), now) }}</span>
                  <span v-if="r.unresolved" class="lr__count tabular" :title="`${r.unresolved} open change requests or questions`"><MessagesSquare aria-hidden="true" />{{ r.unresolved }} unresolved</span>
                </span>
                <span v-if="people(r).length" class="lr__people">
                  <span v-for="p in people(r)" :key="p.name" class="lr__person" :title="`${p.name}: ${STATUS[p.status].word}`">
                    <component :is="STATUS[p.status].icon" :class="`is-${STATUS[p.status].tone}`" aria-hidden="true" />{{ short(p.name) }}
                  </span>
                </span>
              </div>
            </li>
          </ul>
        </section>

        <section class="lr__group" aria-labelledby="lr-open">
          <h3 id="lr-open" class="lr__group-title">
            Open in the repository
            <span v-if="data.open.length" class="lr__group-count tabular">{{ data.open.length }}{{ data.more ? '+' : '' }}</span>
          </h3>
          <p v-if="!data.open.length" class="lr__empty">Nothing else is under review or waiting for rework{{ data.repository ? ` in ${data.repository}` : '' }}.</p>
          <ul v-else class="lr__list">
            <li v-for="r in data.open" :key="r.id" class="lr__row" :title="tooltip(r)">
              <component :is="STATUS[r.status].icon" class="lr__icon" :class="`is-${STATUS[r.status].tone}`" aria-hidden="true" />
              <div class="lr__text">
                <span class="lr__name selectable">{{ r.title || 'Untitled review' }}</span>
                <span class="lr__sub">
                  <span class="lr__state" :class="`is-${STATUS[r.status].tone}`">{{ STATUS[r.status].word }}</span>
                  <span class="tabular">#{{ r.id }}</span>
                  <span class="lr__by">{{ short(r.owner) }}</span>
                  <span v-if="when(r)" class="tabular">{{ shortAgo(when(r), now) }}</span>
                </span>
                <span v-if="r.target" class="lr__target"><code>{{ r.target }}</code></span>
                <span v-if="people(r).length" class="lr__people">
                  <span v-for="p in people(r)" :key="p.name" class="lr__person" :title="`${p.name}: ${STATUS[p.status].word}`">
                    <component :is="STATUS[p.status].icon" :class="`is-${STATUS[p.status].tone}`" aria-hidden="true" />{{ short(p.name) }}
                  </span>
                </span>
              </div>
            </li>
          </ul>
          <p v-if="data.more" class="lr__empty">Showing the newest {{ data.open.length }}. Unity VCS lists the rest.</p>
        </section>
      </template>
    </div>
  </section>
</template>

<style scoped>
.lr { display: flex; flex-direction: column; flex: 1; min-height: 0; }
.lr__head {
  flex: none;
  display: flex;
  align-items: center;
  gap: var(--space-1);
  height: var(--tabbar-h);
  padding: 0 var(--space-2) 0 var(--space-3);
}
.lr__title {
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
.lr__tools { flex: none; display: flex; align-items: center; gap: 2px; }
.is-spinning { animation: lr-turn 0.9s linear infinite; }
@keyframes lr-turn { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .is-spinning { animation: none; } }

.lr__ask { flex: none; display: grid; gap: 6px; padding: var(--space-2) var(--space-3) var(--space-3); border-top: 1px solid var(--line-soft); }
.lr__label { font-size: var(--text-xs); font-weight: 560; color: var(--fg-muted); }
.lr__label + .lr__input { margin-bottom: 4px; }
.lr__optional { font-weight: 400; color: var(--fg-faint); }
.lr__input {
  min-width: 0;
  height: 32px;
  padding: 0 var(--space-3);
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--bg-inset);
  font-size: var(--text-sm);
  color: var(--fg);
  caret-color: var(--accent);
  outline: none;
  transition: border-color var(--dur-fast) var(--ease-out), box-shadow var(--dur-fast) var(--ease-out);
}
.lr__input::placeholder { color: var(--fg-faint); }
.lr__input:focus { border-color: var(--accent-line); box-shadow: 0 0 0 3px var(--accent-soft); }
.lr__input.is-invalid { border-color: color-mix(in oklch, var(--ripe-error) 60%, transparent); }
.lr__ask-hint, .lr__ask-error { margin: 0; font-size: var(--text-xs); color: var(--fg-faint); overflow-wrap: anywhere; }
.lr__ask-hint code { font-size: 0.95em; color: var(--fg-subtle); }
.lr__ask-error { color: var(--ripe-error-fg); white-space: pre-wrap; }
.lr__ask-row { display: flex; align-items: center; gap: var(--space-1); margin-top: 4px; }

.lr__scroll { flex: 1; min-height: 0; overflow: auto; border-top: 1px solid var(--line-soft); padding-bottom: var(--space-3); }
.lr__error {
  margin: var(--space-3) var(--space-3) 0;
  padding: var(--space-2) var(--space-3);
  border: 1px solid color-mix(in oklch, var(--ripe-error) 45%, transparent);
  border-radius: var(--radius-md);
  background: color-mix(in oklch, var(--ripe-error) 10%, transparent);
  font-size: var(--text-xs);
  color: var(--ripe-error-fg);
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}
.lr__skeleton { display: grid; gap: 12px; padding: var(--space-4) var(--space-4) 0; }
.lr__skeleton span { height: 10px; border-radius: var(--radius-xs); background: var(--bg-hover); }

.lr__group { padding-top: var(--space-3); }
.lr__group + .lr__group { margin-top: var(--space-2); border-top: 1px solid var(--line-soft); }
.lr__group-title {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
  min-width: 0;
  margin: 0;
  padding: 0 var(--space-4) var(--space-1);
  font-size: var(--text-xs);
  font-weight: 600;
  color: var(--fg-muted);
  white-space: nowrap;
}
.lr__branch { min-width: 0; overflow: hidden; text-overflow: ellipsis; font-size: var(--text-xs); font-weight: 400; color: var(--fg-subtle); }
.lr__group-count { font-weight: 500; color: var(--fg-faint); }

.lr__empty { display: grid; gap: var(--space-2); justify-items: start; margin: 0; padding: var(--space-1) var(--space-4) 0; font-size: var(--text-sm); color: var(--fg-subtle); }
.lr__empty p { margin: 0; max-width: 46ch; }
.lr__empty :deep(svg) { width: 14px; height: 14px; stroke-width: 1.85; }

.lr__list { margin: 0; padding: 0 var(--space-2); list-style: none; display: grid; gap: 2px; }
.lr__row {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  padding: 6px var(--space-2);
}
.lr__icon { flex: none; width: 15px; height: 15px; margin-top: 2px; stroke-width: 1.85; }
.lr__text { display: grid; gap: 2px; min-width: 0; }
.lr__name { font-size: var(--text-sm); color: var(--fg); font-weight: 520; overflow-wrap: anywhere; }
.lr__sub, .lr__people { display: flex; flex-wrap: wrap; column-gap: 6px; row-gap: 1px; min-width: 0; font-size: var(--text-xs); color: var(--fg-faint); }
.lr__state { font-weight: 560; }
.lr__count { display: inline-flex; align-items: center; gap: 3px; color: var(--fg-subtle); }
.lr__count svg { width: 12px; height: 12px; stroke-width: 1.85; }
.lr__by { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.lr__target { min-width: 0; font-size: var(--text-xs); color: var(--fg-subtle); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.lr__sub code, .lr__target code { font-size: var(--text-xs); }
.lr__people { column-gap: var(--space-2); color: var(--fg-subtle); }
.lr__person { display: inline-flex; align-items: center; gap: 3px; }
.lr__person svg { width: 12px; height: 12px; stroke-width: 2; }

.is-running { color: var(--ripe-running-fg); }
.lr__icon.is-running, .lr__person .is-running { color: var(--ripe-running); }
.is-waiting { color: var(--ripe-waiting-fg); }
.lr__icon.is-waiting, .lr__person .is-waiting { color: var(--ripe-waiting); }
.is-done { color: var(--ripe-done-fg); }
.lr__icon.is-done, .lr__person .is-done { color: var(--ripe-done); }
</style>
