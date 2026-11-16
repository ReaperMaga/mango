<script lang="ts">
import { reactive } from 'vue'
import type { AuthEntry } from './SettingsAgentRow.vue'

/**
 * Last known sign-in state per agent. Kept for the life of the window so
 * reopening Settings shows what we knew while the fresh answer comes in.
 */
const auth = reactive<Record<string, AuthEntry>>({})
const checkSeq = new Map<string, number>()
</script>

<script setup lang="ts">
import type { AuthStatus } from '~/types/ipc'
import type { AgentsTab } from '~/stores/workspace'
import { AGENTS, type AgentId } from '~/types/chat'
import { call } from '~/composables/useBackend'
import { useWorkspace } from '~/stores/workspace'
import { useThreads } from '~/stores/threads'
import SettingsSection from './SettingsSection.vue'
import SettingsRow from './SettingsRow.vue'
import SettingsSegmented from './SettingsSegmented.vue'
import SettingsAgentRow from './SettingsAgentRow.vue'
import SettingsSubscription from './SettingsSubscription.vue'
import SettingsUsage from './SettingsUsage.vue'
import AgentIcon from '~/components/ui/AgentIcon.vue'

/** `active`: this section is the one on screen (it stays mounted while Settings is open). */
const props = defineProps<{ active: boolean }>()

const ws = useWorkspace()
const threads = useThreads()

// Everything below iterates the registry, so a new agent shows up on its own.
const ids = Object.keys(AGENTS) as AgentId[]

function entry(agent: AgentId): AuthEntry {
  return (auth[agent] ??= { status: null, loading: false, error: null })
}
for (const id of ids) entry(id)

const infoOf = (agent: AgentId) => ws.agents.find(a => a.id === agent) ?? null

async function check(agent: AgentId): Promise<AuthStatus | null> {
  const e = entry(agent)
  const n = (checkSeq.get(agent) ?? 0) + 1
  checkSeq.set(agent, n)
  const latest = () => checkSeq.get(agent) === n
  e.loading = true
  try {
    const status = await call('agent_auth_status', { agent })
    if (latest()) {
      e.status = status
      e.error = null
    }
    return status
  } catch (err) {
    if (latest()) {
      e.status = null
      e.error = err instanceof Error ? err.message : String(err)
    }
    return null
  } finally {
    if (latest()) e.loading = false
  }
}

async function refresh(agent: AgentId, opts?: { detect?: boolean }) {
  if (opts?.detect) {
    entry(agent).loading = true
    await ws.refreshAgents()
  }
  return check(agent)
}

function checkAll() {
  for (const id of ids) check(id)
}

onMounted(() => { if (props.active) checkAll() })
watch(() => props.active, (on) => { if (on) checkAll() })

/* ---------- default agent ---------- */

const agentOptions = ids.map(id => ({ value: id, label: AGENTS[id].name, icon: () => h(AgentIcon, { agent: id }) }))

function setDefault(agent: AgentId) {
  threads.defaultAgent = agent
  threads.persistLayout()
}

/** Say so when the chosen default can't answer yet. */
const defaultProblem = computed(() => {
  const id = threads.defaultAgent
  const name = AGENTS[id]?.name ?? id
  const info = infoOf(id)
  const status = auth[id]?.status
  if (info ? !info.installed : status?.installed === false) return `${name} isn't installed yet, so new chats can't start with it.`
  if (status && !status.loggedIn) return `${name} isn't signed in yet. Sign in above before starting a chat with it.`
  return ''
})

/** The heading follows the tab. */
const HEADINGS: Record<AgentsTab, { title: string; description: string }> = {
  agents: {
    title: 'Agents',
    description: 'Mango runs the agent command-line tools installed on this computer. You sign in with each tool\'s own sign-in, so your credentials stay with it.',
  },
  subscription: {
    title: 'Subscription',
    description: 'The plan each agent is signed in with, as the agent itself reports it. Billing and renewal are managed with the vendor.',
  },
  usage: {
    title: 'Usage',
    description: 'How much of each plan\'s allowance is used, and when each limit resets. Checking spends none of it.',
  },
}
const heading = computed(() => HEADINGS[ws.agentsTab])
</script>

<template>
  <SettingsSection
    :title="heading.title"
    :description="heading.description"
  >
    <SettingsSegmented
      v-model="ws.agentsTab"
      class="tabs"
      label="Agent settings"
      :options="[{ value: 'agents', label: 'Agents' }, { value: 'subscription', label: 'Subscription' }, { value: 'usage', label: 'Usage & resets' }]"
    />

    <SettingsSubscription v-if="ws.agentsTab === 'subscription'" :ids="ids" :auth="auth" :info-of="infoOf" />
    <SettingsUsage v-else-if="ws.agentsTab === 'usage'" />

    <ul v-show="ws.agentsTab === 'agents'" class="agents" aria-label="Agents">
      <SettingsAgentRow
        v-for="id in ids"
        :key="id"
        :agent="id"
        :name="AGENTS[id].name"
        :info="infoOf(id)"
        :auth="entry(id)"
        :refresh="(opts?: { detect?: boolean }) => refresh(id, opts)"
      />
    </ul>

    <SettingsRow v-if="ws.agentsTab === 'agents' && ids.length > 1" label="Default agent for new chats">
      <template #hint>
        <span v-if="defaultProblem" class="warn" role="status">{{ defaultProblem }}</span>
        <template v-else>You can still pick another agent in any chat.</template>
      </template>
      <template #default="{ labelId }">
        <SettingsSegmented
          :model-value="threads.defaultAgent"
          :options="agentOptions"
          :labelledby="labelId"
          @update:model-value="setDefault"
        />
      </template>
    </SettingsRow>

    <p v-if="ws.agentsTab === 'agents'" class="later">Mango can learn more agents over time. When it does, they appear in this list.</p>
  </SettingsSection>
</template>

<style scoped>
.tabs { margin-bottom: var(--space-4); }
.agents {
  margin: 0 0 var(--space-3);
  padding: 0;
  list-style: none;
}
.warn { color: var(--ripe-waiting-fg); }
.later {
  margin: var(--space-4) 0 0;
  font-size: var(--text-xs);
  color: var(--fg-faint);
}
</style>
