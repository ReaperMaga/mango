<script setup lang="ts">
import { Check, CircleCheck, Copy, ExternalLink, SquareTerminal, TriangleAlert } from 'lucide-vue-next'
import { openExternal } from '~/composables/useBackend'
import { copyToClipboard } from '~/utils/agentCli'
import LoginTerminal from '~/components/settings/LoginTerminal.vue'

/**
 * A job running in an instance, in place: an installer, a CLI's own sign-in or
 * a shell. Header with its state and actions, the terminal, one line of hint.
 * The process is started by `start` (an `env_*` command returning a pty id)
 * and killed when this unmounts, so closing the panel stops it.
 */
const props = withDefaults(defineProps<{
  start: (cols: number, rows: number) => Promise<string>
  /** Shown while it runs, e.g. "Installing Claude Code…" */
  title: string
  /** Shown after exit code 0 */
  doneTitle?: string
  /** Shown when it fails to start or exits non-zero */
  failedTitle?: string
  /** Accessible name of the terminal */
  label: string
  rows?: number
  /** A sign-in: offer the link the CLI prints as buttons. */
  signIn?: boolean
  /** A shell: no done/failed state worth reporting, closing is the normal end. */
  shell?: boolean
  /** Inside a raised dialog the panel stays transparent (The Lightness Ladder Rule). */
  flat?: boolean
  /** Offer Close / Stop in the header (off when the host puts its own actions elsewhere). */
  closable?: boolean
  /** Offer "Try again" after a failure. */
  retryable?: boolean
}>(), {
  rows: 12,
  signIn: false,
  shell: false,
  flat: false,
  closable: true,
  retryable: true,
  doneTitle: 'Finished',
  failedTitle: 'It didn\'t finish',
})

const emit = defineEmits<{
  exit: [code: number | null]
  close: []
}>()

type Phase = 'running' | 'done' | 'failed'
const phase = ref<Phase>('running')
const note = ref('')
const link = ref<string | null>(null)
const attempt = ref(0)
const focused = ref(false)
const copied = ref(false)
let copiedTimer: ReturnType<typeof setTimeout> | undefined

const modKey = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl'

const heading = computed(() => {
  if (phase.value === 'done') return props.doneTitle
  if (phase.value === 'failed') return props.failedTitle
  return props.title
})

function onExit(code: number | null) {
  if (props.shell) {
    phase.value = 'done'
  } else if (code === 0) {
    phase.value = 'done'
  } else {
    phase.value = 'failed'
    note.value = code == null ? 'The process ended unexpectedly.' : `It stopped with exit code ${code}.`
  }
  emit('exit', code)
}

function onFailed(message: string) {
  phase.value = 'failed'
  note.value = `${message.replace(/\.$/, '')}.`
  emit('exit', null)
}

function retry() {
  phase.value = 'running'
  note.value = ''
  link.value = null
  attempt.value++
}

async function copyLink() {
  if (!link.value) return
  await copyToClipboard(link.value)
  copied.value = true
  clearTimeout(copiedTimer)
  copiedTimer = setTimeout(() => { copied.value = false }, 1600)
}

onBeforeUnmount(() => clearTimeout(copiedTimer))

const term = ref<InstanceType<typeof LoginTerminal> | null>(null)
defineExpose({ focus: () => term.value?.focus(), retry, phase })
</script>

<template>
  <section
    class="job"
    :class="[`job--${phase}`, { 'is-focused': focused, 'job--flat': flat }]"
    :aria-label="label"
  >
    <header class="job__head">
      <span class="job__status" role="status">
        <TriangleAlert v-if="phase === 'failed'" class="job__icon job__icon--bad" aria-hidden="true" />
        <CircleCheck v-else-if="phase === 'done' && !shell" class="job__icon job__icon--ok" aria-hidden="true" />
        <SquareTerminal v-else-if="shell" class="job__icon" aria-hidden="true" />
        <span v-else-if="phase === 'running'" class="ring ring--work" aria-hidden="true" />
        <span class="job__title">{{ heading }}</span>
      </span>
      <span class="job__actions">
        <template v-if="signIn && phase === 'running' && link">
          <UiButton variant="ghost" size="sm" :title="link" @click="openExternal(link)">
            <ExternalLink />Open sign-in page
          </UiButton>
          <UiButton variant="ghost" size="sm" @click="copyLink">
            <Check v-if="copied" /><Copy v-else />{{ copied ? 'Copied' : 'Copy link' }}
          </UiButton>
        </template>
        <slot name="actions" :phase="phase" />
        <UiButton v-if="phase === 'failed' && retryable" size="sm" @click="retry">Try again</UiButton>
        <UiButton v-if="closable" variant="ghost" size="sm" @click="emit('close')">
          {{ phase === 'running' ? (shell ? 'Close' : signIn ? 'Cancel' : 'Stop') : 'Close' }}
        </UiButton>
      </span>
    </header>

    <p v-if="phase === 'failed'" class="job__note selectable" role="alert">
      {{ note }} The output is kept below.
    </p>

    <div class="job__term" @focusin="focused = true" @focusout="focused = false">
      <LoginTerminal
        ref="term"
        :key="attempt"
        :start="start"
        :label="label"
        :rows="rows"
        @exit="onExit"
        @failed="onFailed"
        @link="link = $event"
      />
    </div>

    <p v-if="phase === 'running' && (signIn || $slots.hint)" class="job__hint">
      <slot name="hint">
        Finish in your browser. If the page gives you a code, press <kbd>{{ modKey }}</kbd><kbd>V</kbd> to paste it here,
        then <kbd>Enter</kbd>. The code may stay hidden as you paste.
      </slot>
    </p>
  </section>
</template>

<style scoped>
.job {
  background: var(--bg-panel);
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
  overflow: hidden;
  transition: border-color var(--dur-fast) var(--ease-out), box-shadow var(--dur-fast) var(--ease-out);
}
.job--flat { background: transparent; }
.job.is-focused {
  border-color: var(--accent-line);
  box-shadow: 0 0 0 3px var(--accent-soft);
}
.job--failed,
.job--failed.is-focused {
  border-color: color-mix(in oklch, var(--ripe-error) 45%, transparent);
  box-shadow: none;
}
.job__head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-height: 38px;
  padding: 0 var(--space-2) 0 var(--space-3);
}
.job__status {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
.job__title {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--text-sm);
  font-weight: 560;
}
.job__icon { flex: none; width: 14px; height: 14px; stroke-width: 1.85; color: var(--fg-subtle); }
.job__icon--bad { color: var(--ripe-error); }
.job__icon--ok { color: var(--ripe-queued); }
.job__actions { flex: none; display: inline-flex; align-items: center; gap: var(--space-1); }
.job__note {
  margin: 0;
  padding: 0 var(--space-3) var(--space-2);
  font-size: var(--text-xs);
  color: var(--ripe-error-fg);
  text-wrap: pretty;
}
.job__term {
  border-top: 1px solid var(--line-soft);
  background: var(--term-bg);
}
.job__hint {
  margin: 0;
  padding: var(--space-2) var(--space-3);
  border-top: 1px solid var(--line-soft);
  font-size: var(--text-xs);
  color: var(--fg-subtle);
  text-wrap: pretty;
}
.job__hint kbd { margin: 0 1px; vertical-align: 1px; }

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
</style>
