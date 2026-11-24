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

const { t } = useI18n()
const ws = useWorkspace()

const themes = computed<Array<{ value: Theme; label: string; icon: typeof Sun }>>(() => [
  { value: 'dark', label: t('appearance.theme.dark'), icon: Moon },
  { value: 'light', label: t('appearance.theme.light'), icon: Sun },
  { value: 'system', label: t('appearance.theme.system'), icon: Monitor },
])

const builtinSchemes = computed<Array<{ value: ColorScheme; label: string }>>(() => [
  { value: 'mango', label: t('appearance.scheme.names.mango') },
  { value: 'blue', label: t('appearance.scheme.names.blue') },
  { value: 'teal', label: t('appearance.scheme.names.teal') },
  { value: 'green', label: t('appearance.scheme.names.green') },
  { value: 'purple', label: t('appearance.scheme.names.purple') },
  { value: 'pink', label: t('appearance.scheme.names.pink') },
  { value: 'red', label: t('appearance.scheme.names.red') },
  { value: 'slate', label: t('appearance.scheme.names.slate') },
  { value: 'uchiha', label: t('appearance.scheme.names.uchiha') },
  { value: 'graphite', label: t('appearance.scheme.names.graphite') },
  { value: 'ink', label: t('appearance.scheme.names.ink') },
  { value: 'cocoa', label: t('appearance.scheme.names.cocoa') },
  { value: 'neon', label: t('appearance.scheme.names.neon') },
  { value: 'solar', label: t('appearance.scheme.names.solar') },
])
/** Mango's schemes, then the ones plugins add (named by their plugin in the tooltip). */
const schemes = computed<Array<{ value: SchemeId; label: string; swatch?: string; hint?: string }>>(() => [
  ...builtinSchemes.value,
  ...reg.schemes.map(s => ({
    value: s.fullId as SchemeId,
    label: s.label,
    ...(typeof s.swatch === 'string' && /^[#\w(),.%\s/-]{1,64}$/.test(s.swatch) ? { swatch: s.swatch } : {}),
    hint: t('appearance.scheme.from', { plugin: pluginNames[s.pluginId] ?? s.pluginId }),
  })),
])
/** A plugin scheme whose plugin is not running shows as what applies: Mango. */
const schemeShown = computed(() => effectiveScheme(ws.scheme, isPluginSchemeRegistered) as SchemeId)

const uiFonts = computed<Array<{ value: UiFont; label: string }>>(() => [
  { value: 'inter', label: 'Inter' },
  { value: 'geist', label: 'Geist' },
  { value: 'dm-sans', label: 'DM Sans' },
  { value: 'manrope', label: 'Manrope' },
  { value: 'system', label: t('appearance.fontUi.system') },
])
const monoFonts = computed<Array<{ value: MonoFont; label: string }>>(() => [
  { value: 'jetbrains-mono', label: 'JetBrains Mono' },
  { value: 'fira-code', label: 'Fira Code' },
  { value: 'source-code-pro', label: 'Source Code Pro' },
  { value: 'geist-mono', label: 'Geist Mono' },
  { value: 'system', label: t('appearance.fontMono.system') },
])

const textSizes = computed<Array<{ value: TextSize; label: string }>>(() => [
  { value: 'small', label: t('appearance.textSize.small') },
  { value: 'default', label: t('appearance.textSize.default') },
  { value: 'large', label: t('appearance.textSize.large') },
  { value: 'xlarge', label: t('appearance.textSize.xlarge') },
])

const corners = computed<Array<{ value: Corners; label: string }>>(() => [
  { value: 'sharp', label: t('appearance.corners.sharp') },
  { value: 'default', label: t('appearance.corners.default') },
  { value: 'round', label: t('appearance.corners.round') },
])

const motions = computed<Array<{ value: Motion; label: string }>>(() => [
  { value: 'system', label: t('appearance.motion.system') },
  { value: 'full', label: t('appearance.motion.full') },
  { value: 'reduced', label: t('appearance.motion.reduced') },
])
</script>

<template>
  <SettingsSection :title="t('settings.nav.appearance')" :description="t('appearance.description')">
    <h3 class="head">{{ t('appearance.color') }}</h3>
    <div class="card">
      <SettingsRow :label="t('appearance.theme.label')" :hint="t('appearance.theme.hint')">
        <template #default="{ labelId }">
          <SettingsSegmented
            :model-value="ws.theme"
            :options="themes"
            :labelledby="labelId"
            @update:model-value="ws.setTheme"
          />
        </template>
      </SettingsRow>
      <SettingsRow stacked :label="t('appearance.scheme.label')" :hint="t('appearance.scheme.hint')">
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

    <h3 class="head">{{ t('appearance.text') }}</h3>
    <div class="card">
      <SettingsRow :label="t('appearance.fontUi.label')" :hint="t('appearance.fontUi.hint')">
        <template #default="{ labelId }">
          <SettingsSelect :model-value="ws.fontUi" :options="uiFonts" :labelledby="labelId" :label="t('appearance.fontUi.label')" @update:model-value="v => ws.setFonts({ ui: v })" />
        </template>
      </SettingsRow>
      <SettingsRow :label="t('appearance.fontMono.label')" :hint="t('appearance.fontMono.hint')">
        <template #default="{ labelId }">
          <SettingsSelect :model-value="ws.fontMono" :options="monoFonts" :labelledby="labelId" :label="t('appearance.fontMono.label')" @update:model-value="v => ws.setFonts({ mono: v })" />
        </template>
      </SettingsRow>
      <SettingsRow :label="t('appearance.textSize.label')" :hint="t('appearance.textSize.hint')">
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

    <h3 class="head">{{ t('appearance.shape') }}</h3>
    <div class="card">
      <SettingsRow :label="t('appearance.corners.label')" :hint="t('appearance.corners.hint')">
        <template #default="{ labelId }">
          <SettingsSegmented
            :model-value="ws.corners"
            :options="corners"
            :labelledby="labelId"
            @update:model-value="ws.setCorners"
          />
        </template>
      </SettingsRow>
      <SettingsRow :label="t('appearance.motion.label')" :hint="t('appearance.motion.hint')">
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
