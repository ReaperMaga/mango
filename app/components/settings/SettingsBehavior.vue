<script setup lang="ts">
import { useWorkspace, type FollowUp, type SendKey, type ToolCalls } from '~/stores/workspace'
import { MIN_TOKENS, type IdleCompaction } from '~/utils/idleCompaction'
import { formatTokens } from '~/agents/context'
import SettingsSection from './SettingsSection.vue'
import SettingsRow from './SettingsRow.vue'
import SettingsSelect from './SettingsSelect.vue'

const { t } = useI18n()

/** Settings > Behaviour: how the composer sends, what happens to messages written mid-run, and what a chat shows. */
const ws = useWorkspace()
const mod = modLabel()

const sendKeys: Array<{ value: SendKey; label: string }> = [
  { value: 'enter', label: 'Enter' },
  { value: 'mod-enter', label: `${mod} + Enter` },
]
const followUps = computed<Array<{ value: FollowUp; label: string }>>(() => [
  { value: 'queue', label: t('behavior.followUp.queue') },
  { value: 'steer', label: t('behavior.followUp.steer') },
])
const toolCalls = computed<Array<{ value: ToolCalls; label: string }>>(() => [
  { value: 'all', label: t('behavior.toolCalls.all') },
  { value: 'hide-ok', label: t('behavior.toolCalls.hide-ok') },
  { value: 'hide', label: t('behavior.toolCalls.hide') },
  { value: 'zen', label: t('behavior.toolCalls.zen') },
])
const breaks = computed<Array<{ value: IdleCompaction; label: string }>>(() => [
  { value: 'ask', label: t('behavior.breaks.ask') },
  { value: 'auto', label: t('behavior.breaks.auto') },
  { value: 'off', label: t('behavior.breaks.off') },
])
const opposite = computed(() => (ws.sendKey === 'enter' ? `${mod} + Enter` : `${mod} + Shift + Enter`))

function persist<K extends 'sendKey' | 'followUp' | 'toolCalls' | 'idleCompaction'>(key: K, value: (typeof ws)[K]) {
  ws[key] = value
  ws.persist()
}
</script>

<template>
  <SettingsSection :title="t('settings.nav.behavior')" :description="t('behavior.description')">
    <h3 class="head">{{ t('behavior.composer') }}</h3>
    <div class="card">
      <SettingsRow :label="t('behavior.sendKey.label')" :hint="t('behavior.sendKey.hint')">
        <template #default="{ labelId }">
          <SettingsSelect :model-value="ws.sendKey" :options="sendKeys" :labelledby="labelId" @update:model-value="v => persist('sendKey', v)" />
        </template>
      </SettingsRow>
    </div>

    <h3 class="head">{{ t('behavior.followUps') }}</h3>
    <div class="card">
      <SettingsRow
        :label="t('behavior.followUp.label')"
        :hint="t('behavior.followUp.hint', { shortcut: opposite })"
      >
        <template #default="{ labelId }">
          <SettingsSelect :model-value="ws.followUp" :options="followUps" :labelledby="labelId" @update:model-value="v => persist('followUp', v)" />
        </template>
      </SettingsRow>
    </div>

    <h3 class="head">{{ t('behavior.breaks.title') }}</h3>
    <div class="card">
      <SettingsRow :label="t('behavior.breaks.label')" :hint="t('behavior.breaks.hint', { tokens: formatTokens(MIN_TOKENS) })">
        <template #default="{ labelId }">
          <SettingsSelect :model-value="ws.idleCompaction" :options="breaks" :labelledby="labelId" @update:model-value="v => persist('idleCompaction', v)" />
        </template>
      </SettingsRow>
    </div>

    <h3 class="head">{{ t('behavior.activity') }}</h3>
    <div class="card">
      <SettingsRow
        :label="t('behavior.toolCalls.label')"
        :hint="t('behavior.toolCalls.hint')"
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
