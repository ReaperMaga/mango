<script setup lang="ts">
import { ChevronDown, Download, Square, Trash2, Mic, X } from 'lucide-vue-next'
import type { VoiceModelId } from '~/types/ipc'
import type { MenuItem } from '~/types/ui'
import { useVoice, VOICE_LANGUAGES } from '~/stores/voice'
import { modLabel } from '~/composables/useShortcuts'
import { formatLocale } from '~/i18n'
import SettingsSection from './SettingsSection.vue'
import SettingsRow from './SettingsRow.vue'

const { t } = useI18n()
const voice = useVoice()

const oneDigit: Intl.NumberFormatOptions = { minimumFractionDigits: 1, maximumFractionDigits: 1 }
const size = (bytes: number) => bytes >= 1e9
  ? t('agents.voice.gb', { n: (bytes / 1e9).toLocaleString(formatLocale(), oneDigit) })
  : t('agents.voice.mb', { n: Math.round(bytes / 1e6) })
const percent = (id: VoiceModelId) => Math.round((voice.fraction(id) ?? 0) * 100)

const languageName = (code: string | null) => t(`agents.voice.languages.${code ?? 'auto'}`)
const languageItems = computed<MenuItem[]>(() => VOICE_LANGUAGES.map(code => ({
  label: languageName(code),
  checked: voice.language === code,
  onSelect: () => voice.setLanguage(code),
})))
const languageLabel = computed(() => languageName(voice.language))

/* ---------- microphone ---------- */

const micItems = computed<MenuItem[]>(() => [
  { label: t('agents.voice.micDefault'), checked: voice.micId === null, onSelect: () => pickMic(null) },
  ...voice.mics.map(m => ({ label: m.label, checked: voice.micId === m.id, onSelect: () => pickMic(m.id) })),
])
const micLabel = computed(() => {
  if (voice.micId === null) return t('agents.voice.micDefault')
  return voice.mics.find(m => m.id === voice.micId)?.label ?? t('agents.voice.micUnavailable')
})

/** A live level meter so the chosen microphone can be checked without dictating. */
const testing = ref(false)
const testLevel = ref(0)
const testError = ref<string | null>(null)
let testStream: MediaStream | null = null
let testCtx: AudioContext | null = null
let testFrame = 0

async function startTest() {
  stopTest()
  testError.value = null
  try {
    const base = { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    testStream = await navigator.mediaDevices.getUserMedia({
      audio: voice.micId ? { ...base, deviceId: { exact: voice.micId } } : base,
    })
    testCtx = new AudioContext()
    const analyser = testCtx.createAnalyser()
    analyser.fftSize = 1024
    testCtx.createMediaStreamSource(testStream).connect(analyser)
    const data = new Float32Array(analyser.fftSize)
    testing.value = true
    const tick = () => {
      analyser.getFloatTimeDomainData(data)
      let sum = 0
      for (const x of data) sum += x * x
      const target = Math.min(1, Math.sqrt(sum / data.length) * 6)
      testLevel.value = target > testLevel.value ? target : testLevel.value * 0.85 + target * 0.15
      testFrame = requestAnimationFrame(tick)
    }
    tick()
    void voice.loadMics() // names become readable once recording is allowed
  } catch (e) {
    stopTest()
    testError.value = e instanceof DOMException && e.name === 'NotAllowedError'
      ? t('agents.voice.micDenied')
      : t('agents.voice.micFailed')
  }
}

function stopTest() {
  cancelAnimationFrame(testFrame)
  testStream?.getTracks().forEach(track => track.stop())
  testStream = null
  void testCtx?.close().catch(() => {})
  testCtx = null
  testing.value = false
  testLevel.value = 0
}

function pickMic(id: string | null) {
  voice.setMic(id)
  if (testing.value) void startTest()
}

const onDeviceChange = () => void voice.loadMics()

const name = useId()
const labelId = useId()
const hintId = useId()

onMounted(() => {
  voice.refresh()
  void voice.loadMics()
  navigator.mediaDevices?.addEventListener?.('devicechange', onDeviceChange)
})
onBeforeUnmount(() => {
  stopTest()
  navigator.mediaDevices?.removeEventListener?.('devicechange', onDeviceChange)
})
</script>

<template>
  <SettingsSection
    :title="t('settings.nav.voice')"
    :description="t('agents.voice.description')"
  >
    <div class="group">
      <div class="group__head">
        <h3 :id="labelId" class="group__title">{{ t('agents.voice.model') }}</h3>
        <p :id="hintId" class="group__hint">
          {{ t('agents.voice.modelHint') }}
        </p>
      </div>

      <div v-if="voice.models.length" class="models" role="radiogroup" :aria-labelledby="labelId" :aria-describedby="hintId">
        <div v-for="m in voice.models" :key="m.id" class="model">
          <label class="model__pick">
            <input
              class="model__input"
              type="radio"
              :name="name"
              :value="m.id"
              :checked="voice.model === m.id"
              :aria-describedby="`${name}-${m.id}`"
              @change="voice.setModel(m.id)"
            >
            <span class="model__face">
              <span class="model__radio" aria-hidden="true" />
              <span class="model__text">
                <span class="model__label">
                  {{ m.name }}
                  <span class="model__size tabular">{{ size(m.sizeBytes) }}</span>
                  <span v-if="m.downloaded" class="model__tag">{{ t('agents.voice.downloaded') }}</span>
                </span>
                <span :id="`${name}-${m.id}`" class="model__hint">{{ t(`agents.voice.about.${m.id}`) }}</span>
                <span v-if="m.downloading" class="model__progress">
                  <span class="model__track" role="progressbar" :aria-valuenow="percent(m.id)" aria-valuemin="0" aria-valuemax="100" :aria-label="t('agents.voice.downloading', { name: m.name })">
                    <span class="model__fill" :style="{ transform: `scaleX(${voice.fraction(m.id) ?? 0})` }" />
                  </span>
                  <span class="model__pct tabular">{{ t('agents.voice.percent', { n: percent(m.id) }) }}</span>
                </span>
                <span v-if="voice.errors[m.id]" class="model__error" role="alert">{{ voice.errors[m.id] }}</span>
              </span>
            </span>
          </label>
          <div class="model__actions">
            <UiButton v-if="m.downloading" size="sm" variant="ghost" @click="voice.cancel(m.id)"><X />{{ t('common.actions.cancel') }}</UiButton>
            <UiButton v-else-if="m.downloaded" size="sm" variant="ghost" :aria-label="t('agents.voice.deleteModel', { name: m.name })" @click="voice.remove(m.id)"><Trash2 />{{ t('common.actions.delete') }}</UiButton>
            <UiButton v-else size="sm" :variant="voice.model === m.id ? 'primary' : 'secondary'" :aria-label="t('agents.voice.downloadModel', { name: m.name })" @click="voice.download(m.id)"><Download />{{ t('agents.voice.download') }}</UiButton>
          </div>
        </div>
      </div>
      <p v-else class="note" role="status">{{ t('agents.voice.looking') }}</p>
    </div>

    <div class="rows">
      <SettingsRow :label="t('agents.voice.mic')">
        <template #hint>
          <span v-if="testError" class="mic__error">{{ testError }}</span>
          <template v-else>{{ t('agents.voice.micHint') }}</template>
        </template>
        <template #default="{ labelId: id }">
          <div class="mic">
            <span v-if="testing" class="mic__meter" role="meter" :aria-label="t('agents.voice.level')" aria-valuemin="0" aria-valuemax="100" :aria-valuenow="Math.round(testLevel * 100)">
              <span class="mic__fill" :style="{ transform: `scaleX(${testLevel})` }" />
            </span>
            <UiButton size="sm" variant="ghost" :aria-pressed="testing" @click="testing ? stopTest() : startTest()">
              <Square v-if="testing" /><Mic v-else />{{ testing ? t('agents.voice.stop') : t('agents.voice.test') }}
            </UiButton>
            <UiMenu :items="micItems" placement="bottom-end" :width="280" :label="t('agents.voice.mic')">
              <template #default="{ toggle, open }">
                <UiButton size="sm" class="mic__pick" :class="{ 'is-open': open }" :aria-labelledby="id" aria-haspopup="menu" @click="toggle">
                  <span class="mic__name">{{ micLabel }}</span><ChevronDown />
                </UiButton>
              </template>
            </UiMenu>
          </div>
        </template>
      </SettingsRow>

      <SettingsRow :label="t('agents.voice.language')" :hint="t('agents.voice.languageHint')">
        <template #default="{ labelId: id }">
          <UiMenu :items="languageItems" placement="bottom-end" :width="220" :label="t('agents.voice.language')">
            <template #default="{ toggle, open }">
              <UiButton size="sm" :class="{ 'is-open': open }" :aria-labelledby="id" aria-haspopup="menu" @click="toggle">
                {{ languageLabel }}<ChevronDown />
              </UiButton>
            </template>
          </UiMenu>
        </template>
      </SettingsRow>

      <SettingsRow :label="t('agents.voice.sendAfter')" :hint="t('agents.voice.sendAfterHint')">
        <template #default="{ labelId: id }">
          <button
            type="button"
            class="switch"
            role="switch"
            :aria-checked="voice.sendAfter"
            :aria-labelledby="id"
            @click="voice.setSendAfter(!voice.sendAfter)"
          >
            <span class="switch__knob" aria-hidden="true" />
          </button>
        </template>
      </SettingsRow>

      <SettingsRow :label="t('agents.voice.dictate')" :hint="t('agents.voice.dictateHint')">
        <kbd class="keys">{{ modLabel() }}+Shift+Space</kbd>
      </SettingsRow>
    </div>
  </SettingsSection>
</template>

<style scoped>
.group { padding-top: var(--space-4); border-top: 1px solid var(--line-soft); }
.group__title { margin: 0; font-size: var(--text-sm); font-weight: 560; }
.group__hint { margin: 2px 0 0; font-size: var(--text-xs); color: var(--fg-subtle); text-wrap: pretty; max-width: 58ch; }
.note { margin: var(--space-3) 0 0; font-size: var(--text-sm); color: var(--fg-subtle); }

.models {
  display: grid;
  gap: 2px;
  /* Rows hang out by their own padding, so the radios line up with the heading. */
  margin: var(--space-3) calc(var(--space-2) * -1) 0;
}
.model {
  display: flex;
  align-items: flex-start;
  gap: var(--space-3);
  border-radius: var(--radius-sm);
  transition: background var(--dur-fast) var(--ease-out);
}
.model:hover { background: var(--bg-hover); }
.model:has(.model__input:checked) { background: var(--bg-active); }
.model__pick { position: relative; display: block; flex: 1; min-width: 0; }
.model__input { position: absolute; inset: 0; width: 100%; height: 100%; margin: 0; opacity: 0; cursor: pointer; }
.model__face {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: var(--space-2);
  border-radius: var(--radius-sm);
}
.model__input:focus-visible + .model__face { outline: 2px solid var(--focus-ring); outline-offset: 1px; }
.model__radio {
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
.model__radio::after {
  content: '';
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent-fg);
  transform: scale(0);
  transition: transform var(--dur-fast) var(--ease-out);
}
.model__input:checked + .model__face .model__radio { background: var(--accent); box-shadow: none; }
.model__input:checked + .model__face .model__radio::after { transform: scale(1); }
.model__text { display: grid; gap: 1px; min-width: 0; flex: 1; }
.model__label { display: flex; align-items: baseline; gap: var(--space-2); font-size: var(--text-sm); font-weight: 560; color: var(--fg); }
.model__size { font-size: var(--text-xs); font-weight: 500; color: var(--fg-subtle); }
.model__tag { font-size: var(--text-2xs); font-weight: 500; color: var(--ripe-done-fg); }
.model__hint { font-size: var(--text-xs); color: var(--fg-subtle); text-wrap: pretty; }
.model__progress { display: flex; align-items: center; gap: var(--space-2); margin-top: var(--space-2); }
.model__track {
  position: relative;
  flex: 1;
  height: 4px;
  overflow: hidden;
  border-radius: var(--radius-pill);
  background: var(--bg-inset);
  box-shadow: inset 0 0 0 1px var(--line-soft);
}
.model__fill {
  position: absolute;
  inset: 0;
  background: var(--accent);
  transform-origin: left center;
  transition: transform var(--dur-med) var(--ease-out);
}
.model__pct { min-width: 4ch; text-align: right; font-size: var(--text-xs); color: var(--fg-muted); }
.model__error { margin-top: var(--space-1); font-size: var(--text-xs); color: var(--ripe-error-fg); text-wrap: pretty; }
.model__actions { flex: none; padding: var(--space-2) var(--space-2) 0 0; }

.rows { margin-top: var(--space-5); border-top: 1px solid var(--line-soft); border-bottom: 1px solid var(--line-soft); }
.rows > * + * { border-top: 1px solid var(--line-soft); }

.keys {
  display: inline-block;
  padding: 2px 6px;
  font-family: var(--font-ui);
  font-size: var(--text-xs);
  color: var(--fg-muted);
  background: var(--bg-inset);
  border: 1px solid var(--line);
  border-radius: var(--radius-xs);
  white-space: nowrap;
}

.mic { display: flex; align-items: center; gap: var(--space-2); }
.mic__pick { max-width: 240px; }
.mic__name { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.mic__meter {
  position: relative;
  width: 72px;
  height: 4px;
  overflow: hidden;
  border-radius: var(--radius-pill);
  background: var(--bg-inset);
  box-shadow: inset 0 0 0 1px var(--line-soft);
}
.mic__fill { position: absolute; inset: 0; background: var(--ripe-done); transform-origin: left center; }
.mic__error { color: var(--ripe-error-fg); }

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

@media (prefers-reduced-motion: reduce) {
  .model__fill, .switch, .switch__knob { transition: none; }
}
</style>
