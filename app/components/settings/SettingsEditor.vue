<script setup lang="ts">
import { useWorkspace } from '~/stores/workspace'
import SettingsSection from './SettingsSection.vue'
import SettingsRow from './SettingsRow.vue'
import SettingsSwitch from './SettingsSwitch.vue'
import SettingsLanguageServers from './SettingsLanguageServers.vue'

/** Settings > Editor: how file tabs save and move, and whether they may use language servers. */
const ws = useWorkspace()
</script>

<template>
  <SettingsSection title="Editor" description="How files behave when you edit them in Mango.">
    <h3 class="head">Saving</h3>
    <div class="card">
      <SettingsRow
        label="Save files automatically"
        hint="Saves shortly after you stop typing, when you switch away, and before agents and Git use your files. A file that changed on disk is never overwritten without asking."
      >
        <template #default="{ labelId }">
          <SettingsSwitch :model-value="ws.editorAutoSave" :labelledby="labelId" @update:model-value="v => ws.setEditor({ editorAutoSave: v })" />
        </template>
      </SettingsRow>
    </div>

    <h3 class="head">Cursor</h3>
    <div class="card">
      <SettingsRow label="Smooth caret" hint="The caret glides as it moves. It stays still when motion is reduced.">
        <template #default="{ labelId }">
          <SettingsSwitch :model-value="ws.editorSmoothCaret" :labelledby="labelId" @update:model-value="v => ws.setEditor({ editorSmoothCaret: v })" />
        </template>
      </SettingsRow>
    </div>

    <h3 class="head">Code intelligence</h3>
    <div class="card">
      <SettingsRow label="Language servers" hint="Smarter completion, errors and go to definition. Each project asks first, as a language server can run the project's code.">
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
