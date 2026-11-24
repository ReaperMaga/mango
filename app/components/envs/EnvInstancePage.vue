<script setup lang="ts">
import {
  ChevronDown, CircleCheck, CircleDashed, Ellipsis, FolderGit2, Gauge, Info, Link2, MonitorPlay, Pencil, Play, RefreshCw, RotateCw, Share2, Square,
  SquareTerminal, Trash2, TriangleAlert, X,
} from 'lucide-vue-next'
import { directProblem, directState, instanceKey, shareDay, useEnvironments } from '~/stores/environments'
import type { EnvComponent, EnvComponentId, EnvInstanceAction, EnvLoginTool, EnvVersions } from '~/types/ipc'
import type { MenuItem } from '~/types/ui'
import { useNow } from '~/utils/time'
import EnvStatus from './EnvStatus.vue'
import EnvTerminal from './EnvTerminal.vue'
import EnvDesktop from './EnvDesktop.vue'
import EnvDeleteDialog from './EnvDeleteDialog.vue'
import EnvProjectDialog from './EnvProjectDialog.vue'
import EnvSharing from './EnvSharing.vue'
import EnvShareDialog from './EnvShareDialog.vue'
import EnvRenameDialog from './EnvRenameDialog.vue'
import EnvResizeDialog from './EnvResizeDialog.vue'
import EnvVersionPicker from './EnvVersionPicker.vue'
import EnvGitlabServer from './EnvGitlabServer.vue'
import { GITLAB_COM } from '~/utils/gitHosts'

/**
 * One instance: its state and power actions, ways into it (project, shell,
 * desktop), sign-ins for the CLIs inside it, its components, and who it is
 * shared with. Jobs (installers, sign-ins, a shell) run in a terminal on this
 * page; Settings > Environments keeps the page alive while another one shows,
 * so a job keeps running.
 *
 * An environment joined from someone's link (a direct host) is the same page
 * without what only its owner can do: no power actions, no sharing, no server.
 * It can be renamed (here only, as its owner named it) and left instead. The owner
 * can rename and resize theirs (Incus renames only stopped instances: a running
 * one is stopped and started again).
 */
const props = defineProps<{ hostId: string; name: string }>()

const envs = useEnvironments()
const now = useNow()
const key = computed(() => instanceKey(props.hostId, props.name))
const inst = computed(() => envs.instance(props.hostId, props.name))
const host = computed(() => envs.host(props.hostId))
/** Joined from a share link: the owner's environment, reached straight. */
const direct = computed(() => host.value?.direct ?? null)
const probe = computed(() => envs.probes[props.hostId] ?? null)
const probing = computed(() => !!envs.probing[props.hostId])
const problem = computed(() => (host.value && direct.value ? directProblem(host.value, probe.value, now.value) : null))
const joinedState = computed(() => (host.value && direct.value ? directState(host.value, probe.value, probing.value) : null))
const busy = computed(() => envs.busy[key.value] ?? null)
/** Remembered, so the delete dialog can still name it once it is gone from the list. */
const kind = ref(inst.value?.kind ?? 'container')
watch(inst, (i) => { if (i) kind.value = i.kind })
const running = computed(() => inst.value?.status === 'running' && !busy.value && !problem.value)
/** Stopped, and the user may start it (never for a joined environment: that is its owner's call). */
const stopped = computed(() => !direct.value && !!inst.value && ['stopped', 'frozen', 'error', 'unknown'].includes(inst.value.status))

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
const sharing = ref(false)
const renaming = ref(false)
const resizing = ref(false)
const moreItems = computed<MenuItem[]>(() => [
  { label: 'Restart', icon: RotateCw, disabled: !running.value, onSelect: () => act('restart') },
  { label: 'Share…', icon: Share2, disabled: !running.value, onSelect: () => { sharing.value = true } },
  { label: 'Rename…', icon: Pencil, divider: true, disabled: !!busy.value, onSelect: () => { renaming.value = true } },
  { label: 'Resize…', icon: Gauge, disabled: !!busy.value, onSelect: () => { resizing.value = true } },
  { label: 'Delete…', icon: Trash2, danger: true, divider: true, disabled: !!busy.value, onSelect: () => { deleting.value = true } },
])

/* ---------- rename, resize: what to tell afterwards stays with the instance ---------- */

const note = computed(() => envs.notes[key.value] ?? null)
const dismissNote = () => { delete envs.notes[key.value] }

function onRenamed(newName: string, text: string | null) {
  renaming.value = false
  const to = instanceKey(props.hostId, newName)
  if (text) envs.notes[to] = text
  else delete envs.notes[to]
  // Its page is keyed by name: show the renamed one, unless the user went elsewhere meanwhile.
  const sel = envs.selected
  if (sel?.hostId === props.hostId && sel.instance === props.name) envs.select(props.hostId, newName)
}

function onResized(text: string | null) {
  resizing.value = false
  if (text) envs.notes[key.value] = text
  else dismissNote()
}

function onDeleted() {
  deleting.value = false
  envs.select(props.hostId)
}

/* ---------- a joined environment: check, rename, leave (two steps) ---------- */

const reconnect = () => envs.refreshHost(props.hostId)

const leaving = ref(false)
const leaveBusy = ref(false)
const leaveError = ref<string | null>(null)

async function leave() {
  leaveBusy.value = true
  leaveError.value = null
  try {
    await envs.closeDesktop(props.hostId, props.name)
    await envs.leave(props.hostId)
  } catch (e) {
    leaveError.value = (e instanceof Error ? e.message : String(e)).replace(/\.$/, '')
    leaveBusy.value = false
    leaving.value = false
  }
}

/** Where it connects to, as `host:port`. */
const endpoint = computed(() => {
  const h = host.value
  if (!h) return ''
  const at = h.ssh.lastIndexOf('@')
  return `${at >= 0 ? h.ssh.slice(at + 1) : h.ssh}${h.port ? `:${h.port}` : ''}`
})
const accessEnds = computed(() => {
  const at = direct.value?.expiresAt
  return at ? shareDay(at, now.value) : null
})

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
  /** One line under the terminal while it runs. */
  hint?: string
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

function install(list: EnvComponent[], versions?: EnvVersions) {
  if (!list.length) return
  const one = list.length === 1 ? list[0]! : null
  const picked = one ? versions?.[one.id] : undefined
  const names = one ? (picked ? `${one.name} ${picked}` : one.name) : list.length === installedOnes.value.length && list.every(c => c.installed) ? 'everything' : `${list.length} components`
  // A picked version other than the installed one replaces it (Node.js) or becomes the default (Java).
  const switching = !!(one?.installed && picked && picked !== one.version)
  const updating = !switching && list.every(c => c.installed)
  const [doing, done] = switching ? ['Switching', 'Switched'] : updating ? ['Updating', 'Updated'] : ['Installing', 'Installed']
  const what = switching ? `${one!.name} to ${picked}` : names
  run({
    title: `${doing} ${what}…`,
    doneTitle: `${done} ${what}`,
    failedTitle: `${doing} didn't finish`,
    label: `${doing} ${what} in ${props.name}`,
    start: (cols, rows) => envs.install(props.hostId, props.name, list.map(c => c.id), cols, rows, versions),
    rows: 12,
    after: () => loadComponents(true),
  })
}

const LOGINS: Array<{ tool: EnvLoginTool; name: string; agent?: 'claude' | 'codex' }> = [
  { tool: 'claude', name: 'Claude Code', agent: 'claude' },
  { tool: 'codex', name: 'Codex', agent: 'codex' },
  { tool: 'gh', name: 'GitHub CLI' },
  { tool: 'glab', name: 'GitLab CLI' },
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

/**
 * The GitLab CLI signs in to one server at a time: gitlab.com (a device code and a page, like
 * GitHub), or a self-managed one, where glab asks in the terminal (a token works on any version).
 */
function loginGitlab(server: string) {
  otherServer.value = false
  const selfManaged = server !== GITLAB_COM
  run({
    title: `Signing in to ${server}…`,
    doneTitle: `Signed in to ${server}`,
    failedTitle: 'Sign-in didn\'t finish',
    label: `GitLab CLI sign-in to ${server} in ${props.name}`,
    start: (cols, rows) => envs.login(props.hostId, props.name, 'glab', cols, rows, server),
    signIn: !selfManaged,
    hint: selfManaged
      ? `Choose Token, then paste a personal access token from ${server} with the api and write_repository scopes. glab prints where to make one.`
      : undefined,
    rows: 12,
    after: (code) => { if (code === 0 && selfManaged) void envs.loadGitlabHosts() },
  })
}

/** "Another server…": a GitLab server typed in place under the sign-in buttons. */
const otherServer = ref(false)
const gitlabItems = computed<MenuItem[]>(() => [
  { label: GITLAB_COM, onSelect: () => loginGitlab(GITLAB_COM) },
  ...(envs.gitlabHosts ?? []).map(h => ({ label: h, onSelect: () => loginGitlab(h) })),
  { label: 'Another server…', divider: true, onSelect: () => { otherServer.value = true } },
])
function openGitlabMenu(toggle: () => void) {
  void envs.loadGitlabHosts()
  toggle()
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
  else if (intent === 'login-gh') login('gh', 'GitHub CLI')
  else if (intent.startsWith('login-glab:')) loginGitlab(intent.slice('login-glab:'.length) || GITLAB_COM)
  else if (intent === 'open-project') projectOpen.value = true
  else if (intent === 'open-desktop') desktopShown.value = true
}

watch(inst, (i) => { if (i) takeIntent() })
onMounted(() => { loadComponents(); takeIntent(); void envs.loadGitlabHosts() })
onActivated(() => { loadComponents(); takeIntent() })

/* ---------- presentation ---------- */

const created = computed(() => {
  const ms = inst.value?.createdAt
  if (!ms) return null
  return new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
})
const memory = computed(() => inst.value?.memory?.replace(/([0-9])([A-Za-z])/, '$1 $2') ?? null)
const disk = computed(() => inst.value?.disk?.replace(/([0-9])([A-Za-z])/, '$1 $2') ?? null)
</script>

<template>
  <div class="ip">
    <template v-if="inst">
    <template v-if="direct && host">
      <!-- joined from a link: the owner's environment -->
      <header class="ip__head">
        <div class="ip__title-row">
          <h2 class="ip__title" data-page-title tabindex="-1">{{ host.name }}</h2>
          <span v-if="joinedState" class="ip__state" :class="`ip__state--${joinedState.tone}`" role="status">
            <span v-if="joinedState.tone === 'checking'" class="ring" aria-hidden="true" />
            <TriangleAlert v-else-if="joinedState.tone === 'bad'" class="ip__state-warn" aria-hidden="true" />
            <span v-else class="ip__state-mark" aria-hidden="true" />
            {{ joinedState.label }}
          </span>
          <span class="ip__actions">
            <UiIconButton label="Check again" :disabled="probing" @click="reconnect">
              <RefreshCw :class="{ 'is-turning': probing }" />
            </UiIconButton>
            <UiButton variant="ghost" size="sm" @click="envs.dialog = { kind: 'host', id: hostId }"><Pencil />Rename</UiButton>
            <UiButton v-if="!leaving" variant="ghost" size="sm" @click="leaving = true">Leave</UiButton>
          </span>
        </div>
        <p class="ip__meta">
          <span>Shared with you from</span>
          <span class="ip__mono selectable">{{ direct.sharedFrom }}</span>
          <template v-if="host.name !== name"><span aria-hidden="true">·</span><span class="ip__keep">its name there is {{ name }}</span></template>
          <template v-if="inst.image"><span aria-hidden="true">·</span><span class="ip__clip" :title="inst.image">{{ inst.image }}</span></template>
        </p>

        <div v-if="leaving" class="ip__confirm" role="group" aria-label="Confirm leaving the environment">
          <span>Leave {{ host.name }}? This removes it from Mango and deletes its key here; the owner can still revoke it.</span>
          <span class="ip__confirm-actions">
            <UiButton variant="ghost" size="sm" :disabled="leaveBusy" @click="leaving = false">Cancel</UiButton>
            <UiButton variant="danger" size="sm" :loading="leaveBusy" @click="leave">Leave</UiButton>
          </span>
        </div>
        <p v-if="leaveError" class="ip__error selectable" role="alert">Couldn't leave it. {{ leaveError }}.</p>
      </header>

      <!-- can't use it: why, and what to do, calmly -->
      <div v-if="problem" class="ip__problem" role="status">
        <p class="ip__problem-title">
          <template v-if="problem === 'expired'">Your access ended on {{ accessEnds }}</template>
          <template v-else-if="problem === 'host-key'">{{ name }} doesn't look like the environment you joined</template>
          <template v-else-if="problem === 'refused'">{{ name }} no longer accepts your key</template>
          <template v-else>Can't reach {{ name }} right now</template>
        </p>
        <p class="ip__problem-text">
          <template v-if="problem === 'expired'">
            The link it came from gave access until then. Ask whoever shared it for a new link, and join with that one; it
            replaces this.
          </template>
          <template v-else-if="problem === 'host-key'">
            Its identity changed since you joined, which happens when it is rebuilt, so Mango won't connect in case it is
            something else. If the owner rebuilt it, ask them for a new link.
          </template>
          <template v-else-if="problem === 'refused'">
            The owner may have revoked your access. Ask them for a new link if you still need it.
          </template>
          <template v-else>
            It may be stopped, or its server offline<template v-if="direct && /^100\./.test(endpoint)">, or this computer not on the
            owner's tailnet</template>. Check again in a moment, or ask its owner.
          </template>
        </p>
        <p v-if="probe?.error && problem !== 'expired'" class="ip__problem-raw selectable">{{ probe.error }}</p>
        <div class="ip__problem-actions">
          <UiButton v-if="problem === 'unreachable'" size="sm" :loading="probing" @click="reconnect">Check again</UiButton>
          <UiButton v-else size="sm" @click="envs.openJoin()"><Link2 />Join with a new link…</UiButton>
        </div>
      </div>

      <dl class="ip__facts">
        <div class="ip__fact">
          <dt>Connects to</dt>
          <dd class="ip__mono selectable" :title="endpoint">{{ endpoint }}</dd>
        </div>
        <div class="ip__fact">
          <dt>Access ends</dt>
          <dd v-if="accessEnds" class="tabular" :class="{ 'ip__ended': problem === 'expired' }">{{ accessEnds }}</dd>
          <dd v-else class="ip__off">When the owner revokes it</dd>
        </div>
        <div v-if="inst.ipv4.length || inst.tailscaleIp" class="ip__fact ip__fact--wide">
          <dt>Addresses inside</dt>
          <dd class="ip__mono selectable">{{ [inst.tailscaleIp, ...inst.ipv4].filter(Boolean).join(', ') }}</dd>
        </div>
      </dl>
    </template>

    <template v-else>
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
        <p v-if="note" class="ip__note" role="status">
          <Info class="ip__note-icon" aria-hidden="true" />
          <span class="selectable">{{ note }}</span>
          <UiIconButton label="Dismiss" size="sm" @click="dismissNote"><X /></UiIconButton>
        </p>
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
        <div class="ip__fact">
          <dt>Disk</dt>
          <dd class="tabular">{{ disk ?? 'Pool default' }}</dd>
        </div>
        <div v-if="created" class="ip__fact">
          <dt>Created</dt>
          <dd class="tabular">{{ created }}</dd>
        </div>
      </dl>
    </template>

      <!-- ways in -->
      <div class="ip__work">
        <UiButton :variant="stopped || (direct && !running) ? 'secondary' : 'primary'" :disabled="!running" @click="projectOpen = true">
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
        >
          <template v-if="job.hint" #hint>{{ job.hint }}</template>
        </EnvTerminal>
      </div>

      <EnvDesktop v-if="desktopShown && running" :host-id="hostId" :instance="name" @close="desktopShown = false" />

      <!-- sign in -->
      <section class="ip__sec" aria-labelledby="ip-signin">
        <h3 id="ip-signin" class="ip__h3">Sign in</h3>
        <p v-if="running" class="ip__desc">Each tool runs its own sign-in inside {{ name }}, in a terminal here. Mango never sees your credentials.</p>
        <p v-else class="ip__desc">{{ direct ? 'Once Mango can reach it, sign in to its tools here.' : 'Start the environment to sign in to its tools.' }}</p>
        <div class="ip__logins">
          <template v-for="l in LOGINS" :key="l.tool">
            <UiMenu v-if="l.tool === 'glab'" :items="gitlabItems" :width="240" label="GitLab server">
              <template #default="{ toggle, open }">
                <UiButton
                  size="sm"
                  :disabled="!running || jobRunning || installed(l.tool) === false"
                  :title="installed(l.tool) === false ? `Install ${l.name} first` : busyTitle"
                  :aria-expanded="open"
                  aria-haspopup="menu"
                  @click="openGitlabMenu(toggle)"
                >
                  {{ l.name }}<ChevronDown class="ip__more" />
                </UiButton>
              </template>
            </UiMenu>
            <UiButton
              v-else
              size="sm"
              :disabled="!running || jobRunning || installed(l.tool) === false"
              :title="installed(l.tool) === false ? `Install ${l.name} first` : busyTitle"
              @click="login(l.tool, l.name)"
            >
              <UiAgentIcon v-if="l.agent" :agent="l.agent" class="ip__agent" />{{ l.name }}
            </UiButton>
          </template>
        </div>
        <EnvGitlabServer
          v-if="otherServer && running && !jobRunning"
          class="ip__server"
          @pick="loginGitlab"
          @cancel="otherServer = false"
        />
      </section>

      <!-- who else may use it (only its owner shares it) -->
      <EnvSharing v-if="!direct" :host-id="hostId" :instance="name" :running="running" @share="sharing = true" />

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

        <!-- A joined environment that can't be reached: what was installed may no longer be true, so don't show it as current. -->
        <p v-if="!running && (!components || problem)" class="ip__desc">
          {{ direct ? 'Once Mango can reach it, what is installed shows here.' : 'Start the environment to see what is installed.' }}
        </p>
        <p v-else-if="componentError" class="ip__error" role="alert">
          Couldn't check the components. <span class="selectable">{{ componentError }}</span>
        </p>

        <ul v-if="components && !problem" class="comps">
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
            <span class="comp__actions">
              <EnvVersionPicker
                v-if="c.versioned"
                :component="c.id"
                :name="c.name"
                :installed="c.installed ? c.version : null"
                placement="bottom-end"
                @pick="(v) => v && install([c], { [c.id]: v })"
              >
                <template #default="{ toggle, open }">
                  <UiButton
                    variant="ghost"
                    size="sm"
                    :disabled="!running || jobRunning"
                    :title="busyTitle ?? (c.installed ? `Install another ${c.name} version, or switch to one` : `Pick the ${c.name} version to install`)"
                    aria-haspopup="dialog"
                    :aria-expanded="open"
                    @click="toggle"
                  >
                    Version<ChevronDown class="comp__chev" />
                  </UiButton>
                </template>
              </EnvVersionPicker>
              <UiButton
                :variant="c.installed ? 'ghost' : 'secondary'"
                size="sm"
                :disabled="!running || jobRunning"
                :title="busyTitle"
                @click="install([c])"
              >
                {{ c.installed ? 'Update' : 'Install' }}
              </UiButton>
            </span>
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

    <EnvShareDialog v-if="!direct" :open="sharing" :host-id="hostId" :instance="name" @close="sharing = false" />
    <template v-if="!direct">
      <EnvRenameDialog
        :open="renaming"
        :host-id="hostId"
        :name="name"
        :running="inst?.status === 'running'"
        @close="renaming = false"
        @renamed="onRenamed"
      />
      <EnvResizeDialog v-if="inst" :open="resizing" :host-id="hostId" :instance="inst" @close="resizing = false" @resized="onResized" />
    </template>
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
.ip__meta > .ip__mono { min-width: 0; font-family: var(--font-mono); font-size: var(--text-2xs); color: var(--fg-muted); overflow: hidden; text-overflow: ellipsis; }

/* ---- a joined environment: its state (colour, fill and a word), leaving, what's wrong ---- */
.ip__state {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: var(--text-xs);
  font-weight: 560;
  color: var(--fg-subtle);
  white-space: nowrap;
}
.ip__state-mark {
  flex: none;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  box-shadow: inset 0 0 0 1.25px var(--ripe-idle);
}
.ip__state--ready { color: var(--fg-muted); }
.ip__state--ready .ip__state-mark { background: var(--ripe-queued); box-shadow: none; }
/* Needs a new link: half full in the "needs you" colour. */
.ip__state--setup { color: var(--ripe-waiting-fg); }
.ip__state--setup .ip__state-mark {
  box-shadow: inset 0 0 0 1.25px var(--ripe-waiting);
  background: linear-gradient(var(--ripe-waiting), var(--ripe-waiting)) bottom / 100% 50% no-repeat;
}
.ip__state--bad { color: var(--ripe-error-fg); }
.ip__state-warn { flex: none; width: 12px; height: 12px; stroke-width: 2; color: var(--ripe-error); }

.ip__confirm {
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
  text-wrap: pretty;
}
.ip__confirm-actions { flex: none; display: inline-flex; gap: var(--space-1); }

.ip__problem {
  display: grid;
  justify-items: start;
  gap: var(--space-1);
  padding: var(--space-4);
  background: var(--bg-panel);
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
}
.ip__problem-title { margin: 0; font-size: var(--text-md); font-weight: 600; color: var(--fg); }
.ip__problem-text { margin: 0; max-width: 70ch; font-size: var(--text-sm); color: var(--fg-muted); text-wrap: pretty; }
.ip__problem-raw { margin: var(--space-1) 0 0; max-width: 70ch; font-family: var(--font-mono); font-size: var(--text-2xs); color: var(--fg-subtle); overflow-wrap: anywhere; }
.ip__problem-actions { margin-top: var(--space-2); }
.ip__fact--wide { grid-column: span 2; }
.ip__keep { flex: none; }
.ip__fact dd.ip__ended { font-weight: 560; color: var(--ripe-waiting-fg); }

.ring {
  flex: none;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  border: 1.5px solid var(--fg-subtle);
  border-right-color: transparent;
  animation: ip-turn 0.7s linear infinite;
}
.ip__error { margin: 0; font-size: var(--text-xs); color: var(--ripe-error-fg); text-wrap: pretty; }
.ip__note { display: flex; align-items: center; gap: var(--space-2); margin: var(--space-1) 0 0; font-size: var(--text-xs); color: var(--fg-muted); text-wrap: pretty; }
.ip__note-icon { flex: none; width: 13px; height: 13px; color: var(--fg-subtle); }

.ip__facts {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
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
.ip__more { color: var(--fg-subtle); }
.ip__server { margin-top: var(--space-2); }

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
.comp__actions { display: inline-flex; align-items: center; gap: var(--space-1); }
.comp__actions .comp__chev { width: 13px; height: 13px; margin-right: -2px; color: var(--fg-subtle); }

.comp--skeleton { grid-template-columns: 14px 1fr; }
.bone { height: 10px; border-radius: var(--radius-xs); background: var(--bg-hover); }
.bone--icon { width: 14px; height: 14px; border-radius: 50%; }
.bone--text { width: 40%; height: 12px; }

.ip__missing { display: grid; justify-items: start; gap: var(--space-3); }

.is-turning { animation: ip-turn 0.8s linear infinite; }
@keyframes ip-turn { to { transform: rotate(360deg); } }
</style>
