<script setup lang="ts">
import {
  CircleCheck, CircleDashed, Copy, KeyRound, Laptop, MonitorPlay, RefreshCw, Server, Settings2, Share2, SquareTerminal,
} from 'lucide-vue-next'
import type { EnvComponent, EnvLoginTool } from '~/types/ipc'
import type { MenuItem } from '~/types/ui'
import { instanceKey, shareDay, shareExpired, useEnvironments } from '~/stores/environments'
import { useWorkspace } from '~/stores/workspace'
import { copyToClipboard } from '~/utils/agentCli'
import EnvTerminal from '~/components/envs/EnvTerminal.vue'

/**
 * The Environment tool window: where the active project runs. On this computer, its folder and a
 * terminal there. In an environment, the place and its state, the ways in (a shell in the terminal
 * dock, its desktop, the CLIs' own sign-ins), what is installed (with updates), and who it is shared
 * with. Checked when the window opens (at most once a minute), never polled; installs and sign-ins
 * run in a terminal here, one at a time.
 */
const ws = useWorkspace()
const envs = useEnvironments()

const path = computed(() => ws.activeProjectPath)
const place = computed(() => remotePlace(path.value))
const key = computed(() => (place.value ? instanceKey(place.value.hostId, place.value.instance) : ''))
const host = computed(() => (place.value ? envs.host(place.value.hostId) : null))
const direct = computed(() => host.value?.direct ?? null)
const inst = computed(() => (place.value ? envs.instance(place.value.hostId, place.value.instance) : null))
const state = computed(() => (place.value ? envState(place.value.hostId, place.value.instance) : null))
const running = computed(() => state.value?.tone === 'ready')
const checking = computed(() => !!place.value && (!!envs.probing[place.value.hostId] || !!envs.loadingInstances[place.value.hostId]))

const tildify = (p: string) => p.replace(/^\/(?:home|Users)\/[^/]+(?=\/|$)/, '~')
const shownPath = computed(() => (place.value ? place.value.dir : tildify(path.value ?? '')))

/* ---------- catching up: when the window opens, and when the project changes ---------- */

async function catchUp(p: string | null, force = false) {
  const pl = remotePlace(p)
  if (!pl) return
  if (force) await refreshEnv(pl.hostId, true)
  await refreshPlace(p)
  const k = instanceKey(pl.hostId, pl.instance)
  if (force && envState(pl.hostId, pl.instance).tone === 'ready') await envs.refreshComponents(pl.hostId, pl.instance)
  if (!envs.host(pl.hostId)?.direct && envState(pl.hostId, pl.instance).tone === 'ready' && (force || !envs.shares[k])) {
    await envs.refreshShares(pl.hostId, pl.instance)
  }
}
const refresh = () => catchUp(path.value, true)

/* ---------- facts ---------- */

const kind = computed(() => (inst.value?.kind === 'vm' ? 'Virtual machine' : inst.value ? 'Container' : null))
const subline = computed(() => {
  const p = place.value
  if (!p) return ''
  if (direct.value) return `Shared with you · from ${direct.value.sharedFrom}`
  return `${kind.value ?? 'Environment'} on ${p.host}`
})
const accessEnds = computed(() => (direct.value?.expiresAt ? shareDay(direct.value.expiresAt) : null))

/* ---------- components ---------- */

const components = computed(() => (key.value ? envs.components[key.value] ?? null : null))
const loadingComponents = computed(() => !!(key.value && envs.loadingComponents[key.value]))
const componentError = computed(() => (key.value ? envs.componentErrors[key.value] ?? null : null))
const installed = (id: string) => components.value?.find(c => c.id === id)?.installed ?? null
const installedOnes = computed(() => (components.value ?? []).filter(c => c.installed))

/* ---------- sharing (the owner's view) ---------- */

const shares = computed(() => (key.value ? (envs.shares[key.value] ?? null) : null))
const activeShares = computed(() => (shares.value ?? []).filter(s => !shareExpired(s.expiresAt)))
const shareText = computed(() => {
  if (!shares.value) return running.value ? 'Checking…' : 'Start it to see who has access'
  const n = activeShares.value.length
  if (!n) return 'Only you'
  return n === 1 ? `You and ${activeShares.value[0]!.label}` : `You and ${n} others`
})

/* ---------- jobs: one terminal at a time ---------- */

interface Job {
  id: number
  title: string
  doneTitle: string
  failedTitle: string
  label: string
  start: (cols: number, rows: number) => Promise<string>
  signIn?: boolean
  after?: (code: number | null) => void
}
const job = ref<Job | null>(null)
const jobRunning = ref(false)
let jobSeq = 0
function run(j: Omit<Job, 'id'>) {
  job.value = { ...j, id: ++jobSeq }
  jobRunning.value = true
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
  const p = place.value
  if (!p || !list.length) return
  const updating = list.every(c => c.installed)
  const names = list.length === 1 ? list[0]!.name : updating && list.length === installedOnes.value.length ? 'everything' : `${list.length} components`
  run({
    title: `${updating ? 'Updating' : 'Installing'} ${names}…`,
    doneTitle: `${updating ? 'Updated' : 'Installed'} ${names}`,
    failedTitle: `${updating ? 'Updating' : 'Installing'} didn't finish`,
    label: `${updating ? 'Updating' : 'Installing'} ${names} in ${p.label}`,
    start: (cols, rows) => envs.install(p.hostId, p.instance, list.map(c => c.id), cols, rows),
    after: () => envs.refreshComponents(p.hostId, p.instance),
  })
}

const LOGINS: Array<{ tool: EnvLoginTool; name: string }> = [
  { tool: 'claude', name: 'Claude Code' },
  { tool: 'codex', name: 'Codex' },
  { tool: 'gh', name: 'GitHub CLI' },
  { tool: 'tailscale', name: 'Tailscale' },
]
function login(tool: EnvLoginTool, name: string) {
  const p = place.value
  if (!p) return
  run({
    title: `Signing in to ${name}…`,
    doneTitle: `Signed in to ${name}`,
    failedTitle: 'Sign-in didn\'t finish',
    label: `${name} sign-in in ${p.label}`,
    start: (cols, rows) => envs.login(p.hostId, p.instance, tool, cols, rows),
    signIn: true,
    after: (code) => { if (code === 0 && tool === 'tailscale') envs.refreshInstances(p.hostId) },
  })
}
const loginItems = computed<MenuItem[]>(() => LOGINS.map(l => ({
  label: l.name,
  hint: installed(l.tool) === false ? 'Not installed' : undefined,
  disabled: installed(l.tool) === false,
  onSelect: () => login(l.tool, l.name),
})))

/* ---------- ways in ---------- */

const settings = (intent?: 'open-desktop') => { if (place.value) envs.openInstance(place.value.hostId, place.value.instance, intent) }

/* Started here, after the job slot exists: a new project drops the old one's terminal. */
watch(path, (p) => {
  job.value = null
  void catchUp(p)
}, { immediate: true })

/** Local project: open a folder in an environment instead (the Where flow). */
function openInEnv() {
  if (!envs.hosts.length) {
    envs.openView()
    return
  }
  ws.dialog = 'open-env'
}
</script>

<template>
  <section class="te" aria-label="Environment">
    <header class="te__head">
      <h2 class="te__title">Environment</h2>
      <UiIconButton v-if="place" label="Check again" size="sm" :disabled="checking || loadingComponents" @click="refresh">
        <RefreshCw :class="{ 'is-turning': checking || loadingComponents }" />
      </UiIconButton>
      <UiIconButton v-if="place" label="Environment settings" size="sm" @click="settings()"><Settings2 /></UiIconButton>
    </header>

    <div v-if="path" class="te__body">
      <!-- ---------- this computer ---------- -->
      <template v-if="!place">
        <div class="te__place">
          <Laptop class="te__icon" aria-hidden="true" />
          <div class="te__who">
            <p class="te__name">This computer</p>
            <p class="te__sub">Agents and terminals run here.</p>
          </div>
        </div>
        <p class="te__path">
          <span class="te__path-text selectable" :title="path"><bdi>{{ shownPath }}</bdi></span>
          <UiIconButton label="Copy path" size="sm" @click="copyToClipboard(path)"><Copy /></UiIconButton>
        </p>
        <div class="te__actions">
          <UiButton size="sm" @click="ws.newTerminal(path)"><SquareTerminal />Open terminal here</UiButton>
        </div>
        <div class="te__sec">
          <p class="te__note">
            Projects can also run in an environment: a container or VM on your own server, or one someone shared with you.
          </p>
          <UiButton size="sm" variant="ghost" class="te__ghost" @click="openInEnv">
            <Server />{{ envs.hosts.length ? 'Open a folder in an environment…' : 'Set up an environment…' }}
          </UiButton>
        </div>
      </template>

      <!-- ---------- an environment ---------- -->
      <template v-else>
        <div class="te__place">
          <Server class="te__icon" aria-hidden="true" />
          <div class="te__who">
            <p class="te__name-row">
              <span class="te__name">{{ place.label }}</span>
              <EnvsEnvStatus v-if="state && state.tone !== 'unknown'" :status="state.status" word />
              <span v-else-if="checking" class="te__checking">Checking…</span>
            </p>
            <p class="te__sub">{{ subline }}</p>
          </div>
        </div>
        <p class="te__path">
          <span class="te__path-text selectable" :title="place.dir"><bdi>{{ place.dir }}</bdi></span>
          <UiIconButton label="Copy path" size="sm" @click="copyToClipboard(place.dir)"><Copy /></UiIconButton>
        </p>

        <p v-if="state && (state.tone === 'off' || state.tone === 'bad')" class="te__problem" :class="`te__problem--${state.tone}`" role="status">
          <template v-if="state.tone === 'off'">{{ place.label }} is {{ state.label.toLowerCase() }}. Chats and terminals here wait until it runs. </template>
          <template v-else>{{ state.label }}. Chats and terminals here can't start until Mango reaches it. </template>
          <button type="button" class="te__link" @click="settings()">{{ state.tone === 'off' && !direct ? 'Start it in Settings…' : 'See Settings…' }}</button>
        </p>

        <div class="te__actions">
          <UiButton size="sm" :disabled="!running" @click="ws.newTerminal(path)"><SquareTerminal />Open shell here</UiButton>
          <UiButton
            v-if="installed('desktop') !== false"
            size="sm"
            :disabled="!running"
            @click="settings('open-desktop')"
          >
            <MonitorPlay />Desktop
          </UiButton>
          <UiMenu :items="loginItems" :width="220" label="Sign in">
            <template #default="{ toggle, open }">
              <UiButton size="sm" :disabled="!running || jobRunning" :title="busyTitle" :aria-expanded="open" aria-haspopup="menu" @click="toggle">
                <KeyRound />Sign in…
              </UiButton>
            </template>
          </UiMenu>
        </div>

        <div v-if="job" class="te__job">
          <EnvTerminal
            :key="job.id"
            :start="job.start"
            :title="job.title"
            :done-title="job.doneTitle"
            :failed-title="job.failedTitle"
            :label="job.label"
            :rows="10"
            :sign-in="job.signIn"
            @exit="onJobExit"
            @close="closeJob"
          />
        </div>

        <dl v-if="inst || direct" class="te__facts">
          <template v-if="direct">
            <dt>Access ends</dt>
            <dd class="tabular">{{ accessEnds ?? 'When the owner revokes it' }}</dd>
          </template>
          <template v-if="inst">
            <dt>Addresses</dt>
            <dd class="te__mono selectable">{{ inst.ipv4.join(', ') || '–' }}</dd>
            <dt>Tailscale</dt>
            <dd v-if="inst.tailscaleIp" class="te__mono selectable">{{ inst.tailscaleIp }}</dd>
            <dd v-else class="te__off">Not on a tailnet</dd>
            <template v-if="inst.image">
              <dt>Image</dt>
              <dd class="te__clip" :title="inst.image">{{ inst.image }}</dd>
            </template>
          </template>
        </dl>

        <section class="te__sec" aria-labelledby="te-comps">
          <header class="te__sec-head">
            <h3 id="te-comps" class="te__h3">Components</h3>
            <UiButton
              variant="ghost"
              size="sm"
              :disabled="!running || jobRunning || !installedOnes.length"
              :title="busyTitle"
              @click="install(installedOnes)"
            >
              Update all
            </UiButton>
          </header>
          <p v-if="!running && !components" class="te__note">Once it runs, what is installed shows here.</p>
          <p v-else-if="componentError" class="te__note te__note--bad selectable" role="alert">Couldn't check. {{ componentError }}</p>
          <ul v-if="components" class="te__comps">
            <li v-for="c in components" :key="c.id" class="te__comp">
              <CircleCheck v-if="c.installed" class="te__comp-icon is-ok" aria-hidden="true" />
              <CircleDashed v-else class="te__comp-icon" aria-hidden="true" />
              <span class="te__comp-name" :title="c.description">{{ c.name }}</span>
              <!-- The version gives way to Update on hover; something missing always offers Install. -->
              <span class="te__comp-end">
                <span v-if="c.installed" class="te__comp-ver tabular">{{ c.version ?? 'Installed' }}</span>
                <button
                  type="button"
                  class="te__comp-act"
                  :class="{ 'is-install': !c.installed }"
                  :disabled="!running || jobRunning"
                  :title="busyTitle ?? (c.installed ? undefined : 'Not installed')"
                  :aria-label="`${c.installed ? 'Update' : 'Install'} ${c.name}`"
                  @click="install([c])"
                >
                  {{ c.installed ? 'Update' : 'Install' }}
                </button>
              </span>
            </li>
          </ul>
          <ul v-else-if="loadingComponents" class="te__comps" aria-busy="true" aria-label="Checking components">
            <li v-for="n in 4" :key="n" class="te__comp" aria-hidden="true"><span class="te__bone" :style="{ width: `${[52, 38, 60, 44][n - 1]}%` }" /></li>
          </ul>
        </section>

        <section v-if="!direct" class="te__sec">
          <div class="te__share">
            <Share2 class="te__share-icon" aria-hidden="true" />
            <span class="te__share-text">
              <span class="te__h3">Sharing</span>
              <span class="te__share-who">{{ shareText }}</span>
            </span>
            <button type="button" class="te__link" @click="settings()">Manage…</button>
          </div>
        </section>
      </template>
    </div>
    <p v-else class="te__empty">Open a project to see where it runs.</p>
  </section>
</template>

<style scoped>
.te { flex: 1; display: flex; flex-direction: column; min-width: 0; min-height: 0; }
.te__head {
  flex: none;
  display: flex;
  align-items: center;
  gap: 2px;
  height: var(--tabbar-h);
  border-bottom: 1px solid var(--line);
  padding: 0 var(--space-2) 0 var(--space-3);
}
.te__title {
  flex: 1;
  min-width: 0;
  margin: 0;
  font-size: var(--text-sm);
  font-weight: 600;
  color: var(--fg);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.te__body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-3) var(--space-5) var(--space-4);
  border-top: 1px solid var(--line-soft);
  font-size: var(--text-sm);
  color: var(--fg-muted);
}
.te p { margin: 0; }
.te__empty { padding: var(--space-3) var(--space-4); border-top: 1px solid var(--line-soft); font-size: var(--text-sm); color: var(--fg-subtle); }

.te__place { display: flex; align-items: flex-start; gap: var(--space-3); }
.te__icon { flex: none; width: 18px; height: 18px; margin-top: 2px; stroke-width: 1.75; color: var(--fg-subtle); }
.te__who { display: grid; gap: 1px; min-width: 0; }
.te__name-row { display: flex; align-items: center; gap: var(--space-2); min-width: 0; }
.te__name { min-width: 0; font-size: var(--text-lg); font-weight: 620; letter-spacing: -0.01em; color: var(--fg); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.te__checking { font-size: var(--text-xs); color: var(--fg-subtle); }
.te__sub { font-size: var(--text-xs); color: var(--fg-subtle); overflow-wrap: anywhere; }

.te__path {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  min-height: 30px;
  padding: 0 2px 0 var(--space-2);
  background: var(--bg-inset);
  border: 1px solid var(--line-soft);
  border-radius: var(--radius-sm);
}
.te__path-text bdi { direction: ltr; unicode-bidi: isolate; }
.te__path-text {
  flex: 1;
  min-width: 0;
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--fg);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  direction: rtl;
  text-align: left;
}

.te__problem {
  font-size: var(--text-xs);
  line-height: var(--leading-normal);
  color: var(--fg-muted);
  padding: var(--space-2) var(--space-3);
  background: var(--bg-inset);
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
}
.te__problem--bad {
  background: color-mix(in oklch, var(--ripe-error) 8%, transparent);
  border-color: color-mix(in oklch, var(--ripe-error) 35%, transparent);
}
.te__link {
  display: inline;
  padding: 0;
  font: inherit;
  font-weight: 560;
  color: var(--accent-ink);
  border-radius: var(--radius-xs);
}
.te__link:hover { text-decoration: underline; text-underline-offset: 3px; }
.te__link:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }

.te__actions { display: flex; flex-wrap: wrap; gap: var(--space-2); }
.te__job { margin: 0 calc(var(--space-1) * -1); }

.te__facts {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 4px var(--space-3);
  margin: 0;
  font-size: var(--text-xs);
}
.te__facts dt { color: var(--fg-subtle); }
.te__facts dd { margin: 0; min-width: 0; color: var(--fg); overflow-wrap: anywhere; }
.te__mono { font-family: var(--font-mono); }
.te__facts dd.te__off { color: var(--fg-subtle); }
.te__clip { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

.te__sec { display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--space-2); padding-top: var(--space-3); border-top: 1px solid var(--line-soft); }
.te__sec-head { display: flex; align-items: center; justify-content: space-between; gap: var(--space-2); min-height: 26px; }
.te__h3 { margin: 0; font-size: var(--text-xs); font-weight: 600; color: var(--fg-muted); }
.te__note { font-size: var(--text-xs); line-height: var(--leading-normal); color: var(--fg-subtle); }
.te__note--bad { color: var(--ripe-error-fg); }
.te__ghost { justify-self: start; margin-left: calc(var(--space-2) * -1); }

.te__comps { list-style: none; margin: 0; padding: 0; display: grid; }
.te__comp {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-height: 28px;
  font-size: var(--text-sm);
}
.te__comp-icon { flex: none; width: 14px; height: 14px; stroke-width: 1.85; color: var(--fg-faint); }
.te__comp-icon.is-ok { color: var(--ripe-queued); }
.te__comp-name { flex: 1; min-width: 0; color: var(--fg); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.te__comp-end { flex: none; display: grid; justify-items: end; align-items: center; }
.te__comp-end > * { grid-area: 1 / 1; }
.te__comp-ver { font-size: var(--text-xs); color: var(--fg-subtle); transition: opacity var(--dur-fast) var(--ease-out); }
.te__comp:hover .te__comp-ver:has(~ .te__comp-act:not(:disabled)),
.te__comp:focus-within .te__comp-ver { opacity: 0; }
.te__comp-act {
  height: 22px;
  padding: 0 var(--space-2);
  border-radius: var(--radius-xs);
  font-size: var(--text-xs);
  font-weight: 560;
  color: var(--fg-muted);
  opacity: 0;
  transition: opacity var(--dur-fast) var(--ease-out), background var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out);
}
.te__comp:hover .te__comp-act:not(:disabled), .te__comp-act:focus-visible, .te__comp-act.is-install { opacity: 1; }
.te__comp-act.is-install:disabled { color: var(--fg-faint); }
.te__comp-act:hover:not(:disabled) { background: var(--bg-hover); color: var(--fg); }
.te__comp-act:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 1px; }
.te__bone { height: 9px; border-radius: var(--radius-xs); background: var(--bg-hover); animation: te-pulse 1.4s var(--ease-in-out) infinite; }
@keyframes te-pulse { 50% { opacity: 0.45; } }

.te__share { display: flex; align-items: center; gap: var(--space-2); }
.te__share .te__link { flex: none; white-space: nowrap; }
.te__share-icon { flex: none; width: 14px; height: 14px; stroke-width: 1.85; color: var(--fg-subtle); }
.te__share-text { flex: 1; min-width: 0; display: flex; align-items: baseline; gap: var(--space-2); }
.te__share-who { min-width: 0; font-size: var(--text-xs); color: var(--fg-subtle); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.is-turning { animation: te-turn 0.9s linear infinite; }
@keyframes te-turn { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .te__bone, .is-turning { animation: none; } }
</style>
