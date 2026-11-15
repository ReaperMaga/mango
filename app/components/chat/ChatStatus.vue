<script setup lang="ts">
import { Archive, ChevronDown, CircleCheck, CircleDashed, CircleDot } from 'lucide-vue-next'
import { useThreads, isBusy } from '~/stores/threads'
import { displayStatus, statusLabel, type Thread } from '~/types/chat'
import type { MenuItem } from '~/types/ui'

/**
 * A chat's status, and the place to change it: Idle, Working, Settled or
 * Archived. While an agent runs, the run owns the status ("Working", "Needs you").
 */
const props = defineProps<{ thread: Thread }>()
const threads = useThreads()

const status = computed(() => displayStatus(props.thread))
const busy = computed(() => isBusy(props.thread))

/** The four statuses, as a picker. While an agent is running the run decides, so the others wait. */
const items = computed<MenuItem[]>(() => {
  const t = props.thread
  const wait = busy.value ? 'Available when the agent has finished' : undefined
  const pick = (to: 'idle' | 'working' | 'done') => () => threads.setStatus(t.id, to)
  return [
    { label: 'Idle', hint: wait ?? 'Not started, or parked for now', icon: CircleDashed, checked: status.value === 'idle', disabled: busy.value, onSelect: pick('idle') },
    {
      label: 'Working',
      hint: busy.value ? (status.value === 'waiting' ? 'The agent is waiting for your approval' : 'The agent is running') : 'In progress, more to do here',
      icon: CircleDot,
      checked: status.value === 'working' || status.value === 'waiting',
      onSelect: busy.value ? undefined : pick('working'),
    },
    { label: 'Settled', hint: wait ?? 'Finished, nothing more pending', icon: CircleCheck, checked: status.value === 'done', disabled: busy.value, onSelect: pick('done') },
    {
      label: 'Archived',
      hint: wait ?? 'Hidden from the thread list. Nothing is deleted.',
      icon: Archive,
      checked: status.value === 'archived',
      disabled: busy.value,
      onSelect: () => (t.archived ? undefined : threads.archive(t.id)),
    },
  ]
})
</script>

<template>
  <UiMenu :items="items" placement="bottom-end" :width="280" label="Chat status">
    <template #default="{ toggle, open }">
      <button
        type="button"
        class="st"
        :class="[`st--${status}`, { 'is-open': open }]"
        aria-haspopup="menu"
        :aria-expanded="open"
        :aria-label="`Status: ${statusLabel(thread)}. Change status`"
        :title="open ? undefined : 'Change status'"
        @click="toggle"
      >
        <span v-if="status === 'working' && busy" class="st__spin" aria-hidden="true" />
        <span class="st__label">{{ statusLabel(thread) }}</span>
        <ChevronDown />
      </button>
    </template>
  </UiMenu>
</template>

<style scoped>
.st {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 24px;
  padding: 0 4px 0 8px;
  border-radius: var(--radius-sm);
  font-size: var(--text-xs);
  font-weight: 560;
  color: var(--fg-subtle);
  white-space: nowrap;
  transition: background var(--dur-fast) var(--ease-out);
}
.st:hover, .st.is-open { background: var(--bg-hover); }
.st svg { width: 12px; height: 12px; stroke-width: 2; color: var(--fg-faint); }
.st--working { color: var(--ripe-running-fg); }
.st__spin {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  border: 1.5px solid currentColor;
  border-right-color: transparent;
  animation: st-spin 0.8s linear infinite;
}
@keyframes st-spin { to { transform: rotate(360deg); } }
.st--waiting { color: var(--ripe-waiting-fg); }
.st--done { color: var(--ripe-done-fg); }
.st--error { color: var(--ripe-error-fg); }
.st--archived { color: var(--fg-faint); }
</style>
