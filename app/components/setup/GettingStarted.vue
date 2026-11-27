<script setup lang="ts">
import { Check, CircleAlert, CircleCheck, CircleDashed, Copy, ExternalLink, TriangleAlert } from 'lucide-vue-next'
import type { AuthStatus, SetupTool, SetupToolId } from '~/types/ipc'
import type { AgentId } from '~/types/chat'
import { call, openExternal } from '~/composables/useBackend'
import { AGENT_CLI, copyToClipboard, shortVersion } from '~/utils/agentCli'
import { useWorkspace } from '~/stores/workspace'
import { useLore } from '~/stores/lore'
import LoginTerminal from '~/components/settings/LoginTerminal.vue'

/**
 * "Get started": shown on the first launch, and from the palette or Settings
 * later. Lists the agent CLIs, git and (optional) Lore, installs what is missing with each
 * vendor's own installer (picked by the backend, run in a terminal here so the
 * user can follow it and answer its prompts), then signs in to the agents.
 */
const { t } = useI18n()
const ws = useWorkspace()
const lore = useLore()
const open = computed(() => ws.dialog === 'setup')

const ORDER: SetupToolId[] = ['claude', 'codex', 'git', 'lore']
const isAgent = (id: SetupToolId): id is AgentId => id === 'claude' || id === 'codex'
/** Only for some projects: missing, it reads as a choice, not a gap. */
const isOptional = (id: SetupToolId) => id === 'lore'
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
    await Promise.all(found.filter(f => f.installed && isAgent(f.id)).map(f => checkAuth(f.id as AgentId)))
  } catch (e) {
    checkError.value = errorText(e)
  } finally {
    checking.value = false
  }
}

type RowState = 'checking' | 'missing' | 'installed' | 'signed-in' | 'signed-out'
function stateOf(tool: SetupTool): RowState {
  if (!tool.installed) return 'missing'
  if (!isAgent(tool.id)) return 'installed'
  const a = auth[tool.id]
  if (a === 'checking' || a === undefined) return 'checking'
  return a?.loggedIn ? 'signed-in' : 'signed-out'
}

function account(tool: SetupTool): string {
  const a = isAgent(tool.id) ? auth[tool.id] : null
  if (!a || a === 'checking') return ''
  return a.account ?? (a.method ? t('agents.cli.withMethod', { method: a.method }) : '')
}

/** At least one agent can take a chat. */
const ready = computed(() => tools.value?.some(f => stateOf(f) === 'signed-in') ?? false)

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
  if (j.phase === 'verifying') return t('start.setup.checking')
  if (j.phase === 'failed') return j.kind === 'install' ? t('start.setup.installFailed', { name: j.tool.name }) : t('agents.cli.signInUnfinished')
  return j.kind === 'install' ? t('agents.cli.installing', { name: j.tool.name }) : t('agents.cli.signingInTo', { name: j.tool.name })
})

async function onExit(code: number | null) {
  const j = job.value
  if (!j || j.phase !== 'running') return
  j.phase = 'verifying'
  await refresh()
  if (job.value !== j) return
  const now = tools.value?.find(f => f.id === j.tool.id)
  const bin = isAgent(j.tool.id) ? AGENT_CLI[j.tool.id]?.bin ?? j.tool.name : j.tool.id
  if (j.kind === 'install') {
    // Settings > Lore and the New project dialog read the CLI from the Lore store: tell them too.
    if (j.tool.id === 'lore' && lore.cli) lore.loadCli()
    if (now?.installed) return finish()
    j.note = code === 0
      ? t('start.setup.installedNotFound', { bin })
      : code == null
        ? t('agents.cli.installerStopped')
        : t('agents.cli.installerExited', { code })
  } else {
    const a = isAgent(j.tool.id) ? auth[j.tool.id] : null
    if (a && a !== 'checking' && a.loggedIn) return finish()
    j.note = code === 0
      ? t('agents.cli.closedSignedOut', { bin })
      : code == null
        ? t('agents.cli.signInExited', { bin })
        : t('agents.cli.signInExitedCode', { bin, code })
  }
  j.phase = 'failed'
}

function onFailed(message: string) {
  if (!job.value) return
  job.value.note = t('agents.cli.cantStart', { message: message.replace(/\.$/, '') })
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
  <UiDialog :open="open" :title="t('start.setup.title')" :width="600" :dismissible="!busy" @close="close">
    <div class="setup">
      <p class="setup__lede">
        {{ t('start.setup.lede') }}
      </p>

      <p v-if="checkError" class="setup__error" role="alert">
        <TriangleAlert aria-hidden="true" />
        <span>{{ t('start.setup.checkFailed', { message: checkError }) }}</span>
        <UiButton size="sm" :loading="checking" @click="refresh">{{ t('common.actions.retry') }}</UiButton>
      </p>

      <ul v-else ref="listEl" class="tools" :aria-label="t('start.setup.tools')" :aria-busy="!tools || undefined">
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
        <li v-for="tool in tools" :key="tool.id" class="tool" :class="`tool--${stateOf(tool)}`">
          <span class="tool__lead" aria-hidden="true">
            <span v-if="stateOf(tool) === 'checking'" class="ring" />
            <CircleDashed v-else-if="stateOf(tool) === 'missing'" class="tool__icon tool__icon--idle" />
            <CircleAlert v-else-if="stateOf(tool) === 'signed-out'" class="tool__icon tool__icon--warn" />
            <CircleCheck v-else class="tool__icon tool__icon--ok" />
          </span>

          <div class="tool__main">
            <div class="tool__head">
              <h3 class="tool__name">{{ tool.name }}</h3>
              <span v-if="tool.version" class="tool__version tabular" :title="tool.path ?? undefined">{{ shortVersion(tool.version) }}</span>
              <span v-if="isOptional(tool.id)" class="tool__tag">{{ t('start.setup.optional') }}</span>
            </div>
            <p class="tool__state" role="status">
              <span v-if="stateOf(tool) === 'checking'" class="tool__word">{{ t('agents.cli.checkingSignIn') }}</span>
              <span v-else-if="stateOf(tool) === 'missing'" class="tool__word">{{ t('agents.cli.notInstalled') }}</span>
              <span v-else-if="stateOf(tool) === 'signed-out'" class="tool__word tool__word--warn">{{ t('agents.cli.notSignedIn') }}</span>
              <span v-else-if="stateOf(tool) === 'signed-in'" class="tool__word tool__word--ok">{{ t('start.setup.ready') }}</span>
              <span v-else class="tool__word tool__word--ok">{{ t('agents.cli.installed') }}</span>
              <span class="tool__more">
                <template v-if="stateOf(tool) === 'signed-in' && account(tool)">{{ account(tool) }}</template>
                <template v-else>{{ t(`start.setup.role.${tool.id}`) }}</template>
              </span>
            </p>
            <p v-if="!tool.installed && tool.install" class="tool__cmd">
              <span class="tool__via">{{ tool.install.via }}:</span>
              <code class="selectable" :title="tool.install.command">{{ tool.install.command }}</code>
            </p>
            <p v-else-if="!tool.installed" class="tool__cmd">
              {{ t('start.setup.cantInstall') }}
            </p>
          </div>

          <span class="tool__actions">
            <template v-if="stateOf(tool) === 'missing'">
              <UiButton v-if="tool.install" size="sm" :disabled="!!job" @click="run(tool, 'install')">{{ t('common.actions.install') }}</UiButton>
              <UiButton v-else variant="ghost" size="sm" @click="openExternal(tool.helpUrl)">
                <ExternalLink />{{ t('start.setup.downloadPage') }}
              </UiButton>
            </template>
            <UiButton
              v-else-if="stateOf(tool) === 'signed-out' && isAgent(tool.id) && AGENT_CLI[tool.id]"
              size="sm"
              :disabled="!!job"
              @click="run(tool, 'signin')"
            >
              {{ t('common.actions.signIn') }}
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
                <ExternalLink />{{ t('agents.cli.openSignInPage') }}
              </UiButton>
              <UiButton variant="ghost" size="sm" @click="copyLink(job.link)">
                <Check v-if="copied" /><Copy v-else />{{ copied ? t('common.actions.copied') : t('agents.cli.copyLink') }}
              </UiButton>
            </template>
            <UiButton v-if="job.phase === 'failed'" size="sm" @click="run(job.tool, job.kind)">{{ t('common.actions.retry') }}</UiButton>
            <UiButton v-if="job.phase !== 'verifying'" variant="ghost" size="sm" @click="finish">
              {{ job.phase === 'failed' ? t('common.actions.close') : job.kind === 'install' ? t('start.setup.stop') : t('common.actions.cancel') }}
            </UiButton>
          </span>
        </header>

        <p v-if="job.phase === 'failed'" class="job__note selectable" role="alert">
          {{ job.note }} {{ t('agents.cli.outputKept') }}
        </p>

        <div class="job__term">
          <LoginTerminal
            v-if="job.kind === 'install'"
            :key="`install-${job.attempt}`"
            :start="startInstall(job.tool.id)"
            :label="t('agents.cli.installer', { name: job.tool.name })"
            :rows="10"
            @exit="onExit"
            @failed="onFailed"
          />
          <LoginTerminal
            v-else-if="isAgent(job.tool.id) && AGENT_CLI[job.tool.id]"
            :key="`signin-${job.attempt}`"
            :command="AGENT_CLI[job.tool.id]!.login"
            :label="t('agents.cli.signInTerminal', { name: job.tool.name })"
            :rows="10"
            @exit="onExit"
            @failed="onFailed"
            @link="job.link = $event"
          />
        </div>

        <p v-if="job.phase === 'running'" class="job__hint">
          <template v-if="job.kind === 'install'">
            {{ t('start.setup.answerInstaller') }}
            <template v-if="isWindows">{{ t('start.setup.windowsAsks') }}</template>
          </template>
          <i18n-t v-else keypath="start.setup.signInHint" scope="global">
            <template #keys><kbd>{{ modKey }}</kbd><kbd>V</kbd></template>
            <template #enter><kbd>Enter</kbd></template>
          </i18n-t>
        </p>
      </section>
    </div>

    <template #footer>
      <i18n-t keypath="start.setup.later" tag="span" scope="global" class="setup__later">
        <template #keys><kbd>{{ modKey }}</kbd><kbd>K</kbd></template>
      </i18n-t>
      <UiButton v-if="ready" variant="primary" data-autofocus :disabled="busy" @click="close">{{ t('common.actions.done') }}</UiButton>
      <UiButton v-else variant="ghost" :disabled="busy" @click="close">{{ t('start.setup.skip') }}</UiButton>
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
.tool__tag {
  padding: 0 var(--space-1);
  border: 1px solid var(--line);
  border-radius: var(--radius-xs);
  font-size: var(--text-xs);
  line-height: 16px;
  color: var(--fg-subtle);
}
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
