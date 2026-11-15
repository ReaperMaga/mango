<script setup lang="ts">
import { GitBranch, X, Square, MessageSquareText, Bug, GitPullRequestDraft } from 'lucide-vue-next'
import { useWorkspace } from '~/stores/workspace'
import { useThreads, type Pane } from '~/stores/threads'
import { AGENTS, modelLabel, type AgentId, type Thread } from '~/types/chat'
import { drafts } from '~/utils/drafts'

const props = defineProps<{ pane: Pane; split: boolean; active: boolean }>()

const ws = useWorkspace()
const threads = useThreads()
const thread = computed(() => threads.byId(props.pane.threadId))
const busy = computed(() => !!thread.value && ['running', 'queued', 'waiting'].includes(thread.value.status))

/* ---------- empty pane: draft settings live here until the first send ---------- */
const draft = reactive({ agent: threads.defaultAgent as AgentId, model: AGENTS[threads.defaultAgent].models[0]!.id, mode: ws.defaultMode as Thread['mode'] })
watch(() => draft.agent, a => { draft.model = AGENTS[a].models[0]!.id; threads.defaultAgent = a })
const draftText = ref('')

/* Unsent text is kept per thread, so switching tabs never loses a draft. */
const text = computed({
  get: () => (thread.value ? drafts.get(thread.value.id) ?? '' : ''),
  set: (v: string) => { if (thread.value) v ? drafts.set(thread.value.id, v) : drafts.delete(thread.value.id) },
})

const composer = ref<{ focus: () => void } | null>(null)
watch([() => props.pane.threadId, () => props.active], async ([, active]) => {
  if (!active) return
  await nextTick()
  composer.value?.focus()
})

async function start(text: string) {
  if (!ws.activeProjectPath) return
  const t = threads.create(ws.activeProjectPath, draft.agent, ws.activeProject?.branch ?? null)
  threads.setModel(t.id, draft.model)
  threads.setMode(t.id, draft.mode)
  if (threads.activePane.id !== props.pane.id) threads.show(t.id, props.pane.id)
  await threads.send(t.id, text)
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
  <section class="pane" :class="{ 'is-active': active, 'is-split': split }" @keydown="onKey">
    <!-- Thread -->
    <template v-if="thread">
      <header class="pane__head">
        <UiRipenessDot :status="thread.archived ? 'idle' : thread.status" />
        <h2 class="pane__title" :title="thread.title">{{ thread.title }}</h2>
        <span class="pane__meta">
          {{ AGENTS[thread.agent].name }}<span class="pane__sep">·</span>{{ modelLabel(thread.agent, thread.model) }}
        </span>
        <span v-if="thread.branch" class="pane__branch"><GitBranch />{{ thread.branch }}</span>
        <span v-if="thread.simulated" class="pane__sim" title="These replies are simulated sample content, not a real agent run.">Simulated</span>
        <span class="pane__spacer" />
        <ChatStatus :thread="thread" />
        <UiButton v-if="busy" size="sm" variant="ghost" @click="threads.stop(thread.id)"><Square />Stop</UiButton>
        <UiIconButton v-if="split" size="sm" label="Close pane" @click.stop="threads.closePane(pane.id)"><X /></UiIconButton>
      </header>

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

      <div class="pane__composer">
        <ChatComposer
          ref="composer"
          v-model:text="text"
          :agent="thread.agent"
          :model="thread.model"
          :mode="thread.mode"
          :busy="busy"
          :autofocus="active"
          @send="text => threads.send(thread!.id, text)"
          @stop="threads.stop(thread!.id)"
          @update:agent="a => threads.setAgent(thread!.id, a)"
          @update:model="m => threads.setModel(thread!.id, m)"
          @update:mode="m => threads.setMode(thread!.id, m)"
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
          v-model:agent="draft.agent"
          v-model:model="draft.model"
          v-model:mode="draft.mode"
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

.pane__head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  height: 40px;
  padding: 0 var(--space-3) 0 var(--space-4);
  flex: none;
  border-bottom: 1px solid var(--line-soft);
}
.pane.is-split:not(.is-active) .pane__head { opacity: 0.72; }
.pane__title {
  margin: 0;
  min-width: 0;
  font-size: var(--text-md);
  font-weight: 600;
  word-spacing: 0.06em;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pane__meta { flex: none; font-size: var(--text-xs); color: var(--fg-subtle); white-space: nowrap; }
.pane__sep { margin: 0 5px; color: var(--fg-faint); }
.pane__branch {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
  font-family: var(--font-mono);
  font-size: var(--text-2xs);
  color: var(--fg-faint);
  white-space: nowrap;
  overflow: hidden;
}
.pane__branch svg { width: 12px; height: 12px; flex: none; }
.pane__sim {
  flex: none;
  padding: 1px 7px;
  border-radius: var(--radius-pill);
  border: 1px dashed var(--line-strong);
  font-size: var(--text-2xs);
  font-weight: 560;
  color: var(--fg-subtle);
  white-space: nowrap;
}
.pane__spacer { flex: 1; }
.pane.is-split .pane__meta, .pane.is-split .pane__branch { display: none; }

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
