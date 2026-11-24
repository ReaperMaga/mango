<script setup lang="ts">
import type { Component } from 'vue'
import { Check, CircleAlert, CircleCheck, CircleDashed, Copy, ExternalLink, RefreshCw, TriangleAlert } from 'lucide-vue-next'
import type { HostingAccount, HostingCli, HostingToolId } from '~/types/ipc'
import { call, openExternal } from '~/composables/useBackend'
import { copyToClipboard } from '~/utils/agentCli'
import { normalizeHost } from '~/utils/gitHosts'
import LoginTerminal from './LoginTerminal.vue'

/**
 * One forge CLI in Settings > Git hosting (`gh` or `glab`): installed or not, the hosts it is signed in
 * to, and the actions that change that. Installing and signing in run the tool's own installer and
 * sign-in in a terminal inside the row, as Settings > Agents does.
 */
const props = defineProps<{
  tool: HostingToolId
  name: string
  icon: Component
  /** github.com / gitlab.com: what "Sign in" signs in to. */
  defaultHost: string
  /** What another server is, for the field's hint. */
  otherHint: string
  otherPlaceholder: string
  /** null until the first answer */
  cli: HostingCli | null
  loading: boolean
  /** why the last check failed, when it did */
  error: string | null
  /** Ask both CLIs again. */
  refresh: () => Promise<HostingCli[] | null>
}>()

type View = 'checking' | 'error' | 'missing' | 'ready'
const view = computed<View>(() => {
  if (!props.cli) return props.error && !props.loading ? 'error' : 'checking'
  if (!props.cli.installed) return 'missing'
  if (props.cli.error) return 'error'
  return 'ready'
})
const checkError = computed(() => props.cli?.error ?? props.error)

/** The default host first, then the rest as the CLI listed them. */
const accounts = computed(() => {
  const list = [...(props.cli?.accounts ?? [])]
  return list.sort((a, b) => Number(b.host === props.defaultHost) - Number(a.host === props.defaultHost))
})
const signedInToDefault = computed(() => accounts.value.some(a => a.host === props.defaultHost && a.ok))

const root = ref<HTMLElement | null>(null)
const actionError = ref<string | null>(null)

const rechecking = ref(false)
async function recheck() {
  if (rechecking.value) return
  rechecking.value = true
  actionError.value = null
  try {
    await props.refresh()
  } finally {
    rechecking.value = false
  }
}

/* ---------- jobs: installing, signing in ---------- */

interface Job {
  kind: 'install' | 'login'
  host: string
  phase: 'running' | 'checking' | 'failed'
  note: string
  attempt: number
}
const job = ref<Job | null>(null)
let attempts = 0
const termFocused = ref(false)
const link = ref<string | null>(null)
const copied = ref(false)
let copiedTimer: ReturnType<typeof setTimeout> | undefined
const jobEl = ref<HTMLElement | null>(null)
const pasteMod = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl'

function begin(kind: Job['kind'], host = '') {
  actionError.value = null
  adding.value = false
  link.value = null
  termFocused.value = false
  job.value = { kind, host, phase: 'running', note: '', attempt: ++attempts }
  nextTick(() => jobEl.value?.scrollIntoView({ block: 'nearest' }))
}

const startJob = computed(() => {
  const j = job.value
  if (!j) return undefined
  return j.kind === 'install'
    ? (cols: number, rows: number) => call('setup_install', { tool: props.tool, cols, rows })
    : (cols: number, rows: number) => call('hosting_login', { tool: props.tool, host: j.host, cols, rows })
})

const jobTitle = computed(() => {
  const j = job.value
  if (!j) return ''
  if (j.phase === 'checking') return j.kind === 'install' ? `Checking the ${props.name}…` : 'Checking sign-in…'
  if (j.phase === 'failed') return j.kind === 'install' ? `The ${props.name} isn't installed` : 'Sign-in didn\'t finish'
  return j.kind === 'install' ? `Installing the ${props.name}…` : `Signing in to ${j.host}…`
})

async function onExit(code: number | null) {
  const j = job.value
  if (!j || j.phase !== 'running') return
  j.phase = 'checking'
  const now = await props.refresh()
  if (job.value !== j) return
  const cli = now?.find(c => c.id === props.tool)
  const done = j.kind === 'install'
    ? !!cli?.installed
    : !!cli?.accounts.some(a => a.host === j.host && a.ok)
  if (done) {
    await closeJob()
    return
  }
  const what = j.kind === 'install' ? 'The installer' : `The ${props.tool} command`
  j.note = code === 0
    ? j.kind === 'install'
      ? `The installer finished, but Mango can't find ${props.tool} yet. Restart Mango, then look again.`
      : `${what} closed without signing in to ${j.host}.`
    : code === null
      ? `${what} stopped before it finished.`
      : code === 130
        ? `${what} was interrupted before it finished.`
        : `${what} exited with code ${code}.`
  j.phase = 'failed'
}

function onFailed(message: string) {
  if (!job.value) return
  job.value.note = `Mango couldn't start it: ${message.replace(/\.$/, '')}.`
  job.value.phase = 'failed'
}

async function closeJob() {
  const wasRunning = job.value?.phase === 'running'
  job.value = null
  termFocused.value = false
  await nextTick()
  root.value?.querySelector<HTMLElement>('[data-land]')?.focus()
  if (wasRunning) void props.refresh()
}

function retry() {
  const j = job.value
  if (j) begin(j.kind, j.host)
}

async function copyLink() {
  if (!link.value) return
  await copyToClipboard(link.value)
  copied.value = true
  clearTimeout(copiedTimer)
  copiedTimer = setTimeout(() => { copied.value = false }, 1600)
}

/* ---------- another server ---------- */

const adding = ref(false)
const draft = ref('')
const draftError = ref<string | null>(null)
const fieldId = useId()
const hintId = useId()
const input = ref<HTMLInputElement | null>(null)

async function askHost() {
  actionError.value = null
  draft.value = ''
  draftError.value = null
  adding.value = true
  await nextTick()
  input.value?.focus()
}

async function cancelHost() {
  adding.value = false
  await nextTick()
  root.value?.querySelector<HTMLElement>('[data-land]')?.focus()
}

function signInOther() {
  const host = normalizeHost(draft.value)
  if (!host) {
    draftError.value = draft.value.trim() ? `Type a server name like ${props.otherPlaceholder}.` : 'Type the server\'s name.'
    return
  }
  begin('login', host)
}

/* ---------- sign out ---------- */

const signingOut = ref<string | null>(null)
const keyOf = (a: HostingAccount) => `${a.host}\n${a.user ?? ''}`

async function signOut(a: HostingAccount) {
  if (signingOut.value) return
  signingOut.value = keyOf(a)
  actionError.value = null
  try {
    await call('hosting_logout', { tool: props.tool, host: a.host, user: a.user })
    await props.refresh()
    await nextTick()
    root.value?.querySelector<HTMLElement>('[data-land]')?.focus()
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err)
    actionError.value = `Couldn't sign out of ${a.host}: ${why.replace(/\.$/, '')}. Try again, or run "${props.tool} auth logout --hostname ${a.host}" in a terminal.`
  } finally {
    signingOut.value = null
  }
}

function help() {
  if (props.cli?.helpUrl) void openExternal(props.cli.helpUrl).catch(() => {})
}

onBeforeUnmount(() => clearTimeout(copiedTimer))
</script>

<template>
  <li ref="root" class="cli" :class="`cli--${view}`">
    <div class="cli__head">
      <span class="cli__lead" aria-hidden="true"><component :is="icon" class="cli__mark" /></span>
      <h3 class="cli__name">{{ name }}</h3>
      <template v-if="cli?.installed">
        <span v-if="cli.version" class="cli__version tabular">{{ cli.version }}</span>
        <code v-if="cli.path" class="cli__path selectable" :title="cli.path">{{ cli.path }}</code>
      </template>
      <span class="cli__grow" />
      <UiIconButton size="sm" :label="`Check the ${name} again`" :disabled="rechecking || loading" @click="recheck">
        <RefreshCw :class="{ 'is-turning': rechecking || loading }" />
      </UiIconButton>
    </div>

    <!-- first look -->
    <p v-if="view === 'checking'" class="cli__state" role="status">
      <span class="cli__lead" aria-hidden="true"><span class="ring" /></span>
      <span class="cli__more">Checking sign-in…</span>
    </p>

    <!-- could not ask -->
    <div v-else-if="view === 'error'" class="cli__state">
      <span class="cli__says" role="status">
        <span class="cli__lead" aria-hidden="true"><TriangleAlert class="cli__icon cli__icon--error" /></span>
        <span class="cli__word cli__word--error">Couldn't check sign-in</span>
        <span class="cli__more selectable" :title="checkError ?? undefined">{{ checkError }}</span>
      </span>
      <span class="cli__actions">
        <UiButton size="sm" data-land :loading="rechecking" @click="recheck">Try again</UiButton>
      </span>
    </div>

    <!-- not installed -->
    <template v-else-if="view === 'missing'">
      <p class="cli__state" role="status">
        <span class="cli__lead" aria-hidden="true"><CircleDashed class="cli__icon cli__icon--idle" /></span>
        <span class="cli__word">Not installed</span>
        <span class="cli__more">Mango couldn't find the <code>{{ tool }}</code> command on this computer.</span>
      </p>
      <div v-if="!job" class="cli__after">
        <span v-if="cli?.install" class="cli__more">Mango can install it with {{ cli.install.via }}: <code class="selectable">{{ cli.install.command }}</code></span>
        <span v-else class="cli__more">Install it with the instructions on its page, then check again.</span>
        <span class="cli__actions">
          <UiButton v-if="cli?.install" size="sm" data-land @click="begin('install')">Install</UiButton>
          <UiButton v-else size="sm" variant="ghost" data-land @click="help"><ExternalLink />How to install</UiButton>
        </span>
      </div>
    </template>

    <!-- installed: its accounts -->
    <template v-else>
      <ul v-if="accounts.length" class="cli__accounts" :aria-label="`Signed in with the ${name}`">
        <li v-for="a in accounts" :key="keyOf(a)" class="acct">
          <span class="cli__lead" aria-hidden="true">
            <CircleCheck v-if="a.ok" class="cli__icon cli__icon--ok" />
            <TriangleAlert v-else class="cli__icon cli__icon--warn" />
          </span>
          <span class="acct__text">
            <span class="acct__host selectable">{{ a.host }}</span>
            <span v-if="a.user" class="acct__user selectable">{{ a.user }}</span>
            <span class="acct__word" :class="a.ok ? 'acct__word--ok' : 'acct__word--warn'">{{ a.ok ? 'Signed in' : 'Sign-in failed' }}</span>
            <span v-if="!a.active" class="acct__meta">not in use</span>
            <span v-if="a.fromEnv" class="acct__meta">from an environment variable</span>
            <span v-if="!a.ok && a.error" class="acct__meta selectable" :title="a.error">{{ a.error }}</span>
          </span>
          <span class="cli__actions">
            <UiButton
              v-if="!a.ok && !a.fromEnv"
              size="sm"
              variant="ghost"
              :disabled="!!job && job.phase !== 'failed'"
              @click="begin('login', a.host)"
            >Sign in again</UiButton>
            <UiButton
              v-if="!a.fromEnv"
              size="sm"
              variant="ghost"
              :loading="signingOut === keyOf(a)"
              :aria-label="`Sign out of ${a.host}${a.user ? ` as ${a.user}` : ''}`"
              @click="signOut(a)"
            >Sign out</UiButton>
          </span>
        </li>
      </ul>
      <p v-else class="cli__state" role="status">
        <span class="cli__lead" aria-hidden="true"><CircleAlert class="cli__icon cli__icon--warn" /></span>
        <span class="cli__word cli__word--warn">Not signed in</span>
        <span class="cli__more">{{ tool === 'gh' ? 'Pull requests, checks and releases need a sign-in.' : 'Merge requests, pipelines and releases need a sign-in.' }}</span>
      </p>

      <!-- sign in to another server -->
      <form v-if="adding" class="other" @submit.prevent="signInOther" @keydown.esc.prevent="cancelHost">
        <label class="other__label" :for="fieldId">Server</label>
        <div class="other__line">
          <input
            :id="fieldId"
            ref="input"
            v-model="draft"
            class="other__input"
            :class="{ 'has-error': !!draftError }"
            type="text"
            spellcheck="false"
            autocomplete="off"
            :placeholder="otherPlaceholder"
            :aria-describedby="hintId"
            :aria-invalid="!!draftError || undefined"
            @input="draftError = null"
          >
          <UiButton size="sm" type="submit">Sign in</UiButton>
          <UiButton size="sm" variant="ghost" @click="cancelHost">Cancel</UiButton>
        </div>
        <p v-if="draftError" :id="hintId" class="other__hint other__hint--error" role="alert">{{ draftError }}</p>
        <p v-else :id="hintId" class="other__hint">{{ otherHint }}</p>
      </form>

      <div v-else-if="!job" class="cli__foot">
        <UiButton v-if="!signedInToDefault" size="sm" data-land @click="begin('login', defaultHost)">Sign in to {{ defaultHost }}</UiButton>
        <UiButton size="sm" variant="ghost" :data-land="signedInToDefault || undefined" @click="askHost">Sign in to another server…</UiButton>
      </div>
    </template>

    <p v-if="actionError" class="cli__error selectable" role="alert">{{ actionError }}</p>

    <!-- the installer or the sign-in, running right here -->
    <section
      v-if="job"
      ref="jobEl"
      class="job"
      :class="[`job--${job.phase}`, { 'is-focused': termFocused }]"
      :aria-label="job.kind === 'install' ? `Install the ${name}` : `Sign in to ${job.host}`"
    >
      <header class="job__head">
        <span class="job__status" role="status">
          <TriangleAlert v-if="job.phase === 'failed'" class="job__warn" aria-hidden="true" />
          <span v-else class="ring" :class="{ 'ring--work': job.phase === 'running' }" aria-hidden="true" />
          <span class="job__title">{{ jobTitle }}</span>
        </span>
        <span v-if="job.phase !== 'checking'" class="job__actions">
          <template v-if="job.phase === 'running' && link">
            <UiButton variant="ghost" size="sm" :title="link" @click="openExternal(link)"><ExternalLink />Open page</UiButton>
            <UiButton variant="ghost" size="sm" @click="copyLink"><Check v-if="copied" /><Copy v-else />{{ copied ? 'Copied' : 'Copy link' }}</UiButton>
          </template>
          <template v-if="job.phase === 'failed'">
            <UiButton size="sm" @click="retry">Try again</UiButton>
            <UiButton v-if="job.kind === 'install'" size="sm" variant="ghost" @click="help"><ExternalLink />How to install</UiButton>
          </template>
          <UiButton size="sm" variant="ghost" @click="closeJob">{{ job.phase === 'running' ? 'Cancel' : 'Close' }}</UiButton>
        </span>
      </header>

      <p v-if="job.phase === 'failed'" class="job__note selectable" role="alert">{{ job.note }} The output is kept below.</p>

      <div class="job__term" @focusin="termFocused = true" @focusout="termFocused = false">
        <LoginTerminal
          :key="job.attempt"
          :start="startJob"
          :label="job.kind === 'install' ? `${name} installer` : `${name} sign-in terminal`"
          :rows="job.kind === 'install' ? 10 : 14"
          @exit="onExit"
          @failed="onFailed"
          @link="link = $event"
        />
      </div>

      <p v-if="job.phase === 'running'" class="job__hint">
        <template v-if="job.kind === 'install'">If the installer asks a question, answer it here.</template>
        <template v-else>
          Answer the questions here and finish in your browser. To paste a code or a token, press <kbd>{{ pasteMod }}</kbd><kbd>V</kbd>, then
          <kbd>Enter</kbd>; it may stay hidden as you paste.
        </template>
      </p>
    </section>
  </li>
</template>

<style scoped>
.cli {
  padding: var(--space-3) 0;
  border-top: 1px solid var(--line-soft);
}
.cli:last-child { border-bottom: 1px solid var(--line-soft); }

/* One 14px lead column, so the mark, the status icons and the account icons line up. */
.cli__lead {
  flex: none;
  display: inline-grid;
  place-items: center;
  width: 14px;
  height: 14px;
}
.cli__head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  height: 28px;
  min-width: 0;
}
.cli__mark { width: 14px; height: 14px; color: var(--fg); stroke-width: 1.75; }
.cli--missing .cli__mark { color: var(--fg-subtle); }
.cli__name {
  margin: 0;
  flex: none;
  font-size: var(--text-md);
  font-weight: 600;
  letter-spacing: -0.005em;
  color: var(--fg);
}
.cli__version {
  flex: none;
  margin-left: var(--space-1);
  font-size: var(--text-xs);
  color: var(--fg-subtle);
}
.cli__path {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--text-xs);
  color: var(--fg-faint);
}
.cli__grow { flex: 1; }
.is-turning { animation: cli-turn 0.8s linear infinite; }
@keyframes cli-turn { to { transform: rotate(360deg); } }

/* ---- status lines ---- */
.cli__state {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-height: 30px;
  margin: 0;
  min-width: 0;
  font-size: var(--text-sm);
}
.cli__says {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
.cli__icon { width: 14px; height: 14px; stroke-width: 1.85; }
.cli__icon--ok { color: var(--ripe-queued); }
.cli__icon--warn { color: var(--ripe-waiting); }
.cli__icon--error { color: var(--ripe-error); }
.cli__icon--idle { color: var(--ripe-idle); }
.cli__word { flex: none; font-weight: 560; color: var(--fg-muted); }
.cli__word--warn { color: var(--ripe-waiting-fg); }
.cli__word--error { color: var(--ripe-error-fg); }
.cli__more {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--fg-muted);
}
.cli__more code { font-size: var(--text-xs); color: var(--fg); }
.cli__actions {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  margin-left: auto;
  padding-left: var(--space-2);
}
.cli__after {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  margin: var(--space-1) 0 0 22px;
  font-size: var(--text-xs);
}
.cli__after .cli__more { color: var(--fg-subtle); }
.cli__error {
  margin: var(--space-1) 0 0 22px;
  font-size: var(--text-xs);
  color: var(--ripe-error-fg);
  text-wrap: pretty;
}

/* ---- accounts ---- */
.cli__accounts { margin: 0; padding: 0; list-style: none; }
.acct {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-height: 30px;
  min-width: 0;
  font-size: var(--text-sm);
}
.acct__text {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
  overflow: hidden;
  white-space: nowrap;
}
.acct__host { flex: none; font-weight: 560; color: var(--fg); }
.acct__user { flex: none; color: var(--fg-muted); }
.acct__word { flex: none; font-size: var(--text-xs); font-weight: 560; }
.acct__word--ok { color: var(--ripe-queued-fg); }
.acct__word--warn { color: var(--ripe-waiting-fg); }
.acct__meta {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: var(--text-xs);
  color: var(--fg-subtle);
}
/* The ways to sign in sit at the right, under the accounts' own actions. */
.cli__foot {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--space-1);
  margin: var(--space-1) 0 0 22px;
}

/* ---- another server ---- */
.other { margin: var(--space-2) 0 0 22px; display: grid; gap: 6px; max-width: 520px; }
.other__label { font-size: var(--text-xs); font-weight: 560; color: var(--fg-muted); }
.other__line { display: flex; align-items: center; gap: var(--space-1); }
.other__input {
  flex: 1;
  min-width: 0;
  height: 32px;
  margin-right: var(--space-1);
  padding: 0 var(--space-3);
  background: var(--bg-inset);
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  font-size: var(--text-sm);
  transition: border-color var(--dur-fast) var(--ease-out), box-shadow var(--dur-fast) var(--ease-out);
}
.other__input::placeholder { color: var(--fg-faint); }
.other__input:focus-visible { outline: none; }
.other__input:focus { border-color: var(--accent-line); box-shadow: 0 0 0 3px var(--accent-soft); }
.other__input.has-error { border-color: color-mix(in oklch, var(--ripe-error) 60%, transparent); }
.other__hint { margin: 0; font-size: var(--text-xs); color: var(--fg-subtle); line-height: var(--leading-tight); }
.other__hint--error { color: var(--ripe-error-fg); }

/* ---- the job panel (Settings > Agents' embedded sign-in) ---- */
.job {
  margin: var(--space-2) 0 var(--space-1);
  scroll-margin: var(--space-4);
  background: var(--bg-panel);
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
  overflow: hidden;
  transition: border-color var(--dur-fast) var(--ease-out), box-shadow var(--dur-fast) var(--ease-out);
}
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
.job__status { flex: 1; min-width: 0; display: flex; align-items: center; gap: var(--space-2); }
.job__title {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--text-sm);
  font-weight: 560;
}
.job__warn { flex: none; width: 14px; height: 14px; stroke-width: 1.85; color: var(--ripe-error); }
.job__actions { flex: none; display: inline-flex; align-items: center; gap: var(--space-1); }
.job__note {
  margin: 0;
  padding: 0 var(--space-3) var(--space-2);
  font-size: var(--text-xs);
  color: var(--ripe-error-fg);
  text-wrap: pretty;
}
.job__term { border-top: 1px solid var(--line-soft); background: var(--term-bg); }
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
  animation: cli-turn 0.7s linear infinite;
}
.ring--work { border-color: var(--ripe-running); border-right-color: transparent; }
</style>
