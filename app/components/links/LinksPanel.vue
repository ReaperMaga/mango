<script setup lang="ts">
import { ArrowLeft, ExternalLink, Link2, RefreshCw, Unlink, X } from 'lucide-vue-next'
import type { LinkedItem } from '~/types/chat'
import { useThreads } from '~/stores/threads'
import { useLinks } from '~/stores/links'
import { openExternal } from '~/composables/useBackend'
import { stateOf } from '~/utils/linkState'

/**
 * The Pull requests tool window: the pull requests and issues linked to the chat in front of
 * the user. The agent links the ones it opens (`gh pr create`); the user can link others by
 * hand. With one linked item it opens straight away, with several the list comes first.
 */

const threads = useThreads()
const links = useLinks()

/** The chat in the active pane; a sub-agent's chat stands for the chat that started it. */
const chat = computed(() => {
  const id = threads.activePane.threadId
  return id && threads.byId(id) ? threads.rootOf(id) : null
})
const list = computed<LinkedItem[]>(() => chat.value?.links ?? [])
const current = computed(() =>
  list.value.find(l => l.key === links.focused) ?? (list.value.length === 1 ? list.value[0]! : null))

watch(() => current.value?.key, () => {
  if (current.value && chat.value) void links.load(current.value, chat.value.projectPath)
}, { immediate: true })
// Titles and states of the list come from the last read; read the ones never read.
watch(list, (items) => {
  if (!chat.value) return
  for (const l of items) if (!l.title && !links.details[l.key]) void links.load(l, chat.value.projectPath)
}, { immediate: true })

function open(l: LinkedItem) { links.focused = l.key }
const currentDetail = computed(() => (current.value ? links.details[current.value.key] : undefined))
const refreshing = computed(() => !!(currentDetail.value?.loading && currentDetail.value.item && !currentDetail.value.quiet))
/** An open pull request (or draft) can be merged from here. */
const mergeable = computed(() => {
  const it = currentDetail.value?.item
  return it?.kind === 'pr' && (it.state === 'open' || it.state === 'draft') ? it : null
})

/* ---------- keeping an open pull request current ---------- */
/** While checks run or GitHub works out mergeability, look often; otherwise now and then. */
const POLL_BUSY_MS = 10_000
const POLL_IDLE_MS = 60_000
let poller: ReturnType<typeof setTimeout> | undefined

function pollDelay(): number | null {
  const it = currentDetail.value?.item
  if (!it || it.kind !== 'pr' || it.state === 'merged' || it.state === 'closed') return null
  const busy = it.checkRuns.some(c => c.state === 'pending') || it.checks === 'pending'
    || it.mergeable === 'unknown' || it.mergeState === 'unknown'
  return busy ? POLL_BUSY_MS : POLL_IDLE_MS
}
function schedule() {
  clearTimeout(poller)
  const detail = currentDetail.value
  if (!detail || detail.loading) return
  const delay = pollDelay()
  if (delay === null) return
  // Counted from the last good read, so an item opened again catches up at once; after a failed
  // read, wait the whole interval rather than ask again straight away.
  const wait = detail.error ? delay : Math.max(0, delay - (Date.now() - detail.fetchedAt))
  poller = setTimeout(poll, wait)
}
function poll() {
  // Nobody is looking at a hidden window: try again later rather than spend requests.
  if (document.hidden) { schedule(); return }
  if (current.value && chat.value) void links.load(current.value, chat.value.projectPath, true, true)
}
watch(() => [current.value?.key, currentDetail.value?.loading, currentDetail.value?.fetchedAt], schedule, { immediate: true })
onBeforeUnmount(() => clearTimeout(poller))
function back() { links.focused = null }
function refresh() { if (current.value && chat.value) void links.load(current.value, chat.value.projectPath, true) }
function unlink(l: LinkedItem) {
  if (!chat.value) return
  threads.unlink(chat.value.id, l.key)
  if (links.focused === l.key) links.focused = null
}

/* ---------- linking by hand ---------- */
const adding = ref(false)
const reference = ref('')
const addError = ref<string | null>(null)
const addBusy = ref(false)
const input = ref<HTMLInputElement | null>(null)

async function startAdd() {
  adding.value = !adding.value
  addError.value = null
  if (adding.value) { await nextTick(); input.value?.focus() }
}
function cancelAdd() {
  adding.value = false
  reference.value = ''
  addError.value = null
}
async function submitAdd() {
  if (!chat.value || !reference.value.trim() || addBusy.value) return
  addBusy.value = true
  addError.value = null
  try {
    await links.linkByReference(chat.value.id, reference.value)
    cancelAdd()
  } catch (e) {
    addError.value = e instanceof Error ? e.message : String(e)
  } finally {
    addBusy.value = false
  }
}
// Another chat, another list: a half-typed link does not follow.
watch(() => chat.value?.id, cancelAdd)
</script>

<template>
  <!-- Shown in the tool window on the right (see AppToolPanel), which owns width and resizing. -->
  <section class="lp" aria-label="Pull requests and issues">
    <header class="lp__head">
      <UiIconButton v-if="current && list.length > 1" label="All linked items" size="sm" @click="back"><ArrowLeft /></UiIconButton>
      <h2 class="lp__title" :title="chat ? `Linked to “${chat.title}”` : undefined">Pull requests</h2>
      <div v-if="chat" class="lp__tools">
        <UiIconButton label="Link a pull request or issue" :active="adding" @click="startAdd"><Link2 /></UiIconButton>
      </div>
    </header>

    <form v-if="adding && chat" class="lp__add" @submit.prevent="submitAdd">
      <label class="lp__label" for="lp-add-ref">Pull request or issue</label>
      <div class="lp__add-row">
        <input
          id="lp-add-ref"
          ref="input"
          v-model="reference"
          class="lp__input"
          :class="{ 'is-invalid': addError }"
          placeholder="Link, owner/repo#12 or #12"
          :aria-invalid="!!addError || undefined"
          :aria-describedby="addError ? 'lp-add-error' : 'lp-add-hint'"
          spellcheck="false"
          autocomplete="off"
          @keydown.esc.prevent="cancelAdd"
        >
        <UiButton type="submit" variant="primary" :loading="addBusy" :disabled="!reference.trim() || undefined">Link</UiButton>
      </div>
      <p v-if="addError" id="lp-add-error" class="lp__add-error selectable" role="alert">{{ addError }}</p>
      <p v-else id="lp-add-hint" class="lp__add-hint">A number is looked up in this project's GitHub repository.</p>
    </form>

    <div v-if="!chat" class="lp__quiet">
      <p>Open a chat to see the pull requests and issues linked to it.</p>
    </div>

    <div v-else-if="!list.length" class="lp__quiet">
      <p class="lp__quiet-title">Nothing linked to this chat</p>
      <p>When the agent opens a pull request or an issue in this chat, it shows up here with its description and pictures. Ask it to “open a pull request” when the work is done.</p>
      <UiButton v-if="!adding" size="sm" @click="startAdd"><Link2 aria-hidden="true" />Link one by hand</UiButton>
    </div>

    <template v-else-if="current">
      <div class="lp__scroll">
        <LinksItem :key="current.key" :link="current" :detail="currentDetail" />
      </div>
      <LinksMerge v-if="mergeable && chat" :key="current.key" :link="current" :item="mergeable" :project-path="chat.projectPath" />
      <footer class="lp__foot">
        <UiButton size="sm" @click="openExternal(currentDetail?.item?.url ?? current.url)"><ExternalLink aria-hidden="true" />Open on GitHub</UiButton>
        <UiButton size="sm" variant="ghost" :loading="refreshing" @click="refresh"><RefreshCw v-if="!refreshing" aria-hidden="true" />Refresh</UiButton>
        <UiButton size="sm" variant="ghost" class="lp__unlink" title="Remove it from this chat; nothing changes on GitHub" @click="unlink(current)"><Unlink aria-hidden="true" />Unlink</UiButton>
      </footer>
    </template>

    <ul v-else class="lp__scroll lp__list" aria-label="Linked to this chat">
      <li v-for="l in list" :key="l.key" class="lp__row">
        <button type="button" class="lp__open" :title="l.url" @click="open(l)">
          <component :is="stateOf(l.kind, l.state).icon" class="lp__icon" :class="`is-${stateOf(l.kind, l.state).tone}`" aria-hidden="true" />
          <span class="lp__text">
            <span class="lp__name">{{ l.title ?? `${l.owner}/${l.repo} #${l.number}` }}</span>
            <span class="lp__sub">
              <span :class="`is-${stateOf(l.kind, l.state).tone}`">{{ stateOf(l.kind, l.state).word }}</span>
              <span class="tabular">#{{ l.number }}</span>
              <span class="lp__repo">{{ l.owner }}/{{ l.repo }}</span>
            </span>
          </span>
        </button>
        <UiIconButton class="lp__remove" size="sm" :label="`Unlink #${l.number}`" @click="unlink(l)"><X /></UiIconButton>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.lp { display: flex; flex-direction: column; flex: 1; min-height: 0; }
.lp__head {
  flex: none;
  display: flex;
  align-items: center;
  gap: var(--space-1);
  height: var(--tabbar-h);
  padding: 0 var(--space-2) 0 var(--space-3);
}
.lp__head:has(> .icon-btn:first-child) { padding-left: var(--space-2); }
.lp__title {
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
.lp__tools { flex: none; display: flex; align-items: center; gap: 2px; }

.lp__add { flex: none; display: grid; gap: 6px; padding: var(--space-2) var(--space-3) var(--space-3); border-top: 1px solid var(--line-soft); }
.lp__label { font-size: var(--text-xs); font-weight: 560; color: var(--fg-muted); }
.lp__add-row { display: flex; align-items: center; gap: var(--space-2); }
.lp__input {
  flex: 1;
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
.lp__input::placeholder { color: var(--fg-faint); }
.lp__input:focus { border-color: var(--accent-line); box-shadow: 0 0 0 3px var(--accent-soft); }
.lp__input.is-invalid { border-color: color-mix(in oklch, var(--ripe-error) 60%, transparent); }
.lp__add-hint, .lp__add-error { margin: 0; font-size: var(--text-xs); color: var(--fg-faint); overflow-wrap: anywhere; }
.lp__add-error { color: var(--ripe-error-fg); }

.lp__quiet {
  display: grid;
  gap: var(--space-2);
  justify-items: start;
  padding: var(--space-3) var(--space-4);
  border-top: 1px solid var(--line-soft);
  font-size: var(--text-sm);
  color: var(--fg-subtle);
}
.lp__quiet p { margin: 0; max-width: 46ch; }
.lp__quiet-title { color: var(--fg); font-weight: 600; }
.lp__quiet :deep(svg) { width: 14px; height: 14px; stroke-width: 1.85; }

.lp__foot {
  flex: none;
  display: flex;
  align-items: center;
  gap: var(--space-1);
  padding: var(--space-2) var(--space-3);
  border-top: 1px solid var(--line-soft);
}
.lp__foot :deep(svg) { width: 14px; height: 14px; stroke-width: 1.85; }
.lp__unlink { margin-left: auto; }

.lp__scroll { flex: 1; min-height: 0; overflow: auto; border-top: 1px solid var(--line-soft); }
.lp__list { margin: 0; padding: var(--space-1) var(--space-2); list-style: none; display: grid; align-content: start; gap: 2px; }
.lp__row { position: relative; display: flex; align-items: center; }
.lp__open {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  padding: 6px var(--space-2);
  padding-right: 30px;
  border-radius: var(--radius-sm);
  text-align: left;
  transition: background var(--dur-fast) var(--ease-out);
}
.lp__open:hover { background: var(--bg-hover); }
.lp__open:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: -2px; }
.lp__icon { flex: none; width: 15px; height: 15px; margin-top: 2px; stroke-width: 1.85; }
.lp__text { display: grid; gap: 1px; min-width: 0; }
.lp__name { font-size: var(--text-sm); color: var(--fg-muted); font-weight: 520; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.lp__open:hover .lp__name { color: var(--fg); }
.lp__sub { display: flex; gap: 6px; min-width: 0; font-size: var(--text-xs); color: var(--fg-faint); white-space: nowrap; }
.lp__sub > span:first-child { font-weight: 560; }
.lp__repo { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.lp__remove { position: absolute; right: 4px; top: 8px; opacity: 0; transition: opacity var(--dur-fast) var(--ease-out); }
.lp__row:hover .lp__remove, .lp__remove:focus-visible { opacity: 1; }

.is-running { color: var(--ripe-running-fg); }
.lp__icon.is-running { color: var(--ripe-running); }
.is-queued { color: var(--ripe-queued-fg); }
.lp__icon.is-queued { color: var(--ripe-queued); }
.is-done { color: var(--ripe-done-fg); }
.lp__icon.is-done { color: var(--ripe-done); }
.is-error { color: var(--ripe-error-fg); }
.lp__icon.is-error { color: var(--ripe-error); }
.is-idle { color: var(--fg-subtle); }
</style>
