<script setup lang="ts">
import type { PluginSettingField } from '~/types/ipc'
import { usePlugins } from '~/stores/plugins'
import SettingsRow from '~/components/settings/SettingsRow.vue'
import SettingsSwitch from '~/components/settings/SettingsSwitch.vue'
import SettingsSelect from '~/components/settings/SettingsSelect.vue'

/**
 * A plugin's declarative settings (`settings` in its manifest) as Settings rows: a switch, a field, a
 * text area, a number or a choice. Values save as they change (stores/plugins.ts); the plugin reads
 * them through `mango.settings` and hears about changes.
 */
const props = defineProps<{ pluginId: string; fields: PluginSettingField[] }>()
const plugins = usePlugins()

const value = (f: PluginSettingField) => plugins.setting(props.pluginId, f.key)
const set = (f: PluginSettingField, v: unknown) => plugins.setSetting(props.pluginId, f.key, v)

const str = (f: PluginSettingField) => {
  const v = value(f)
  return v === undefined || v === null ? '' : String(v)
}
const bool = (f: PluginSettingField) => !!value(f)

/** Numbers commit on change (Enter, leaving the field), kept within min and max; empty goes back to the default. */
function setNumber(f: PluginSettingField, e: Event) {
  const el = e.target as HTMLInputElement
  if (el.value.trim() === '') {
    plugins.clearSetting(props.pluginId, f.key)
    el.value = str(f)
    return
  }
  let n = Number(el.value)
  if (!Number.isFinite(n)) {
    el.value = str(f)
    return
  }
  if (typeof f.min === 'number') n = Math.max(f.min, n)
  if (typeof f.max === 'number') n = Math.min(f.max, n)
  el.value = String(n)
  set(f, n)
}

const options = (f: PluginSettingField) => (f.options ?? []).map(o => ({ value: String(o.value), label: o.label }))
const selected = (f: PluginSettingField) => {
  const v = str(f)
  return options(f).some(o => o.value === v) ? v : (options(f)[0]?.value ?? '')
}

const changed = computed(() => Object.keys(plugins.settingsValues[props.pluginId] ?? {}).length > 0)
const rangeHint = (f: PluginSettingField) =>
  typeof f.min === 'number' && typeof f.max === 'number' ? `${f.min} to ${f.max}`
    : typeof f.min === 'number' ? `At least ${f.min}`
      : typeof f.max === 'number' ? `At most ${f.max}` : ''
const hintOf = (f: PluginSettingField) => [f.description?.replace(/\.\s*$/, ''), f.type === 'number' ? rangeHint(f) : ''].filter(Boolean).join('. ')
</script>

<template>
  <div class="psf">
    <template v-for="f in fields" :key="f.key">
      <SettingsRow v-if="f.type === 'boolean'" :label="f.label" :hint="f.description">
        <template #default="{ labelId }">
          <SettingsSwitch :model-value="bool(f)" :labelledby="labelId" @update:model-value="v => set(f, v)" />
        </template>
      </SettingsRow>

      <SettingsRow v-else-if="f.type === 'select'" :label="f.label" :hint="f.description">
        <template #default="{ labelId }">
          <SettingsSelect :model-value="selected(f)" :options="options(f)" :labelledby="labelId" :label="f.label" @update:model-value="v => set(f, v)" />
        </template>
      </SettingsRow>

      <SettingsRow v-else-if="f.type === 'number'" :label="f.label" :hint="hintOf(f)">
        <template #default="{ labelId }">
          <input
            class="psf__input psf__input--number tabular"
            type="number"
            :value="str(f)"
            :min="f.min"
            :max="f.max"
            :placeholder="f.placeholder"
            :aria-labelledby="labelId"
            @change="setNumber(f, $event)"
            @keydown.enter="($event.target as HTMLInputElement).blur()"
          >
        </template>
      </SettingsRow>

      <SettingsRow v-else-if="f.type === 'text'" :label="f.label" :hint="f.description" stacked>
        <template #default="{ labelId }">
          <textarea
            class="psf__input psf__input--area"
            rows="4"
            :value="str(f)"
            :placeholder="f.placeholder"
            :aria-labelledby="labelId"
            spellcheck="false"
            @input="set(f, ($event.target as HTMLTextAreaElement).value)"
          />
        </template>
      </SettingsRow>

      <SettingsRow v-else :label="f.label" :hint="f.description">
        <template #default="{ labelId }">
          <input
            class="psf__input psf__input--text"
            type="text"
            :value="str(f)"
            :placeholder="f.placeholder"
            :aria-labelledby="labelId"
            spellcheck="false"
            autocomplete="off"
            @input="set(f, ($event.target as HTMLInputElement).value)"
          >
        </template>
      </SettingsRow>
    </template>

    <div class="psf__foot">
      <UiButton size="sm" variant="ghost" :disabled="!changed" @click="plugins.resetSettings(pluginId)">Reset to defaults</UiButton>
    </div>
  </div>
</template>

<style scoped>
.psf { display: grid; }
.psf__input {
  height: 30px;
  padding: 0 var(--space-3);
  background: var(--bg-inset);
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  font-size: var(--text-sm);
  transition: border-color var(--dur-fast) var(--ease-out), box-shadow var(--dur-fast) var(--ease-out);
}
.psf__input::placeholder { color: var(--fg-faint); }
.psf__input:focus-visible { outline: none; }
.psf__input:focus { border-color: var(--accent-line); box-shadow: 0 0 0 3px var(--accent-soft); }
.psf__input--text { width: 240px; max-width: 100%; }
.psf__input--number { width: 110px; }
.psf__input--area {
  display: block;
  width: 100%;
  height: auto;
  min-height: 80px;
  padding: var(--space-2) var(--space-3);
  line-height: var(--leading-normal, 1.5);
  resize: vertical;
}
.psf__foot { display: flex; justify-content: flex-end; padding-top: var(--space-2); border-top: 1px solid var(--line-soft); }
</style>
