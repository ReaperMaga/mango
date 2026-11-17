<script setup lang="ts">
import { CircleAlert, FileText } from 'lucide-vue-next'
import type { Message, Part, Thread } from '~/types/chat'
import { formatDuration } from '~/utils/time'
import { formatSize } from '~/utils/attachments'
import { openImage } from '~/utils/imageViewer'
import { AGENTS } from '~/types/chat'
import { useThreads } from '~/stores/threads'
import { createdBy } from '~/utils/githubLinks'
import { useWorkspace } from '~/stores/workspace'

const props = defineProps<{ message: Message; thread: Thread; last: boolean }>()
const threads = useThreads()
const ws = useWorkspace()

/** Still being written. Not while the run only waits on background tasks: this answer is complete. */
const live = computed(() => props.last && ['running', 'queued', 'waiting'].includes(props.thread.status) && !threads.live[props.thread.id]?.idle)
function viewAttachment(id: string) {
  const images = (props.message.attachments ?? []).filter(a => a.thumb)
  openImage(images, images.findIndex(a => a.id === id))
}

type Step = Extract<Part, { type: 'thinking' } | { type: 'tool' }>
type Segment =
  | { kind: 'part'; key: string; part: Part; i: number }
  | { kind: 'steps'; key: string; steps: Step[]; end: number }

/**
 * A delegated task stays on its own row, so its link to the sub-agent's chat is never folded away;
 * so does a call that opened a pull request or issue, with its link to the Pull requests tool window.
 */
const isStep = (p: Part): p is Step =>
  p.type === 'thinking' || (p.type === 'tool' && !p.childId && !createdBy(p).length)

/** Runs of two or more thinking/tool rows fold into one ChatSteps; everything else renders on its own. */
const segments = computed<Segment[]>(() => {
  const parts = props.message.parts
  // Which rows Settings > Behaviour shows. Approvals, questions and errors always show.
  const mode = ws.toolCalls
  const lastText = parts.map(p => p.type).lastIndexOf('text')
  const shown = parts.map((p, i) => i).filter((i) => {
    const p = parts[i]!
    if (mode === 'zen') return p.type === 'approval' || p.type === 'notice' || i === lastText
    if (p.type === 'tool' && !p.childId && !createdBy(p).length) {
      if (mode === 'hide') return false
      if (mode === 'hide-ok') return p.status !== 'ok'
    }
    return true
  })
  const out: Segment[] = []
  for (let n = 0; n < shown.length;) {
    let last = n
    while (isStep(parts[shown[n]!]!) && last + 1 < shown.length && isStep(parts[shown[last + 1]!]!)) last++
    const i = shown[n]!
    if (last > n) {
      const steps = shown.slice(n, last + 1).map(k => parts[k]) as Step[]
      out.push({ kind: 'steps', key: `s:${steps[0]!.id ?? i}`, steps, end: shown[last]! })
    } else {
      const part = parts[i]!
      out.push({ kind: 'part', key: `p:${('id' in part && part.id) || i}`, part, i })
    }
    n = last + 1
  }
  return out
})

const lastTextIndex = computed(() => {
  for (let i = props.message.parts.length - 1; i >= 0; i--) if (props.message.parts[i]!.type === 'text') return i
  return -1
})
</script>

<template>
  <article v-if="message.role === 'user'" class="msg msg--user">
    <p v-if="message.fromAgent" class="msg__from">Task from {{ AGENTS[thread.agent].name }}</p>
    <ul v-if="message.attachments?.length" class="msg__files" aria-label="Attachments">
      <li
        v-for="a in message.attachments"
        :key="a.id"
        class="msg__file"
        :class="{ 'msg__file--image': a.thumb }"
        :title="`${a.name} · ${formatSize(a.size)}
${a.path}`"
      >
        <button v-if="a.thumb" type="button" class="msg__thumb-btn" :aria-label="`View ${a.name}`" @click="viewAttachment(a.id)">
          <img class="msg__thumb" :src="a.thumb" alt="">
        </button>
        <template v-else>
          <FileText class="msg__file-icon" aria-hidden="true" />
          <span class="msg__file-meta">
            <span class="msg__file-name">{{ a.name }}</span>
            <span class="msg__file-size tabular">{{ formatSize(a.size) }}</span>
          </span>
        </template>
      </li>
    </ul>
    <div v-if="message.parts.length" class="msg__bubble selectable">
      <template v-for="(p, i) in message.parts" :key="i">
        <p v-if="p.type === 'text'" class="msg__user-text">{{ p.text }}</p>
      </template>
    </div>
  </article>

  <article v-else class="msg msg--agent">
    <template v-for="seg in segments" :key="seg.key">
      <ChatSteps
        v-if="seg.kind === 'steps'"
        :steps="seg.steps"
        :live="live && seg.end === message.parts.length - 1"
      />
      <template v-else>
        <ChatThinking
          v-if="seg.part.type === 'thinking'"
          :text="seg.part.text"
          :seconds="seg.part.seconds"
          :live="live && seg.part.seconds === 0"
        />
        <ChatTool v-else-if="seg.part.type === 'tool'" :part="seg.part" />
        <ChatApproval
          v-else-if="seg.part.type === 'approval'"
          :part="seg.part"
          :agent-name="AGENTS[thread.agent].name"
          @resolve="allow => threads.resolveApproval(thread.id, message.id, seg.i, allow)"
        />
        <p v-else-if="seg.part.type === 'notice'" class="msg__notice" :class="`msg__notice--${seg.part.level}`" :role="seg.part.level === 'error' ? 'alert' : undefined">
          <CircleAlert v-if="seg.part.level === 'error'" />
          <span class="selectable">{{ seg.part.text }}</span>
        </p>
        <ChatMarkdown
          v-else-if="seg.part.type === 'text'"
          class="msg__text"
          :text="seg.part.text"
          :base="thread.projectPath"
          :thread-id="thread.id"
          :streaming="live && seg.i === lastTextIndex && seg.i === message.parts.length - 1"
        />
      </template>
    </template>
    <p v-if="message.elapsedMs !== undefined && !live" class="msg__ran tabular">
      {{ message.outcome === 'stopped' ? 'Stopped after' : message.outcome === 'error' ? 'Failed after' : 'Worked for' }} {{ formatDuration(message.elapsedMs) }}
    </p>
  </article>
</template>

<style scoped>
.msg { display: flex; flex-direction: column; gap: 2px; }
.msg--user { align-items: flex-end; }
.msg__bubble {
  max-width: min(88%, 620px);
  padding: 10px 14px;
  border-radius: var(--radius-lg);
  border-bottom-right-radius: var(--radius-xs);
  background: var(--bg-panel);
  border: 1px solid var(--line-soft);
}
.msg__files {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: var(--space-2);
  max-width: min(88%, 620px);
  margin: 0 0 var(--space-1);
  padding: 0;
  list-style: none;
}
.msg__file {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  height: 44px;
  max-width: 240px;
  padding: 0 var(--space-3) 0 10px;
  border: 1px solid var(--line-soft);
  border-radius: var(--radius-md);
  background: var(--bg-panel);
}
.msg__file--image {
  height: auto;
  max-width: none;
  padding: 0;
  overflow: hidden;
  background: var(--bg-inset);
}
.msg__thumb-btn { display: block; padding: 0; cursor: zoom-in; }
.msg__thumb-btn:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: -2px; border-radius: var(--radius-md); }
.msg__thumb { display: block; max-width: 200px; max-height: 140px; object-fit: contain; }
.msg__file-icon { flex: none; width: 18px; height: 18px; stroke-width: 1.75; color: var(--fg-subtle); }
.msg__file-meta { display: flex; flex-direction: column; min-width: 0; line-height: var(--leading-tight); }
.msg__file-name { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-size: var(--text-xs); font-weight: 540; color: var(--fg); }
.msg__file-size { font-size: var(--text-2xs); color: var(--fg-subtle); }
.msg__from { margin: 0 0 2px; font-size: var(--text-xs); color: var(--fg-faint); }
.msg__user-text { margin: 0; white-space: pre-wrap; line-height: var(--leading-chat); overflow-wrap: anywhere; }
.msg__text { margin: 6px 0 2px; }
.msg__ran { margin: var(--space-2) 0 0; font-size: var(--text-xs); color: var(--fg-faint); }
.msg__notice {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  margin: 6px 0 0;
  font-size: var(--text-sm);
  line-height: var(--leading-normal);
  color: var(--fg-subtle);
}
.msg__notice svg { width: 15px; height: 15px; flex: none; margin-top: 2px; }
.msg__notice--error { color: var(--ripe-error-fg); }
</style>
