<script setup lang="ts">
import type { PermissionMode } from '~/types/chat'
import { LOCALES, type Locale, type LocalePref } from '~/i18n/locales'
import { useWorkspace } from '~/stores/workspace'
import SettingsSection from './SettingsSection.vue'
import SettingsRow from './SettingsRow.vue'
import SettingsSwitch from './SettingsSwitch.vue'
import SettingsSelect from './SettingsSelect.vue'
import type { OpenProjectIn } from '~/utils/openWhere'

const { t } = useI18n()
const ws = useWorkspace()

const languages = computed<Array<{ value: LocalePref; label: string }>>(() => [
  { value: 'system', label: t('general.language.system') },
  ...(Object.keys(LOCALES) as Locale[]).map(value => ({ value, label: LOCALES[value] })),
])

/** Least to most independent. */
const modes = computed<Array<{ value: PermissionMode; label: string; hint: string }>>(() => [
  { value: 'plan', label: t('general.modes.plan.label'), hint: t('general.modes.plan.hint') },
  { value: 'ask', label: t('general.modes.ask.label'), hint: t('general.modes.ask.hint') },
  { value: 'edits', label: t('general.modes.edits.label'), hint: t('general.modes.edits.hint') },
  { value: 'auto', label: t('general.modes.auto.label'), hint: t('general.modes.auto.hint') },
])

/** Opening a project in a window that already holds others. */
const openIns = computed<Array<{ value: OpenProjectIn; label: string }>>(() => [
  { value: 'ask', label: t('general.windows.ask') },
  { value: 'this', label: t('general.windows.this') },
  { value: 'new', label: t('general.windows.new') },
])

function setMode(mode: PermissionMode) {
  ws.defaultMode = mode
  ws.persist()
}

const name = useId()
const labelId = useId()
const hintId = useId()
</script>

<template>
  <SettingsSection :title="t('settings.nav.general')" :description="t('general.description')">
    <div class="group">
      <div class="group__head">
        <h3 class="group__title">{{ t('general.language.title') }}</h3>
        <p class="group__hint">{{ t('general.language.hint') }}</p>
      </div>
      <SettingsRow :label="t('general.language.label')">
        <template #default="{ labelId }">
          <SettingsSelect :model-value="ws.locale" :options="languages" :labelledby="labelId" :label="t('general.language.label')" @update:model-value="ws.setLocale" />
        </template>
      </SettingsRow>
    </div>

    <div class="group spaced">
      <div class="group__head">
        <h3 :id="labelId" class="group__title">{{ t('general.permissions.title') }}</h3>
        <p :id="hintId" class="group__hint">{{ t('general.permissions.hint') }}</p>
      </div>

      <div class="modes" role="radiogroup" :aria-labelledby="labelId" :aria-describedby="hintId">
        <label v-for="m in modes" :key="m.value" class="mode">
          <input
            class="mode__input"
            type="radio"
            :name="name"
            :value="m.value"
            :checked="ws.defaultMode === m.value"
            :aria-describedby="`${name}-${m.value}`"
            @change="setMode(m.value)"
          >
          <span class="mode__face">
            <span class="mode__radio" aria-hidden="true" />
            <span class="mode__text">
              <span class="mode__label">{{ m.label }}</span>
              <span :id="`${name}-${m.value}`" class="mode__hint">{{ m.hint }}</span>
            </span>
          </span>
        </label>
      </div>
    </div>

    <div class="group spaced">
      <div class="group__head">
        <h3 class="group__title">{{ t('general.confirm.title') }}</h3>
        <p class="group__hint">{{ t('general.confirm.hint') }}</p>
      </div>
      <SettingsRow :label="t('general.confirm.archive')" :hint="t('general.confirm.archiveHint')">
        <template #default="{ labelId }">
          <SettingsSwitch :model-value="ws.confirmArchive" :labelledby="labelId" @update:model-value="v => { ws.confirmArchive = v; ws.persist() }" />
        </template>
      </SettingsRow>
      <SettingsRow :label="t('general.confirm.delete')" :hint="t('general.confirm.deleteHint')">
        <template #default="{ labelId }">
          <SettingsSwitch :model-value="ws.confirmDelete" :labelledby="labelId" @update:model-value="v => { ws.confirmDelete = v; ws.persist() }" />
        </template>
      </SettingsRow>
    </div>

    <div class="group spaced">
      <div class="group__head">
        <h3 class="group__title">{{ t('general.windows.title') }}</h3>
        <p class="group__hint">{{ t('general.windows.hint') }}</p>
      </div>
      <SettingsRow :label="t('general.windows.openIn')" :hint="t('general.windows.openInHint')">
        <template #default="{ labelId }">
          <SettingsSelect :model-value="ws.openProjectIn" :options="openIns" :labelledby="labelId" @update:model-value="v => { ws.openProjectIn = v; ws.persist() }" />
        </template>
      </SettingsRow>
    </div>
  </SettingsSection>
</template>

<style scoped>
.group { padding-top: var(--space-4); border-top: 1px solid var(--line-soft); }
.group__title { margin: 0; font-size: var(--text-sm); font-weight: 560; }
.group__hint {
  margin: 2px 0 0;
  font-size: var(--text-xs);
  color: var(--fg-subtle);
  text-wrap: pretty;
}

.modes {
  display: grid;
  gap: 2px;
  /* Rows hang out by their own padding, so the radios line up with the heading. */
  margin: var(--space-3) calc(var(--space-2) * -1) 0;
}
.mode { position: relative; display: block; }
.mode__input {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  margin: 0;
  opacity: 0;
  cursor: pointer;
}
.mode__face {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: var(--space-2);
  border-radius: var(--radius-sm);
  transition: background var(--dur-fast) var(--ease-out);
}
.mode__input:hover + .mode__face { background: var(--bg-hover); }
.mode__input:checked + .mode__face { background: var(--bg-active); }
.mode__input:focus-visible + .mode__face {
  outline: 2px solid var(--focus-ring);
  outline-offset: 1px;
}
.mode__radio {
  flex: none;
  display: grid;
  place-items: center;
  width: 14px;
  height: 14px;
  margin-top: 2px;
  border-radius: 50%;
  box-shadow: inset 0 0 0 1px var(--line-strong);
  transition: background var(--dur-fast) var(--ease-out), box-shadow var(--dur-fast) var(--ease-out);
}
.mode__radio::after {
  content: '';
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent-fg);
  transform: scale(0);
  transition: transform var(--dur-fast) var(--ease-out);
}
.mode__input:checked + .mode__face .mode__radio {
  background: var(--accent);
  box-shadow: none;
}
.mode__input:checked + .mode__face .mode__radio::after { transform: scale(1); }
.mode__text { display: grid; gap: 1px; min-width: 0; }
.mode__label { font-size: var(--text-sm); font-weight: 560; color: var(--fg); }
.mode__hint { font-size: var(--text-xs); color: var(--fg-subtle); text-wrap: pretty; }

.spaced { margin-top: var(--space-6); }
</style>
