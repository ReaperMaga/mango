<script setup lang="ts">
import { useWorkspace } from '~/stores/workspace'
import SettingsSection from './SettingsSection.vue'
import SettingsRow from './SettingsRow.vue'
import SettingsSwitch from './SettingsSwitch.vue'
import SettingsLanguageServers from './SettingsLanguageServers.vue'

/** Settings > Editor: how file tabs save and move, and whether they may use language servers. */
const { t } = useI18n()
const ws = useWorkspace()
</script>

<template>
  <SettingsSection :title="t('settings.nav.editor')" :description="t('settings.editor.description')">
    <h3 class="head">{{ t('settings.editor.saving') }}</h3>
    <div class="card">
      <SettingsRow
        :label="t('settings.editor.autoSave')"
        :hint="t('settings.editor.autoSaveHint')"
      >
        <template #default="{ labelId }">
          <SettingsSwitch :model-value="ws.editorAutoSave" :labelledby="labelId" @update:model-value="v => ws.setEditor({ editorAutoSave: v })" />
        </template>
      </SettingsRow>
    </div>

    <h3 class="head">{{ t('settings.terminal.cursor') }}</h3>
    <div class="card">
      <SettingsRow :label="t('settings.editor.smooth')" :hint="t('settings.editor.smoothHint')">
        <template #default="{ labelId }">
          <SettingsSwitch :model-value="ws.editorSmoothCaret" :labelledby="labelId" @update:model-value="v => ws.setEditor({ editorSmoothCaret: v })" />
        </template>
      </SettingsRow>
    </div>

    <h3 class="head">{{ t('settings.editor.intelligence') }}</h3>
    <div class="card">
      <SettingsRow :label="t('settings.editor.servers')" :hint="t('settings.editor.serversHint')">
        <template #default="{ labelId }">
          <SettingsSwitch :model-value="ws.editorLanguageServers" :labelledby="labelId" @update:model-value="v => ws.setEditor({ editorLanguageServers: v })" />
        </template>
      </SettingsRow>
    </div>
    <SettingsLanguageServers />
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
