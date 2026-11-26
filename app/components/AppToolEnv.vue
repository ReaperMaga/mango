<script setup lang="ts">
import {
  CircleCheck, CircleDashed, Copy, KeyRound, Laptop, MonitorPlay, RefreshCw, Server, Settings2, Share2, SquareTerminal,
} from 'lucide-vue-next'
import type { EnvComponent, EnvLoginTool } from '~/types/ipc'
import type { MenuItem } from '~/types/ui'
import { envComponentName, instanceKey, shareDay, shareExpired, useEnvironments } from '~/stores/environments'
import { useWorkspace } from '~/stores/workspace'
import { copyToClipboard } from '~/utils/agentCli'
import EnvTerminal from '~/components/envs/EnvTerminal.vue'
import EnvGitlabServer from '~/components/envs/EnvGitlabServer.vue'
import { GITLAB_COM } from '~/utils/gitHosts'

/**
 * The Environment tool window: where the active project runs. On this computer, its folder and a
 * terminal there. In an environment, the place and its state, the ways in (a shell in the terminal
 * dock, its desktop, the CLIs' own sign-ins), what is installed (with updates), and who it is shared
 * with. Checked when the window opens (at most once a minute), never polled; installs and sign-ins
 * run in a terminal here, one at a time.
 */
const { t } = useI18n()
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

const kind = computed(() => (inst.value?.kind === 'vm' ? t('envs.common.vm') : inst.value ? t('envs.common.container') : null))
const subline = computed(() => {
  const p = place.value
  if (!p) return ''
  if (direct.value) return t('envs.tool.sharedFrom', { from: direct.value.sharedFrom })
  return t('envs.tool.placed', { kind: kind.value ?? t('envs.tool.title'), on: p.sub })
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
  if (!shares.value) return running.value ? t('envs.state.checking') : t('envs.tool.startToSee')
  const n = activeShares.value.length
  if (!n) return t('envs.tool.onlyYou')
  return n === 1 ? t('envs.tool.youAnd', { name: activeShares.value[0]!.label }) : t('envs.tool.youAndOthers', n)
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
  /** One line under the terminal while it runs. */
  hint?: string
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
const busyTitle = computed(() => (jobRunning.value ? t('envs.job.busy') : undefined))

function install(list: EnvComponent[]) {
  const p = place.value
  if (!p || !list.length) return
  const updating = list.every(c => c.installed)
  const names = list.length === 1 ? envComponentName(list[0]!.id) : updating && list.length === installedOnes.value.length ? t('envs.job.everything') : t('envs.job.componentCount', list.length)
  const doing = updating ? 'update' : 'install'
  run({
    title: t(`envs.job.${doing}.title`, { what: names }),
    doneTitle: t(`envs.job.${doing}.done`, { what: names }),
    failedTitle: t(`envs.job.${doing}.failed`),
    label: t(`envs.job.${doing}.label`, { what: names, place: p.label }),
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
    title: t('envs.job.signIn.title', { name }),
    doneTitle: t('envs.job.signIn.done', { name }),
    failedTitle: t('envs.job.signIn.failed'),
    label: t('envs.job.signIn.label', { name, place: p.label }),
    start: (cols, rows) => envs.login(p.hostId, p.instance, tool, cols, rows),
    signIn: true,
    after: (code) => { if (code === 0 && tool === 'tailscale') envs.refreshInstances(p.hostId) },
  })
}
/** glab signs in to one GitLab server at a time: gitlab.com, one Mango knows, or one typed in place. */
function loginGitlab(server: string) {
  const p = place.value
  if (!p) return
  otherServer.value = false
  const selfManaged = server !== GITLAB_COM
  run({
    title: t('envs.job.signIn.title', { name: server }),
    doneTitle: t('envs.job.signIn.done', { name: server }),
    failedTitle: t('envs.job.signIn.failed'),
    label: t('envs.job.signIn.gitlabLabel', { server, place: p.label }),
    start: (cols, rows) => envs.login(p.hostId, p.instance, 'glab', cols, rows, server),
    signIn: !selfManaged,
    hint: selfManaged
      ? t('envs.job.signIn.token', { server })
      : undefined,
    after: (code) => { if (code === 0 && selfManaged) void envs.loadGitlabHosts() },
  })
}
const otherServer = ref(false)
const loginItems = computed<MenuItem[]>(() => {
  const items: MenuItem[] = LOGINS.map(l => ({
    label: l.name,
    hint: installed(l.tool) === false ? t('envs.common.notInstalled') : undefined,
    disabled: installed(l.tool) === false,
    onSelect: () => login(l.tool, l.name),
  }))
  const noGlab = installed('glab') === false
  const servers = [GITLAB_COM, ...(envs.gitlabHosts ?? [])]
  servers.forEach((h, i) => items.push({
    label: h,
    group: i === 0 ? 'GitLab CLI' : undefined,
    hint: noGlab && i === 0 ? t('envs.common.notInstalled') : undefined,
    disabled: noGlab,
    onSelect: () => loginGitlab(h),
  }))
  items.push({ label: t('envs.tool.anotherGitlab'), disabled: noGlab, onSelect: () => { otherServer.value = true } })
  return items
})
function openLogins(toggle: () => void) {
  void envs.loadGitlabHosts()
  toggle()
}

/* ---------- ways in ---------- */

const settings = (intent?: 'open-desktop') => { if (place.value) envs.openInstance(place.value.hostId, place.value.instance, intent) }

/* Started here, after the job slot exists: a new project drops the old one's terminal. */
watch(path, (p) => {
  job.value = null
  otherServer.value = false
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
  <section class="te" :aria-label="t('envs.tool.title')">
    <header class="te__head">
      <h2 class="te__title">{{ t('envs.tool.title') }}</h2>
      <UiIconButton v-if="place" :label="t('envs.common.checkAgain')" size="sm" :disabled="checking || loadingComponents" @click="refresh">
        <RefreshCw :class="{ 'is-turning': checking || loadingComponents }" />
      </UiIconButton>
      <UiIconButton v-if="place" :label="t('envs.tool.settings')" size="sm" @click="settings()"><Settings2 /></UiIconButton>
    </header>

    <div v-if="path" class="te__body">
      <!-- ---------- this computer ---------- -->
      <template v-if="!place">
        <div class="te__place">
          <Laptop class="te__icon" aria-hidden="true" />
          <div class="te__who">
            <p class="te__name">{{ t('envs.place.thisComputer') }}</p>
            <p class="te__sub">{{ t('envs.tool.runsHere') }}</p>
          </div>
        </div>
        <p class="te__path">
          <span class="te__path-text selectable" :title="path"><bdi>{{ shownPath }}</bdi></span>
          <UiIconButton :label="t('envs.tool.copyPath')" size="sm" @click="copyToClipboard(path)"><Copy /></UiIconButton>
        </p>
        <div class="te__actions">
          <UiButton size="sm" @click="ws.newTerminal(path)"><SquareTerminal />{{ t('envs.tool.openTerminal') }}</UiButton>
        </div>
        <div class="te__sec">
          <p class="te__note">
            {{ t('envs.tool.about') }}
          </p>
          <UiButton size="sm" variant="ghost" class="te__ghost" @click="openInEnv">
            <Server />{{ envs.hosts.length ? t('envs.tool.openInEnv') : t('envs.tool.setUpEnv') }}
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
              <span v-else-if="checking" class="te__checking">{{ t('envs.state.checking') }}</span>
            </p>
            <p class="te__sub">{{ subline }}</p>
          </div>
        </div>
        <p class="te__path">
          <span class="te__path-text selectable" :title="place.dir"><bdi>{{ place.dir }}</bdi></span>
          <UiIconButton :label="t('envs.tool.copyPath')" size="sm" @click="copyToClipboard(place.dir)"><Copy /></UiIconButton>
        </p>

        <p v-if="state && (state.tone === 'off' || state.tone === 'bad')" class="te__problem" :class="`te__problem--${state.tone}`" role="status">
          <template v-if="state.tone === 'off'">{{ `${state.status === 'frozen' ? t('envs.tool.frozen', { name: place.label }) : t('envs.tool.stopped', { name: place.label })} ` }}</template>
          <template v-else>{{ `${t('envs.tool.bad', { state: state.label })} ` }}</template>
          <button type="button" class="te__link" @click="settings()">{{ state.tone === 'off' && !direct ? t('envs.tool.startInSettings') : t('envs.tool.seeSettings') }}</button>
        </p>

        <div class="te__actions">
          <UiButton size="sm" :disabled="!running" @click="ws.newTerminal(path)"><SquareTerminal />{{ t('envs.tool.openShell') }}</UiButton>
          <UiButton
            v-if="installed('desktop') !== false"
            size="sm"
            :disabled="!running"
            @click="settings('open-desktop')"
          >
            <MonitorPlay />{{ t('envs.common.desktop') }}
          </UiButton>
          <UiMenu :items="loginItems" :width="220" :label="t('common.actions.signIn')">
            <template #default="{ toggle, open }">
              <UiButton size="sm" :disabled="!running || jobRunning" :title="busyTitle" :aria-expanded="open" aria-haspopup="menu" @click="openLogins(toggle)">
                <KeyRound />{{ t('envs.tool.signIn') }}
              </UiButton>
            </template>
          </UiMenu>
        </div>

        <EnvGitlabServer
          v-if="otherServer && running && !jobRunning"
          compact
          @pick="loginGitlab"
          @cancel="otherServer = false"
        />

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
          >
            <template v-if="job.hint" #hint>{{ job.hint }}</template>
          </EnvTerminal>
        </div>

        <dl v-if="inst || direct" class="te__facts">
          <template v-if="direct">
            <dt>{{ t('envs.common.accessEnds') }}</dt>
            <dd class="tabular">{{ accessEnds ?? t('envs.common.whenRevoked') }}</dd>
          </template>
          <template v-if="inst">
            <dt>{{ t('envs.common.addresses') }}</dt>
            <dd class="te__mono selectable">{{ inst.ipv4.join(', ') || '–' }}</dd>
            <dt>Tailscale</dt>
            <dd v-if="inst.tailscaleIp" class="te__mono selectable">{{ inst.tailscaleIp }}</dd>
            <dd v-else class="te__off">{{ t('envs.tool.notOnTailnet') }}</dd>
            <template v-if="inst.image">
              <dt>{{ t('envs.common.image') }}</dt>
              <dd class="te__clip" :title="inst.image">{{ inst.image }}</dd>
            </template>
          </template>
        </dl>

        <section class="te__sec" aria-labelledby="te-comps">
          <header class="te__sec-head">
            <h3 id="te-comps" class="te__h3">{{ t('envs.common.components') }}</h3>
            <UiButton
              variant="ghost"
              size="sm"
              :disabled="!running || jobRunning || !installedOnes.length"
              :title="busyTitle"
              @click="install(installedOnes)"
            >
              {{ t('envs.common.updateAll') }}
            </UiButton>
          </header>
          <p v-if="!running && !components" class="te__note">{{ t('envs.tool.onceRunning') }}</p>
          <p v-else-if="componentError" class="te__note te__note--bad selectable" role="alert">{{ t('envs.tool.checkFailed', { error: componentError }) }}</p>
          <ul v-if="components" class="te__comps">
            <li v-for="c in components" :key="c.id" class="te__comp">
              <CircleCheck v-if="c.installed" class="te__comp-icon is-ok" aria-hidden="true" />
              <CircleDashed v-else class="te__comp-icon" aria-hidden="true" />
              <span class="te__comp-name" :title="c.description">{{ envComponentName(c.id) }}</span>
              <!-- The version gives way to Update on hover; something missing always offers Install. -->
              <span class="te__comp-end">
                <span v-if="c.installed" class="te__comp-ver tabular">{{ c.version ?? t('envs.common.installed') }}</span>
                <button
                  type="button"
                  class="te__comp-act"
                  :class="{ 'is-install': !c.installed }"
                  :disabled="!running || jobRunning"
                  :title="busyTitle ?? (c.installed ? undefined : t('envs.common.notInstalled'))"
                  :aria-label="c.installed ? t('envs.tool.updateOne', { name: envComponentName(c.id) }) : t('envs.tool.installOne', { name: envComponentName(c.id) })"
                  @click="install([c])"
                >
                  {{ c.installed ? t('envs.common.update') : t('common.actions.install') }}
                </button>
              </span>
            </li>
          </ul>
          <ul v-else-if="loadingComponents" class="te__comps" aria-busy="true" :aria-label="t('envs.common.checkingComponents')">
            <li v-for="n in 4" :key="n" class="te__comp" aria-hidden="true"><span class="te__bone" :style="{ width: `${[52, 38, 60, 44][n - 1]}%` }" /></li>
          </ul>
        </section>

        <section v-if="!direct" class="te__sec">
          <div class="te__share">
            <Share2 class="te__share-icon" aria-hidden="true" />
            <span class="te__share-text">
              <span class="te__h3">{{ t('envs.common.sharing') }}</span>
              <span class="te__share-who">{{ shareText }}</span>
            </span>
            <button type="button" class="te__link" @click="settings()">{{ t('envs.tool.manage') }}</button>
          </div>
        </section>
      </template>
    </div>
    <p v-else class="te__empty">{{ t('envs.tool.empty') }}</p>
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
