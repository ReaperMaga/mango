<script setup lang="ts">
import { TriangleAlert } from 'lucide-vue-next'
import type { EnvInstanceStatus } from '~/types/ipc'
import type { EnvBusy } from '~/stores/environments'

/**
 * An instance's state: a small round mark whose colour and fill follow the
 * ripening scale (hollow when stopped, half and breathing while it changes,
 * full when running; a failure is a warning sign, not a red disc, so it is
 * never told from running by colour alone) and, with `word`, the state.
 * The fruit-shaped ripeness dot stays reserved for threads.
 */
const props = withDefaults(defineProps<{
  status: EnvInstanceStatus
  /** An action Mango has in flight; it wins over the reported status. */
  busy?: EnvBusy | null
  word?: boolean
}>(), { busy: null, word: false })

const { t } = useI18n()

type Tone = 'on' | 'moving' | 'off' | 'error'

const view = computed<{ tone: Tone; label: string }>(() => {
  switch (props.busy) {
    case 'start': return { tone: 'moving', label: t('envs.status.starting') }
    case 'stop': return { tone: 'moving', label: t('envs.status.stopping') }
    case 'restart': return { tone: 'moving', label: t('envs.status.restarting') }
    case 'delete': return { tone: 'moving', label: t('envs.status.deleting') }
    case 'rename': return { tone: 'moving', label: t('envs.status.renaming') }
    case 'resize': return { tone: 'moving', label: t('envs.status.resizing') }
  }
  switch (props.status) {
    case 'running': return { tone: 'on', label: t('envs.status.running') }
    case 'starting': return { tone: 'moving', label: t('envs.status.starting') }
    case 'stopping': return { tone: 'moving', label: t('envs.status.stopping') }
    case 'stopped': return { tone: 'off', label: t('envs.status.stopped') }
    case 'frozen': return { tone: 'off', label: t('envs.status.frozen') }
    case 'error': return { tone: 'error', label: t('envs.status.error') }
    default: return { tone: 'off', label: t('envs.status.unknown') }
  }
})
</script>

<template>
  <span class="est" :class="`est--${view.tone}`">
    <TriangleAlert
      v-if="view.tone === 'error'"
      class="est__warn"
      :role="word ? undefined : 'img'"
      :aria-label="word ? undefined : view.label"
      :aria-hidden="word || undefined"
    />
    <span v-else class="est__dot" :role="word ? undefined : 'img'" :aria-label="word ? undefined : view.label" :title="word ? undefined : view.label" :aria-hidden="word || undefined" />
    <span v-if="word" class="est__word">{{ view.label }}</span>
  </span>
</template>

<style scoped>
.est {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  --c: var(--ripe-idle);
  --c-fg: var(--fg-subtle);
}
.est--on { --c: var(--ripe-queued); --c-fg: var(--ripe-queued-fg); }
.est--moving { --c: var(--ripe-running); --c-fg: var(--ripe-running-fg); }
.est--error { --c: var(--ripe-error); --c-fg: var(--ripe-error-fg); }

.est__dot {
  flex: none;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  box-shadow: inset 0 0 0 1.25px var(--c);
  background: linear-gradient(var(--c), var(--c)) bottom / 100% 0% no-repeat;
  transition: box-shadow var(--dur-med) var(--ease-out), background-size var(--dur-slow) var(--ease-out);
}
.est--on .est__dot { background-size: 100% 100%; }
.est__warn { flex: none; width: 11px; height: 11px; margin: 0 -1.5px; stroke-width: 2.1; color: var(--c); }
/* Changing: half full, and the level breathes (work in progress is the one thing that moves). */
.est--moving .est__dot {
  background-size: 100% 50%;
  animation: est-breathe 1.8s var(--ease-in-out) infinite;
}
@keyframes est-breathe {
  0%, 100% { background-size: 100% 34%; }
  50% { background-size: 100% 66%; }
}

.est__word {
  font-size: var(--text-xs);
  font-weight: 560;
  color: var(--c-fg);
  white-space: nowrap;
}
</style>
