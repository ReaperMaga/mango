<script setup lang="ts">
import { CircleAlert, CircleCheck, CircleDashed, Download, Ellipsis, Pencil, RefreshCw, RotateCw, Server, Settings2, TriangleAlert, Trash2, X } from 'lucide-vue-next'
import type { LoreMachineAction, LoreServer, LoreServerCheck } from '~/types/ipc'
import type { MenuItem } from '~/types/ui'
import { machineHost } from '~/utils/loreMachine'
import { call, openExternal } from '~/composables/useBackend'
import { useLore } from '~/stores/lore'
import LoginTerminal from './LoginTerminal.vue'
import SettingsLoreForm from './SettingsLoreForm.vue'

/**
 * One saved Lore server in Settings > Lore: how it answered this computer (TCP, UDP, sign-in), signing in
 * and out through the CLI (in a terminal inside the row), and changing or removing the entry.
 */
const props = defineProps<{ server: LoreServer; cliInstalled: boolean }>()

const { t } = useI18n()
const lore = useLore()

const state = computed(() => lore.checkOf(props.server.url))
const check = computed<LoreServerCheck | null>(() => state.value?.check ?? null)
const checking = computed(() => !!state.value?.loading)
const place = computed(() => (props.server.origin ? envLabels(props.server.origin.hostId, props.server.origin.instance) : null))

type Tone = 'ok' | 'warn' | 'error' | 'idle' | 'checking'
/** What the row says: a tone (icon + colour), a word, and the detail after it. */
const status = computed<{ tone: Tone; word: string; detail: string | null }>(() => {
  const c = check.value
  if (!c) {
    if (state.value?.error) return { tone: 'error', word: t('lore.state.checkFailed'), detail: state.value.error }
    return { tone: 'checking', word: t('lore.state.checking'), detail: null }
  }
  switch (c.reach) {
    case 'noCli': return { tone: 'idle', word: t('lore.state.noCli'), detail: c.message }
    case 'udp': return { tone: 'warn', word: t('lore.state.udp'), detail: c.message }
    case 'error': return { tone: 'error', word: t('lore.state.error'), detail: c.message }
    case 'dns': case 'refused': case 'timeout': case 'notLore':
      return { tone: 'error', word: t('lore.state.unreachable'), detail: c.message }
  }
  if (c.auth === 'signedOut') return { tone: 'warn', word: t('lore.state.signInNeeded'), detail: null }
  const parts = [
    c.auth === 'signedIn' && c.user ? t('lore.state.signedInAs', { user: c.user }) : null,
    c.auth === 'notRequired' ? t('lore.state.noSignIn') : null,
    c.repositories ? t('lore.state.repos', { n: c.repositories.length }) : null,
    c.dataChecked ? null : t('lore.state.dataUnchecked'),
  ].filter(Boolean)
  return { tone: 'ok', word: t('lore.state.ready'), detail: parts.join(' · ') || null }
})
const canSignIn = computed(() => props.cliInstalled && check.value?.auth === 'signedOut')
const canSignOut = computed(() => props.cliInstalled && check.value?.auth === 'signedIn')

const root = ref<HTMLElement | null>(null)
const actionError = ref<string | null>(null)

async function recheck() {
  actionError.value = null
  await lore.check(props.server.url)
}

/* ---------- edit, remove ---------- */

const editing = ref(false)
const saving = ref(false)
const saveError = ref<string | null>(null)
const removing = ref(false)

async function startEdit() {
  saveError.value = null
  editing.value = true
}

async function save(name: string, url: string) {
  saving.value = true
  saveError.value = null
  try {
    const saved = await lore.upsert({ id: props.server.id, name, url, insideUrl: props.server.insideUrl, origin: props.server.origin, machine: props.server.machine })
    editing.value = false
    if (saved) void lore.check(saved.url)
  } catch (e) {
    saveError.value = e instanceof Error ? e.message : String(e)
  } finally {
    saving.value = false
  }
}

async function remove() {
  if (removing.value) return
  removing.value = true
  actionError.value = null
  try {
    await lore.remove(props.server.id)
  } catch (e) {
    actionError.value = t('lore.servers.removeFailed', { name: props.server.name, message: e instanceof Error ? e.message : String(e) })
    removing.value = false
  }
}

/* ---------- sign in, sign out ---------- */

interface Job { phase: 'running' | 'checking' | 'failed'; note: string; attempt: number }
const job = ref<Job | null>(null)
let attempts = 0
const termFocused = ref(false)
const link = ref<string | null>(null)
const jobEl = ref<HTMLElement | null>(null)
const startLogin = (cols: number, rows: number) => call('lore_login', { url: props.server.url, cols, rows })

function signIn() {
  actionError.value = null
  link.value = null
  job.value = { phase: 'running', note: '', attempt: ++attempts }
  nextTick(() => jobEl.value?.scrollIntoView({ block: 'nearest' }))
}

async function onExit(code: number | null) {
  const j = job.value
  if (!j || j.phase !== 'running') return
  j.phase = 'checking'
  const now = await lore.check(props.server.url)
  if (job.value !== j) return
  if (now?.auth === 'signedIn' || now?.auth === 'notRequired') {
    await closeJob()
    return
  }
  j.note = code === 0 || code === null ? t('lore.servers.loginClosed', { name: props.server.name }) : t('lore.servers.loginExited', { code })
  j.phase = 'failed'
}

function onFailed(message: string) {
  if (!job.value) return
  job.value.note = t('agents.cli.cantStart', { message: message.replace(/\.$/, '') })
  job.value.phase = 'failed'
}

async function closeJob() {
  const wasRunning = job.value?.phase === 'running'
  job.value = null
  termFocused.value = false
  await nextTick()
  root.value?.querySelector<HTMLElement>('[data-land]')?.focus()
  if (wasRunning) void lore.check(props.server.url)
}

/* ---------- a server Mango set up on a machine over SSH ---------- */

const machine = computed(() => props.server.machine ?? null)
const machineHostName = computed(() => (machine.value ? machineHost(machine.value.ssh) : ''))
const runsAs = computed(() => {
  const m = machine.value
  if (!m) return ''
  return m.runtime === 'docker' ? t('lore.machine.inDocker') : m.runtime === 'service' ? t('lore.machine.asService') : ''
})

/** Update, restart or remove it, in a terminal in the row (ssh and sudo ask there). */
interface MachineJob { action: LoreMachineAction; phase: 'running' | 'done' | 'failed'; note: string; attempt: number }
const mjob = ref<MachineJob | null>(null)
const mjobEl = ref<HTMLElement | null>(null)
const mjobFocused = ref(false)
/** Removing asks first: the server goes away for everyone using it. */
const confirmRemove = ref(false)
const startMachine = (cols: number, rows: number) =>
  call('lore_machine_run', { machine: machine.value!, action: mjob.value!.action, cols, rows })

function runMachine(action: LoreMachineAction) {
  if (!machine.value || mjob.value?.phase === 'running') return
  confirmRemove.value = false
  actionError.value = null
  mjob.value = { action, phase: 'running', note: '', attempt: ++attempts }
  nextTick(() => mjobEl.value?.scrollIntoView({ block: 'nearest' }))
}

async function onMachineExit(code: number | null) {
  const j = mjob.value
  if (!j || j.phase !== 'running') return
  if (code !== 0) {
    j.note = code === null ? t('lore.machine.jobStopped') : t('lore.machine.jobExited', { code })
    j.phase = 'failed'
    return
  }
  j.phase = 'done'
  // Removed: the entry goes when its output (where the data stayed) is closed.
  if (j.action !== 'remove') void lore.check(props.server.url)
}

function onMachineFailed(message: string) {
  if (!mjob.value) return
  mjob.value.note = t('agents.cli.cantStart', { message: message.replace(/\.$/, '') })
  mjob.value.phase = 'failed'
}

async function closeMachineJob() {
  const j = mjob.value
  mjob.value = null
  mjobFocused.value = false
  if (j?.action === 'remove' && j.phase === 'done') {
    // It is gone from the machine: nothing is left to point at.
    try {
      await lore.remove(props.server.id)
    } catch (e) {
      actionError.value = t('lore.servers.removeFailed', { name: props.server.name, message: e instanceof Error ? e.message : String(e) })
    }
    return
  }
  if (j?.phase === 'running') void lore.check(props.server.url)
}

const machineTitle = computed(() => {
  const j = mjob.value
  if (!j) return ''
  const host = machineHostName.value
  if (j.phase === 'failed') return t(`lore.machine.jobFailed.${j.action}`, { host })
  if (j.phase === 'done') return t(`lore.machine.jobDone.${j.action}`, { host })
  return t(`lore.machine.jobRunning.${j.action}`, { host })
})

const moreItems = computed<MenuItem[]>(() => [
  { label: t('lore.machine.change'), icon: Settings2, onSelect: () => { lore.machineDialog = { server: props.server } } },
  { label: t('lore.machine.update'), icon: Download, disabled: mjob.value?.phase === 'running', onSelect: () => runMachine('setup') },
  { label: t('lore.machine.restart'), icon: RotateCw, disabled: mjob.value?.phase === 'running', onSelect: () => runMachine('restart') },
  {
    label: t('lore.machine.remove'),
    icon: Trash2,
    danger: true,
    divider: true,
    disabled: mjob.value?.phase === 'running',
    onSelect: () => { confirmRemove.value = true; mjob.value = null },
  },
])

const signingOut = ref(false)
async function signOut() {
  if (signingOut.value) return
  signingOut.value = true
  actionError.value = null
  try {
    await call('lore_logout', { url: props.server.url })
    await lore.check(props.server.url)
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e)
    actionError.value = t('lore.servers.signOutFailed', { name: props.server.name, why: why.replace(/\.$/, '') })
  } finally {
    signingOut.value = false
  }
}

onMounted(() => { if (!state.value) void lore.check(props.server.url) })
</script>

<template>
  <li ref="root" class="srv" :class="`srv--${status.tone}`">
    <SettingsLoreForm
      v-if="editing"
      class="srv__form"
      :server="server"
      :list="lore.servers ?? []"
      :saving="saving"
      :error="saveError"
      @edit="saveError = null"
      @save="save"
      @cancel="editing = false"
    />
    <template v-else>
      <div class="srv__head">
        <span class="srv__lead" aria-hidden="true"><Server class="srv__mark" /></span>
        <h4 class="srv__name">{{ server.name }}</h4>
        <code class="srv__url selectable" :title="server.url">{{ server.url }}</code>
        <span v-if="place" class="srv__origin" :title="server.insideUrl ? t('lore.servers.insideUrl', { url: server.insideUrl }) : undefined">{{ t('lore.servers.setUpIn', { place: place.label }) }}</span>
        <span v-else-if="machine" class="srv__origin" :title="machine.ssh">{{ t('lore.machine.on', { host: machineHostName }) }}<template v-if="runsAs"> · {{ runsAs }}</template></span>
        <span class="srv__grow" />
        <span class="srv__actions">
          <UiButton v-if="canSignIn" size="sm" :disabled="!!job && job.phase !== 'failed'" data-land @click="signIn">{{ t('lore.servers.signIn') }}</UiButton>
          <UiButton v-if="canSignOut" size="sm" variant="ghost" :loading="signingOut" @click="signOut">{{ t('common.actions.signOut') }}</UiButton>
          <UiIconButton size="sm" :label="t('lore.servers.check', { name: server.name })" :disabled="checking" @click="recheck">
            <RefreshCw :class="{ 'is-turning': checking }" />
          </UiIconButton>
          <UiIconButton size="sm" :label="t('lore.servers.edit', { name: server.name })" @click="startEdit"><Pencil /></UiIconButton>
          <UiMenu v-if="machine" :items="moreItems" placement="bottom-end" :width="220" :label="t('lore.machine.actions', { name: server.name })">
            <template #default="{ toggle, open }">
              <UiIconButton size="sm" :label="t('lore.machine.actions', { name: server.name })" :active="open" aria-haspopup="menu" :aria-expanded="open" @click="toggle">
                <Ellipsis />
              </UiIconButton>
            </template>
          </UiMenu>
          <UiIconButton size="sm" :label="t('lore.servers.remove', { name: server.name })" :disabled="removing" @click="remove"><X /></UiIconButton>
        </span>
      </div>

      <p class="srv__state" role="status">
        <span class="srv__lead" aria-hidden="true">
          <span v-if="status.tone === 'checking'" class="ring" />
          <CircleCheck v-else-if="status.tone === 'ok'" class="srv__icon srv__icon--ok" />
          <CircleAlert v-else-if="status.tone === 'warn'" class="srv__icon srv__icon--warn" />
          <CircleDashed v-else-if="status.tone === 'idle'" class="srv__icon srv__icon--idle" />
          <TriangleAlert v-else class="srv__icon srv__icon--error" />
        </span>
        <span class="srv__word">{{ status.word }}</span>
        <span v-if="status.detail" class="srv__detail selectable">{{ status.detail }}</span>
      </p>
    </template>

    <p v-if="actionError" class="srv__error selectable" role="alert">{{ actionError }}</p>

    <div v-if="confirmRemove && machine" class="srv__confirm" role="group" :aria-label="t('lore.machine.remove')">
      <p class="srv__confirm-text">{{ t('lore.machine.removeConfirm', { host: machineHostName }) }}</p>
      <span class="srv__confirm-actions">
        <UiButton size="sm" variant="ghost" @click="confirmRemove = false">{{ t('common.actions.cancel') }}</UiButton>
        <UiButton size="sm" variant="danger" @click="runMachine('remove')">{{ t('lore.machine.removeAction') }}</UiButton>
      </span>
    </div>

    <section
      v-if="mjob"
      ref="mjobEl"
      class="job"
      :class="[`job--${mjob.phase}`, { 'is-focused': mjobFocused }]"
      :aria-label="t('lore.machine.terminal', { host: machineHostName })"
    >
      <header class="job__head">
        <span class="job__status" role="status">
          <TriangleAlert v-if="mjob.phase === 'failed'" class="job__warn" aria-hidden="true" />
          <CircleCheck v-else-if="mjob.phase === 'done'" class="job__ok" aria-hidden="true" />
          <span v-else class="ring ring--work" aria-hidden="true" />
          <span class="job__title">{{ machineTitle }}</span>
        </span>
        <span class="job__actions">
          <UiButton v-if="mjob.phase === 'failed'" size="sm" @click="runMachine(mjob.action)">{{ t('common.actions.retry') }}</UiButton>
          <UiButton size="sm" variant="ghost" @click="closeMachineJob">{{ mjob.phase === 'running' ? t('envs.common.stop') : t('common.actions.close') }}</UiButton>
        </span>
      </header>
      <p v-if="mjob.phase === 'failed'" class="job__note selectable" role="alert">{{ mjob.note }} {{ t('agents.cli.outputKept') }}</p>
      <div class="job__term" @focusin="mjobFocused = true" @focusout="mjobFocused = false">
        <LoginTerminal
          :key="mjob.attempt"
          :start="startMachine"
          :label="t('lore.machine.terminal', { host: machineHostName })"
          :rows="12"
          @exit="onMachineExit"
          @failed="onMachineFailed"
        />
      </div>
      <p v-if="mjob.phase === 'running'" class="job__hint">{{ machine?.password ? t('lore.machine.runHintPassword') : t('lore.machine.runHint') }}</p>
      <p v-else-if="mjob.phase === 'done' && mjob.action === 'remove'" class="job__hint">{{ t('lore.machine.removedHint') }}</p>
    </section>

    <section
      v-if="job"
      ref="jobEl"
      class="job"
      :class="[`job--${job.phase}`, { 'is-focused': termFocused }]"
      :aria-label="t('lore.servers.signInTerminal', { name: server.name })"
    >
      <header class="job__head">
        <span class="job__status" role="status">
          <TriangleAlert v-if="job.phase === 'failed'" class="job__warn" aria-hidden="true" />
          <span v-else class="ring" :class="{ 'ring--work': job.phase === 'running' }" aria-hidden="true" />
          <span class="job__title">{{ job.phase === 'checking' ? t('lore.servers.checkingSignIn') : job.phase === 'failed' ? t('lore.servers.signInUnfinished') : t('lore.servers.signingIn', { name: server.name }) }}</span>
        </span>
        <span v-if="job.phase !== 'checking'" class="job__actions">
          <UiButton v-if="job.phase === 'running' && link" variant="ghost" size="sm" :title="link" @click="openExternal(link)">{{ t('agents.hosting.openPage') }}</UiButton>
          <UiButton v-if="job.phase === 'failed'" size="sm" @click="signIn">{{ t('common.actions.retry') }}</UiButton>
          <UiButton size="sm" variant="ghost" @click="closeJob">{{ job.phase === 'running' ? t('common.actions.cancel') : t('common.actions.close') }}</UiButton>
        </span>
      </header>
      <p v-if="job.phase === 'failed'" class="job__note selectable" role="alert">{{ job.note }} {{ t('agents.cli.outputKept') }}</p>
      <div class="job__term" @focusin="termFocused = true" @focusout="termFocused = false">
        <LoginTerminal
          :key="job.attempt"
          :start="startLogin"
          :label="t('lore.servers.signInTerminal', { name: server.name })"
          :rows="12"
          @exit="onExit"
          @failed="onFailed"
          @link="link = $event"
        />
      </div>
      <p v-if="job.phase === 'running'" class="job__hint">{{ t('lore.servers.loginHint') }}</p>
    </section>
  </li>
</template>

<style scoped>
.srv {
  padding: var(--space-2) 0;
  border-bottom: 1px solid var(--line-soft);
}
.srv__form { padding: var(--space-1) 0; }
.srv__lead {
  flex: none;
  display: inline-grid;
  place-items: center;
  width: 14px;
  height: 14px;
}
.srv__head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-height: 28px;
  min-width: 0;
}
.srv__mark { width: 14px; height: 14px; stroke-width: 1.75; color: var(--fg-subtle); }
.srv__name {
  margin: 0;
  flex: none;
  max-width: 30%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--text-sm);
  font-weight: 600;
  color: var(--fg);
}
.srv__url {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--text-xs);
  color: var(--fg-subtle);
}
.srv__origin {
  flex: none;
  font-size: var(--text-xs);
  color: var(--fg-subtle);
  white-space: nowrap;
}
.srv__grow { flex: 1; }
.srv__actions { flex: none; display: inline-flex; align-items: center; gap: var(--space-1); }
.is-turning { animation: srv-turn 0.8s linear infinite; }
@keyframes srv-turn { to { transform: rotate(360deg); } }

.srv__state {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
  min-height: 24px;
  margin: 0;
  min-width: 0;
  font-size: var(--text-sm);
}
.srv__state .srv__lead { align-self: flex-start; height: 20px; }
.srv__icon { width: 14px; height: 14px; stroke-width: 1.85; }
.srv__icon--ok { color: var(--ripe-queued); }
.srv__icon--warn { color: var(--ripe-waiting); }
.srv__icon--error { color: var(--ripe-error); }
.srv__icon--idle { color: var(--ripe-idle); }
.srv__word { flex: none; font-weight: 560; color: var(--fg-muted); }
.srv--ok .srv__word { color: var(--ripe-queued-fg); }
.srv--warn .srv__word { color: var(--ripe-waiting-fg); }
.srv--error .srv__word { color: var(--ripe-error-fg); }
.srv__detail {
  min-width: 0;
  font-size: var(--text-xs);
  color: var(--fg-muted);
  text-wrap: pretty;
}
.srv__error {
  margin: var(--space-1) 0 0 22px;
  font-size: var(--text-xs);
  color: var(--ripe-error-fg);
  text-wrap: pretty;
}

/* ---- removing it from its machine: asked first, in the row ---- */
.srv__confirm {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  margin: var(--space-2) 0 var(--space-1) 22px;
  padding: var(--space-2) var(--space-2) var(--space-2) var(--space-3);
  background: var(--bg-raised);
  border: 1px solid color-mix(in oklch, var(--ripe-error) 35%, var(--line));
  border-radius: var(--radius-md);
}
.srv__confirm-text { margin: 0; min-width: 0; font-size: var(--text-xs); color: var(--fg); text-wrap: pretty; }
.srv__confirm-actions { flex: none; display: inline-flex; gap: var(--space-1); }

/* ---- the sign-in, running in the row (as Settings > Git hosting) ---- */
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
.job__ok { flex: none; width: 14px; height: 14px; stroke-width: 1.85; color: var(--ripe-queued); }
.job--done, .job--done.is-focused { box-shadow: none; }
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
  animation: srv-turn 0.7s linear infinite;
}
.ring--work { border-color: var(--ripe-running); border-right-color: transparent; }
</style>
