<script setup lang="ts">
import { ShieldQuestion, Check, Ban } from 'lucide-vue-next'
import type { Part } from '~/types/chat'

type ApprovalPart = Extract<Part, { type: 'approval' }>
defineProps<{ part: ApprovalPart; agentName: string }>()
const emit = defineEmits<{ resolve: [allow: boolean] }>()
</script>

<template>
  <!-- Pending: a card that asks. Settled: one quiet line, the tool row above tells the rest.
       Answering folds the card away and the line opens in its place. -->
  <UiReveal mode="out-in">
    <div v-if="part.state === 'pending'" class="ap ap--pending" role="group" :aria-label="part.title ?? `${agentName} needs your approval`">
      <div class="ap__head">
        <ShieldQuestion class="ap__icon" />
        <span>{{ part.title ?? `${agentName} wants to run a command` }}</span>
      </div>
      <pre v-if="part.command" class="ap__cmd selectable">{{ part.command }}</pre>
      <p v-if="part.reason" class="ap__reason">{{ part.reason }}</p>
      <div class="ap__actions">
        <UiButton variant="primary" size="sm" @click="emit('resolve', true)">Allow once</UiButton>
        <UiButton variant="ghost" size="sm" @click="emit('resolve', false)">Deny</UiButton>
      </div>
    </div>
    <p v-else class="ap-done" :class="`ap-done--${part.state}`">
      <Check v-if="part.state === 'allowed'" />
      <Ban v-else />
      <span>{{ part.state === 'allowed' ? 'You allowed this' : part.state === 'denied' ? 'You denied this' : 'Not answered' }}</span>
    </p>
  </UiReveal>
</template>

<style scoped>
.ap {
  margin: 6px 0;
  padding: var(--space-3);
  border-radius: var(--radius-md);
  border: 1px solid var(--line);
  background: var(--bg-panel);
  font-size: var(--text-sm);
}
.ap--pending {
  border-color: color-mix(in oklch, var(--ripe-waiting) 55%, transparent);
  background: color-mix(in oklch, var(--ripe-waiting) 7%, var(--bg-panel));
  box-shadow: var(--shadow-soft);
}
.ap__head { display: flex; align-items: center; gap: var(--space-2); font-weight: 580; color: var(--fg); }
.ap--allowed .ap__head, .ap--denied .ap__head { color: var(--fg-subtle); font-weight: 520; }
.ap__icon { width: 15px; height: 15px; stroke-width: 1.85; color: var(--ripe-waiting); }
.ap--allowed .ap__icon { color: var(--ripe-queued); }
.ap--denied .ap__icon, .ap--cancelled .ap__icon { color: var(--fg-faint); }
.ap--cancelled .ap__head { color: var(--fg-subtle); font-weight: 520; }
.ap__cmd {
  margin: var(--space-2) 0 0;
  padding: 8px 10px;
  border-radius: var(--radius-sm);
  background: var(--bg-inset);
  border: 1px solid var(--line-soft);
  font-size: var(--text-xs);
  color: var(--fg);
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 220px;
  overflow: auto;
}
.ap__prompt { color: var(--fg-faint); }
.ap__reason { margin: var(--space-2) 0 0; color: var(--fg-subtle); font-size: var(--text-xs); }
.ap__actions { display: flex; gap: var(--space-2); margin-top: var(--space-3); }

.ap-done {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0 0 2px 24px;
  font-size: var(--text-xs);
  color: var(--fg-faint);
}
.ap-done svg { width: 12px; height: 12px; stroke-width: 2; }
.ap-done--allowed svg { color: var(--ripe-queued-fg); }
.ap-done--denied { color: var(--fg-subtle); }
</style>
