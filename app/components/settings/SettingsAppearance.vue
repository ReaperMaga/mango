<script setup lang="ts">
import { Monitor, Moon, Sun } from 'lucide-vue-next'
import { useWorkspace, type ColorScheme, type Theme } from '~/stores/workspace'
import SettingsSection from './SettingsSection.vue'
import SettingsRow from './SettingsRow.vue'
import SettingsSegmented from './SettingsSegmented.vue'
import SettingsSchemePicker from './SettingsSchemePicker.vue'

const ws = useWorkspace()

const themes: Array<{ value: Theme; label: string; icon: typeof Sun }> = [
  { value: 'dark', label: 'Dark', icon: Moon },
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'system', label: 'System', icon: Monitor },
]

const schemes: Array<{ value: ColorScheme; label: string }> = [
  { value: 'mango', label: 'Mango' },
  { value: 'blue', label: 'Blue' },
  { value: 'purple', label: 'Purple' },
  { value: 'pink', label: 'Pink' },
  { value: 'graphite', label: 'Graphite' },
]
</script>

<template>
  <SettingsSection title="Appearance" description="How Mango looks on this computer.">
    <div class="group">
      <SettingsRow label="Theme" hint="System follows your computer's light or dark setting.">
        <template #default="{ labelId }">
          <SettingsSegmented
            :model-value="ws.theme"
            :options="themes"
            :labelledby="labelId"
            @update:model-value="ws.setTheme"
          />
        </template>
      </SettingsRow>
      <SettingsRow label="Color scheme" hint="Tints the background and sets the accent color. Status colors stay the same.">
        <template #default="{ labelId }">
          <SettingsSchemePicker
            :model-value="ws.scheme"
            :options="schemes"
            :labelledby="labelId"
            @update:model-value="ws.setScheme"
          />
        </template>
      </SettingsRow>
    </div>
  </SettingsSection>
</template>

<style scoped>
.group {
  border-top: 1px solid var(--line-soft);
  border-bottom: 1px solid var(--line-soft);
}
</style>
