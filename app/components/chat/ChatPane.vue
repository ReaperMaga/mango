<script setup lang="ts">
import { ArrowDown, ChevronDown, ChevronUp, CornerLeftUp, List, Pin, Search, Square, X } from 'lucide-vue-next'
import { useWorkspace } from '~/stores/workspace'
import { useThreads, type Pane } from '~/stores/threads'
import { useModels } from '~/stores/models'
import { AGENTS, type AgentId, type Attachment, type Message, type Thread } from '~/types/chat'
import { worktreeName } from '~/utils/worktrees'
import { vcsTerms } from '~/utils/vcs'
import { attachmentDrafts, drafts } from '~/utils/drafts'
import { DUR, EASE_OUT, motionMs } from '~/utils/motion'
import { findRequest } from '~/utils/chatFind'
import { dayLabel, sameDay } from '~/utils/time'

const props = defineProps<{ pane: Pane; split: boolean; active: boolean }>()

const ws = useWorkspace()
const threads = useThreads()
const thread = computed(() => threads.byId(props.pane.threadId))
/** "worktree", or "workspace" for a Unity VCS project. */
const term = computed(() => vcsTerms(ws.openProjects.find(p => p.path === thread.value?.projectPath)?.vcs).worktree)
const busy = computed(() => !!thread.value && ['running', 'queued', 'waiting'].includes(thread.value.status))
/** A sub-agent's chat: filled by its parent's run, so it has no composer of its own. */
const parent = computed(() => (thread.value?.parentId ? threads.byId(thread.value.parentId) : null))

/* ---------- empty pane: draft settings live here until the first send ---------- */
const draft = reactive({ agent: threads.defaultAgent as AgentId, model: AGENTS[threads.defaultAgent].models[0]!.id, mode: ws.defaultMode as Thread['mode'], effort: null as string | null })
/* The agent is chosen in the sidebar (Code settings); an empty pane follows the default. */
/* ...and a project can set its own agent and permission mode (Settings > Projects). */
const projectPref = computed(() => (ws.activeProjectPath ? ws.projectPrefs[ws.activeProjectPath] : undefined))
watch([() => threads.defaultAgent, () => projectPref.value?.agent], ([a, own]) => { draft.agent = own ?? a }, { immediate: true })
watch([() => ws.defaultMode, () => projectPref.value?.mode], ([m, own]) => { draft.mode = own ?? m }, { immediate: true })
/** A model picked together with its agent in the composer: kept when the agent change resets the draft. */
let pickedModel: string | null = null
watch([() => draft.agent, () => projectPref.value?.model], ([a, own]) => {
  draft.model = pickedModel ?? (own && useModels().find(a, own) ? own : AGENTS[a].models[0]!.id)
  pickedModel = null
  draft.effort = null
}, { immediate: true })
function draftAgent(agent: AgentId, model: string) {
  pickedModel = model
  draft.agent = agent
}
const draftText = ref('')
const draftFiles = ref<Attachment[]>([])

/* Unsent text is kept per thread, so switching tabs never loses a draft. */
const text = computed({
  get: () => (thread.value ? drafts.get(thread.value.id) ?? '' : ''),
  set: (v: string) => { if (thread.value) v ? drafts.set(thread.value.id, v) : drafts.delete(thread.value.id) },
})

const files = computed({
  get: () => (thread.value ? attachmentDrafts.get(thread.value.id) ?? [] : []),
  set: (v: Attachment[]) => { if (thread.value) v.length ? attachmentDrafts.set(thread.value.id, v) : attachmentDrafts.delete(thread.value.id) },
})

const composer = ref<{ focus: () => void } | null>(null)
watch([() => props.pane.threadId, () => props.active], async ([, active]) => {
  if (!active) return
  await nextTick()
  composer.value?.focus()
})

async function start(text: string, attachments: Attachment[]) {
  if (!ws.activeProjectPath) return
  const t = threads.create(ws.activeProjectPath, draft.agent, ws.activeProject?.branch ?? null)
  threads.setModel(t.id, draft.model)
  threads.setMode(t.id, draft.mode)
  threads.setEffort(t.id, draft.effort)
  if (threads.activePane.id !== props.pane.id) threads.show(t.id, props.pane.id)
  await threads.send(t.id, text, attachments)
}

/* ---------- scrolling: stick to bottom while new output arrives ---------- */
const scroller = ref<HTMLElement | null>(null)
const pinned = ref(true)
let lastTop = 0
function onScroll() {
  const el = scroller.value
  if (!el) return
  const nearEnd = el.scrollHeight - el.scrollTop - el.clientHeight < 80
  // Only a deliberate scroll up unpins; reflow that grows the content does not.
  if (nearEnd) pinned.value = true
  else if (el.scrollTop < lastTop) pinned.value = false
  lastTop = el.scrollTop
}
const contentSig = computed(() => {
  const t = thread.value
  if (!t) return ''
  const last = t.messages[t.messages.length - 1]
  const lastPart = last?.parts[last.parts.length - 1]
  const len = lastPart && 'text' in lastPart ? lastPart.text.length : 0
  return `${t.id}:${t.messages.length}:${last?.parts.length ?? 0}:${len}:${t.status}`
})
watch(contentSig, async (sig, old) => {
  const switched = sig.split(':')[0] !== old?.split(':')[0]
  if (!pinned.value && !switched) return
  await nextTick()
  scroller.value?.scrollTo({ top: scroller.value.scrollHeight, behavior: switched ? 'auto' : 'smooth' })
  if (switched) pinned.value = true
}, { flush: 'post', immediate: true })

/* Keep the newest output in view when the pane itself changes size (terminal opens, split, window resize). */
let ro: ResizeObserver | undefined
watch(scroller, (el) => {
  ro?.disconnect()
  if (!el) return
  ro = new ResizeObserver(() => { if (pinned.value) el.scrollTop = el.scrollHeight })
  ro.observe(el)
  // The content column too: reflow and new output change its height, not the scroller's.
  if (el.firstElementChild) ro.observe(el.firstElementChild)
}, { immediate: true, flush: 'post' })
onBeforeUnmount(() => ro?.disconnect())

/* A chat from before Mango kept context readings gets one when it is shown (no turn is run). */
watch(() => thread.value?.id, (id) => { if (id) void threads.readContext(id) }, { immediate: true })

/* Switching chats: the new one fades in over the old instead of swapping in one frame. */
watch(() => thread.value?.id, (id, was) => {
  if (!id || !was) return
  scroller.value?.firstElementChild?.animate([{ opacity: 0 }, { opacity: 1 }], { duration: motionMs(DUR.fast), easing: EASE_OUT })
}, { flush: 'post' })

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape' && listOpen.value) { listOpen.value = false; return }
  if (e.key === 'Escape' && busy.value && thread.value) threads.stop(thread.value.id)
}

/*
 * "Esc to stop" is shown whenever the agent works, so it has to work wherever focus is, not only inside
 * this pane (after a click on the list, a tab or the page it is on the body). The pane in front takes it,
 * unless something else owns Escape there: a menu or dialog (they stop it first), a terminal, an editor, a field.
 */
function onWindowKey(e: KeyboardEvent) {
  if (e.key !== 'Escape' || e.defaultPrevented || !props.active || !busy.value || !thread.value) return
  const el = e.target as HTMLElement | null
  if (el && el !== document.body && el.closest('[data-drop-zone], .xterm, .monaco-editor, [role="dialog"], [role="menu"], input, textarea, select, [contenteditable="true"]')) return
  e.preventDefault()
  threads.stop(thread.value.id)
}
onMounted(() => window.addEventListener('keydown', onWindowKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onWindowKey))

/* ---------- the way back down, and day marks between messages ---------- */

function toLatest() {
  pinned.value = true
  scroller.value?.scrollTo({ top: scroller.value.scrollHeight, behavior: 'smooth' })
}

/** Whether a day mark goes above message `i`: the first one, and each time the day changes. */
function newDay(i: number) {
  const ms = thread.value?.messages
  if (!ms?.[i]) return false
  return i === 0 || !sameDay(ms[i - 1]!.createdAt, ms[i]!.createdAt)
}

/* ---------- jumping to a message ---------- */

/** Brings a message into view and marks it for a moment; the view stops following new output. */
function reveal(el: Element | null | undefined, block: ScrollLogicalPosition = 'start') {
  if (!el) return
  pinned.value = false
  el.scrollIntoView({ block, behavior: 'smooth' })
}
function jumpTo(messageId: string) {
  const el = scroller.value?.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(messageId)}"]`)
  if (!el) return
  reveal(el)
  el.classList.remove('is-flash')
  void el.offsetWidth
  el.classList.add('is-flash')
  setTimeout(() => el.classList.remove('is-flash'), 1500)
  listOpen.value = false
}

/* The message list: what you asked, in order, to jump to; pinned ones can be told apart. */
const listOpen = ref(false)
const onlyPinned = ref(false)
/** What you wrote in this chat, newest first: the composer's arrow keys walk through it. */
const history = computed(() => asks.value.map(preview).reverse())
const asks = computed(() => (thread.value?.messages ?? []).filter(m => m.role === 'user' && !m.fromAgent && (m.parts.length || m.attachments?.length)))
const pins = computed(() => (thread.value?.messages ?? []).filter(m => m.pinned))
/** Pinned messages of either side; otherwise your questions. */
const listed = computed(() => (onlyPinned.value ? pins.value : asks.value))
const preview = (m: Message) => m.parts.map(p => (p.type === 'text' ? p.text : '')).join(' ').replace(/\s+/g, ' ').trim() || m.attachments?.[0]?.name || 'Attachment'
const clock = (ts: number) => new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
watch(() => thread.value?.id, () => { listOpen.value = false; onlyPinned.value = false; closeFind() })

/* ---------- find in this chat ---------- */

const findOpen = ref(false)
const query = ref('')
const hits = shallowRef<Range[]>([])
const at = ref(0)
const findField = ref<HTMLInputElement | null>(null)
const hasHighlights = typeof CSS !== 'undefined' && 'highlights' in CSS

function paint() {
  if (!hasHighlights) return
  const all = hits.value
  CSS.highlights.set(`mango-find-${props.pane.id}`, new Highlight(...all.filter((_, i) => i !== at.value)))
  CSS.highlights.set(`mango-find-now-${props.pane.id}`, new Highlight(...(all[at.value] ? [all[at.value]!] : [])))
}
function unpaint() {
  if (!hasHighlights) return
  CSS.highlights.delete(`mango-find-${props.pane.id}`)
  CSS.highlights.delete(`mango-find-now-${props.pane.id}`)
}

/** Every place the words appear in what the chat shows (rows folded away are not in the page, so not searched). */
function search(keep = false) {
  const root = scroller.value?.firstElementChild
  const q = query.value.trim().toLowerCase()
  const found: Range[] = []
  if (root && q) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: n => (n.parentElement?.closest('textarea, script, style, [data-nofind]') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    })
    for (let n = walker.nextNode(); n && found.length < 500; n = walker.nextNode()) {
      const text = n.nodeValue!.toLowerCase()
      for (let from = text.indexOf(q); from >= 0 && found.length < 500; from = text.indexOf(q, from + q.length)) {
        const r = document.createRange()
        r.setStart(n, from)
        r.setEnd(n, from + q.length)
        found.push(r)
      }
    }
  }
  hits.value = found
  at.value = keep ? Math.min(at.value, Math.max(0, found.length - 1)) : 0
  paint()
  if (!keep) show()
}
/** Scrolls to the current hit. */
function show() {
  const r = hits.value[at.value]
  if (r) reveal(r.startContainer.parentElement, 'center')
}
function step(by: number) {
  const n = hits.value.length
  if (!n) return
  at.value = (at.value + by + n) % n
  paint()
  show()
}
async function openFind() {
  if (!thread.value) return
  findOpen.value = true
  await nextTick()
  findField.value?.focus()
  findField.value?.select()
  if (query.value) search()
}
function closeFind() {
  if (!findOpen.value) return
  findOpen.value = false
  hits.value = []
  unpaint()
  composer.value?.focus()
}
function onFindKey(e: KeyboardEvent) {
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeFind() }
  else if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); step(e.shiftKey ? -1 : 1) }
}
watch(query, () => search())
/* New output while looking: the hits follow it, and the view stays where it is. */
watch(contentSig, () => { if (findOpen.value && query.value) nextTick(() => search(true)) })
watch(findRequest, () => { if (props.active) void openFind() })
onBeforeUnmount(unpaint)
</script>

<template>
  <section class="pane" :class="{ 'is-active': active, 'is-split': split }" data-drop-zone @keydown="onKey">
    <!-- Thread -->
    <template v-if="thread">
      <div v-if="thread.messages.length" class="pane__bar">
        <div v-if="findOpen" class="find" role="search">
          <Search class="find__icon" aria-hidden="true" />
          <input
            ref="findField"
            v-model="query"
            class="find__field"
            type="search"
            placeholder="Find in this chat"
            aria-label="Find in this chat"
            autocomplete="off"
            spellcheck="false"
            @keydown="onFindKey"
          >
          <span class="find__count tabular" aria-live="polite">{{ query.trim() ? (hits.length ? `${at + 1} of ${hits.length}` : 'No matches') : '' }}</span>
          <UiIconButton size="sm" label="Previous match (Shift+Enter)" @click="step(-1)"><ChevronUp /></UiIconButton>
          <UiIconButton size="sm" label="Next match (Enter)" @click="step(1)"><ChevronDown /></UiIconButton>
          <UiIconButton size="sm" label="Close find (Esc)" @click="closeFind"><X /></UiIconButton>
        </div>
        <template v-else>
          <UiIconButton size="sm" label="Find in this chat" @click="openFind"><Search /></UiIconButton>
        </template>
        <UiIconButton size="sm" label="Message list" :active="listOpen" @click="listOpen = !listOpen"><List /></UiIconButton>
      </div>

      <div v-if="listOpen" class="mlist" role="dialog" aria-label="Messages in this chat">
        <div class="mlist__head">
          <button type="button" class="mlist__tab" :class="{ 'is-on': !onlyPinned }" @click="onlyPinned = false">Asked <span class="tabular">{{ asks.length }}</span></button>
          <button type="button" class="mlist__tab" :class="{ 'is-on': onlyPinned }" @click="onlyPinned = true"><Pin aria-hidden="true" /> Pinned <span class="tabular">{{ pins.length }}</span></button>
        </div>
        <ul v-if="listed.length" class="mlist__items">
          <li v-for="m in listed" :key="m.id">
            <button type="button" class="mlist__item" @click="jumpTo(m.id)">
              <span class="mlist__text">{{ preview(m) }}</span>
              <span class="mlist__meta tabular">{{ m.role === 'agent' ? `${AGENTS[thread.agent].name} · ` : '' }}{{ clock(m.createdAt) }}</span>
            </button>
          </li>
        </ul>
        <p v-else class="mlist__empty">{{ onlyPinned ? 'Nothing pinned yet. Pin a message from its row of buttons.' : 'Nothing asked yet.' }}</p>
      </div>

      <div class="pane__stage">
      <div ref="scroller" class="pane__scroll" @scroll.passive="onScroll">
        <div class="pane__col">
          <div v-if="!thread.messages.length" class="pane__fresh">
            <p v-if="thread.awaitingWorktree">{{ AGENTS[thread.agent].name }} will start in a new {{ term }}, made when you send your first message. Its branch is named after what you write.</p>
            <p v-else-if="thread.worktree">
              {{ AGENTS[thread.agent].name }} is ready in its own {{ term }} <code :title="thread.worktree">{{ worktreeName(thread.worktree) }}</code><template v-if="thread.branch">
                on <code>{{ thread.branch }}</code></template>, beside {{ ws.activeProject?.name }}. Other chats keep working undisturbed. Describe the change you want.
            </p>
            <p v-else>{{ AGENTS[thread.agent].name }} is ready in <code>{{ ws.activeProject?.name }}</code>. Describe the change you want.</p>
          </div>
          <!-- Keyed by chat: opening one shows its history at once, only messages that arrive after rise in. -->
          <TransitionGroup :key="thread.id" name="msg">
            <template v-for="(m, i) in thread.messages" :key="m.id">
              <p v-if="newDay(i)" :key="`day-${m.id}`" class="pane__day tabular">{{ dayLabel(m.createdAt) }}</p>
              <ChatMessage
                :message="m"
                :thread="thread"
                :last="i === thread.messages.length - 1"
              />
            </template>
          </TransitionGroup>
          <Transition name="msg">
            <ChatWorking v-if="busy" :thread="thread" />
          </Transition>
        </div>
      </div>
      <Transition name="latest">
        <button v-if="!pinned && thread.messages.length" type="button" class="pane__latest" @click="toLatest">
          <ArrowDown aria-hidden="true" /> {{ busy ? 'Follow latest' : 'Jump to latest' }}
        </button>
      </Transition>
      </div>

      <div v-if="thread.parentId" class="pane__composer">
        <div class="pane__sub" role="note">
          <p class="pane__sub-text">
            {{ thread.agentType ? `${thread.agentType} sub-agent` : 'Sub-agent' }}, started by <button v-if="parent" type="button" class="pane__sub-parent" @click="threads.show(parent.id)">{{ parent.title }}</button><span v-else>a chat that was deleted</span>. It reports back to that chat, so there is nothing to write here.
          </p>
          <UiButton v-if="busy" size="sm" @click="threads.stop(thread.id)"><Square /> Stop</UiButton>
          <UiButton v-if="parent" size="sm" @click="threads.show(parent.id)"><CornerLeftUp /> Open parent chat</UiButton>
        </div>
      </div>

      <div v-else class="pane__composer">
        <ChatQueue :thread="thread" />
        <ChatTasks :thread="thread" />
        <ChatComposer
          ref="composer"
          v-model:text="text"
          v-model:attachments="files"
          :agent="thread.agent"
          :model="thread.model"
          :mode="thread.mode"
          :effort="thread.effort ?? null"
          :busy="busy"
          :autofocus="active"
          :context="thread.context ?? null"
          :context-pending="!!threads.contextReading[thread.id]"
          :started="thread.messages.length > 0"
          :history="history"
          @send="(text, attachments, opposite) => threads.send(thread!.id, text, attachments, opposite)"
          @compact="threads.send(thread!.id, '/compact')"
          @stop="threads.stop(thread!.id)"
          @update:model="m => threads.setModel(thread!.id, m)"
          @update:agent="(a, m) => threads.setAgent(thread!.id, a, m)"
          @update:mode="m => threads.setMode(thread!.id, m)"
          @update:effort="e => threads.setEffort(thread!.id, e)"
        />
      </div>
    </template>

    <!-- Empty pane: start a chat right here -->
    <div v-else class="pane__empty">
      <div class="pane__start">
        <h2 class="pane__hello">What should we work on in <span>{{ ws.activeProject?.name }}</span>?</h2>
        <ChatComposer
          ref="composer"
          v-model:text="draftText"
          v-model:attachments="draftFiles"
          :agent="draft.agent"
          v-model:model="draft.model"
          v-model:mode="draft.mode"
          v-model:effort="draft.effort"
          large
          @update:agent="draftAgent"
          :autofocus="active"
          @send="start"
        />
      </div>
    </div>
  </section>
</template>

<style scoped>
.pane {
  flex: 1 1 0;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--bg-canvas);
  position: relative;
}

.pane__stage { position: relative; flex: 1; min-height: 0; display: flex; flex-direction: column; }
.pane__scroll { flex: 1; min-height: 0; overflow-y: auto; scrollbar-gutter: stable; }

.pane__bar {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: flex-start;
  gap: var(--space-1);
  min-height: 30px;
  padding: var(--space-1) var(--space-3) 0;
}
.find {
  flex: 1;
  max-width: 420px;
  display: flex;
  align-items: center;
  gap: var(--space-1);
  height: 26px;
  padding: 0 var(--space-1) 0 var(--space-2);
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-sm);
  background: var(--bg-panel);
}
.find:focus-within { outline: 2px solid var(--focus-ring); outline-offset: 1px; }
.find__icon { flex: none; width: 13px; height: 13px; color: var(--fg-faint); }
.find__field { flex: 1; min-width: 0; height: 100%; border: 0; outline: 0; background: none; color: var(--fg); font: inherit; font-size: var(--text-sm); }
.find__field::-webkit-search-cancel-button { display: none; }
.find__count { flex: none; font-size: var(--text-xs); color: var(--fg-subtle); }

.pane__day { align-self: center; margin: var(--space-2) 0 0; font-size: var(--text-xs); color: var(--fg-faint); }

/* The way back down once the view is no longer following the output. */
.pane__latest {
  position: absolute;
  left: 50%;
  bottom: var(--space-3);
  translate: -50% 0;
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  height: 28px;
  padding: 0 var(--space-3) 0 var(--space-2);
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-pill);
  background: var(--bg-raised);
  box-shadow: var(--shadow-soft);
  color: var(--fg-muted);
  font-size: var(--text-xs);
  font-weight: 560;
  transition: color var(--dur-fast) var(--ease-out), border-color var(--dur-fast) var(--ease-out);
}
.pane__latest:hover { color: var(--fg); }
.pane__latest:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
.pane__latest svg { width: 13px; height: 13px; }
.latest-enter-active, .latest-leave-active { transition: opacity var(--dur-fast) var(--ease-out), transform var(--dur-fast) var(--ease-out); }
.latest-enter-from, .latest-leave-to { opacity: 0; transform: translateY(4px); }

/* The message list: a floating layer under the bar. */
.mlist {
  position: absolute;
  z-index: 5;
  top: 34px;
  left: var(--space-3);
  width: min(340px, calc(100% - var(--space-6)));
  max-height: min(60%, 420px);
  display: flex;
  flex-direction: column;
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-md);
  background: var(--bg-raised);
  box-shadow: var(--shadow-pop);
  overflow: hidden;
}
.mlist__head { flex: none; display: flex; gap: var(--space-1); padding: var(--space-1); border-bottom: 1px solid var(--line-soft); }
.mlist__tab {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 24px;
  padding: 0 var(--space-2);
  border-radius: var(--radius-sm);
  font-size: var(--text-xs);
  font-weight: 560;
  color: var(--fg-subtle);
}
.mlist__tab svg { width: 12px; height: 12px; }
.mlist__tab:hover { background: var(--bg-hover); color: var(--fg); }
.mlist__tab.is-on { background: var(--bg-active); color: var(--fg); }
.mlist__tab:focus-visible, .mlist__item:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: -2px; }
.mlist__items { margin: 0; padding: var(--space-1); list-style: none; overflow-y: auto; }
.mlist__item { width: 100%; display: grid; gap: 1px; padding: 6px var(--space-2); border-radius: var(--radius-sm); text-align: left; }
.mlist__item:hover { background: var(--bg-hover); }
.mlist__text { overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; font-size: var(--text-sm); color: var(--fg); overflow-wrap: anywhere; }
.mlist__meta { font-size: var(--text-2xs); color: var(--fg-faint); }
.mlist__empty { margin: 0; padding: var(--space-3); font-size: var(--text-xs); color: var(--fg-subtle); text-wrap: pretty; }
.pane__col {
  max-width: 780px;
  margin: 0 auto;
  padding: var(--space-6) var(--space-6) var(--space-8);
  display: flex;
  flex-direction: column;
  gap: var(--space-5);
}
.pane__fresh { color: var(--fg-subtle); font-size: var(--text-sm); }
.pane__fresh code { font-size: var(--text-xs); color: var(--fg-muted); }

.pane__composer {
  flex: none;
  width: 100%;
  max-width: 780px;
  margin: 0 auto;
  padding: 0 var(--space-6) var(--space-4);
}

.pane__sub {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-height: 44px;
  padding: var(--space-2) var(--space-2) var(--space-2) var(--space-4);
  border: 1px solid var(--line-soft);
  border-radius: var(--radius-lg);
  background: var(--bg-panel);
}
.pane__sub-text { flex: 1; min-width: 0; margin: 0; font-size: var(--text-sm); line-height: var(--leading-normal); color: var(--fg-subtle); }
.pane__sub-parent {
  max-width: 100%;
  font-weight: 560;
  color: var(--fg);
  text-decoration: underline;
  text-decoration-color: var(--line-strong);
  text-underline-offset: 3px;
  border-radius: var(--radius-xs);
}
.pane__sub-parent:hover { text-decoration-color: currentColor; }
.pane__sub-parent:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
.pane__sub :deep(svg) { width: 13px; height: 13px; }

.pane__empty {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: grid;
  place-items: center;
  padding: var(--space-6);
}
.pane__start { width: min(680px, 100%); margin-top: -8vh; }
.pane__hello {
  margin: 0 0 var(--space-5);
  font-size: var(--text-xl);
  font-weight: 620;
  letter-spacing: -0.015em;
  text-wrap: balance;
  color: var(--fg-muted);
}
.pane__hello span { color: var(--fg); }

/* A message that arrives rises into place. Nothing on leave: a cleared chat should just be clear. */
.msg-enter-active { transition: opacity var(--dur-med) var(--ease-out), transform var(--dur-med) var(--ease-out); }
.msg-enter-from { opacity: 0; transform: translateY(6px); }
</style>
