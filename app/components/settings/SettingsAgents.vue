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
import { AGENTS, type AgentId } from '~/types/chat'
import { call } from '~/composables/useBackend'
import { useWorkspace } from '~/stores/workspace'
import { useThreads } from '~/stores/threads'
import SettingsSection from './SettingsSection.vue'
import SettingsRow from './SettingsRow.vue'
import SettingsSegmented from './SettingsSegmented.vue'
import SettingsAgentRow from './SettingsAgentRow.vue'
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
  threads.persist()
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
</script>

<template>
  <SettingsSection
    title="Agents"
    description="Mango runs the agent command-line tools installed on this computer. You sign in with each tool's own sign-in, so your credentials stay with it."
  >
    <ul class="agents" aria-label="Agents">
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

    <SettingsRow v-if="ids.length > 1" label="Default agent for new chats">
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

    <p class="later">Mango can learn more agents over time. When it does, they appear in this list.</p>
  </SettingsSection>
</template>

<style scoped>
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
