<script setup lang="ts">
import { useWorkspace, type FollowUp, type SendKey, type ToolCalls } from '~/stores/workspace'
import SettingsSection from './SettingsSection.vue'
import SettingsRow from './SettingsRow.vue'
import SettingsSelect from './SettingsSelect.vue'

/** Settings > Behaviour: how the composer sends, what happens to messages written mid-run, and what a chat shows. */
const ws = useWorkspace()
const mod = modLabel()

const sendKeys: Array<{ value: SendKey; label: string }> = [
  { value: 'enter', label: 'Enter' },
  { value: 'mod-enter', label: `${mod} + Enter` },
]
const followUps: Array<{ value: FollowUp; label: string }> = [
  { value: 'queue', label: 'Queue' },
  { value: 'steer', label: 'Steer' },
]
const toolCalls: Array<{ value: ToolCalls; label: string }> = [
  { value: 'all', label: 'Show all' },
  { value: 'hide-ok', label: 'Hide successful' },
  { value: 'hide', label: 'Hide all' },
  { value: 'zen', label: 'Zen' },
]
const opposite = computed(() => (ws.sendKey === 'enter' ? `${mod} + Enter` : `${mod} + Shift + Enter`))

function persist<K extends 'sendKey' | 'followUp' | 'toolCalls'>(key: K, value: (typeof ws)[K]) {
  ws[key] = value
  ws.persist()
}
</script>

<template>
  <SettingsSection title="Behaviour" description="How the composer sends, and what a chat shows while the agent works.">
    <h3 class="head">Composer</h3>
    <div class="card">
      <SettingsRow label="Send shortcut" hint="Choose when Enter sends a message or inserts a new line.">
        <template #default="{ labelId }">
          <SettingsSelect :model-value="ws.sendKey" :options="sendKeys" :labelledby="labelId" @update:model-value="v => persist('sendKey', v)" />
        </template>
      </SettingsRow>
    </div>

    <h3 class="head">Follow-ups</h3>
    <div class="card">
      <SettingsRow
        label="Follow-up behavior"
        :hint="`Queue messages written while the agent works, or steer the current run. Press ${opposite} to do the opposite for one message.`"
      >
        <template #default="{ labelId }">
          <SettingsSelect :model-value="ws.followUp" :options="followUps" :labelledby="labelId" @update:model-value="v => persist('followUp', v)" />
        </template>
      </SettingsRow>
    </div>

    <h3 class="head">Activity</h3>
    <div class="card">
      <SettingsRow
        label="Tool calls in chat"
        hint="Hide the commands, edits and searches agents run. Hide successful keeps failures. Zen shows only final answers. Approvals, questions and errors always show."
      >
        <template #default="{ labelId }">
          <SettingsSelect :model-value="ws.toolCalls" :options="toolCalls" :labelledby="labelId" @update:model-value="v => persist('toolCalls', v)" />
        </template>
      </SettingsRow>
    </div>
  </SettingsSection>
</template>

<style scoped>
.head { margin: var(--space-6) 0 var(--space-3); font-size: var(--text-md); font-weight: 600; }
.head:first-of-type { margin-top: 0; }
.card {
  border: 1px solid var(--line-soft);
  border-radius: var(--radius-md);
  background: var(--bg-panel);
}
.card :deep(.srow) { padding: var(--space-3) var(--space-4); }
</style>
