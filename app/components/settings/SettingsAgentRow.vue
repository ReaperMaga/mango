<script lang="ts">
import type { AuthStatus } from '~/types/ipc'

/** What the settings page knows about one agent's sign-in. */
export interface AuthEntry {
  status: AuthStatus | null
  loading: boolean
  /** why the last check failed, when it did */
  error: string | null
}
</script>

<script setup lang="ts">
import { Check, CircleAlert, CircleCheck, CircleDashed, Copy, ExternalLink, RefreshCw, TriangleAlert } from 'lucide-vue-next'
import { AGENT_CLI, copyToClipboard } from '~/utils/agentCli'
import { useWorkspace } from '~/stores/workspace'
import type { AgentInfo } from '~/types/ipc'
import type { AgentId } from '~/types/chat'
import { call, openExternal } from '~/composables/useBackend'
import LoginTerminal from './LoginTerminal.vue'

/**
 * One agent in Settings: is its CLI installed, is it signed in, and the
 * actions that change that. Sign-in runs the CLI's own login command in a
 * terminal inside the row.
 */
const props = defineProps<{
  agent: AgentId
  name: string
  /** from detect_agents; null until known */
  info: AgentInfo | null
  auth: AuthEntry
  /** Re-query sign-in state; with `detect` also look for the CLI again. */
  refresh: (opts?: { detect?: boolean }) => Promise<AuthStatus | null>
}>()

const ws = useWorkspace()
const cli = computed(() => AGENT_CLI[props.agent] ?? null)
const loginCommand = computed(() => cli.value?.login.join(' ') ?? '')

/** true / false once known, null while we are still finding out. */
const installed = computed<boolean | null>(() => props.info?.installed ?? props.auth.status?.installed ?? null)
const status = computed(() => (installed.value ? props.auth.status : null))

type View = 'unknown' | 'missing' | 'checking' | 'error' | 'in' | 'out'
const view = computed<View>(() => {
  if (installed.value === false) return 'missing'
  if (props.auth.error && !props.auth.loading) return 'error'
  if (!status.value) return installed.value === null && !props.auth.loading ? 'unknown' : 'checking'
  return status.value.loggedIn ? 'in' : 'out'
})

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

/** "you@example.com · Max plan · claude.ai", or "with ChatGPT" when no account is reported. */
const account = computed(() => {
  const s = status.value
  if (!s?.loggedIn) return ''
  const plan = s.plan ? `${cap(s.plan)} plan` : null
  if (s.account) return [s.account, plan, s.method].filter(Boolean).join(' · ')
  const parts = [s.method ? `with ${s.method}` : null, plan].filter(Boolean)
  if (parts.length) return parts.join(' · ')
  return s.detail && !/^(logged|signed) in\.?$/i.test(s.detail) ? s.detail : ''
})

/** The CLI's own line, when it says more than "not logged in". */
const signedOutDetail = computed(() => {
  const d = status.value?.detail?.trim()
  if (!d || status.value?.loggedIn) return ''
  return /^not (logged|signed) in\.?$/i.test(d) ? '' : d
})

/* ---------- copy ---------- */

const copied = ref<null | 'link'>(null)
let copiedTimer: ReturnType<typeof setTimeout> | undefined

async function copyText(text: string, what: 'link') {
  await copyToClipboard(text)
  copied.value = what
  clearTimeout(copiedTimer)
  copiedTimer = setTimeout(() => { copied.value = null }, 1600)
}

/* ---------- re-check ---------- */

const rechecking = ref(false)
async function recheck() {
  if (rechecking.value) return
  rechecking.value = true
  actionError.value = null
  try {
    await props.refresh({ detect: true })
  } finally {
    rechecking.value = false
  }
}

/* ---------- sign in ---------- */

type Login = 'off' | 'running' | 'verifying' | 'failed'
const login = ref<Login>('off')
/** bumped per attempt so "Try again" gets a fresh terminal */
const attempt = ref(0)
const loginLink = ref<string | null>(null)
const loginNote = ref('')
const termFocused = ref(false)
const pasteMod = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl'
const stateEl = ref<HTMLElement | null>(null)
const loginEl = ref<HTMLElement | null>(null)

function startLogin() {
  if (!cli.value) return
  actionError.value = null
  confirming.value = false
  loginLink.value = null
  loginNote.value = ''
  attempt.value++
  login.value = 'running'
  // In a short window the terminal opens below the fold: bring all of it into view.
  nextTick(() => loginEl.value?.scrollIntoView({ block: 'nearest' }))
}

/** Cancel a running sign-in, or dismiss a finished one. Unmounting the terminal kills its process. */
async function closeLogin() {
  const wasRunning = login.value === 'running'
  login.value = 'off'
  termFocused.value = false
  await nextTick()
  stateEl.value?.focus()
  if (wasRunning) props.refresh()
}

async function onLoginExit(code: number | null) {
  if (login.value !== 'running') return
  login.value = 'verifying'
  const now = await props.refresh()
  if (login.value !== 'verifying') return
  if (code === 0 && now?.loggedIn) {
    await closeLogin()
    return
  }
  const bin = cli.value?.bin ?? props.name
  loginNote.value = code === 0
    ? `The ${bin} command closed without signing in.`
    : code == null
      ? `The ${bin} command stopped before sign-in finished.`
      : code === 130
        ? `The ${bin} command was interrupted before sign-in finished.`
        : `The ${bin} command exited with code ${code} before sign-in finished.`
  login.value = 'failed'
}

function onLoginFailed(message: string) {
  loginNote.value = `Mango couldn't start "${loginCommand.value}": ${message}`
  login.value = 'failed'
}

/* ---------- sign out ---------- */

const confirming = ref(false)
const signingOut = ref(false)
const actionError = ref<string | null>(null)
const confirmEl = ref<HTMLElement | null>(null)

async function askSignOut() {
  actionError.value = null
  confirming.value = true
  await nextTick()
  // Land on the safe choice.
  confirmEl.value?.querySelector<HTMLElement>('[data-cancel]')?.focus()
}

async function cancelSignOut() {
  confirming.value = false
  await nextTick()
  stateEl.value?.querySelector<HTMLElement>('[data-signout]')?.focus()
}

async function signOut() {
  if (signingOut.value) return
  signingOut.value = true
  try {
    await call('agent_logout', { agent: props.agent })
    confirming.value = false
    await props.refresh()
    await nextTick()
    stateEl.value?.focus()
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err)
    const manual = cli.value ? ` Try again, or run "${cli.value.logout}" in a terminal.` : ' Try again.'
    actionError.value = `Couldn't sign out of ${props.name}: ${why.replace(/\.$/, '')}.${manual}`
    confirming.value = false
  } finally {
    signingOut.value = false
  }
}

onBeforeUnmount(() => clearTimeout(copiedTimer))
</script>

<template>
  <li class="agent" :class="`agent--${view}`">
    <div class="agent__head">
      <span class="agent__lead" aria-hidden="true">
        <UiAgentIcon :agent="agent" class="agent__mark" />
      </span>
      <h3 class="agent__name">{{ name }}</h3>
      <template v-if="installed">
        <span v-if="info?.version" class="agent__version tabular" :title="`${name} ${info.version}`">{{ info.version }}</span>
        <code v-if="info?.path" class="agent__path selectable" :title="info.path">{{ info.path }}</code>
      </template>
      <span class="agent__grow" />
      <UiIconButton
        v-if="view !== 'missing'"
        size="sm"
        :label="`Check ${name} again`"
        :disabled="rechecking || auth.loading"
        @click="recheck"
      >
        <RefreshCw :class="{ 'is-turning': rechecking || auth.loading }" />
      </UiIconButton>
    </div>

    <!-- CLI not found -->
    <div v-if="view === 'missing'" class="agent__missing">
      <p ref="stateEl" class="agent__state" tabindex="-1">
        <span class="agent__says" role="status">
          <span class="agent__lead" aria-hidden="true"><CircleDashed class="agent__icon agent__icon--idle" /></span>
          <span class="agent__word">Not installed</span>
          <span class="agent__more">
            <template v-if="cli">Mango couldn't find the <code>{{ cli.bin }}</code> command on this computer.</template>
            <template v-else>Mango couldn't find this agent's command on this computer.</template>
          </span>
        </span>
      </p>
      <div class="agent__indent">
        <div class="agent__after">
          <span>Mango can run the official installer for you.</span>
          <span class="agent__actions">
            <UiButton variant="ghost" size="sm" :loading="rechecking" @click="recheck">Check again</UiButton>
            <UiButton size="sm" @click="ws.openSetup()">Install…</UiButton>
          </span>
        </div>
      </div>
    </div>

    <!-- sign-out confirmation replaces the status line -->
    <div
      v-else-if="confirming"
      ref="confirmEl"
      class="agent__state agent__state--confirm"
      role="group"
      :aria-label="`Sign out of ${name}`"
      @keydown.esc.stop.prevent="cancelSignOut"
    >
      <span class="agent__lead" aria-hidden="true"><CircleAlert class="agent__icon agent__icon--warn" /></span>
      <span class="agent__more agent__more--strong">Sign out of {{ name }}? Chats that use it stop until you sign in again.</span>
      <span class="agent__actions">
        <UiButton variant="ghost" size="sm" data-cancel :disabled="signingOut" @click="cancelSignOut">Cancel</UiButton>
        <UiButton variant="danger" size="sm" :loading="signingOut" @click="signOut">Sign out</UiButton>
      </span>
    </div>

    <!-- sign-in state -->
    <div v-else ref="stateEl" class="agent__state" tabindex="-1">
      <span class="agent__says" role="status">
        <template v-if="view === 'checking' || view === 'unknown'">
          <span class="agent__lead" aria-hidden="true"><span class="ring" /></span>
          <span class="agent__more">Checking sign-in…</span>
        </template>
        <template v-else-if="view === 'error'">
          <span class="agent__lead" aria-hidden="true"><TriangleAlert class="agent__icon agent__icon--error" /></span>
          <span class="agent__word agent__word--error">Couldn't check sign-in</span>
          <span class="agent__more selectable" :title="auth.error ?? undefined">{{ auth.error }}</span>
        </template>
        <template v-else-if="view === 'in'">
          <span class="agent__lead" aria-hidden="true"><CircleCheck class="agent__icon agent__icon--ok" /></span>
          <span class="agent__word agent__word--ok">Signed in</span>
          <span v-if="account" class="agent__more selectable" :title="account">{{ account }}</span>
        </template>
        <template v-else>
          <span class="agent__lead" aria-hidden="true"><CircleAlert class="agent__icon agent__icon--warn" /></span>
          <span class="agent__word agent__word--warn">Not signed in</span>
          <span v-if="signedOutDetail" class="agent__more selectable" :title="signedOutDetail">{{ signedOutDetail }}</span>
          <span v-else-if="!cli" class="agent__more">Sign in with this agent's own command, then check again.</span>
        </template>
      </span>

      <span v-if="view === 'error'" class="agent__actions">
        <UiButton size="sm" :loading="rechecking" @click="recheck">Try again</UiButton>
      </span>
      <span v-else-if="view === 'in' && login === 'off'" class="agent__actions">
        <UiButton v-if="cli" variant="ghost" size="sm" @click="startLogin">Switch account</UiButton>
        <UiButton variant="ghost" size="sm" data-signout @click="askSignOut">Sign out</UiButton>
      </span>
      <span v-else-if="view === 'out' && login === 'off' && cli" class="agent__actions">
        <UiButton size="sm" @click="startLogin">Sign in</UiButton>
      </span>
    </div>

    <p v-if="actionError" class="agent__error selectable" role="alert">{{ actionError }}</p>

    <!-- the CLI's own sign-in, running right here -->
    <section
      v-if="login !== 'off' && cli"
      ref="loginEl"
      class="login"
      :class="[`login--${login}`, { 'is-focused': termFocused }]"
      :aria-label="`Sign in to ${name}`"
    >
      <header class="login__head">
        <span class="login__status" role="status">
          <template v-if="login === 'running'">
            <span class="ring ring--work" aria-hidden="true" />
            <span class="login__title">Signing in to {{ name }}…</span>
          </template>
          <template v-else-if="login === 'verifying'">
            <span class="ring" aria-hidden="true" />
            <span class="login__title">Checking sign-in…</span>
          </template>
          <template v-else>
            <TriangleAlert class="login__warn" aria-hidden="true" />
            <span class="login__title">Sign-in didn't finish</span>
          </template>
        </span>
        <span class="login__actions">
          <template v-if="login === 'running' && loginLink">
            <UiButton variant="ghost" size="sm" :title="loginLink" @click="openExternal(loginLink)">
              <ExternalLink />Open sign-in page
            </UiButton>
            <UiButton variant="ghost" size="sm" @click="copyText(loginLink, 'link')">
              <Check v-if="copied === 'link'" /><Copy v-else />{{ copied === 'link' ? 'Copied' : 'Copy link' }}
            </UiButton>
          </template>
          <UiButton v-if="login === 'failed'" size="sm" @click="startLogin">Try again</UiButton>
          <UiButton variant="ghost" size="sm" @click="closeLogin">{{ login === 'failed' ? 'Close' : 'Cancel' }}</UiButton>
        </span>
      </header>

      <p v-if="login === 'failed'" class="login__note selectable" role="alert">
        {{ loginNote }} The output is kept below.
      </p>

      <div class="login__term" @focusin="termFocused = true" @focusout="termFocused = false">
        <LoginTerminal
          :key="attempt"
          :command="cli.login"
          :label="`${name} sign-in terminal`"
          @exit="onLoginExit"
          @failed="onLoginFailed"
          @link="loginLink = $event"
        />
      </div>

      <p v-if="login === 'running'" class="login__hint">
        Finish in your browser. If the page gives you a code, press <kbd>{{ pasteMod }}</kbd><kbd>V</kbd> to paste it here, then
        <kbd>Enter</kbd>. The code may stay hidden as you paste.
      </p>
    </section>
  </li>
</template>

<style scoped>
.agent {
  padding: var(--space-3) 0;
  border-top: 1px solid var(--line-soft);
}
.agent:last-child { border-bottom: 1px solid var(--line-soft); }

/* Both lines share one 14px lead column, so the identity mark and the status icon line up. */
.agent__lead {
  flex: none;
  display: inline-grid;
  place-items: center;
  width: 14px;
  height: 14px;
}
.agent__head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  height: 28px;
  min-width: 0;
}
.agent__mark { width: 14px; height: 14px; color: var(--fg); }
/* Not installed yet: the mark recedes, like the rest of the row. */
.agent--missing .agent__mark { opacity: 0.45; filter: grayscale(1); }
.agent__name {
  margin: 0;
  flex: none;
  font-size: var(--text-md);
  font-weight: 600;
  letter-spacing: -0.005em;
  color: var(--fg);
}
.agent__version {
  flex: none;
  margin-left: var(--space-1);
  font-size: var(--text-xs);
  color: var(--fg-subtle);
}
.agent__path {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--text-xs);
  color: var(--fg-faint);
}
.agent__grow { flex: 1; }
.is-turning { animation: agent-turn 0.8s linear infinite; }
@keyframes agent-turn { to { transform: rotate(360deg); } }

/* ---- status line ---- */
.agent__state {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-height: 30px;
  margin: 0;
  min-width: 0;
  font-size: var(--text-sm);
  border-radius: var(--radius-xs);
}
/* Only ever focused from code, as a place to land after an inline panel closes. */
.agent__state:focus-visible { outline: none; }
.agent__says {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
.agent__icon { width: 14px; height: 14px; stroke-width: 1.85; }
.agent__icon--ok { color: var(--ripe-queued); }
.agent__icon--warn { color: var(--ripe-waiting); }
.agent__icon--error { color: var(--ripe-error); }
.agent__icon--idle { color: var(--ripe-idle); }
.agent__word { flex: none; font-weight: 560; color: var(--fg-muted); }
.agent__word--ok { color: var(--ripe-queued-fg); }
.agent__word--warn { color: var(--ripe-waiting-fg); }
.agent__word--error { color: var(--ripe-error-fg); }
.agent__more {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--fg-muted);
}
.agent__more--strong { color: var(--fg); white-space: normal; text-wrap: pretty; }
.agent__more code { font-size: var(--text-xs); color: var(--fg); }
.agent__actions {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  margin-left: auto;
  padding-left: var(--space-2);
}
.agent__state--confirm { padding: 2px 0; }

.agent__error {
  margin: var(--space-1) 0 0 22px;
  font-size: var(--text-xs);
  color: var(--ripe-error-fg);
  text-wrap: pretty;
}

/* ---- not installed ---- */
.agent__indent { margin-left: 22px; }
.agent__after {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  margin-top: var(--space-2);
  font-size: var(--text-xs);
  color: var(--fg-subtle);
}

/* ---- ring spinner ---- */
.ring {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  border: 1.75px solid var(--fg-subtle);
  border-right-color: transparent;
  animation: agent-turn 0.7s linear infinite;
}
.ring--work { border-color: var(--ripe-running); border-right-color: transparent; }

/* ---- embedded sign-in ---- */
.login {
  margin: var(--space-2) 0 var(--space-1);
  scroll-margin: var(--space-4);
  background: var(--bg-panel);
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
  overflow: hidden;
  transition: border-color var(--dur-fast) var(--ease-out), box-shadow var(--dur-fast) var(--ease-out);
}
.login.is-focused {
  border-color: var(--accent-line);
  box-shadow: 0 0 0 3px var(--accent-soft);
}
.login--failed,
.login--failed.is-focused {
  border-color: color-mix(in oklch, var(--ripe-error) 45%, transparent);
  box-shadow: none;
}
.login__head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-height: 38px;
  padding: 0 var(--space-2) 0 var(--space-3);
}
.login__status {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
.login__title {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--text-sm);
  font-weight: 560;
}
.login__warn { flex: none; width: 14px; height: 14px; stroke-width: 1.85; color: var(--ripe-error); }
.login__actions { flex: none; display: inline-flex; align-items: center; gap: var(--space-1); }
.login__note {
  margin: 0;
  padding: 0 var(--space-3) var(--space-2);
  font-size: var(--text-xs);
  color: var(--ripe-error-fg);
  text-wrap: pretty;
}
.login__term {
  border-top: 1px solid var(--line-soft);
  background: var(--term-bg);
}
.login__hint {
  margin: 0;
  padding: var(--space-2) var(--space-3);
  border-top: 1px solid var(--line-soft);
  font-size: var(--text-xs);
  color: var(--fg-subtle);
  text-wrap: pretty;
}
.login__hint kbd { margin: 0 1px; vertical-align: 1px; }
</style>
