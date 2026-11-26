<script setup lang="ts">
import { Minus, Plus, RefreshCw } from 'lucide-vue-next'
import { useWorkspace, type CursorStyle } from '~/stores/workspace'
import SettingsSection from './SettingsSection.vue'
import SettingsRow from './SettingsRow.vue'
import SettingsSegmented from './SettingsSegmented.vue'

const { t } = useI18n()
const ws = useWorkspace()

/** The shell new terminals use: the user's pick while it still exists, otherwise the system default. */
const chosen = computed(() => ws.defaultTerminalProfile?.id ?? null)
const systemDefault = computed(() => ws.terminalProfiles.find(p => p.isDefault) ?? null)
/** A saved choice whose shell is gone (uninstalled, other machine's settings). */
const missingChoice = computed(() =>
  !!ws.terminalProfileId && !ws.terminalProfilesLoading && ws.terminalProfiles.length > 0
  && !ws.terminalProfiles.some(p => p.id === ws.terminalProfileId))

function choose(id: string) {
  // Picking the system default again means "follow the system", so it keeps following if that changes.
  ws.setTerminalProfile(id === systemDefault.value?.id ? null : id)
}

const cursors = computed<Array<{ value: CursorStyle; label: string }>>(() => [
  { value: 'bar', label: t('settings.terminal.bar') },
  { value: 'block', label: t('settings.terminal.block') },
  { value: 'underline', label: t('settings.terminal.underline') },
])
function setCursor(style: CursorStyle) {
  ws.terminalCursorStyle = style
  ws.persist()
}
function setBlink(on: boolean) {
  ws.terminalCursorBlink = on
  ws.persist()
}

const name = useId()
const labelId = useId()
const hintId = useId()
const blinkId = useId()

onMounted(() => { if (!ws.terminalProfiles.length) ws.loadTerminalProfiles() })
</script>

<template>
  <SettingsSection :title="t('settings.nav.terminal')" :description="t('settings.terminal.description')">
    <div class="group">
      <div class="group__head">
        <div>
          <h3 :id="labelId" class="group__title">{{ t('settings.terminal.shell') }}</h3>
          <p :id="hintId" class="group__hint">
            {{ t('settings.terminal.shellHint') }}
          </p>
        </div>
        <UiButton size="sm" variant="ghost" :loading="ws.terminalProfilesLoading" @click="ws.loadTerminalProfiles()">
          <RefreshCw v-if="!ws.terminalProfilesLoading" />{{ t('settings.terminal.lookAgain') }}
        </UiButton>
      </div>

      <p v-if="missingChoice" class="note" role="status">
        {{ t('settings.terminal.missing', { shell: ws.defaultTerminalProfile?.name ?? '' }) }}
      </p>

      <div v-if="ws.terminalProfiles.length" class="shells" role="radiogroup" :aria-labelledby="labelId" :aria-describedby="hintId">
        <label v-for="p in ws.terminalProfiles" :key="p.id" class="shell">
          <input
            class="shell__input"
            type="radio"
            :name="name"
            :value="p.id"
            :checked="chosen === p.id"
            @change="choose(p.id)"
          >
          <span class="shell__face">
            <span class="shell__radio" aria-hidden="true" />
            <span class="shell__text">
              <span class="shell__label">
                {{ p.name }}
                <span v-if="p.isDefault" class="shell__tag">{{ t('settings.terminal.systemDefault') }}</span>
              </span>
              <code class="shell__path">{{ [p.path, ...p.args].join(' ') }}</code>
            </span>
          </span>
        </label>
      </div>
      <p v-else-if="ws.terminalProfilesLoading" class="note" role="status">{{ t('settings.terminal.looking') }}</p>
      <p v-else class="note" role="status">
        {{ t('settings.terminal.none') }}
      </p>
    </div>

    <div class="rows">
      <SettingsRow :label="t('settings.terminal.fontSize')" :hint="t('settings.terminal.fontSizeHint')">
        <template #default="{ labelId: id }">
          <div class="stepper" role="group" :aria-labelledby="id">
            <UiIconButton size="sm" :label="t('settings.terminal.smaller')" :disabled="ws.terminalFontSize <= 9" @click="ws.setTerminalFontSize(ws.terminalFontSize - 0.5)"><Minus /></UiIconButton>
            <output class="stepper__value tabular" aria-live="polite">{{ ws.terminalFontSize }} px</output>
            <UiIconButton size="sm" :label="t('settings.terminal.larger')" :disabled="ws.terminalFontSize >= 22" @click="ws.setTerminalFontSize(ws.terminalFontSize + 0.5)"><Plus /></UiIconButton>
          </div>
        </template>
      </SettingsRow>

      <SettingsRow :label="t('settings.terminal.cursor')">
        <template #default="{ labelId: id }">
          <SettingsSegmented :model-value="ws.terminalCursorStyle" :options="cursors" :labelledby="id" @update:model-value="setCursor" />
        </template>
      </SettingsRow>

      <SettingsRow :label="t('settings.terminal.blink')">
        <template #default="{ labelId: id }">
          <button
            :id="blinkId"
            type="button"
            class="switch"
            role="switch"
            :aria-checked="ws.terminalCursorBlink"
            :aria-labelledby="id"
            @click="setBlink(!ws.terminalCursorBlink)"
          >
            <span class="switch__knob" aria-hidden="true" />
          </button>
        </template>
      </SettingsRow>
    </div>
  </SettingsSection>
</template>

<style scoped>
.group { padding-top: var(--space-4); border-top: 1px solid var(--line-soft); }
.group__head { display: flex; align-items: flex-start; gap: var(--space-4); }
.group__head > div { flex: 1; min-width: 0; }
.group__title { margin: 0; font-size: var(--text-sm); font-weight: 560; }
.group__hint { margin: 2px 0 0; font-size: var(--text-xs); color: var(--fg-subtle); text-wrap: pretty; max-width: 58ch; }
.note { margin: var(--space-3) 0 0; font-size: var(--text-sm); color: var(--fg-subtle); }

.shells {
  display: grid;
  gap: 2px;
  /* Rows hang out by their own padding, so the radios line up with the heading. */
  margin: var(--space-3) calc(var(--space-2) * -1) 0;
}
.shell { position: relative; display: block; }
.shell__input { position: absolute; inset: 0; width: 100%; height: 100%; margin: 0; opacity: 0; cursor: pointer; }
.shell__face {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: var(--space-2);
  border-radius: var(--radius-sm);
  transition: background var(--dur-fast) var(--ease-out);
}
.shell__input:hover + .shell__face { background: var(--bg-hover); }
.shell__input:checked + .shell__face { background: var(--bg-active); }
.shell__input:focus-visible + .shell__face { outline: 2px solid var(--focus-ring); outline-offset: 1px; }
.shell__radio {
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
.shell__radio::after {
  content: '';
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent-fg);
  transform: scale(0);
  transition: transform var(--dur-fast) var(--ease-out);
}
.shell__input:checked + .shell__face .shell__radio { background: var(--accent); box-shadow: none; }
.shell__input:checked + .shell__face .shell__radio::after { transform: scale(1); }
.shell__text { display: grid; gap: 1px; min-width: 0; }
.shell__label { display: flex; align-items: baseline; gap: var(--space-2); font-size: var(--text-sm); font-weight: 560; color: var(--fg); }
.shell__tag { font-size: var(--text-2xs); font-weight: 500; color: var(--fg-subtle); }
.shell__path {
  font-size: var(--text-xs);
  color: var(--fg-subtle);
  overflow-wrap: anywhere;
}

.rows { margin-top: var(--space-5); border-top: 1px solid var(--line-soft); border-bottom: 1px solid var(--line-soft); }
.rows > * + * { border-top: 1px solid var(--line-soft); }

.stepper { display: flex; align-items: center; gap: var(--space-1); }
.stepper__value { min-width: 58px; text-align: center; font-size: var(--text-sm); color: var(--fg); }

.switch {
  position: relative;
  width: 32px;
  height: 18px;
  border-radius: var(--radius-pill);
  background: var(--bg-active);
  box-shadow: inset 0 0 0 1px var(--line-strong);
  transition: background var(--dur-fast) var(--ease-out), box-shadow var(--dur-fast) var(--ease-out);
}
.switch__knob {
  position: absolute;
  top: 3px;
  left: 3px;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: var(--fg-muted);
  transition: transform var(--dur-fast) var(--ease-out), background var(--dur-fast) var(--ease-out);
}
.switch[aria-checked='true'] { background: var(--accent); box-shadow: none; }
.switch[aria-checked='true'] .switch__knob { transform: translateX(14px); background: var(--accent-fg); }
</style>
