<script setup lang="ts">
import { Clock, Paperclip, SendHorizontal, X } from 'lucide-vue-next'
import type { Thread } from '~/types/chat'
import { useThreads } from '~/stores/threads'
import { isRunning } from '~/agents'
import { formatLocale } from '~/i18n'

/**
 * Messages written while the agent works. They wait for the turn to end, so the agent is not
 * disturbed; "Send now" hands one to the running turn instead (it reads it at its next step).
 * One row each, so a glance says what is still to go out.
 */
const props = defineProps<{ thread: Thread }>()
const { t } = useI18n()
const threads = useThreads()

/** A message that is already in the chat only waits for its turn: nothing to offer there. */
const waiting = computed(() => (threads.queue[props.thread.id] ?? []).filter(q => !q.shown))

/**
 * Only a real run can take a message mid-turn. The simulated agent of the browser preview cannot,
 * so there (and between turns) "Send now" is not offered. The status is read so this re-checks as the run starts and ends.
 */
const steerable = computed(() => props.thread.status !== undefined && isRunning(props.thread.id))
</script>

<template>
  <ul v-if="waiting.length" class="qu" role="list" :aria-label="t('chat.queue.label')">
    <li v-for="q in waiting" :key="q.id" class="qu__row">
      <Clock class="qu__icon" aria-hidden="true" />
      <span class="qu__text" :title="q.text">{{ q.text || t('chat.attachment') }}</span>
      <time v-if="q.queuedAt" class="qu__time tabular" :datetime="new Date(q.queuedAt).toISOString()" :title="t('chat.queue.written', { time: new Date(q.queuedAt).toLocaleTimeString(formatLocale()) })">{{ new Date(q.queuedAt).toLocaleTimeString(formatLocale(), { hour: '2-digit', minute: '2-digit' }) }}</time>
      <span v-if="q.attachments.length" class="qu__files tabular" :title="t('chat.queue.attached', { n: q.attachments.length })">
        <Paperclip aria-hidden="true" />{{ q.attachments.length }}
      </span>
      <UiButton
        v-if="steerable"
        variant="ghost"
        size="sm"
        :title="thread.status === 'waiting' ? t('chat.queue.toAgent') : t('chat.queue.toTurn')"
        @click="threads.sendNow(thread.id, q.id)"
      >
        <SendHorizontal aria-hidden="true" /> {{ t('chat.queue.sendNow') }}
      </UiButton>
      <UiIconButton size="sm" :label="t('chat.queue.remove')" @click="threads.dropQueued(thread.id, q.id)">
        <X />
      </UiIconButton>
    </li>
  </ul>
</template>

<style scoped>
.qu {
  list-style: none;
  margin: 0 0 var(--space-2);
  padding: 2px 0;
  border: 1px solid var(--line-soft);
  border-radius: var(--radius-md);
  background: var(--bg-panel);
  font-size: var(--text-sm);
}
.qu__row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-height: 32px;
  padding: 0 4px 0 var(--space-2);
}
.qu__icon { width: 14px; height: 14px; flex: none; stroke-width: 1.75; color: var(--fg-faint); }
.qu__text { flex: 1; min-width: 0; color: var(--fg-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.qu__files { flex: none; display: inline-flex; align-items: center; gap: 2px; font-size: var(--text-xs); color: var(--fg-subtle); }
.qu__files svg { width: 12px; height: 12px; stroke-width: 1.75; }
.qu__row :deep(.btn svg) { width: 13px; height: 13px; }
.qu__row :deep(.icon-btn svg) { width: 13px; height: 13px; }
.qu__time { flex: none; font-size: var(--text-xs); color: var(--fg-faint); }
</style>
