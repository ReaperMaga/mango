<script setup lang="ts">
import { AGENTS, waitingFor, type Thread } from '~/types/chat'
import { formatDuration } from '~/utils/time'
import { useThreads } from '~/stores/threads'
import { useWorkspace } from '~/stores/workspace'
import { vcsTerms } from '~/utils/vcs'
import { parseEnvPath } from '~/utils/envPath'
import { toolLabel } from '~/utils/chatTexts'

/**
 * The live "the agent is at work" row under the conversation: what it is
 * doing right now and for how long. Present from the moment a message is sent
 * until the turn ends, so the chat never looks idle while something runs.
 */
const props = defineProps<{ thread: Thread }>()

const { t } = useI18n()
const agent = computed(() => AGENTS[props.thread.agent].name)
const threads = useThreads()
const ws = useWorkspace()
/** Answered already, and only background tasks keep the run open (they are listed above the composer). */
const waitingOn = computed(() => {
  const live = threads.live[props.thread.id]
  return live?.idle ? live.tasks.filter(x => x.status === 'running').length : 0
})

/** The run's environment lost its connection: the agent goes on there while Mango reconnects. */
const reconnecting = computed(() => {
  if (!threads.live[props.thread.id]?.reconnecting) return null
  const root = threads.rootOf(props.thread.id) ?? props.thread
  return { name: parseEnvPath(root.projectPath)?.instance }
})

/** Only the conversation is being compacted: by the user's `/compact`, or by itself in a break. */
const compacting = computed(() => {
  const last = props.thread.messages.at(-1)
  if (last?.role !== 'agent' || last.parts.length) return false
  if (last.idle) return true
  const asked = props.thread.messages.at(-2)
  return props.thread.agent === 'claude' && asked?.role === 'user' && asked.parts.some(p => p.type === 'text' && /^\/compact(\s|$)/.test(p.text))
})

const activity = computed(() => {
  const chat = props.thread
  if (reconnecting.value) return reconnecting.value.name ? t('chat.working.reconnecting', { name: reconnecting.value.name }) : t('chat.working.reconnectingEnv')
  if (chat.status === 'queued' && chat.awaitingWorktree) {
    // Unity VCS downloads the branch's files into the new workspace first: minutes on a big project.
    const terms = vcsTerms(ws.openProjects.find(p => p.path === chat.projectPath)?.vcs)
    return terms.pathBranches ? t('chat.working.makingFiles', { term: t('chat.terms.workspace') }) : t('chat.working.making', { term: t('chat.terms.worktree') })
  }
  if (chat.status === 'queued') return t('chat.working.starting', { agent: agent.value })
  if (chat.status === 'waiting') return t(`chat.working.waitingFor.${waitingFor(chat)}`)
  if (waitingOn.value) return t('chat.working.waitingTasks', waitingOn.value)
  const last = chat.messages[chat.messages.length - 1]
  if (compacting.value) return t('chat.working.compacting')
  const part = last?.role === 'agent' ? last.parts[last.parts.length - 1] : undefined
  if (!part) return t('chat.working.startingUp', { agent: agent.value })
  if (part.type === 'thinking' && part.seconds === 0) return t('chat.working.thinking')
  if (part.type === 'text') return t('chat.working.writing')
  if (part.type === 'tool' && part.status === 'running') {
    switch (part.tool) {
      case 'read': return t('chat.working.read')
      case 'edit': return t('chat.working.edit')
      case 'write': return t('chat.working.write')
      case 'bash': return t('chat.working.bash')
      case 'search': return t('chat.working.search')
      case 'web': return t('chat.working.web')
      default: return part.label ? `${toolLabel(part.label)} ${part.target}`.trim() : t('chat.working.other')
    }
  }
  return t('chat.working.working')
})

/** The turn started when the user's message was sent. */
const startedAt = computed(() => {
  const msgs = props.thread.messages
  if (msgs.at(-1)?.idle) return msgs.at(-1)!.createdAt
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
  <div class="wk" :class="[`wk--${thread.status}`, { 'wk--reconnecting': reconnecting }]" role="status" aria-live="polite">
    <UiRipenessDot :status="thread.status" :size="13" />
    <span class="wk__label">{{ activity }}<span class="wk__dots" aria-hidden="true"><i /><i /><i /></span></span>
    <span v-if="reconnecting" class="wk__note">{{ t('chat.working.goesOn') }}</span>
    <span class="wk__time tabular">{{ elapsed }}</span>
    <i18n-t v-if="thread.status !== 'waiting'" keypath="chat.working.toStop" tag="span" scope="global" class="wk__hint"><template #key><kbd>Esc</kbd></template></i18n-t>
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
/* A dropped connection is not the agent's doing: said quietly, the run goes on. */
.wk--reconnecting .wk__label { color: var(--fg-muted); }
.wk__note {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--fg-subtle);
}
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
