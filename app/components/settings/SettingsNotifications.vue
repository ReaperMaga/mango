<script setup lang="ts">
import { useWorkspace, type NotifyPrefs } from '~/stores/workspace'
import { sendTestNotification } from '~/composables/notify'
import SettingsSection from './SettingsSection.vue'
import SettingsRow from './SettingsRow.vue'
import SettingsSwitch from './SettingsSwitch.vue'

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
    result.value = { ok: true, text: 'Sent. If nothing appeared, check that notifications are allowed for Mango in your system settings.' }
  } catch (e) {
    const text = e instanceof Error ? e.message : typeof e === 'string' ? e : 'The notification could not be shown.'
    result.value = {
      ok: false,
      // A page in a Mango browser tab has no access to Mango's commands (that is by design).
      text: /not allowed by ACL/i.test(text)
        ? 'This page is open in a browser tab, which cannot use Mango\'s commands. Open Mango itself (pnpm app), or open localhost:1420 in a normal browser, to try notifications.'
        : text,
    }
  } finally {
    testing.value = false
  }
}
</script>

<template>
  <SettingsSection title="Notifications" description="Hear about a chat while you are in another window, so you can leave an agent to work.">
    <div class="card">
      <SettingsRow label="Desktop notifications" hint="Show a system notification when a chat needs you.">
        <template #default="{ labelId }">
          <SettingsSwitch :model-value="ws.notify.enabled" :labelledby="labelId" @update:model-value="v => set('enabled', v)" />
        </template>
      </SettingsRow>
    </div>

    <div class="rest" :class="{ 'is-off': !ws.notify.enabled }" :inert="!ws.notify.enabled || undefined">
      <h3 class="head">Notify me when</h3>
      <div class="card">
        <SettingsRow label="A chat needs you" hint="An approval is waiting. The agent stays stopped until you answer.">
          <template #default="{ labelId }">
            <SettingsSwitch :model-value="ws.notify.needsYou" :labelledby="labelId" @update:model-value="v => set('needsYou', v)" />
          </template>
        </SettingsRow>
        <SettingsRow label="A chat finishes" hint="The agent ended its turn and has a reply for you.">
          <template #default="{ labelId }">
            <SettingsSwitch :model-value="ws.notify.done" :labelledby="labelId" @update:model-value="v => set('done', v)" />
          </template>
        </SettingsRow>
        <SettingsRow label="A chat fails" hint="The run stopped on an error, such as a crash or a missing sign-in.">
          <template #default="{ labelId }">
            <SettingsSwitch :model-value="ws.notify.failed" :labelledby="labelId" @update:model-value="v => set('failed', v)" />
          </template>
        </SettingsRow>
      </div>

      <h3 class="head">How</h3>
      <div class="card">
        <SettingsRow label="Only when Mango is in the background" hint="Stay quiet while the window is in front. Off, you are still not told about the chat you are looking at.">
          <template #default="{ labelId }">
            <SettingsSwitch :model-value="ws.notify.backgroundOnly" :labelledby="labelId" @update:model-value="v => set('backgroundOnly', v)" />
          </template>
        </SettingsRow>
        <SettingsRow label="Show the chat and its reply" hint="Off, a notification only says that a chat finished, so nothing from your work shows on a shared screen.">
          <template #default="{ labelId }">
            <SettingsSwitch :model-value="ws.notify.preview" :labelledby="labelId" @update:model-value="v => set('preview', v)" />
          </template>
        </SettingsRow>
        <SettingsRow label="Play a sound" hint="The system's notification sound.">
          <template #default="{ labelId }">
            <SettingsSwitch :model-value="ws.notify.sound" :labelledby="labelId" @update:model-value="v => set('sound', v)" />
          </template>
        </SettingsRow>
        <SettingsRow label="Try it" hint="Show a notification now, whatever is switched on above.">
          <template #default>
            <UiButton size="sm" :loading="testing" @click="test">Send a test</UiButton>
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
