<script setup lang="ts">
import { TriangleAlert } from 'lucide-vue-next'
import { call, openExternal } from '~/composables/useBackend'
import { useLore } from '~/stores/lore'
import LoginTerminal from './LoginTerminal.vue'

/**
 * Signing this computer in to one Lore server: `lore login` in a terminal (the CLI opens the browser and
 * keeps its own token; Mango never sees it), then a check. It starts when it shows and closes itself
 * once the server lets this computer in. Settings > Lore and a Lore server's environment page use it.
 */
const props = defineProps<{ url: string; name: string }>()
const emit = defineEmits<{ close: [signedIn: boolean] }>()

const { t } = useI18n()
const lore = useLore()

type Phase = 'running' | 'checking' | 'failed'
const phase = ref<Phase>('running')
const note = ref('')
const attempt = ref(0)
const focused = ref(false)
const link = ref<string | null>(null)
const el = ref<HTMLElement | null>(null)
const start = (cols: number, rows: number) => call('lore_login', { url: props.url, cols, rows })

function retry() {
  link.value = null
  note.value = ''
  phase.value = 'running'
  attempt.value++
}

async function onExit(code: number | null) {
  if (phase.value !== 'running') return
  phase.value = 'checking'
  const at = attempt.value
  const now = await lore.check(props.url)
  if (at !== attempt.value) return
  if (now?.auth === 'signedIn' || now?.auth === 'notRequired') {
    emit('close', true)
    return
  }
  note.value = code === 0 || code === null ? t('lore.servers.loginClosed', { name: props.name }) : t('lore.servers.loginExited', { code })
  phase.value = 'failed'
}

function onFailed(message: string) {
  note.value = t('agents.cli.cantStart', { message: message.replace(/\.$/, '') })
  phase.value = 'failed'
}

function close() {
  // Stopped halfway: the CLI may still have finished, so the row asks again.
  if (phase.value === 'running') void lore.check(props.url)
  emit('close', false)
}

onMounted(() => nextTick(() => el.value?.scrollIntoView({ block: 'nearest' })))
</script>

<template>
  <section
    ref="el"
    class="job"
    :class="[`job--${phase}`, { 'is-focused': focused }]"
    :aria-label="t('lore.servers.signInTerminal', { name })"
  >
    <header class="job__head">
      <span class="job__status" role="status">
        <TriangleAlert v-if="phase === 'failed'" class="job__warn" aria-hidden="true" />
        <span v-else class="ring" :class="{ 'ring--work': phase === 'running' }" aria-hidden="true" />
        <span class="job__title">{{ phase === 'checking' ? t('lore.servers.checkingSignIn') : phase === 'failed' ? t('lore.servers.signInUnfinished') : t('lore.servers.signingIn', { name }) }}</span>
      </span>
      <span v-if="phase !== 'checking'" class="job__actions">
        <UiButton v-if="phase === 'running' && link" variant="ghost" size="sm" :title="link" @click="openExternal(link)">{{ t('agents.hosting.openPage') }}</UiButton>
        <UiButton v-if="phase === 'failed'" size="sm" @click="retry">{{ t('common.actions.retry') }}</UiButton>
        <UiButton size="sm" variant="ghost" @click="close">{{ phase === 'running' ? t('common.actions.cancel') : t('common.actions.close') }}</UiButton>
      </span>
    </header>
    <p v-if="phase === 'failed'" class="job__note selectable" role="alert">{{ note }} {{ t('agents.cli.outputKept') }}</p>
    <div class="job__term" @focusin="focused = true" @focusout="focused = false">
      <LoginTerminal
        :key="attempt"
        :start="start"
        :label="t('lore.servers.signInTerminal', { name })"
        :rows="12"
        @exit="onExit"
        @failed="onFailed"
        @link="link = $event"
      />
    </div>
    <p v-if="phase === 'running'" class="job__hint">{{ t('lore.servers.loginHint') }}</p>
  </section>
</template>

<style scoped>
.job {
  margin: var(--space-2) 0 var(--space-1);
  scroll-margin: var(--space-4);
  background: var(--bg-panel);
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
  overflow: hidden;
  transition: border-color var(--dur-fast) var(--ease-out), box-shadow var(--dur-fast) var(--ease-out);
}
.job.is-focused { border-color: var(--accent-line); box-shadow: 0 0 0 3px var(--accent-soft); }
.job--failed, .job--failed.is-focused { border-color: color-mix(in oklch, var(--ripe-error) 45%, transparent); box-shadow: none; }
.job__head { display: flex; align-items: center; gap: var(--space-2); min-height: 38px; padding: 0 var(--space-2) 0 var(--space-3); }
.job__status { flex: 1; min-width: 0; display: flex; align-items: center; gap: var(--space-2); }
.job__title { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--text-sm); font-weight: 560; }
.job__warn { flex: none; width: 14px; height: 14px; stroke-width: 1.85; color: var(--ripe-error); }
.job__actions { flex: none; display: inline-flex; align-items: center; gap: var(--space-1); }
.job__note { margin: 0; padding: 0 var(--space-3) var(--space-2); font-size: var(--text-xs); color: var(--ripe-error-fg); text-wrap: pretty; }
.job__term { border-top: 1px solid var(--line-soft); background: var(--term-bg); }
.job__hint { margin: 0; padding: var(--space-2) var(--space-3); border-top: 1px solid var(--line-soft); font-size: var(--text-xs); color: var(--fg-subtle); text-wrap: pretty; }

.ring {
  flex: none;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  border: 1.75px solid var(--fg-subtle);
  border-right-color: transparent;
  animation: job-turn 0.7s linear infinite;
}
.ring--work { border-color: var(--ripe-running); border-right-color: transparent; }
@keyframes job-turn { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .ring { animation: none; } }
</style>
