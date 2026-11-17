<script setup lang="ts">
import { Bot, ChevronRight, CircleAlert, CircleCheck, CircleSlash, Activity, ScrollText, CircleStop, SquareTerminal, ArrowUpRight } from 'lucide-vue-next'
import type { BackgroundTask, Thread } from '~/types/chat'
import { useThreads } from '~/stores/threads'
import { readTaskOutput, stopTask } from '~/agents'
import { formatDuration } from '~/utils/time'

/**
 * What the chat's run keeps going in the background: commands started with "run in background",
 * commands that outlived their timeout, sub-agents nobody waits for. One row each, with how long
 * it has run, a peek at a command's output, and a stop button. Finished ones stay (dimmed) until
 * the run ends, so a glance says what happened.
 */
const props = defineProps<{ thread: Thread }>()
const threads = useThreads()

const tasks = computed<BackgroundTask[]>(() => threads.live[props.thread.id]?.tasks ?? [])
const running = computed(() => tasks.value.filter(t => t.status === 'running').length)
const open = ref(true)

const now = ref(Date.now())
let clock: ReturnType<typeof setInterval> | undefined
onMounted(() => { clock = setInterval(() => (now.value = Date.now()), 1000) })
onBeforeUnmount(() => clearInterval(clock))
const elapsed = (t: BackgroundTask) => formatDuration(Math.max(0, (t.endedAt ?? now.value) - t.startedAt))

const ICONS = { command: SquareTerminal, agent: Bot, other: Activity } as const
const END_ICONS = { done: CircleCheck, error: CircleAlert, stopped: CircleSlash } as const
const END_WORDS = { done: 'finished', error: 'failed', stopped: 'stopped' } as const

/** A background sub-agent has a chat of its own. */
const childOf = (t: BackgroundTask) =>
  t.kind === 'agent' && t.toolId ? threads.threads.find(c => c.parentId && c.toolId === t.toolId) ?? null : null

/* ---------- output peek: polled while open and the command runs ---------- */
const peeking = ref<string | null>(null)
const output = ref('')
const outputState = ref<'loading' | 'ready' | 'none'>('loading')
let poll: ReturnType<typeof setTimeout> | undefined
/** The open output's scroller (a function ref: a ref inside v-for would collect an array). */
let outEl: HTMLElement | null = null
const setOutEl = (el: unknown) => { outEl = el instanceof HTMLElement ? el : null }

async function readOutput(id: string) {
  const text = await readTaskOutput(props.thread.id, id)
  if (peeking.value !== id) return
  const el = outEl
  const atEnd = !el || el.scrollHeight - el.scrollTop - el.clientHeight < 24
  if (text === null) { if (outputState.value === 'loading') outputState.value = 'none' }
  else { output.value = text; outputState.value = 'ready' }
  if (atEnd) { await nextTick(); outEl?.scrollTo({ top: outEl.scrollHeight }) }
  const task = tasks.value.find(t => t.id === id)
  if (task?.status === 'running') poll = setTimeout(() => readOutput(id), 1500)
}

function togglePeek(t: BackgroundTask) {
  clearTimeout(poll)
  if (peeking.value === t.id) { peeking.value = null; return }
  peeking.value = t.id
  output.value = ''
  outputState.value = 'loading'
  void readOutput(t.id)
}
watch(tasks, (list) => { if (peeking.value && !list.some(t => t.id === peeking.value)) peeking.value = null })
onBeforeUnmount(() => clearTimeout(poll))

/** The end of a terminal's output can carry colour codes: plain text reads better here. */
const plain = computed(() => output.value.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, ''))
</script>

<template>
  <section v-if="tasks.length" class="bg" aria-label="Background tasks">
    <button type="button" class="bg__head" :aria-expanded="open" @click="open = !open">
      <ChevronRight class="bg__caret" :class="{ 'is-open': open }" aria-hidden="true" />
      <span class="bg__title">Background</span>
      <span class="bg__count tabular">{{ running ? `${running} running` : 'all finished' }}</span>
    </button>
    <UiReveal>
      <ul v-show="open" class="bg__list" role="list">
        <li v-for="t in tasks" :key="t.id" class="bg__item" :class="`is-${t.status}`">
          <div class="bg__row">
            <span class="bg__icon" aria-hidden="true">
              <span v-if="t.status === 'running'" class="bg__spin" />
              <component :is="END_ICONS[t.status]" v-else />
            </span>
            <component :is="ICONS[t.kind]" class="bg__kind" aria-hidden="true" />
            <span class="bg__name" :title="t.title">{{ t.title }}</span>
            <span v-if="t.status === 'running' && t.activity" class="bg__activity" :title="t.activity">{{ t.activity }}</span>
            <span v-else-if="t.status !== 'running'" class="bg__activity">{{ END_WORDS[t.status] }}</span>
            <span class="bg__time tabular">{{ elapsed(t) }}</span>
            <span class="bg__actions">
              <UiIconButton
                v-if="t.kind === 'command' || t.kind === 'other'"
                size="sm"
                :label="peeking === t.id ? 'Hide output' : 'Show output'"
                :active="peeking === t.id"
                @click="togglePeek(t)"
              >
                <ScrollText />
              </UiIconButton>
              <UiIconButton v-else-if="childOf(t)" size="sm" label="Open the sub-agent's chat" @click="threads.show(childOf(t)!.id)">
                <ArrowUpRight />
              </UiIconButton>
              <UiIconButton v-if="t.status === 'running'" size="sm" label="Stop" @click="stopTask(thread.id, t.id)">
                <CircleStop />
              </UiIconButton>
            </span>
          </div>
          <div v-if="peeking === t.id" class="bg__out selectable">
            <pre v-if="outputState === 'ready' && plain" :ref="setOutEl">{{ plain }}</pre>
            <p v-else class="bg__out-note">{{ outputState === 'loading' ? 'Reading output…' : outputState === 'ready' ? 'No output yet.' : 'This task has no output to show.' }}</p>
          </div>
        </li>
      </ul>
    </UiReveal>
  </section>
</template>

<style scoped>
.bg {
  margin-bottom: var(--space-2);
  border: 1px solid var(--line-soft);
  border-radius: var(--radius-md);
  background: var(--bg-panel);
  font-size: var(--text-sm);
}
.bg__head {
  display: flex;
  align-items: center;
  gap: 4px;
  width: 100%;
  height: 28px;
  padding: 0 var(--space-2);
  color: var(--fg-subtle);
  text-align: left;
  border-radius: var(--radius-md);
}
.bg__head:hover { color: var(--fg-muted); }
.bg__head:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: -2px; }
.bg__caret { width: 13px; height: 13px; flex: none; transition: transform var(--dur-fast) var(--ease-out); }
.bg__caret.is-open { transform: rotate(90deg); }
.bg__title { font-size: var(--text-xs); font-weight: 600; }
.bg__count { font-size: var(--text-xs); color: var(--fg-faint); margin-left: 4px; }

.bg__list { list-style: none; margin: 0; padding: 0 0 4px; max-height: 240px; overflow-y: auto; }
.bg__row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-height: 30px;
  padding: 0 4px 0 var(--space-2);
}
.bg__icon { width: 14px; height: 14px; display: grid; place-items: center; flex: none; }
.bg__icon svg { width: 14px; height: 14px; stroke-width: 1.75; }
.bg__kind { width: 14px; height: 14px; flex: none; stroke-width: 1.75; color: var(--fg-faint); }
.bg__name { min-width: 0; flex: 0 1 auto; color: var(--fg); font-weight: 520; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bg__activity { min-width: 0; flex: 1 1 0; font-size: var(--text-xs); color: var(--fg-faint); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bg__name + .bg__time { margin-left: auto; }
.bg__time { flex: none; font-size: var(--text-xs); color: var(--fg-subtle); }
.bg__actions { flex: none; display: flex; gap: 1px; }
.bg__actions :deep(svg) { width: 13px; height: 13px; }

.bg__item.is-done .bg__icon { color: var(--ripe-done-fg); }
.bg__item.is-error .bg__icon { color: var(--ripe-error-fg); }
.bg__item.is-stopped .bg__icon { color: var(--fg-faint); }
.bg__item:not(.is-running) .bg__name { color: var(--fg-subtle); font-weight: 500; }

.bg__spin {
  width: 11px;
  height: 11px;
  border-radius: 50%;
  border: 1.75px solid var(--ripe-running);
  border-right-color: transparent;
  animation: bg-spin 0.75s linear infinite;
}
@keyframes bg-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .bg__spin { animation-duration: 2.4s; } }

.bg__out {
  margin: 0 var(--space-2) 6px calc(var(--space-2) + 44px);
  border: 1px solid var(--line-soft);
  border-radius: var(--radius-sm);
  background: var(--bg-inset);
  overflow: hidden;
}
.bg__out pre {
  margin: 0;
  padding: var(--space-2) var(--space-3);
  max-height: 180px;
  overflow: auto;
  font-size: var(--text-xs);
  line-height: 1.55;
  color: var(--fg-muted);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.bg__out-note { margin: 0; padding: var(--space-2) var(--space-3); font-size: var(--text-xs); color: var(--fg-faint); }
</style>
