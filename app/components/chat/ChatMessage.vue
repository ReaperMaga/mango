<script setup lang="ts">
import { CircleAlert, FileText } from 'lucide-vue-next'
import type { Message, Thread } from '~/types/chat'
import { formatDuration } from '~/utils/time'
import { formatSize } from '~/utils/attachments'
import { openImage } from '~/utils/imageViewer'
import { AGENTS } from '~/types/chat'
import { useThreads } from '~/stores/threads'

const props = defineProps<{ message: Message; thread: Thread; last: boolean }>()
const threads = useThreads()

const live = computed(() => props.last && ['running', 'queued', 'waiting'].includes(props.thread.status))
function viewAttachment(id: string) {
  const images = (props.message.attachments ?? []).filter(a => a.thumb)
  openImage(images, images.findIndex(a => a.id === id))
}

const lastTextIndex = computed(() => {
  for (let i = props.message.parts.length - 1; i >= 0; i--) if (props.message.parts[i]!.type === 'text') return i
  return -1
})
</script>

<template>
  <article v-if="message.role === 'user'" class="msg msg--user">
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
    <template v-for="(p, i) in message.parts" :key="i">
      <ChatThinking
        v-if="p.type === 'thinking'"
        :text="p.text"
        :seconds="p.seconds"
        :live="live && p.seconds === 0"
      />
      <ChatTool v-else-if="p.type === 'tool'" :part="p" />
      <ChatApproval
        v-else-if="p.type === 'approval'"
        :part="p"
        :agent-name="AGENTS[thread.agent].name"
        @resolve="allow => threads.resolveApproval(thread.id, message.id, i, allow)"
      />
      <p v-else-if="p.type === 'notice'" class="msg__notice" :class="`msg__notice--${p.level}`" :role="p.level === 'error' ? 'alert' : undefined">
        <CircleAlert v-if="p.level === 'error'" />
        <span class="selectable">{{ p.text }}</span>
      </p>
      <ChatMarkdown
        v-else-if="p.type === 'text'"
        class="msg__text"
        :text="p.text"
        :streaming="live && i === lastTextIndex && i === message.parts.length - 1"
      />
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
