<script setup lang="ts">
import { AGENTS, waitingFor, type Thread } from '~/types/chat'
import { formatDuration } from '~/utils/time'
import { useThreads } from '~/stores/threads'
import { useWorkspace } from '~/stores/workspace'
import { vcsTerms } from '~/utils/vcs'

/**
 * The live "the agent is at work" row under the conversation: what it is
 * doing right now and for how long. Present from the moment a message is sent
 * until the turn ends, so the chat never looks idle while something runs.
 */
const props = defineProps<{ thread: Thread }>()

const agent = computed(() => AGENTS[props.thread.agent].name)
const threads = useThreads()
const ws = useWorkspace()
/** Answered already, and only background tasks keep the run open (they are listed above the composer). */
const waitingOn = computed(() => {
  const live = threads.live[props.thread.id]
  return live?.idle ? live.tasks.filter(t => t.status === 'running').length : 0
})

const activity = computed(() => {
  const t = props.thread
  if (t.status === 'queued' && t.awaitingWorktree) {
    // Unity VCS downloads the branch's files into the new workspace first: minutes on a big project.
    const terms = vcsTerms(ws.openProjects.find(p => p.path === t.projectPath)?.vcs)
    return terms.pathBranches ? `Making a ${terms.worktree} and downloading its files` : `Making a ${terms.worktree}`
  }
  if (t.status === 'queued') return `Starting ${agent.value}`
  if (t.status === 'waiting') return `Waiting for your ${waitingFor(t)}`
  if (waitingOn.value) return `Waiting for ${waitingOn.value} background task${waitingOn.value === 1 ? '' : 's'}`
  const last = t.messages[t.messages.length - 1]
  const part = last?.role === 'agent' ? last.parts[last.parts.length - 1] : undefined
  if (!part) return `${agent.value} is starting up`
  if (part.type === 'thinking' && part.seconds === 0) return 'Thinking'
  if (part.type === 'text') return 'Writing'
  if (part.type === 'tool' && part.status === 'running') {
    switch (part.tool) {
      case 'read': return 'Reading files'
      case 'edit': return 'Editing a file'
      case 'write': return 'Creating a file'
      case 'bash': return 'Running a command'
      case 'search': return 'Searching the project'
      case 'web': return 'Looking something up online'
      default: return part.label ? `${part.label} ${part.target}`.trim() : 'Using a tool'
    }
  }
  return 'Working'
})

/** The turn started when the user's message was sent. */
const startedAt = computed(() => {
  const msgs = props.thread.messages
  for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i]!.role === 'user') return msgs[i]!.createdAt
  return props.thread.updatedAt
})

const now = ref(Date.now())
let timer: ReturnType<typeof setInterval> | undefined
onMounted(() => { timer = setInterval(() => (now.value = Date.now()), 1000) })
onBeforeUnmount(() => clearInterval(timer))
const elapsed = computed(() => formatDuration(Math.max(0, now.value - startedAt.value)))
</script>

<template>
  <div class="wk" :class="`wk--${thread.status}`" role="status" aria-live="polite">
    <UiRipenessDot :status="thread.status" :size="13" />
    <span class="wk__label">{{ activity }}<span class="wk__dots" aria-hidden="true"><i /><i /><i /></span></span>
    <span class="wk__time tabular">{{ elapsed }}</span>
    <span v-if="thread.status !== 'waiting'" class="wk__hint"><kbd>Esc</kbd> to stop</span>
  </div>
</template>

<style scoped>
.wk {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-height: 28px;
  font-size: var(--text-sm);
  color: var(--fg-muted);
}
.wk__label { font-weight: 520; color: var(--fg); }
.wk--waiting .wk__label { color: var(--ripe-waiting-fg); }
.wk__time { color: var(--fg-subtle); }
.wk__hint { margin-left: auto; display: inline-flex; align-items: center; gap: 6px; font-size: var(--text-xs); color: var(--fg-faint); }

/* Three dots that take turns: unmistakably "in progress" without shouting. */
.wk__dots { display: inline-flex; gap: 3px; margin-left: 5px; vertical-align: 1px; }
.wk__dots i {
  width: 3px;
  height: 3px;
  border-radius: 50%;
  background: currentColor;
  opacity: 0.25;
  animation: wk-dot 1.2s var(--ease-in-out) infinite;
}
.wk__dots i:nth-child(2) { animation-delay: 0.15s; }
.wk__dots i:nth-child(3) { animation-delay: 0.3s; }
.wk--waiting .wk__dots { display: none; }
@keyframes wk-dot {
  0%, 60%, 100% { opacity: 0.25; transform: translateY(0); }
  30% { opacity: 1; transform: translateY(-2px); }
}
</style>
