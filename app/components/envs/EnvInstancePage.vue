<script setup lang="ts">
import {
  CircleCheck, CircleDashed, Ellipsis, FolderGit2, MonitorPlay, Play, RefreshCw, RotateCw, Square, SquareTerminal, Trash2,
} from 'lucide-vue-next'
import { instanceKey, useEnvironments } from '~/stores/environments'
import type { EnvComponent, EnvComponentId, EnvInstanceAction, EnvLoginTool } from '~/types/ipc'
import type { MenuItem } from '~/types/ui'
import EnvStatus from './EnvStatus.vue'
import EnvTerminal from './EnvTerminal.vue'
import EnvDesktop from './EnvDesktop.vue'
import EnvDeleteDialog from './EnvDeleteDialog.vue'
import EnvProjectDialog from './EnvProjectDialog.vue'

/**
 * One instance: its state and power actions, ways into it (project, shell,
 * desktop), sign-ins for the CLIs inside it, and its components. Jobs
 * (installers, sign-ins, a shell) run in a terminal on this page; Settings >
 * Environments keeps the page alive while another one shows, so a job keeps running.
 */
const props = defineProps<{ hostId: string; name: string }>()

const envs = useEnvironments()
const key = computed(() => instanceKey(props.hostId, props.name))
const inst = computed(() => envs.instance(props.hostId, props.name))
const host = computed(() => envs.host(props.hostId))
const busy = computed(() => envs.busy[key.value] ?? null)
/** Remembered, so the delete dialog can still name it once it is gone from the list. */
const kind = ref(inst.value?.kind ?? 'container')
watch(inst, (i) => { if (i) kind.value = i.kind })
const running = computed(() => inst.value?.status === 'running' && !busy.value)
const stopped = computed(() => !!inst.value && ['stopped', 'frozen', 'error', 'unknown'].includes(inst.value.status))

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/\.$/, '')

/* ---------- power ---------- */

const actionError = ref<string | null>(null)

async function act(action: EnvInstanceAction) {
  actionError.value = null
  try {
    await envs.act(props.hostId, props.name, action)
  } catch (e) {
    const verb = { start: 'start', stop: 'stop', restart: 'restart', delete: 'delete' }[action]
    actionError.value = `Couldn't ${verb} it. ${errorText(e)}.`
  }
}

const deleting = ref(false)
const moreItems = computed<MenuItem[]>(() => [
  { label: 'Restart', icon: RotateCw, disabled: !running.value, onSelect: () => act('restart') },
  { label: 'Delete…', icon: Trash2, danger: true, divider: true, disabled: !!busy.value, onSelect: () => { deleting.value = true } },
])

function onDeleted() {
  deleting.value = false
  envs.select(props.hostId)
}

/* ---------- components ---------- */

const components = computed(() => envs.components[key.value] ?? null)
const loadingComponents = computed(() => !!envs.loadingComponents[key.value])
const componentError = computed(() => envs.componentErrors[key.value] ?? null)
const installed = (id: EnvComponentId) => components.value?.find(c => c.id === id)?.installed ?? null

function loadComponents(force = false) {
  if (!running.value) return
  if (force || (!components.value && !loadingComponents.value)) envs.refreshComponents(props.hostId, props.name)
}
watch(running, (r) => { if (r) loadComponents() })

const installedOnes = computed(() => (components.value ?? []).filter(c => c.installed))

/* ---------- jobs: one terminal at a time ---------- */

interface Job {
  id: number
  title: string
  doneTitle: string
  failedTitle: string
  label: string
  start: (cols: number, rows: number) => Promise<string>
  signIn?: boolean
  shell?: boolean
  rows: number
  after?: (code: number | null) => void
}

const job = ref<Job | null>(null)
const jobRunning = ref(false)
const jobEl = ref<HTMLElement | null>(null)
let jobSeq = 0

async function run(j: Omit<Job, 'id'>) {
  job.value = { ...j, id: ++jobSeq }
  jobRunning.value = true
  await nextTick()
  jobEl.value?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
}

function onJobExit(code: number | null) {
  jobRunning.value = false
  job.value?.after?.(code)
}
function closeJob() {
  job.value = null
  jobRunning.value = false
}

const busyTitle = computed(() => (jobRunning.value ? 'Finish or stop the job below first' : undefined))

function install(list: EnvComponent[]) {
  if (!list.length) return
  const names = list.length === 1 ? list[0]!.name : list.length === installedOnes.value.length && list.every(c => c.installed) ? 'everything' : `${list.length} components`
  const updating = list.every(c => c.installed)
  run({
    title: `${updating ? 'Updating' : 'Installing'} ${names}…`,
    doneTitle: `${updating ? 'Updated' : 'Installed'} ${names}`,
    failedTitle: `${updating ? 'Updating' : 'Installing'} didn't finish`,
    label: `${updating ? 'Updating' : 'Installing'} ${names} in ${props.name}`,
    start: (cols, rows) => envs.install(props.hostId, props.name, list.map(c => c.id), cols, rows),
    rows: 12,
    after: () => loadComponents(true),
  })
}

const LOGINS: Array<{ tool: EnvLoginTool; name: string; agent?: 'claude' | 'codex' }> = [
  { tool: 'claude', name: 'Claude Code', agent: 'claude' },
  { tool: 'codex', name: 'Codex', agent: 'codex' },
  { tool: 'gh', name: 'GitHub CLI' },
  { tool: 'tailscale', name: 'Tailscale' },
]

function login(tool: EnvLoginTool, name: string) {
  run({
    title: `Signing in to ${name}…`,
    doneTitle: `Signed in to ${name}`,
    failedTitle: 'Sign-in didn\'t finish',
    label: `${name} sign-in in ${props.name}`,
    start: (cols, rows) => envs.login(props.hostId, props.name, tool, cols, rows),
    signIn: true,
    rows: 12,
    after: code => { if (code === 0 && tool === 'tailscale') envs.refreshInstances(props.hostId) },
  })
}

function shell() {
  run({
    title: `Shell in ${props.name}`,
    doneTitle: 'Shell closed',
    failedTitle: 'The shell didn\'t start',
    label: `Shell in ${props.name}`,
    start: (cols, rows) => envs.shell(props.hostId, props.name, null, cols, rows),
    shell: true,
    rows: 18,
  })
}

/* ---------- desktop, project ---------- */

const desktopShown = ref(!!envs.desktops[key.value])
const desktopInstalled = computed(() => installed('desktop'))
const projectOpen = ref(false)

/* ---------- next steps handed over (e.g. from the create dialog) ---------- */

function takeIntent() {
  const intent = envs.intents[key.value]
  if (!intent || !inst.value) return
  delete envs.intents[key.value]
  if (intent === 'login-claude') login('claude', 'Claude Code')
  else if (intent === 'open-project') projectOpen.value = true
}

watch(inst, (i) => { if (i) takeIntent() })
onMounted(() => { loadComponents(); takeIntent() })
onActivated(() => { loadComponents(); takeIntent() })

/* ---------- presentation ---------- */

const created = computed(() => {
  const ms = inst.value?.createdAt
  if (!ms) return null
  return new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
})
const memory = computed(() => inst.value?.memory?.replace(/([0-9])([A-Za-z])/, '$1 $2') ?? null)
</script>

<template>
  <div class="ip">
    <template v-if="inst">
      <header class="ip__head">
        <div class="ip__title-row">
          <h2 class="ip__title" data-page-title tabindex="-1">{{ name }}</h2>
          <EnvStatus :status="inst.status" :busy="busy" word />
          <span class="ip__actions">
            <UiButton
              v-if="stopped"
              variant="primary"
              size="sm"
              :loading="busy === 'start'"
              :disabled="!!busy"
              @click="act('start')"
            >
              <Play />Start
            </UiButton>
            <UiButton v-else size="sm" :loading="busy === 'stop'" :disabled="!!busy || inst.status !== 'running'" @click="act('stop')">
              <Square />Stop
            </UiButton>
            <UiMenu :items="moreItems" placement="bottom-end" :width="200" label="More actions">
              <template #default="{ toggle, open }">
                <UiIconButton label="More actions" :active="open" aria-haspopup="menu" :aria-expanded="open" @click="toggle">
                  <Ellipsis />
                </UiIconButton>
              </template>
            </UiMenu>
          </span>
        </div>
        <p class="ip__meta">
          <span>{{ inst.kind === 'vm' ? 'Virtual machine' : 'Container' }} on</span>
          <button type="button" class="ip__link" @click="envs.select(hostId)">{{ host?.name ?? 'its server' }}</button>
          <template v-if="inst.image"><span aria-hidden="true">·</span><span class="ip__clip" :title="inst.image">{{ inst.image }}</span></template>
        </p>
        <p v-if="actionError" class="ip__error selectable" role="alert">{{ actionError }}</p>
      </header>

      <dl class="ip__facts">
        <div class="ip__fact">
          <dt>Addresses</dt>
          <dd class="ip__mono selectable">{{ inst.ipv4.join(', ') || '–' }}</dd>
        </div>
        <div class="ip__fact">
          <dt>Tailscale</dt>
          <dd v-if="inst.tailscaleIp" class="ip__mono selectable">{{ inst.tailscaleIp }}</dd>
          <dd v-else class="ip__off">{{ host?.tailscale ? 'Not on the tailnet yet' : 'Off for this server' }}</dd>
        </div>
        <div class="ip__fact">
          <dt>CPUs</dt>
          <dd class="tabular">{{ inst.cpus ?? 'Server default' }}</dd>
        </div>
        <div class="ip__fact">
          <dt>Memory</dt>
          <dd class="tabular">{{ memory ?? 'Server default' }}</dd>
        </div>
        <div v-if="created" class="ip__fact">
          <dt>Created</dt>
          <dd class="tabular">{{ created }}</dd>
        </div>
      </dl>

      <!-- ways in -->
      <div class="ip__work">
        <UiButton :variant="stopped ? 'secondary' : 'primary'" :disabled="!running" @click="projectOpen = true">
          <FolderGit2 />Open project…
        </UiButton>
        <UiButton :disabled="!running || jobRunning" :title="busyTitle" @click="shell"><SquareTerminal />Shell</UiButton>
        <UiButton
          :disabled="!running || desktopInstalled === false"
          :title="desktopInstalled === false ? 'Install the Desktop component first' : undefined"
          @click="desktopShown = true"
        >
          <MonitorPlay />Desktop
        </UiButton>
        <span v-if="stopped" class="ip__work-hint">Start it to open a project, a shell or its desktop.</span>
      </div>

      <div v-if="job" ref="jobEl" class="ip__job">
        <EnvTerminal
          :key="job.id"
          :start="job.start"
          :title="job.title"
          :done-title="job.doneTitle"
          :failed-title="job.failedTitle"
          :label="job.label"
          :rows="job.rows"
          :sign-in="job.signIn"
          :shell="job.shell"
          @exit="onJobExit"
          @close="closeJob"
        />
      </div>

      <EnvDesktop v-if="desktopShown && running" :host-id="hostId" :instance="name" @close="desktopShown = false" />

      <!-- sign in -->
      <section class="ip__sec" aria-labelledby="ip-signin">
        <h3 id="ip-signin" class="ip__h3">Sign in</h3>
        <p v-if="running" class="ip__desc">Each tool runs its own sign-in inside {{ name }}, in a terminal here. Mango never sees your credentials.</p>
        <p v-else class="ip__desc">Start the environment to sign in to its tools.</p>
        <div class="ip__logins">
          <UiButton
            v-for="l in LOGINS"
            :key="l.tool"
            size="sm"
            :disabled="!running || jobRunning || installed(l.tool) === false"
            :title="installed(l.tool) === false ? `Install ${l.name} first` : busyTitle"
            @click="login(l.tool, l.name)"
          >
            <UiAgentIcon v-if="l.agent" :agent="l.agent" class="ip__agent" />{{ l.name }}
          </UiButton>
        </div>
      </section>

      <!-- components -->
      <section class="ip__sec" aria-labelledby="ip-comps">
        <header class="ip__sec-head">
          <h3 id="ip-comps" class="ip__h3">Components</h3>
          <span class="ip__sec-actions">
            <UiIconButton label="Check again" size="sm" :disabled="!running || loadingComponents" @click="loadComponents(true)">
              <RefreshCw :class="{ 'is-turning': loadingComponents }" />
            </UiIconButton>
            <UiButton
              variant="ghost"
              size="sm"
              :disabled="!running || jobRunning || !installedOnes.length"
              :title="busyTitle"
              @click="install(installedOnes)"
            >
              Update all
            </UiButton>
          </span>
        </header>

        <p v-if="!running && !components" class="ip__desc">Start the environment to see what is installed.</p>
        <p v-else-if="componentError" class="ip__error" role="alert">
          Couldn't check the components. <span class="selectable">{{ componentError }}</span>
        </p>

        <ul v-if="components" class="comps">
          <li v-for="c in components" :key="c.id" class="comp">
            <span class="comp__lead" aria-hidden="true">
              <CircleCheck v-if="c.installed" class="comp__icon comp__icon--ok" />
              <CircleDashed v-else class="comp__icon" />
            </span>
            <span class="comp__text">
              <span class="comp__line">
                <span class="comp__name">{{ c.name }}</span>
                <span v-if="c.installed && c.version" class="comp__version selectable">{{ c.version }}</span>
                <span v-if="!c.installed" class="comp__state">Not installed</span>
              </span>
              <span class="comp__desc">{{ c.description }}</span>
            </span>
            <UiButton
              :variant="c.installed ? 'ghost' : 'secondary'"
              size="sm"
              :disabled="!running || jobRunning"
              :title="busyTitle"
              @click="install([c])"
            >
              {{ c.installed ? 'Update' : 'Install' }}
            </UiButton>
          </li>
        </ul>
        <ul v-else-if="loadingComponents" class="comps" aria-busy="true" aria-label="Checking components">
          <li v-for="n in 4" :key="n" class="comp comp--skeleton" aria-hidden="true">
            <span class="bone bone--icon" /><span class="bone bone--text" />
          </li>
        </ul>
      </section>
    </template>

    <div v-else class="ip__missing">
      <h2 class="ip__title" data-page-title tabindex="-1">{{ name }}</h2>
      <p class="ip__desc">
        <template v-if="envs.loadingInstances[hostId]">Looking for it on the server…</template>
        <template v-else>It isn't on {{ host?.name ?? 'the server' }} any more, or the server can't be reached.</template>
      </p>
      <UiButton size="sm" @click="envs.select(hostId)">Back to {{ host?.name ?? 'the server' }}</UiButton>
    </div>

    <!-- Not gated on `inst`: the list refreshes (and drops it) before the dialog reports back. -->
    <EnvDeleteDialog
      :open="deleting"
      :host-id="hostId"
      :name="name"
      :kind="kind"
      @close="deleting = false"
      @deleted="onDeleted"
    />
    <EnvProjectDialog :open="projectOpen" :host-id="hostId" :instance="name" @close="projectOpen = false" />
  </div>
</template>

<style scoped>
.ip { display: grid; gap: var(--space-5); }

.ip__head { display: grid; gap: var(--space-1); }
.ip__title-row { display: flex; align-items: center; gap: var(--space-3); min-width: 0; }
.ip__title {
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
.ip__title:focus { outline: none; }
.ip__actions { flex: none; display: inline-flex; align-items: center; gap: var(--space-1); margin-left: auto; }
.ip__meta {
  display: flex;
  align-items: baseline;
  gap: 6px;
  min-width: 0;
  margin: 0;
  font-size: var(--text-xs);
  color: var(--fg-subtle);
  white-space: nowrap;
}
.ip__link {
  flex: none;
  color: var(--accent-ink);
  font-weight: 560;
  border-radius: var(--radius-xs);
  text-decoration: underline;
  text-decoration-color: transparent;
  text-underline-offset: 2px;
  transition: text-decoration-color var(--dur-fast) var(--ease-out);
}
.ip__link:hover { text-decoration-color: currentColor; }
.ip__clip { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.ip__error { margin: 0; font-size: var(--text-xs); color: var(--ripe-error-fg); text-wrap: pretty; }

.ip__facts {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: var(--space-3) var(--space-5);
  margin: 0;
  padding: var(--space-4) 0;
  border-top: 1px solid var(--line-soft);
  border-bottom: 1px solid var(--line-soft);
}
.ip__fact { display: grid; gap: 2px; min-width: 0; }
.ip__fact dt { font-size: var(--text-xs); color: var(--fg-subtle); }
.ip__fact dd { margin: 0; min-width: 0; font-size: var(--text-sm); color: var(--fg); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ip__fact dd.ip__mono { font-family: var(--font-mono); font-size: var(--text-xs); }
.ip__fact dd.ip__off { color: var(--fg-subtle); }

.ip__work { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2); }
.ip__work-hint { font-size: var(--text-xs); color: var(--fg-subtle); }
.ip__job { scroll-margin: var(--space-4); }

/* ---- sections ---- */
.ip__sec { display: grid; gap: var(--space-2); margin-top: var(--space-3); }
.ip__sec-head { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); }
.ip__sec-actions { display: inline-flex; align-items: center; gap: var(--space-1); }
.ip__h3 { margin: 0; font-size: var(--text-lg); font-weight: 620; letter-spacing: -0.01em; }
.ip__desc { margin: 0; max-width: 70ch; font-size: var(--text-sm); color: var(--fg-subtle); text-wrap: pretty; }
.ip__logins { display: flex; flex-wrap: wrap; gap: var(--space-2); margin-top: var(--space-1); }
.ip__agent { width: 13px; height: 13px; }

/* ---- components ---- */
.comps { display: grid; margin: 0; padding: 0; list-style: none; }
.comp {
  display: grid;
  grid-template-columns: 14px 1fr auto;
  align-items: center;
  gap: var(--space-3);
  min-height: 48px;
  padding: var(--space-2) 0;
  border-top: 1px solid var(--line-soft);
}
.comp:last-child { border-bottom: 1px solid var(--line-soft); }
.comp__lead { display: grid; place-items: center; align-self: start; height: 20px; }
.comp__icon { width: 14px; height: 14px; stroke-width: 1.85; color: var(--ripe-idle); }
.comp__icon--ok { color: var(--ripe-queued); }
.comp__text { display: grid; min-width: 0; }
.comp__line { display: flex; align-items: baseline; gap: var(--space-2); min-width: 0; }
.comp__name { flex: none; font-size: var(--text-md); font-weight: 600; color: var(--fg); }
.comp__version { min-width: 0; font-size: var(--text-xs); color: var(--fg-subtle); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.comp__state { font-size: var(--text-xs); font-weight: 560; color: var(--fg-subtle); }
.comp__desc { font-size: var(--text-xs); color: var(--fg-subtle); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.comp--skeleton { grid-template-columns: 14px 1fr; }
.bone { height: 10px; border-radius: var(--radius-xs); background: var(--bg-hover); }
.bone--icon { width: 14px; height: 14px; border-radius: 50%; }
.bone--text { width: 40%; height: 12px; }

.ip__missing { display: grid; justify-items: start; gap: var(--space-3); }

.is-turning { animation: ip-turn 0.8s linear infinite; }
@keyframes ip-turn { to { transform: rotate(360deg); } }
</style>
