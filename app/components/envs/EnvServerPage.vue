<script setup lang="ts">
import { ChevronRight, CircleCheck, Pencil, Plus, RefreshCw, Server, TriangleAlert } from 'lucide-vue-next'
import { hostState, instanceKey, sshUser, useEnvironments } from '~/stores/environments'
import type { EnvInstance } from '~/types/ipc'
import EnvStatus from './EnvStatus.vue'
import EnvTerminal from './EnvTerminal.vue'

/**
 * One master server: can Mango reach it, what runs there, the state of Incus
 * (installing, initialising or updating it in a terminal here), and its instances.
 * Kept alive per server by the section, so a setup in progress survives a look elsewhere.
 */
const props = defineProps<{ hostId: string }>()

const { t } = useI18n()
const envs = useEnvironments()
const host = computed(() => envs.host(props.hostId))
const probe = computed(() => envs.probes[props.hostId] ?? null)
const probing = computed(() => !!envs.probing[props.hostId])
const state = computed(() => hostState(probe.value, probing.value))
const instances = computed(() => envs.instances[props.hostId] ?? null)
const loading = computed(() => !!envs.loadingInstances[props.hostId])
const listError = computed(() => envs.errors[props.hostId] ?? null)
const ready = computed(() => probe.value?.ok === true)
const reachable = computed(() => probe.value?.reachable === true)

const refresh = () => envs.refreshHost(props.hostId)

/* ---------- remove (two steps) ---------- */

const confirming = ref(false)
const removing = ref(false)
const removeError = ref<string | null>(null)

async function remove() {
  removing.value = true
  removeError.value = null
  try {
    await envs.removeHost(props.hostId)
  } catch (e) {
    removeError.value = (e instanceof Error ? e.message : String(e)).replace(/\.$/, '')
    removing.value = false
    confirming.value = false
  }
}

/* ---------- Incus: install, initialise, give access, update ---------- */

type SetupMode = 'install' | 'init' | 'access' | 'update'
const mode = computed<SetupMode | null>(() => {
  const p = probe.value
  if (!p?.reachable) return null
  switch (p.incus) {
    case 'missing': return 'install'
    case 'uninitialised': return 'init'
    case 'no-access': return 'access'
    case 'ready': return 'update'
    default: return null
  }
})
/** Incus needs work before instances can exist; the page leads with it. */
const needsSetup = computed(() => !!mode.value && mode.value !== 'update')

/** The SSH login that gets access, when the destination names one (an ssh_config alias doesn't). */
const user = computed(() => (host.value ? sshUser(host.value.ssh) : null))

/** What the setup and its terminal say; giving access reads like setting up. */
function copy(m: SetupMode, what: 'action' | 'running' | 'done' | 'failed') {
  return t(`envs.server.setup.${m === 'access' ? 'init' : m}.${what}`)
}

interface Job { id: number; mode: SetupMode }
const job = ref<Job | null>(null)
const jobRunning = ref(false)
const jobEl = ref<HTMLElement | null>(null)
let jobSeq = 0

async function setup() {
  if (!mode.value || jobRunning.value) return
  job.value = { id: ++jobSeq, mode: mode.value }
  jobRunning.value = true
  await nextTick()
  jobEl.value?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
}
const startSetup = (cols: number, rows: number) => envs.setupServer(props.hostId, cols, rows)

function onJobExit(code: number | null) {
  jobRunning.value = false
  if (code === 0) refresh()
}
function closeJob() {
  job.value = null
  jobRunning.value = false
}

/* ---------- led here after adding a server that needs Incus ---------- */

const setupButton = ref<HTMLElement | null>(null)

function takeIntent() {
  if (envs.intents[props.hostId] !== 'setup-incus' || !probe.value || probing.value) return
  delete envs.intents[props.hostId]
  if (!needsSetup.value || !probe.value.canSetup) return
  nextTick(() => {
    const b = setupButton.value?.querySelector<HTMLElement>('button')
    b?.scrollIntoView({ block: 'nearest' })
    b?.focus()
  })
}
watch([probe, probing], takeIntent)
onMounted(takeIntent)
onActivated(takeIntent)

/* ---------- presentation ---------- */

const sshLine = computed(() => {
  const h = host.value
  if (!h) return ''
  return h.port ? `${h.ssh}:${h.port}` : h.ssh
})

/** What to try in a terminal, with the same port and key Mango uses. */
const sshCommand = computed(() => {
  const h = host.value
  if (!h) return 'ssh'
  const key = h.identityFile ? ` -i ${/\s/.test(h.identityFile) ? `"${h.identityFile}"` : h.identityFile}` : ''
  return `ssh${h.port ? ` -p ${h.port}` : ''}${key} ${h.ssh}`
})

const addresses = (i: EnvInstance) => [i.tailscaleIp, ...i.ipv4].filter(Boolean).join(', ')
const size = (i: EnvInstance) => {
  const parts = []
  if (i.cpus) parts.push(t('envs.server.cpuCount', i.cpus))
  if (i.memory) parts.push(i.memory.replace(/([0-9])([A-Za-z])/, '$1 $2'))
  return parts.join(' · ')
}
const kindLabel = (i: EnvInstance) => (i.kind === 'vm' ? t('envs.common.vmShort') : t('envs.common.container'))
</script>

<template>
  <div v-if="host" class="sp">
    <header class="sp__head">
      <div class="sp__title-row">
        <h2 class="sp__title" data-page-title tabindex="-1">{{ host.name }}</h2>
        <span class="sp__actions">
          <UiIconButton :label="t('envs.common.checkAgain')" :disabled="probing || loading" @click="refresh">
            <RefreshCw :class="{ 'is-turning': probing || loading }" />
          </UiIconButton>
          <UiButton variant="ghost" size="sm" @click="envs.dialog = { kind: 'host', id: host.id }"><Pencil />{{ t('common.actions.edit') }}</UiButton>
          <UiButton v-if="!confirming" variant="ghost" size="sm" @click="confirming = true">{{ t('envs.server.remove') }}</UiButton>
        </span>
      </div>
      <p class="sp__meta">
        <span class="sp__mono selectable" :title="sshLine">{{ sshLine }}</span>
        <template v-if="host.incusRemote"><span aria-hidden="true">·</span><i18n-t keypath="envs.server.remote" tag="span" scope="global"><template #name><span class="sp__mono">{{ host.incusRemote }}</span></template></i18n-t></template>
        <template v-if="host.identityFile"><span aria-hidden="true">·</span><i18n-t keypath="envs.server.key" tag="span" scope="global" class="sp__clip" :title="host.identityFile"><template #path><span class="sp__mono">{{ host.identityFile }}</span></template></i18n-t></template>
      </p>

      <div v-if="confirming" class="sp__confirm" role="group" :aria-label="t('envs.server.confirmLabel')">
        <span>{{ t('envs.server.confirm', { name: host.name }) }}</span>
        <span class="sp__confirm-actions">
          <UiButton variant="ghost" size="sm" :disabled="removing" @click="confirming = false">{{ t('common.actions.cancel') }}</UiButton>
          <UiButton variant="danger" size="sm" :loading="removing" data-autofocus @click="remove">{{ t('envs.server.removeServer') }}</UiButton>
        </span>
      </div>
      <p v-if="removeError" class="sp__error" role="alert">{{ removeError }}.</p>
    </header>

    <!-- reachability, system, Incus -->
    <div class="sp__state">
      <span class="sp__state-main" role="status">
        <template v-if="state.tone === 'checking'">
          <span class="ring" aria-hidden="true" />
          <span class="sp__word">{{ t('envs.server.connecting') }}</span>
        </template>
        <template v-else-if="state.tone === 'unknown'">
          <span class="sp__word">{{ t('envs.server.notChecked') }}</span>
        </template>
        <template v-else-if="!reachable">
          <TriangleAlert class="sp__icon sp__icon--bad" aria-hidden="true" />
          <span class="sp__word sp__word--bad">{{ t('envs.state.cantReach') }}</span>
        </template>
        <template v-else>
          <CircleCheck class="sp__icon sp__icon--ok" aria-hidden="true" />
          <span class="sp__word sp__word--ok">{{ t('envs.server.reachable') }}</span>
          <template v-if="probe?.os"><span class="sp__dot" aria-hidden="true">·</span><span class="sp__more">{{ probe.os }}</span></template>
          <span class="sp__dot" aria-hidden="true">·</span>
          <span class="sp__more" :class="{ 'sp__more--setup': needsSetup }">{{ state.label }}</span>
        </template>
      </span>
      <UiButton
        v-if="mode === 'update' && probe?.canSetup"
        variant="ghost"
        size="sm"
        :disabled="jobRunning"
        :title="jobRunning ? t('envs.server.runningBelow') : t('envs.server.updateTitle')"
        @click="setup"
      >
        {{ copy('update', 'action') }}
      </UiButton>
    </div>

    <dl class="sp__facts">
      <div class="sp__fact">
        <dt>Tailscale</dt>
        <i18n-t v-if="host.tailscale?.authKeyFile" keypath="envs.server.joinsKey" tag="dd" scope="global">
          <template #tags><span class="sp__mono">{{ host.tailscale.tags.join(' ') || t('envs.server.untagged') }}</span></template>
          <template #file><span class="sp__mono selectable">{{ host.tailscale.authKeyFile }}</span></template>
        </i18n-t>
        <i18n-t v-else-if="host.tailscale" keypath="envs.server.joinsLink" tag="dd" scope="global">
          <template #tags><span class="sp__mono">{{ host.tailscale.tags.join(' ') || t('envs.server.untagged') }}</span></template>
        </i18n-t>
        <dd v-else class="sp__off">{{ t('envs.server.off') }}</dd>
      </div>
      <div class="sp__fact">
        <dt>{{ t('envs.common.publicAddress') }}</dt>
        <i18n-t v-if="host.publicAddress" keypath="envs.server.publicFor" tag="dd" scope="global">
          <template #address><span class="sp__mono selectable">{{ host.publicAddress }}</span></template>
        </i18n-t>
        <dd v-else class="sp__off">{{ t('envs.server.publicDefault') }}</dd>
      </div>
    </dl>
    <div v-if="probe && !probe.reachable" class="sp__problem">
      <p class="sp__problem-text selectable">{{ probe.error ?? t('envs.common.noAnswer') }}</p>
      <i18n-t keypath="envs.server.checkSsh" tag="p" class="sp__problem-help" scope="global">
        <template #command><code class="selectable">{{ sshCommand }}</code></template>
      </i18n-t>
      <UiButton size="sm" :loading="probing" @click="refresh">{{ t('envs.common.checkAgain') }}</UiButton>
    </div>

    <!-- Incus needs work: what Mango will do, and the one action -->
    <section v-if="needsSetup && probe" class="setup" aria-labelledby="sp-setup">
      <template v-if="probe.canSetup">
        <h3 id="sp-setup" class="setup__title">
          {{ mode === 'install' ? t('envs.server.titleInstall') : mode === 'init' ? t('envs.server.titleInit') : t('envs.server.titleAccess') }}
        </h3>
        <p class="setup__text">
          <template v-if="mode === 'install'">
            {{ t('envs.server.textInstall') }}
          </template>
          <template v-else-if="mode === 'init'">
            {{ t('envs.server.textInit') }}
          </template>
          <i18n-t v-else-if="user" keypath="envs.server.textAccessUser" scope="global">
            <template #user><code>{{ user }}</code></template>
          </i18n-t>
          <template v-else>{{ t('envs.server.textAccess') }}</template>
        </p>
        <ul class="setup__steps">
          <li v-if="mode === 'install'">{{ t('envs.server.stepInstall') }}</li>
          <li v-if="mode !== 'access'">{{ t('envs.server.stepInit') }}</li>
          <i18n-t v-if="user" keypath="envs.server.stepGroupUser" tag="li" scope="global">
            <template #user><code>{{ user }}</code></template>
            <template #group><code>incus-admin</code></template>
          </i18n-t>
          <i18n-t v-else keypath="envs.server.stepGroup" tag="li" scope="global">
            <template #group><code>incus-admin</code></template>
          </i18n-t>
        </ul>
        <div class="setup__actions">
          <span ref="setupButton">
            <UiButton variant="primary" :disabled="jobRunning" @click="setup">{{ copy(mode!, 'action') }}</UiButton>
          </span>
          <span v-if="jobRunning" class="setup__note">{{ t('envs.server.runningBelowNote') }}</span>
          <i18n-t v-else keypath="envs.server.sudoNote" tag="span" class="setup__note" scope="global">
            <template #sudo><code>sudo</code></template>
          </i18n-t>
        </div>
      </template>
      <template v-else>
        <h3 id="sp-setup" class="setup__title">{{ state.label }}</h3>
        <p class="setup__text selectable">{{ probe.setupNote ?? t('envs.server.cantSetUp') }}</p>
        <i18n-t v-if="user" keypath="envs.server.yourselfUser" tag="p" class="setup__text setup__text--quiet" scope="global">
          <template #command><code>incus admin init</code></template>
          <template #user><code>{{ user }}</code></template>
          <template #group><code>incus-admin</code></template>
        </i18n-t>
        <i18n-t v-else keypath="envs.server.yourself" tag="p" class="setup__text setup__text--quiet" scope="global">
          <template #command><code>incus admin init</code></template>
          <template #group><code>incus-admin</code></template>
        </i18n-t>
        <div class="setup__actions">
          <UiButton size="sm" :loading="probing" @click="refresh">{{ t('envs.common.checkAgain') }}</UiButton>
        </div>
      </template>
    </section>

    <div v-if="job" ref="jobEl" class="sp__job">
      <EnvTerminal
        :key="job.id"
        :start="startSetup"
        :title="copy(job.mode, 'running')"
        :done-title="copy(job.mode, 'done')"
        :failed-title="copy(job.mode, 'failed')"
        :label="t('envs.server.jobLabel', { action: copy(job.mode, 'action'), name: host.name })"
        :rows="14"
        @exit="onJobExit"
        @close="closeJob"
      >
        <template #hint>
          <i18n-t keypath="envs.server.passwordHint" scope="global">
            <template #sudo><code>sudo</code></template>
            <template #enter><kbd>Enter</kbd></template>
          </i18n-t>
        </template>
      </EnvTerminal>
    </div>


    <!-- instances: only once Incus is ready -->
    <section v-if="ready || (probing && !probe)" class="sp__list" aria-labelledby="sp-instances">
      <header class="sp__list-head">
        <h3 id="sp-instances" class="sp__h3">
          {{ t('envs.common.title') }}
          <span v-if="instances?.length" class="sp__count tabular">{{ instances.length }}</span>
        </h3>
        <span v-if="ready" class="sp__list-actions">
          <UiButton size="sm" :title="t('envs.lore.newServerTitle')" @click="envs.dialog = { kind: 'create', hostId, preset: 'lore-server' }">
            <Server />{{ t('envs.lore.newServer') }}
          </UiButton>
          <UiButton variant="primary" size="sm" @click="envs.dialog = { kind: 'create', hostId }">
            <Plus />{{ t('envs.common.newEnvironment') }}
          </UiButton>
        </span>
      </header>

      <p v-if="listError" class="sp__error" role="alert">
        {{ t('envs.server.listFailed') }} <span class="selectable">{{ listError }}</span>
      </p>

      <ul v-if="instances?.length" class="rows">
        <li v-for="i in instances" :key="i.name">
          <button type="button" class="row" :data-row="instanceKey(hostId, i.name)" @click="envs.select(hostId, i.name)">
            <span class="row__name-col">
              <span class="row__name">{{ i.name }}</span>
              <span class="row__image" :title="i.image ?? undefined">{{ kindLabel(i) }}<template v-if="i.image"> · {{ i.image }}</template></span>
            </span>
            <EnvStatus class="row__status" :status="i.status" :busy="envs.busy[instanceKey(hostId, i.name)]" word />
            <span class="row__addr selectable" :title="addresses(i)">{{ addresses(i) || '–' }}</span>
            <span class="row__size tabular" :class="{ 'is-default': !size(i) }">{{ size(i) || t('envs.server.defaultSize') }}</span>
            <ChevronRight class="row__go" aria-hidden="true" />
          </button>
        </li>
      </ul>
      <ul v-else-if="loading || (probing && !probe)" class="rows" aria-busy="true" :aria-label="t('envs.server.loading')">
        <li v-for="n in 3" :key="n" class="row row--skeleton" aria-hidden="true">
          <span class="bone bone--name" /><span class="bone bone--status" /><span class="bone bone--addr" />
        </li>
      </ul>
      <p v-else-if="instances" class="sp__empty">
        {{ t('envs.server.none') }}
      </p>
    </section>
    <p v-else-if="reachable && !needsSetup" class="sp__empty">{{ t('envs.server.notReady') }}</p>
  </div>
</template>

<style scoped>
.sp { display: grid; gap: var(--space-5); }

.sp__head { display: grid; gap: var(--space-1); }
.sp__title-row { display: flex; align-items: center; gap: var(--space-3); min-width: 0; }
.sp__title {
  flex: 1;
  min-width: 0;
  margin: 0;
  font-size: var(--text-xl);
  font-weight: 620;
  letter-spacing: -0.015em;
  line-height: var(--leading-tight);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sp__title:focus { outline: none; }
.sp__actions { flex: none; display: inline-flex; align-items: center; gap: var(--space-1); }
.sp__meta {
  display: flex;
  align-items: baseline;
  gap: 6px;
  min-width: 0;
  margin: 0;
  font-size: var(--text-xs);
  color: var(--fg-subtle);
  white-space: nowrap;
}
.sp__mono { font-family: var(--font-mono); font-size: var(--text-2xs); color: var(--fg-muted); }
.sp__meta > .sp__mono { overflow: hidden; text-overflow: ellipsis; }
.sp__clip { min-width: 0; overflow: hidden; text-overflow: ellipsis; }

.sp__confirm {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  margin-top: var(--space-2);
  padding: var(--space-2) var(--space-2) var(--space-2) var(--space-3);
  font-size: var(--text-sm);
  color: var(--fg);
  background: color-mix(in oklch, var(--ripe-error) 8%, transparent);
  border: 1px solid color-mix(in oklch, var(--ripe-error) 35%, transparent);
  border-radius: var(--radius-md);
}
.sp__confirm-actions { flex: none; display: inline-flex; gap: var(--space-1); }
.sp__error { margin: 0; font-size: var(--text-xs); color: var(--ripe-error-fg); text-wrap: pretty; }

/* ---- reachability, system, Incus ---- */
.sp__state {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  min-height: 28px;
  font-size: var(--text-sm);
  border-top: 1px solid var(--line-soft);
  padding-top: var(--space-4);
}
.sp__state-main { display: flex; align-items: center; gap: var(--space-2); min-width: 0; white-space: nowrap; }
.sp__icon { flex: none; width: 14px; height: 14px; stroke-width: 1.85; }
.sp__icon--ok { color: var(--ripe-queued); }
.sp__icon--bad { color: var(--ripe-error); }
.sp__word { flex: none; font-weight: 560; color: var(--fg-muted); }
.sp__word--ok { color: var(--ripe-queued-fg); }
.sp__word--bad { color: var(--ripe-error-fg); }
.sp__dot { color: var(--fg-faint); }
.sp__more { min-width: 0; color: var(--fg-subtle); overflow: hidden; text-overflow: ellipsis; }
.sp__more--setup { flex: none; font-weight: 560; color: var(--ripe-waiting-fg); }
.sp__problem {
  display: grid;
  justify-items: start;
  gap: var(--space-2);
  margin-top: calc(var(--space-3) * -1);
  padding-left: 22px;
}
.sp__problem-text {
  margin: 0;
  max-width: 70ch;
  font-size: var(--text-sm);
  color: var(--fg);
  text-wrap: pretty;
}
.sp__problem-help { margin: 0; max-width: 70ch; font-size: var(--text-xs); color: var(--fg-subtle); text-wrap: pretty; }
.sp__problem-help code { font-size: var(--text-2xs); color: var(--fg-muted); }

/* ---- Incus setup: the page's one task while Incus isn't ready ---- */
.setup {
  display: grid;
  justify-items: start;
  gap: var(--space-2);
  padding: var(--space-4);
  background: var(--bg-panel);
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
}
.setup__title { margin: 0; font-size: var(--text-lg); font-weight: 620; letter-spacing: -0.01em; }
.setup__text { margin: 0; max-width: 70ch; font-size: var(--text-sm); color: var(--fg-muted); text-wrap: pretty; }
.setup__text--quiet { color: var(--fg-subtle); }
.setup__steps {
  display: grid;
  gap: 2px;
  margin: 0;
  padding-left: var(--space-5);
  font-size: var(--text-sm);
  color: var(--fg-muted);
}
.setup__steps li::marker { color: var(--fg-faint); }
.setup code { font-size: var(--text-2xs); color: var(--fg); }
.setup__actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2) var(--space-3);
  margin-top: var(--space-2);
}
.setup__note { font-size: var(--text-xs); color: var(--fg-subtle); }
.sp__job { scroll-margin: var(--space-4); }
.sp__job :deep(.job__hint code) { font-size: var(--text-2xs); color: var(--fg-muted); }

.sp__facts { margin: calc(var(--space-2) * -1) 0 0; display: grid; gap: var(--space-1); }
.sp__fact { display: grid; grid-template-columns: 96px 1fr; gap: var(--space-3); font-size: var(--text-sm); }
.sp__fact dt { color: var(--fg-subtle); }
.sp__fact dd { margin: 0; min-width: 0; color: var(--fg-muted); }
.sp__off { color: var(--fg-subtle); }

/* ---- instances ---- */
.sp__list { display: grid; gap: var(--space-2); margin-top: var(--space-3); }
.sp__list-head { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); }
.sp__list-actions { display: inline-flex; align-items: center; gap: var(--space-1); }
.sp__h3 {
  display: inline-flex;
  align-items: baseline;
  gap: var(--space-2);
  margin: 0;
  font-size: var(--text-lg);
  font-weight: 620;
  letter-spacing: -0.01em;
}
.sp__count { font-size: var(--text-xs); font-weight: 500; color: var(--fg-faint); }
.sp__empty { margin: 0; padding: var(--space-3) 0; font-size: var(--text-sm); color: var(--fg-subtle); text-wrap: pretty; }

.rows { display: grid; gap: 1px; margin: 0 calc(var(--space-3) * -1); padding: 0; list-style: none; }
.row {
  display: grid;
  grid-template-columns: minmax(0, 1.5fr) 92px minmax(0, 1fr) 112px 14px;
  align-items: center;
  gap: var(--space-4);
  width: 100%;
  min-height: 44px;
  padding: 6px var(--space-3);
  text-align: left;
  border-radius: var(--radius-sm);
  transition: background var(--dur-fast) var(--ease-out);
}
button.row:hover { background: var(--bg-hover); }
button.row:active { background: var(--bg-active); }
button.row:focus-visible { outline: none; background: var(--bg-hover); box-shadow: inset 0 0 0 1.5px var(--focus-ring); }
.row__name-col { display: grid; min-width: 0; }
.row__name { font-size: var(--text-md); font-weight: 560; color: var(--fg); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.row__image { font-size: var(--text-xs); color: var(--fg-subtle); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.row__addr {
  min-width: 0;
  font-family: var(--font-mono);
  font-size: var(--text-2xs);
  color: var(--fg-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.row__size { font-size: var(--text-xs); color: var(--fg-subtle); white-space: nowrap; text-align: right; }
.row__size.is-default { color: var(--fg-faint); }
.row__go { width: 14px; height: 14px; stroke-width: 1.85; color: var(--fg-faint); transition: color var(--dur-fast) var(--ease-out); }
button.row:hover .row__go { color: var(--fg-subtle); }

.bone { height: 10px; border-radius: var(--radius-xs); background: var(--bg-hover); }
.bone--name { width: 60%; height: 12px; }
.bone--status { width: 64px; }
.bone--addr { width: 80%; }

.ring {
  flex: none;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  border: 1.75px solid var(--fg-subtle);
  border-right-color: transparent;
  animation: sp-turn 0.7s linear infinite;
}
.is-turning { animation: sp-turn 0.8s linear infinite; }
@keyframes sp-turn { to { transform: rotate(360deg); } }
</style>
