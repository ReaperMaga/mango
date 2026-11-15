<script setup lang="ts">
import { Check, CircleAlert, CircleCheck, CircleDashed, Copy, ExternalLink, TriangleAlert } from 'lucide-vue-next'
import type { AuthStatus, SetupTool, SetupToolId } from '~/types/ipc'
import type { AgentId } from '~/types/chat'
import { call, openExternal } from '~/composables/useBackend'
import { AGENT_CLI, copyToClipboard, shortVersion } from '~/utils/agentCli'
import { useWorkspace } from '~/stores/workspace'
import LoginTerminal from '~/components/settings/LoginTerminal.vue'

/**
 * "Get started": shown on the first launch, and from the palette or Settings
 * later. Lists the agent CLIs and git, installs what is missing with each
 * vendor's own installer (picked by the backend, run in a terminal here so the
 * user can follow it and answer its prompts), then signs in to the agents.
 */
const ws = useWorkspace()
const open = computed(() => ws.dialog === 'setup')

const ORDER: SetupToolId[] = ['claude', 'codex', 'git']
const ROLE: Record<SetupToolId, string> = {
  claude: 'Anthropic\'s coding agent',
  codex: 'OpenAI\'s coding agent',
  git: 'For the Changes view, commits and cloning',
}
const isAgent = (id: SetupToolId): id is AgentId => id !== 'git'
const isWindows = /Win/.test(navigator.platform)
const modKey = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl'

/* ---------- what is installed ---------- */

const tools = ref<SetupTool[] | null>(null)
const checkError = ref<string | null>(null)
const checking = ref(false)
/** Sign-in state of installed agents; 'checking' while a check runs. */
const auth = reactive<Partial<Record<AgentId, AuthStatus | 'checking' | null>>>({})

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/\.$/, '')

async function checkAuth(agent: AgentId) {
  // Keep a known answer on screen while the new one comes in: no flicker, no repeat announcement.
  if (auth[agent] === undefined) auth[agent] = 'checking'
  auth[agent] = await call('agent_auth_status', { agent }).catch(() => null)
}

async function refresh() {
  checking.value = true
  try {
    const found = await call('setup_check')
    tools.value = [...found].sort((a, b) => ORDER.indexOf(a.id) - ORDER.indexOf(b.id))
    checkError.value = null
    await Promise.all(found.filter(t => t.installed && isAgent(t.id)).map(t => checkAuth(t.id as AgentId)))
  } catch (e) {
    checkError.value = errorText(e)
  } finally {
    checking.value = false
  }
}

type RowState = 'checking' | 'missing' | 'installed' | 'signed-in' | 'signed-out'
function stateOf(t: SetupTool): RowState {
  if (!t.installed) return 'missing'
  if (!isAgent(t.id)) return 'installed'
  const a = auth[t.id]
  if (a === 'checking' || a === undefined) return 'checking'
  return a?.loggedIn ? 'signed-in' : 'signed-out'
}

function account(t: SetupTool): string {
  const a = isAgent(t.id) ? auth[t.id] : null
  if (!a || a === 'checking') return ''
  return a.account ?? (a.method ? `with ${a.method}` : '')
}

/** At least one agent can take a chat. */
const ready = computed(() => tools.value?.some(t => stateOf(t) === 'signed-in') ?? false)

/* ---------- running an installer or a sign-in ---------- */

interface Job {
  tool: SetupTool
  kind: 'install' | 'signin'
  phase: 'running' | 'verifying' | 'failed'
  note: string
  /** bumped per attempt so "Try again" gets a fresh terminal */
  attempt: number
  link: string | null
}
const job = ref<Job | null>(null)
const busy = computed(() => !!job.value && job.value.phase !== 'failed')
const jobEl = ref<HTMLElement | null>(null)
const listEl = ref<HTMLElement | null>(null)

watch(open, (isOpen) => {
  if (isOpen) refresh()
  else job.value = null
}, { immediate: true })

function run(tool: SetupTool, kind: Job['kind']) {
  job.value = { tool, kind, phase: 'running', note: '', attempt: (job.value?.attempt ?? 0) + 1, link: null }
  nextTick(() => jobEl.value?.scrollIntoView({ block: 'nearest' }))
}

const startInstall = (tool: SetupToolId) => (cols: number, rows: number) => call('setup_install', { tool, cols, rows })

const jobTitle = computed(() => {
  const j = job.value
  if (!j) return ''
  if (j.phase === 'verifying') return 'Checking…'
  if (j.phase === 'failed') return j.kind === 'install' ? `${j.tool.name} didn't install` : 'Sign-in didn\'t finish'
  return j.kind === 'install' ? `Installing ${j.tool.name}…` : `Signing in to ${j.tool.name}…`
})

async function onExit(code: number | null) {
  const j = job.value
  if (!j || j.phase !== 'running') return
  j.phase = 'verifying'
  await refresh()
  if (job.value !== j) return
  const now = tools.value?.find(t => t.id === j.tool.id)
  const bin = isAgent(j.tool.id) ? AGENT_CLI[j.tool.id]?.bin ?? j.tool.name : 'git'
  if (j.kind === 'install') {
    if (now?.installed) return finish()
    j.note = code === 0
      ? `The installer finished, but Mango can't find the ${bin} command yet. Restart Mango, then open Get started again.`
      : code == null
        ? 'The installer stopped before it finished.'
        : `The installer exited with code ${code}.`
  } else {
    const a = isAgent(j.tool.id) ? auth[j.tool.id] : null
    if (a && a !== 'checking' && a.loggedIn) return finish()
    j.note = code === 0
      ? `The ${bin} command closed without signing in.`
      : `The ${bin} command exited${code == null ? '' : ` with code ${code}`} before sign-in finished.`
  }
  j.phase = 'failed'
}

function onFailed(message: string) {
  if (!job.value) return
  job.value.note = `Mango couldn't start it: ${message.replace(/\.$/, '')}.`
  job.value.phase = 'failed'
}

/** Close the terminal (unmounting it stops the process) and land back in the list. */
async function finish() {
  const wasRunning = job.value?.phase === 'running'
  job.value = null
  await nextTick()
  listEl.value?.querySelector<HTMLElement>('button:not(:disabled)')?.focus()
  if (wasRunning) refresh()
}

const copied = ref(false)
let copiedTimer: ReturnType<typeof setTimeout> | undefined
async function copyLink(url: string) {
  await copyToClipboard(url)
  copied.value = true
  clearTimeout(copiedTimer)
  copiedTimer = setTimeout(() => { copied.value = false }, 1600)
}
onBeforeUnmount(() => clearTimeout(copiedTimer))

function close() {
  if (busy.value) return
  ws.closeSetup()
}
</script>

<template>
  <UiDialog :open="open" title="Get started" :width="600" :dismissible="!busy" @close="close">
    <div class="setup">
      <p class="setup__lede">
        Mango runs the coding agents installed on this computer. Install at least one and sign in to it.
        Installers come from each vendor and run in a terminal below, so you can follow along.
      </p>

      <p v-if="checkError" class="setup__error" role="alert">
        <TriangleAlert aria-hidden="true" />
        <span>Couldn't check what is installed: {{ checkError }}.</span>
        <UiButton size="sm" :loading="checking" @click="refresh">Try again</UiButton>
      </p>

      <ul v-else ref="listEl" class="tools" aria-label="Tools" :aria-busy="!tools || undefined">
        <template v-if="!tools">
          <li v-for="id in ORDER" :key="id" class="tool tool--skeleton" aria-hidden="true">
            <span class="tool__lead"><span class="ring" /></span>
            <span class="tool__main">
              <span class="tool__bar" />
              <span class="tool__bar tool__bar--short" />
            </span>
          </li>
        </template>

        <template v-else>
        <li v-for="t in tools" :key="t.id" class="tool" :class="`tool--${stateOf(t)}`">
          <span class="tool__lead" aria-hidden="true">
            <span v-if="stateOf(t) === 'checking'" class="ring" />
            <CircleDashed v-else-if="stateOf(t) === 'missing'" class="tool__icon tool__icon--idle" />
            <CircleAlert v-else-if="stateOf(t) === 'signed-out'" class="tool__icon tool__icon--warn" />
            <CircleCheck v-else class="tool__icon tool__icon--ok" />
          </span>

          <div class="tool__main">
            <div class="tool__head">
              <h3 class="tool__name">{{ t.name }}</h3>
              <span v-if="t.version" class="tool__version tabular" :title="t.path ?? undefined">{{ shortVersion(t.version) }}</span>
            </div>
            <p class="tool__state" role="status">
              <span v-if="stateOf(t) === 'checking'" class="tool__word">Checking sign-in…</span>
              <span v-else-if="stateOf(t) === 'missing'" class="tool__word">Not installed</span>
              <span v-else-if="stateOf(t) === 'signed-out'" class="tool__word tool__word--warn">Not signed in</span>
              <span v-else-if="stateOf(t) === 'signed-in'" class="tool__word tool__word--ok">Ready</span>
              <span v-else class="tool__word tool__word--ok">Installed</span>
              <span class="tool__more">
                <template v-if="stateOf(t) === 'signed-in' && account(t)">{{ account(t) }}</template>
                <template v-else>{{ ROLE[t.id] }}</template>
              </span>
            </p>
            <p v-if="!t.installed && t.install" class="tool__cmd">
              <span class="tool__via">{{ t.install.via }}:</span>
              <code class="selectable" :title="t.install.command">{{ t.install.command }}</code>
            </p>
            <p v-else-if="!t.installed" class="tool__cmd">
              Mango can't install it on this computer. Use the download page, then check again.
            </p>
          </div>

          <span class="tool__actions">
            <template v-if="stateOf(t) === 'missing'">
              <UiButton v-if="t.install" size="sm" :disabled="!!job" @click="run(t, 'install')">Install</UiButton>
              <UiButton v-else variant="ghost" size="sm" @click="openExternal(t.helpUrl)">
                <ExternalLink />Download page
              </UiButton>
            </template>
            <UiButton
              v-else-if="stateOf(t) === 'signed-out' && isAgent(t.id) && AGENT_CLI[t.id]"
              size="sm"
              :disabled="!!job"
              @click="run(t, 'signin')"
            >
              Sign in
            </UiButton>
          </span>
        </li>
        </template>
      </ul>

      <!-- the installer or the CLI's sign-in, running right here -->
      <section
        v-if="job"
        ref="jobEl"
        class="job"
        :class="`job--${job.phase}`"
        :aria-label="jobTitle"
      >
        <header class="job__head">
          <span class="job__status" role="status">
            <TriangleAlert v-if="job.phase === 'failed'" class="job__warn" aria-hidden="true" />
            <span v-else class="ring" :class="{ 'ring--work': job.phase === 'running' }" aria-hidden="true" />
            <span class="job__title">{{ jobTitle }}</span>
          </span>
          <span class="job__actions">
            <template v-if="job.phase === 'running' && job.link">
              <UiButton variant="ghost" size="sm" :title="job.link" @click="openExternal(job.link)">
                <ExternalLink />Open sign-in page
              </UiButton>
              <UiButton variant="ghost" size="sm" @click="copyLink(job.link)">
                <Check v-if="copied" /><Copy v-else />{{ copied ? 'Copied' : 'Copy link' }}
              </UiButton>
            </template>
            <UiButton v-if="job.phase === 'failed'" size="sm" @click="run(job.tool, job.kind)">Try again</UiButton>
            <UiButton v-if="job.phase !== 'verifying'" variant="ghost" size="sm" @click="finish">
              {{ job.phase === 'failed' ? 'Close' : job.kind === 'install' ? 'Stop' : 'Cancel' }}
            </UiButton>
          </span>
        </header>

        <p v-if="job.phase === 'failed'" class="job__note selectable" role="alert">
          {{ job.note }} The output is kept below.
        </p>

        <div class="job__term">
          <LoginTerminal
            v-if="job.kind === 'install'"
            :key="`install-${job.attempt}`"
            :start="startInstall(job.tool.id)"
            :label="`${job.tool.name} installer`"
            :rows="10"
            @exit="onExit"
            @failed="onFailed"
          />
          <LoginTerminal
            v-else-if="isAgent(job.tool.id) && AGENT_CLI[job.tool.id]"
            :key="`signin-${job.attempt}`"
            :command="AGENT_CLI[job.tool.id]!.login"
            :label="`${job.tool.name} sign-in terminal`"
            :rows="10"
            @exit="onExit"
            @failed="onFailed"
            @link="job.link = $event"
          />
        </div>

        <p v-if="job.phase === 'running'" class="job__hint">
          <template v-if="job.kind === 'install'">
            If the installer asks a question or for your password, answer it here.
            <template v-if="isWindows">Windows may also ask for permission in a separate window.</template>
          </template>
          <template v-else>
            Finish in your browser. If the page gives you a code, press <kbd>{{ modKey }}</kbd><kbd>V</kbd> to paste it
            here, then <kbd>Enter</kbd>.
          </template>
        </p>
      </section>
    </div>

    <template #footer>
      <span class="setup__later">Open this again any time: <kbd>{{ modKey }}</kbd><kbd>K</kbd>, then “Get started”.</span>
      <UiButton v-if="ready" variant="primary" data-autofocus :disabled="busy" @click="close">Done</UiButton>
      <UiButton v-else variant="ghost" :disabled="busy" @click="close">Skip for now</UiButton>
    </template>
  </UiDialog>
</template>

<style scoped>
.setup { display: grid; gap: var(--space-4); }
.setup__lede {
  margin: 0;
  max-width: 68ch;
  font-size: var(--text-sm);
  line-height: var(--leading-normal);
  color: var(--fg-muted);
  text-wrap: pretty;
}
.setup__error {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin: 0;
  font-size: var(--text-sm);
}
.setup__error :deep(svg) { flex: none; width: 15px; height: 15px; color: var(--ripe-error); }
.setup__error span { flex: 1; }
.setup__later {
  margin-right: auto;
  font-size: var(--text-xs);
  color: var(--fg-subtle);
}
.setup__later kbd { margin: 0 1px; vertical-align: 1px; }

/* ---- tool rows ---- */
.tools { margin: 0; padding: 0; list-style: none; }
.tool {
  display: grid;
  grid-template-columns: 14px minmax(0, 1fr) auto;
  column-gap: var(--space-3);
  align-items: start;
  padding: var(--space-3) 0;
  border-top: 1px solid var(--line);
}
.tool__lead {
  display: grid;
  place-items: center;
  width: 14px;
  height: 20px;
}
.tool__icon { width: 14px; height: 14px; stroke-width: 1.85; }
.tool__icon--ok { color: var(--ripe-queued); }
.tool__icon--warn { color: var(--ripe-waiting); }
.tool__icon--idle { color: var(--ripe-idle); }

.tool__main { min-width: 0; display: grid; gap: 2px; }
.tool__head { display: flex; align-items: baseline; gap: var(--space-2); min-height: 20px; }
.tool__name {
  margin: 0;
  font-size: var(--text-md);
  font-weight: 600;
  letter-spacing: -0.005em;
  color: var(--fg);
}
.tool__version { font-size: var(--text-xs); color: var(--fg-subtle); }
.tool__state {
  display: flex;
  gap: var(--space-2);
  min-width: 0;
  margin: 0;
  font-size: var(--text-sm);
}
.tool__word { flex: none; font-weight: 560; color: var(--fg-muted); }
.tool__word--ok { color: var(--ripe-queued-fg); }
.tool__word--warn { color: var(--ripe-waiting-fg); }
.tool__more {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--fg-subtle);
}
.tool__cmd {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
  min-width: 0;
  margin: var(--space-1) 0 0;
  font-size: var(--text-xs);
  color: var(--fg-subtle);
}
.tool__via { flex: none; }
.tool__cmd code {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--text-xs);
  color: var(--fg-muted);
}
.tool__actions {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  min-height: 20px;
}

/* loading rows hold the final layout */
.tool__bar {
  display: block;
  width: 140px;
  height: 10px;
  margin: 5px 0;
  border-radius: var(--radius-xs);
  background: var(--bg-active);
}
.tool__bar--short { width: 220px; opacity: 0.6; }

/* ---- spinner ---- */
.ring {
  display: block;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  border: 1.75px solid var(--fg-subtle);
  border-right-color: transparent;
  animation: setup-turn 0.7s linear infinite;
}
.ring--work { border-color: var(--ripe-running); border-right-color: transparent; }
@keyframes setup-turn { to { transform: rotate(360deg); } }

/* ---- embedded terminal ---- */
.job {
  scroll-margin: var(--space-4);
  background: transparent;
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
  overflow: hidden;
}
.job:focus-within { border-color: var(--accent-line); }
.job--failed, .job--failed:focus-within { border-color: color-mix(in oklch, var(--ripe-error) 45%, transparent); }
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
.job__term { border-top: 1px solid var(--line); background: var(--term-bg); }
.job__hint {
  margin: 0;
  padding: var(--space-2) var(--space-3);
  border-top: 1px solid var(--line);
  font-size: var(--text-xs);
  color: var(--fg-subtle);
  text-wrap: pretty;
}
.job__hint kbd { margin: 0 1px; vertical-align: 1px; }
</style>
