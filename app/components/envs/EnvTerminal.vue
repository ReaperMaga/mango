<script setup lang="ts">
import { Check, ChevronDown, CircleCheck, Copy, ExternalLink, SquareTerminal, TriangleAlert } from 'lucide-vue-next'
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
const codeId = useId()

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
  resetSignIn()
  attempt.value++
}

/* ---------- sign-in in the browser ----------
 * A CLI signing in inside an environment can't open a browser there. Mango opens the sign-in page
 * here as soon as the CLI prints it, shows the one-time code a device sign-in asks for (GitHub,
 * Codex), takes the code Claude Code wants pasted back, and answers GitHub's "Press Enter" for the
 * user. The terminal stays available under "Show output" for anything else the CLI asks.
 */
const showOutput = ref(!props.signIn)
const deviceCode = ref<string | null>(null)
const codeCopied = ref(false)
const wantsCode = ref(false)
const pasted = ref('')
const sentCode = ref(false)
let opened = false
let outputText = ''
const answered = new Set<string>()

function resetSignIn() {
  showOutput.value = !props.signIn
  deviceCode.value = null
  codeCopied.value = false
  wantsCode.value = false
  pasted.value = ''
  sentCode.value = false
  opened = false
  outputText = ''
  answered.clear()
}

/**
 * The sign-in pages of the tools Mango signs in to. CLIs print other links too (GitHub's notices
 * link to its changelog), so only these are opened or offered as "the sign-in page".
 */
const SIGN_IN_PAGE = /^https:\/\/(github\.com\/login\/(device|oauth)|([a-z0-9-]+\.)?claude\.(ai|com)\/(.*\/)?oauth|([a-z0-9-]+\.)?anthropic\.com\/(.*\/)?oauth|auth\.openai\.com\/|login\.tailscale\.com\/)/i

function onLink(url: string) {
  if (props.signIn && !SIGN_IN_PAGE.test(url)) return
  link.value = url
  if (props.signIn && !opened) {
    opened = true
    openExternal(url)
  }
}

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[@-_]/g
/** Prompts Mango answers for the user, once each: [what the CLI asks, what to type]. */
const ANSWERS: Array<[RegExp, string]> = [
  [/press enter to open/i, '\r'],
  [/authenticate git with your github credentials\?/i, 'Y\r'],
]

function onOutput(data: string) {
  if (!props.signIn) return
  outputText = (outputText + data.replace(ANSI, '')).slice(-8192)
  for (const [ask, reply] of ANSWERS) {
    if (!answered.has(ask.source) && ask.test(outputText)) {
      answered.add(ask.source)
      term.value?.send(reply)
    }
  }
  if (!deviceCode.value && /one-time code|device code|enter (this|the) code|user code/i.test(outputText)) {
    const codes = outputText.match(/\b[A-Z0-9]{4}-[A-Z0-9]{4,5}\b/g)
    if (codes?.length) {
      deviceCode.value = codes[codes.length - 1]!
      copyToClipboard(deviceCode.value).then(() => { codeCopied.value = true }).catch(() => {})
    }
  }
  if (!wantsCode.value && /paste (the |your )?(authentication |authorization )?code/i.test(outputText)) wantsCode.value = true
}

async function copyCode() {
  if (!deviceCode.value) return
  await copyToClipboard(deviceCode.value)
  codeCopied.value = true
}

function sendCode() {
  const code = pasted.value.trim()
  if (!code) return
  term.value?.send(`${code}\r`)
  sentCode.value = true
  pasted.value = ''
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

    <div v-if="signIn && phase === 'running'" class="signin">
      <p class="signin__lead">
        <template v-if="!link">Waiting for the sign-in page…</template>
        <template v-else-if="sentCode">Code sent. Finishing the sign-in…</template>
        <template v-else>The sign-in page is open in your browser. Sign in there to continue.</template>
      </p>
      <div v-if="deviceCode" class="signin__code">
        <span class="signin__code-label">Enter this code on the page</span>
        <span class="signin__code-value selectable">{{ deviceCode }}</span>
        <UiButton variant="ghost" size="sm" @click="copyCode">
          <Check v-if="codeCopied" /><Copy v-else />{{ codeCopied ? 'Copied' : 'Copy' }}
        </UiButton>
      </div>
      <form v-else-if="wantsCode && !sentCode" class="signin__paste" @submit.prevent="sendCode">
        <label class="signin__code-label" :for="codeId">When the page shows a code, paste it here</label>
        <div class="signin__paste-row">
          <input
            :id="codeId"
            v-model="pasted"
            class="signin__input"
            autocomplete="off"
            spellcheck="false"
            placeholder="Code from the browser"
          >
          <UiButton size="sm" type="submit" :disabled="!pasted.trim()">Continue</UiButton>
        </div>
      </form>
    </div>

    <button
      v-if="signIn"
      type="button"
      class="job__toggle"
      :aria-expanded="showOutput"
      @click="showOutput = !showOutput"
    >
      <ChevronDown class="job__toggle-icon" :class="{ 'is-open': showOutput }" aria-hidden="true" />
      {{ showOutput ? 'Hide output' : 'Show output' }}
    </button>

    <div
      class="job__term"
      :class="{ 'is-collapsed': !showOutput }"
      :inert="!showOutput || undefined"
      @focusin="focused = true"
      @focusout="focused = false"
    >
      <LoginTerminal
        ref="term"
        :key="attempt"
        :start="start"
        :label="label"
        :rows="rows"
        @exit="onExit"
        @failed="onFailed"
        @link="onLink"
        @output="onOutput"
      />
    </div>

    <p v-if="phase === 'running' && (signIn ? showOutput : $slots.hint)" class="job__hint">
      <slot name="hint">
        If the page gives you a code, press <kbd>{{ modKey }}</kbd><kbd>V</kbd> to paste it here,
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
/* Kept running (and sized) while folded away: the sign-in still reads its output. */
.job__term.is-collapsed {
  height: 0;
  overflow: hidden;
  border-top: 0;
  visibility: hidden;
}
.signin {
  display: grid;
  gap: var(--space-3);
  padding: var(--space-1) var(--space-3) var(--space-3);
}
.signin__lead { margin: 0; font-size: var(--text-sm); color: var(--fg-muted); text-wrap: pretty; }
.signin__code {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  flex-wrap: wrap;
}
.signin__code-label { font-size: var(--text-xs); color: var(--fg-subtle); }
.signin__code-value {
  font-family: var(--font-mono);
  font-size: var(--text-lg);
  font-weight: 600;
  letter-spacing: 0.08em;
  color: var(--fg);
}
.signin__paste { display: grid; gap: var(--space-1); }
.signin__paste-row { display: flex; gap: var(--space-2); }
.signin__input {
  flex: 1;
  min-width: 0;
  height: 30px;
  padding: 0 var(--space-3);
  background: var(--bg-inset);
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  font-family: var(--font-mono);
  font-size: var(--text-sm);
}
.signin__input:focus-visible { outline: none; border-color: var(--accent-line); box-shadow: 0 0 0 3px var(--accent-soft); }
.job__toggle {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  width: 100%;
  padding: var(--space-1) var(--space-3);
  border: 0;
  border-top: 1px solid var(--line-soft);
  background: none;
  font-size: var(--text-xs);
  color: var(--fg-subtle);
  text-align: left;
  cursor: pointer;
}
.job__toggle:hover { color: var(--fg-muted); }
.job__toggle:focus-visible { outline: 2px solid var(--accent-line); outline-offset: -2px; }
.job__toggle-icon { width: 13px; height: 13px; transition: transform var(--dur-fast) var(--ease-out); }
.job__toggle-icon.is-open { transform: rotate(180deg); }
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
