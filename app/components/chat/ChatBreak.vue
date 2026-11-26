<script setup lang="ts">
import { Minimize2 } from 'lucide-vue-next'
import type { Thread } from '~/types/chat'
import { formatTokens } from '~/agents/context'
import { useThreads } from '~/stores/threads'
import { useWorkspace } from '~/stores/workspace'
import { breakToAsk } from '~/utils/idleCompaction'
import { longAgo, useNow } from '~/utils/time'

/**
 * A large Claude Code chat after a break: its next message has the whole conversation read again. Says so
 * over the composer and offers to compact it first; writing on as usual ignores the offer.
 */
const props = defineProps<{
  thread: Thread
  /** Something is written in the composer: it goes out once the chat is compacted. */
  written: boolean
}>()
const emit = defineEmits<{ compact: [] }>()

const { t } = useI18n()
const threads = useThreads()
const ws = useWorkspace()
const now = useNow()
// Another chat in the pane counts from now, not from the last tick.
watch(() => props.thread.id, () => { now.value = Date.now() })
const pause = computed(() => breakToAsk(props.thread, ws.idleCompaction, now.value, ws.idleTokensFor(props.thread.projectPath)))
</script>

<template>
  <div v-if="pause" class="brk" role="note">
    <p class="brk__text">
      {{ t('chat.break.text', { ago: longAgo(pause.since, now), tokens: formatTokens(pause.tokens) }) }}
      <span class="brk__more">{{ t('chat.break.more') }}</span>
    </p>
    <div class="brk__actions">
      <UiButton variant="ghost" size="sm" @click="threads.keepContext(thread.id)">{{ t('chat.break.never') }}</UiButton>
      <UiButton size="sm" @click="emit('compact')"><Minimize2 aria-hidden="true" /> {{ written ? t('chat.break.compactSend') : t('chat.break.compact') }}</UiButton>
    </div>
  </div>
</template>

<style scoped>
.brk {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: var(--space-2) var(--space-3);
  margin-bottom: var(--space-2);
  padding: var(--space-2) var(--space-2) var(--space-2) var(--space-3);
  border: 1px solid var(--line-soft);
  border-radius: var(--radius-md);
  background: var(--bg-panel);
}
.brk__text { flex: 1 1 320px; min-width: 0; margin: 0; font-size: var(--text-sm); line-height: var(--leading-normal); color: var(--fg-muted); text-wrap: pretty; }
.brk__more { color: var(--fg-subtle); }
.brk__actions { flex: none; display: flex; flex-wrap: wrap; justify-content: flex-end; gap: var(--space-1); }
.brk__actions :deep(svg) { width: 13px; height: 13px; }
</style>
