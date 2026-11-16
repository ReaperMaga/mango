<script setup lang="ts">
import { MessageSquareText, Bug, GitPullRequestDraft, CornerLeftUp, Square } from 'lucide-vue-next'
import { useWorkspace } from '~/stores/workspace'
import { useThreads, type Pane } from '~/stores/threads'
import { AGENTS, type AgentId, type Attachment, type Thread } from '~/types/chat'
import { attachmentDrafts, drafts } from '~/utils/drafts'

const props = defineProps<{ pane: Pane; split: boolean; active: boolean }>()

const ws = useWorkspace()
const threads = useThreads()
const thread = computed(() => threads.byId(props.pane.threadId))
const busy = computed(() => !!thread.value && ['running', 'queued', 'waiting'].includes(thread.value.status))
/** A sub-agent's chat: filled by its parent's run, so it has no composer of its own. */
const parent = computed(() => (thread.value?.parentId ? threads.byId(thread.value.parentId) : null))

/* ---------- empty pane: draft settings live here until the first send ---------- */
const draft = reactive({ agent: threads.defaultAgent as AgentId, model: AGENTS[threads.defaultAgent].models[0]!.id, mode: ws.defaultMode as Thread['mode'], effort: null as string | null })
/* The agent is chosen in the sidebar (Code settings); an empty pane follows the default. */
watch(() => threads.defaultAgent, (a) => { draft.agent = a })
watch(() => draft.agent, (a) => { draft.model = AGENTS[a].models[0]!.id; draft.effort = null })
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

const suggestions = [
  { icon: MessageSquareText, text: 'Explain how this project is structured and where to start reading' },
  { icon: Bug, text: 'Run the tests and fix whatever fails' },
  { icon: GitPullRequestDraft, text: 'Review my uncommitted changes before I commit' },
]

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

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape' && busy.value && thread.value) threads.stop(thread.value.id)
}
</script>

<template>
  <section class="pane" :class="{ 'is-active': active, 'is-split': split }" data-drop-zone @keydown="onKey">
    <!-- Thread -->
    <template v-if="thread">
      <div ref="scroller" class="pane__scroll" @scroll.passive="onScroll">
        <div class="pane__col">
          <div v-if="!thread.messages.length" class="pane__fresh">
            <p>{{ AGENTS[thread.agent].name }} is ready in <code>{{ ws.activeProject?.name }}</code>. Describe the change you want.</p>
          </div>
          <ChatMessage
            v-for="(m, i) in thread.messages"
            :key="m.id"
            :message="m"
            :thread="thread"
            :last="i === thread.messages.length - 1"
          />
          <ChatWorking v-if="busy" :thread="thread" />
        </div>
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
          @send="(text, attachments) => threads.send(thread!.id, text, attachments)"
          @stop="threads.stop(thread!.id)"
          @update:model="m => threads.setModel(thread!.id, m)"
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
          :autofocus="active"
          @send="start"
        />
        <ul class="pane__suggest" role="list">
          <li v-for="s in suggestions" :key="s.text">
            <button type="button" @click="draftText = s.text">
              <component :is="s.icon" />
              <span>{{ s.text }}</span>
            </button>
          </li>
        </ul>
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

.pane__scroll { flex: 1; min-height: 0; overflow-y: auto; scrollbar-gutter: stable; }
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
.pane__suggest { list-style: none; margin: var(--space-4) 0 0; padding: 0; display: grid; gap: 2px; }
.pane__suggest button {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  width: 100%;
  min-height: 34px;
  padding: 0 var(--space-3);
  border-radius: var(--radius-sm);
  font-size: var(--text-sm);
  color: var(--fg-subtle);
  text-align: left;
  transition: background var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out);
}
.pane__suggest button:hover { background: var(--bg-hover); color: var(--fg); }
.pane__suggest svg { width: 15px; height: 15px; flex: none; stroke-width: 1.75; color: var(--fg-faint); }
.pane__suggest button:hover svg { color: var(--accent-ink); }
</style>
