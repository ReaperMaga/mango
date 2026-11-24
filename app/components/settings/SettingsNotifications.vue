<script setup lang="ts">
import { useWorkspace, type NotifyPrefs } from '~/stores/workspace'
import { sendTestNotification } from '~/composables/notify'
import SettingsSection from './SettingsSection.vue'
import SettingsRow from './SettingsRow.vue'
import SettingsSwitch from './SettingsSwitch.vue'

const { t } = useI18n()

/** Settings > Notifications: which moments of a chat Mango tells you about, and how. */
const ws = useWorkspace()

function set<K extends keyof NotifyPrefs>(key: K, value: NotifyPrefs[K]) {
  ws.notify[key] = value
  ws.persist()
}

const testing = ref(false)
const result = ref<{ ok: boolean; text: string } | null>(null)

async function test() {
  testing.value = true
  result.value = null
  try {
    await sendTestNotification(ws.notify.sound)
    result.value = { ok: true, text: t('notifications.testSent') }
  } catch (e) {
    const text = e instanceof Error ? e.message : typeof e === 'string' ? e : t('notifications.testFailed')
    result.value = {
      ok: false,
      // A page in a Mango browser tab has no access to Mango's commands (that is by design).
      text: /not allowed by ACL/i.test(text)
        ? t('notifications.testInTab')
        : text,
    }
  } finally {
    testing.value = false
  }
}
</script>

<template>
  <SettingsSection :title="t('settings.nav.notifications')" :description="t('notifications.description')">
    <div class="card">
      <SettingsRow :label="t('notifications.enabled')" :hint="t('notifications.enabledHint')">
        <template #default="{ labelId }">
          <SettingsSwitch :model-value="ws.notify.enabled" :labelledby="labelId" @update:model-value="v => set('enabled', v)" />
        </template>
      </SettingsRow>
    </div>

    <div class="rest" :class="{ 'is-off': !ws.notify.enabled }" :inert="!ws.notify.enabled || undefined">
      <h3 class="head">{{ t('notifications.when') }}</h3>
      <div class="card">
        <SettingsRow :label="t('notifications.needsYou')" :hint="t('notifications.needsYouHint')">
          <template #default="{ labelId }">
            <SettingsSwitch :model-value="ws.notify.needsYou" :labelledby="labelId" @update:model-value="v => set('needsYou', v)" />
          </template>
        </SettingsRow>
        <SettingsRow :label="t('notifications.done')" :hint="t('notifications.doneHint')">
          <template #default="{ labelId }">
            <SettingsSwitch :model-value="ws.notify.done" :labelledby="labelId" @update:model-value="v => set('done', v)" />
          </template>
        </SettingsRow>
        <SettingsRow :label="t('notifications.failed')" :hint="t('notifications.failedHint')">
          <template #default="{ labelId }">
            <SettingsSwitch :model-value="ws.notify.failed" :labelledby="labelId" @update:model-value="v => set('failed', v)" />
          </template>
        </SettingsRow>
      </div>

      <h3 class="head">{{ t('notifications.how') }}</h3>
      <div class="card">
        <SettingsRow :label="t('notifications.backgroundOnly')" :hint="t('notifications.backgroundOnlyHint')">
          <template #default="{ labelId }">
            <SettingsSwitch :model-value="ws.notify.backgroundOnly" :labelledby="labelId" @update:model-value="v => set('backgroundOnly', v)" />
          </template>
        </SettingsRow>
        <SettingsRow :label="t('notifications.preview')" :hint="t('notifications.previewHint')">
          <template #default="{ labelId }">
            <SettingsSwitch :model-value="ws.notify.preview" :labelledby="labelId" @update:model-value="v => set('preview', v)" />
          </template>
        </SettingsRow>
        <SettingsRow :label="t('notifications.sound')" :hint="t('notifications.soundHint')">
          <template #default="{ labelId }">
            <SettingsSwitch :model-value="ws.notify.sound" :labelledby="labelId" @update:model-value="v => set('sound', v)" />
          </template>
        </SettingsRow>
        <SettingsRow :label="t('notifications.test')" :hint="t('notifications.testHint')">
          <template #default>
            <UiButton size="sm" :loading="testing" @click="test">{{ t('notifications.testSend') }}</UiButton>
          </template>
        </SettingsRow>
      </div>
      <p v-if="result" class="result" :class="{ 'is-error': !result.ok }" :role="result.ok ? 'status' : 'alert'">{{ result.text }}</p>
    </div>
  </SettingsSection>
</template>

<style scoped>
.head { margin: var(--space-6) 0 var(--space-3); font-size: var(--text-md); font-weight: 600; }
.card {
  border: 1px solid var(--line-soft);
  border-radius: var(--radius-md);
  background: var(--bg-panel);
}
.card :deep(.srow) { padding: var(--space-3) var(--space-4); }
.card :deep(.srow + .srow) { border-top: 1px solid var(--line-soft); }

.rest { transition: opacity var(--dur-fast) var(--ease-out); }
.rest.is-off { opacity: 0.5; }

.result { margin: var(--space-3) 0 0; font-size: var(--text-xs); color: var(--fg-subtle); text-wrap: pretty; }
.result.is-error { color: var(--ripe-error-fg); }
</style>
