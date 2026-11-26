<script setup lang="ts">
import { Bug, CircleArrowUp, CircleHelp, CreditCard, Gauge, History, Info, Keyboard, LogIn, LogOut, Plus, RefreshCw, Rocket, Settings } from 'lucide-vue-next'
import { releaseAgents } from '~/agents'
import AgentIcon from '~/components/ui/AgentIcon.vue'
import { call, openExternal } from '~/composables/useBackend'
import { useWhatsNew } from '~/composables/useWhatsNew'
import { useThreads } from '~/stores/threads'
import { useUpdater } from '~/stores/updater'
import { useUsage } from '~/stores/usage'
import { useWorkspace } from '~/stores/workspace'
import type { AuthStatus } from '~/types/ipc'
import { AGENTS, type AgentId } from '~/types/chat'
import type { MenuItem } from '~/types/ui'
import { isEnvPath } from '~/utils/envPath'
import { newIssueUrl } from '~/utils/releases'
import { useNow } from '~/utils/time'
import { summarize, type UsageTone } from '~/utils/usageSummary'

/**
 * The sidebar footer: who the agents are signed in as, and how much of the plan is left.
 * Left, the agent of the chat on screen with its plan and tightest limit (one meter); its menu
 * holds every agent's account and the default for new chats. Right, Help and Settings, one
 * click each. Usage numbers come from `stores/usage` (the titlebar keeps them fresh); sign-in
 * state is asked of each CLI here, on mount and whenever the menu opens.
 */
const { t } = useI18n()
const ws = useWorkspace()
const threads = useThreads()
const usage = useUsage()
const updater = useUpdater()
const build = useBuildInfo()
const { unseen } = useWhatsNew()
const now = useNow(60_000)

const ids = Object.keys(AGENTS) as AgentId[]

/** The agent of the chat on screen, or the one new chats start with. */
const current = computed<AgentId>(() => threads.activeThread?.agent ?? threads.defaultAgent)
/** A remote project runs its agents in the environment: whether they are installed or signed in here does not apply. */
const remote = computed(() => isEnvPath(ws.activeProjectPath))

const installed = (id: AgentId) => ws.agents.find(a => a.id === id)?.installed ?? null
const missing = (id: AgentId) => !remote.value && installed(id) === false

/* ---------- sign-in state, from each CLI ---------- */

const auth = reactive<Partial<Record<AgentId, AuthStatus>>>({})

function refreshAuth() {
  for (const id of ids) {
    if (installed(id) !== true) continue
    call('agent_auth_status', { agent: id })
      .then((s) => { auth[id] = s })
      .catch(() => { delete auth[id] })
  }
}
watch(() => ws.agents.filter(a => a.installed).map(a => a.id).join(), refreshAuth, { immediate: true })

const signedOut = (id: AgentId) => !remote.value && auth[id]?.loggedIn === false

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
/**
 * "Max", "Plus": what the usage read says, else what the sign-in says. A remote project's usage is
 * read in its environment (`stores/usage`); this computer's sign-in says nothing about it.
 */
const localAuth = (id: AgentId) => (remote.value ? undefined : auth[id])
const planOf = (id: AgentId) => usage.entries[id].usage?.plan ?? (localAuth(id)?.plan ? cap(localAuth(id)!.plan!) : null)

/* ---------- the account button ---------- */

interface Line { tone: UsageTone | 'waiting'; text: string; meter: number | null; plan: string | null; long: string }

const line = computed<Line | null>(() => {
  const id = current.value
  if (missing(id)) return { tone: 'waiting', text: t('shell.foot.notInstalled'), meter: null, plan: null, long: t('shell.usage.notInstalled') }
  if (signedOut(id)) return { tone: 'waiting', text: t('shell.foot.signedOut'), meter: null, plan: null, long: t('shell.usage.signedOut') }
  const plan = planOf(id)
  const s = summarize(usage.entries[id].usage?.windows ?? [], now.value)
  if (s) return { tone: s.tone, text: s.text, meter: s.percent, plan, long: s.long }
  return plan ? { tone: 'calm', text: '', meter: null, plan, long: '' } : null
})

const accountTitle = computed(() => {
  const name = AGENTS[current.value].name
  const plan = line.value?.plan
  return [plan ? t('shell.foot.namePlan', { name, plan }) : `${name}.`, line.value?.long, t('shell.foot.accounts')].filter(Boolean).join(' ')
})

/* ---------- the account menu ---------- */

function hintOf(id: AgentId): string | undefined {
  if (missing(id)) return t('shell.foot.notInstalled')
  if (signedOut(id)) return t('shell.foot.signedOut')
  return [planOf(id), localAuth(id)?.account].filter(Boolean).join(' · ') || undefined
}

function setDefault(id: AgentId) {
  threads.defaultAgent = id
  threads.persistLayout()
}

const accountItems = computed<MenuItem[]>(() => {
  const id = current.value
  const name = AGENTS[id].name
  const items: MenuItem[] = ids.map((a, i) => ({
    group: i === 0 ? t('shell.foot.newChatsWith') : undefined,
    label: AGENTS[a].name,
    icon: () => h(AgentIcon, { agent: a }),
    hint: hintOf(a),
    checked: threads.defaultAgent === a,
    onSelect: () => setDefault(a),
  }))
  items.push(
    { label: t('shell.usage.title'), icon: Gauge, divider: true, kbd: ws.keyLabel('usage'), onSelect: () => ws.openUsage() },
    { label: t('shell.foot.subscription'), icon: CreditCard, onSelect: () => ws.openSettings('agents', 'subscription') },
  )
  if (ids.some(missing)) items.push({ label: t('shell.foot.addAgent'), icon: Plus, onSelect: () => ws.openSetup() })
  if (signedOut(id)) items.push({ label: t('shell.foot.signIn', { name }), icon: LogIn, onSelect: () => ws.openSettings('agents') })
  else if (!missing(id)) items.push({ label: t('shell.foot.signOut', { name }), icon: LogOut, onSelect: askLogout })
  return items
})

/* ---------- the help menu ---------- */

const helpItems = computed<MenuItem[]>(() => {
  const items: MenuItem[] = [
    { label: t('shell.foot.whatsNew'), icon: History, aside: unseen.value ? t('shell.foot.newIn', { version: build.version }) : undefined, onSelect: () => ws.openSettings('changelog') },
    { label: t('shell.foot.getStarted'), icon: Rocket, onSelect: () => ws.openSetup() },
    { label: t('shell.palette.shortcuts'), icon: Keyboard, onSelect: () => ws.openSettings('shortcuts') },
    { label: t('shell.foot.report'), icon: Bug, onSelect: () => void openExternal(newIssueUrl(build.summary())) },
  ]
  if (updater.update && !updater.busy) {
    items.push({ label: t('shell.update.restart'), icon: CircleArrowUp, divider: true, aside: updater.update.version, asideMono: true, onSelect: () => void updater.install() })
  } else {
    // Like the palette's: Settings > Maintenance shows the answer (up to date, or the new version).
    items.push({
      label: t('shell.update.check'),
      icon: RefreshCw,
      divider: true,
      aside: updater.phase === 'checking' ? t('shell.foot.checking') : undefined,
      disabled: updater.busy,
      onSelect: () => { ws.openSettings('maintenance'); void updater.check(true) },
    })
  }
  items.push({ label: t('shell.foot.about'), icon: Info, aside: build.version, asideMono: true, onSelect: () => ws.openSettings('maintenance') })
  return items
})

/* ---------- sign out: ends the sign-in of the agent on screen, after asking ---------- */

const logoutOpen = ref(false)
const loggingOut = ref(false)
const logoutError = ref('')
/** Fixed when the dialog opens, so switching chats meanwhile cannot change who is signed out. */
const logoutAgent = ref<AgentId>('claude')

function askLogout() {
  logoutAgent.value = current.value
  logoutError.value = ''
  logoutOpen.value = true
}

async function logout() {
  if (loggingOut.value) return
  loggingOut.value = true
  logoutError.value = ''
  const id = logoutAgent.value
  try {
    await releaseAgents(p => p.agent === id)
    await call('agent_logout', { agent: id })
    logoutOpen.value = false
    refreshAuth()
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err)
    logoutError.value = t('shell.foot.signOutFailed', { name: AGENTS[id].name, why: why.replace(/\.$/, '') })
  } finally {
    loggingOut.value = false
  }
}
</script>

<template>
  <footer class="sf">
    <UiMenu :items="accountItems" placement="top-start" :width="290" :label="t('shell.foot.menu')" class="sf__acct-menu">
      <template #default="{ toggle, open }">
        <button
          type="button"
          class="sf__acct"
          :class="{ 'is-open': open }"
          :title="accountTitle"
          :aria-label="accountTitle"
          @click="open || refreshAuth(); toggle()"
        >
          <UiAgentIcon :agent="current" class="sf__mark" />
          <span class="sf__txt">
            <span class="sf__name">{{ AGENTS[current].name }}</span>
            <span v-if="line" class="sf__sub" :class="`is-${line.tone}`">
              <span v-if="line.plan" class="sf__plan">{{ line.plan }}</span>
              <span v-if="line.meter !== null" class="sf__meter" aria-hidden="true"><i :style="{ transform: `scaleX(${line.meter / 100})` }" /></span>
              <span v-if="line.text" class="sf__line tabular">{{ line.text }}</span>
            </span>
          </span>
        </button>
      </template>
    </UiMenu>

    <UiButton v-if="signedOut(current)" size="sm" class="sf__signin" @click="ws.openSettings('agents')">{{ t('common.actions.signIn') }}</UiButton>

    <UiMenu :items="helpItems" placement="top-end" :width="250" :label="t('shell.foot.help')">
      <template #default="{ toggle, open }">
        <UiIconButton
          :label="unseen ? t('shell.foot.helpNew', { version: build.version }) : t('shell.foot.help')"
          class="sf__help"
          :class="{ 'is-active': open }"
          @click="toggle"
        >
          <CircleHelp />
          <span v-if="unseen" class="sf__dot" aria-hidden="true" />
        </UiIconButton>
      </template>
    </UiMenu>

    <UiIconButton :label="t('shell.foot.settings')" :shortcut="ws.keyLabel('settings')" @click="ws.openSettings()">
      <Settings />
    </UiIconButton>

    <UiDialog :open="logoutOpen" :title="t('shell.foot.signOutTitle', { name: AGENTS[logoutAgent].name })" :width="420" :dismissible="!loggingOut" @close="logoutOpen = false">
      <p class="sf__msg">
        {{ t('shell.foot.signOutBody', { name: AGENTS[logoutAgent].name }) }}
      </p>
      <p v-if="logoutError" class="sf__msg sf__msg--error selectable" role="alert">{{ logoutError }}</p>
      <template #footer>
        <UiButton variant="ghost" data-autofocus :disabled="loggingOut" @click="logoutOpen = false">{{ t('common.actions.cancel') }}</UiButton>
        <UiButton variant="danger" :loading="loggingOut" @click="logout">{{ t('common.actions.signOut') }}</UiButton>
      </template>
    </UiDialog>
  </footer>
</template>

<style scoped>
.sf {
  display: flex;
  align-items: center;
  gap: 2px;
  height: 48px;
  padding: 0 var(--space-2);
  border-top: 1px solid var(--line-soft);
  container: sidebar-foot / inline-size;
}
.sf__acct-menu { flex: 1 1 auto; min-width: 0; }

.sf__acct {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  min-width: 0;
  height: 36px;
  padding: 0 var(--space-2);
  border-radius: var(--radius-sm);
  text-align: left;
  color: var(--fg);
  transition: background var(--dur-fast) var(--ease-out);
}
.sf__acct:hover, .sf__acct.is-open { background: var(--bg-hover); }
.sf__mark { width: 16px; height: 16px; flex: none; }
.sf__txt { display: flex; flex-direction: column; gap: 1px; min-width: 0; line-height: var(--leading-tight); }
.sf__name { font-size: var(--text-sm); font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sf__sub {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  font-size: var(--text-2xs);
  color: var(--fg-subtle);
  white-space: nowrap;
}
.sf__plan { flex: none; }
/* A narrow sidebar keeps the reading and drops the plan name (still in the tooltip and the menu). */
@container sidebar-foot (max-width: 240px) { .sf__plan { display: none; } .sf__meter { width: 28px; } }
.sf__line { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.sf__sub.is-high { color: var(--ripe-running-fg); }
.sf__sub.is-full { color: var(--ripe-error-fg); }
.sf__sub.is-waiting { color: var(--ripe-waiting-fg); }

/* The one meter: neutral while there is room, the running hue from 80%, the error hue when used up. */
.sf__meter { flex: none; display: block; width: 40px; height: 4px; border-radius: var(--radius-pill); background: var(--bg-active); overflow: hidden; }
.sf__meter i { display: block; width: 100%; height: 100%; border-radius: var(--radius-pill); background: var(--fg-muted); transform-origin: left center; transition: transform var(--dur-med) var(--ease-out); }
.sf__sub.is-high .sf__meter i { background: var(--ripe-running); }
.sf__sub.is-full .sf__meter i { background: var(--ripe-error); }

.sf__signin { flex: none; margin: 0 2px; }

.sf__help { position: relative; }
/* A version not looked at yet: a mark on the help button until its changelog is opened. */
.sf__dot {
  position: absolute;
  top: 4px;
  right: 4px;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent);
  box-shadow: 0 0 0 2px var(--bg-app);
}

.sf__msg { margin: 0; font-size: var(--text-sm); color: var(--fg-muted); text-wrap: pretty; }
.sf__msg--error { margin-top: var(--space-2); color: var(--ripe-error-fg); }
</style>
