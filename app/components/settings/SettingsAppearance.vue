<script setup lang="ts">
import { Monitor, Moon, Sun } from 'lucide-vue-next'
import { useWorkspace, type ColorScheme, type SchemeId, type Corners, type MonoFont, type Motion, type TextSize, type Theme, type UiFont } from '~/stores/workspace'
import SettingsSection from './SettingsSection.vue'
import SettingsRow from './SettingsRow.vue'
import SettingsSegmented from './SettingsSegmented.vue'
import SettingsSchemePicker from './SettingsSchemePicker.vue'
import SettingsSelect from './SettingsSelect.vue'
import { effectiveScheme } from '~/plugin-host/ids'
import { isPluginSchemeRegistered, pluginNames, reg } from '~/plugin-host/registry'

const ws = useWorkspace()

const themes: Array<{ value: Theme; label: string; icon: typeof Sun }> = [
  { value: 'dark', label: 'Dark', icon: Moon },
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'system', label: 'System', icon: Monitor },
]

const builtinSchemes: Array<{ value: ColorScheme; label: string }> = [
  { value: 'mango', label: 'Mango' },
  { value: 'blue', label: 'Blue' },
  { value: 'teal', label: 'Teal' },
  { value: 'green', label: 'Green' },
  { value: 'purple', label: 'Purple' },
  { value: 'pink', label: 'Pink' },
  { value: 'red', label: 'Red' },
  { value: 'slate', label: 'Slate' },
  { value: 'uchiha', label: 'Uchiha' },
  { value: 'graphite', label: 'Graphite' },
  { value: 'ink', label: 'Ink' },
  { value: 'cocoa', label: 'Cocoa' },
  { value: 'neon', label: 'Neon' },
  { value: 'solar', label: 'Solar' },
]
/** Mango's schemes, then the ones plugins add (named by their plugin in the tooltip). */
const schemes = computed<Array<{ value: SchemeId; label: string; swatch?: string; hint?: string }>>(() => [
  ...builtinSchemes,
  ...reg.schemes.map(s => ({
    value: s.fullId as SchemeId,
    label: s.label,
    ...(typeof s.swatch === 'string' && /^[#\w(),.%\s/-]{1,64}$/.test(s.swatch) ? { swatch: s.swatch } : {}),
    hint: `From ${pluginNames[s.pluginId] ?? s.pluginId}`,
  })),
])
/** A plugin scheme whose plugin is not running shows as what applies: Mango. */
const schemeShown = computed(() => effectiveScheme(ws.scheme, isPluginSchemeRegistered) as SchemeId)

const uiFonts: Array<{ value: UiFont; label: string }> = [
  { value: 'inter', label: 'Inter' },
  { value: 'geist', label: 'Geist' },
  { value: 'dm-sans', label: 'DM Sans' },
  { value: 'manrope', label: 'Manrope' },
  { value: 'system', label: 'System font' },
]
const monoFonts: Array<{ value: MonoFont; label: string }> = [
  { value: 'jetbrains-mono', label: 'JetBrains Mono' },
  { value: 'fira-code', label: 'Fira Code' },
  { value: 'source-code-pro', label: 'Source Code Pro' },
  { value: 'geist-mono', label: 'Geist Mono' },
  { value: 'system', label: 'System monospace' },
]

const textSizes: Array<{ value: TextSize; label: string }> = [
  { value: 'small', label: 'Small' },
  { value: 'default', label: 'Default' },
  { value: 'large', label: 'Large' },
  { value: 'xlarge', label: 'Extra large' },
]

const corners: Array<{ value: Corners; label: string }> = [
  { value: 'sharp', label: 'Sharp' },
  { value: 'default', label: 'Default' },
  { value: 'round', label: 'Round' },
]

const motions: Array<{ value: Motion; label: string }> = [
  { value: 'system', label: 'System' },
  { value: 'full', label: 'Full' },
  { value: 'reduced', label: 'Reduced' },
]
</script>

<template>
  <SettingsSection title="Appearance" description="How Mango looks on this computer.">
    <h3 class="head">Color</h3>
    <div class="card">
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
      <SettingsRow stacked label="Color scheme" hint="Tints the background and sets the accent color. Status colors stay the same.">
        <template #default="{ labelId }">
          <SettingsSchemePicker
            :model-value="schemeShown"
            :options="schemes"
            :labelledby="labelId"
            @update:model-value="ws.setScheme"
          />
        </template>
      </SettingsRow>
    </div>

    <h3 class="head">Text</h3>
    <div class="card">
      <SettingsRow label="Interface font" hint="The font of menus, chats and settings.">
        <template #default="{ labelId }">
          <SettingsSelect :model-value="ws.fontUi" :options="uiFonts" :labelledby="labelId" label="Interface font" @update:model-value="v => ws.setFonts({ ui: v })" />
        </template>
      </SettingsRow>
      <SettingsRow label="Code font" hint="The font of code, paths and branches, the editor and the terminal.">
        <template #default="{ labelId }">
          <SettingsSelect :model-value="ws.fontMono" :options="monoFonts" :labelledby="labelId" label="Code font" @update:model-value="v => ws.setFonts({ mono: v })" />
        </template>
      </SettingsRow>
      <SettingsRow label="Text size" hint="Scales the interface text. The terminal has its own size in Terminal settings.">
        <template #default="{ labelId }">
          <SettingsSegmented
            :model-value="ws.textSize"
            :options="textSizes"
            :labelledby="labelId"
            @update:model-value="ws.setTextSize"
          />
        </template>
      </SettingsRow>
    </div>

    <h3 class="head">Shape and motion</h3>
    <div class="card">
      <SettingsRow label="Corners" hint="How rounded buttons, panels and menus are.">
        <template #default="{ labelId }">
          <SettingsSegmented
            :model-value="ws.corners"
            :options="corners"
            :labelledby="labelId"
            @update:model-value="ws.setCorners"
          />
        </template>
      </SettingsRow>
      <SettingsRow label="Animations" hint="Reduced turns transitions off. System follows your computer's setting.">
        <template #default="{ labelId }">
          <SettingsSegmented
            :model-value="ws.motion"
            :options="motions"
            :labelledby="labelId"
            @update:model-value="ws.setMotion"
          />
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
