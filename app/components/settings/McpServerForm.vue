<script setup lang="ts">
import { CircleAlert } from 'lucide-vue-next'
import type { McpServerConfig } from '~/types/ipc'
import { AGENTS } from '~/types/chat'
import { mcpNameProblem } from '~/agents/mcp'
import { joinCommandLine, splitCommandLine } from '~/utils/mcpServers'
import SettingsSegmented from './SettingsSegmented.vue'
import McpPairs from './McpPairs.vue'

/**
 * Adding or editing one MCP server, in place in the list (not a dialog). Enter in a one-line field
 * saves, Escape cancels. The parent saves; it passes back `busy` and the backend's `error`.
 */
const props = defineProps<{
  server: McpServerConfig
  /** Names already used in this scope (lower case), the server's own excluded. */
  taken: string[]
  /** The project is in a remote environment: the command runs there. */
  remote?: boolean
  busy?: boolean
  error?: string | null
}>()
const emit = defineEmits<{ save: [server: McpServerConfig]; cancel: [] }>()

const isNew = !props.server.id
const name = ref(props.server.name)
const transport = ref<McpServerConfig['transport']>(props.server.transport)
const commandLine = ref(joinCommandLine(props.server.command, props.server.args))
const url = ref(props.server.url)
const env = ref(props.server.env.map(p => ({ ...p })))
const headers = ref(props.server.headers.map(p => ({ ...p })))
type AgentsChoice = 'both' | 'claude' | 'codex'
const agents = ref<AgentsChoice>(props.server.agents.length === 1 ? props.server.agents[0]! : 'both')
const badPairs = ref(0)
/** Shown once Save was pressed (or a field left), not while the name is first typed. */
const touched = reactive({ name: false, command: false, url: false })

const ids = { name: useId(), command: useId(), url: useId(), agents: useId() }

const nameError = computed(() => {
  const n = name.value.trim()
  return mcpNameProblem(n) ?? (props.taken.includes(n.toLowerCase()) ? `There is already a server named ${n} here.` : null)
})
const commandError = computed(() => (splitCommandLine(commandLine.value).length ? null : 'Give the command that starts the server.'))
const urlError = computed(() => (/^https?:\/\/[^/\s]\S*$/i.test(url.value.trim()) ? null : 'Give the server\'s address, starting with http:// or https://.'))

const transports = [
  { value: 'stdio' as const, label: 'Command' },
  { value: 'http' as const, label: 'HTTP' },
]
const agentChoices: Array<{ value: AgentsChoice; label: string }> = [
  { value: 'both', label: 'Both' },
  { value: 'claude', label: AGENTS.claude.name },
  { value: 'codex', label: AGENTS.codex.name },
]

const commandHint = computed(() => (props.remote
  ? 'Started inside the environment by the agent\'s CLI, for each chat that uses it. Quotes keep spaces in an argument.'
  : 'Started by the agent\'s CLI for each chat that uses it, in the project folder. Quotes keep spaces in an argument.'))

const form = ref<HTMLFormElement | null>(null)
onMounted(() => {
  const first = form.value?.querySelector<HTMLInputElement>(isNew ? `#${CSS.escape(ids.name)}` : 'input')
  first?.focus()
})

function submit() {
  touched.name = touched.command = touched.url = true
  const bad = nameError.value || badPairs.value || (transport.value === 'stdio' ? commandError.value : urlError.value)
  if (bad) {
    void nextTick(() => form.value?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus())
    return
  }
  const [command = '', ...args] = splitCommandLine(commandLine.value)
  const stdio = transport.value === 'stdio'
  emit('save', {
    ...props.server,
    name: name.value.trim(),
    transport: transport.value,
    agents: agents.value === 'both' ? ['claude', 'codex'] : [agents.value],
    command: stdio ? command : '',
    args: stdio ? args : [],
    env: stdio ? env.value.filter(p => p.name.trim()) : [],
    url: stdio ? '' : url.value.trim(),
    headers: stdio ? [] : headers.value.filter(p => p.name.trim()),
  })
}
</script>

<template>
  <form
    ref="form"
    class="mf"
    :aria-label="isNew ? 'New MCP server' : `Edit ${server.name}`"
    novalidate
    @submit.prevent="submit"
    @keydown.esc.stop.prevent="emit('cancel')"
  >
    <div class="mf__grid">
      <UiField label="Name" :for="ids.name" :error="touched.name ? nameError : null" hint="Its tools show up as mcp__name__tool.">
        <input
          :id="ids.name"
          v-model="name"
          class="input mf__mono"
          type="text"
          placeholder="github"
          autocomplete="off"
          autocapitalize="off"
          spellcheck="false"
          :aria-invalid="(touched.name && !!nameError) || undefined"
          @blur="touched.name = !!name"
        >
      </UiField>
      <div class="mf__field">
        <span :id="ids.agents" class="mf__label">Agents</span>
        <SettingsSegmented v-model="agents" :options="agentChoices" :labelledby="ids.agents" />
      </div>
    </div>

    <div class="mf__field">
      <span class="mf__label">Transport</span>
      <SettingsSegmented v-model="transport" :options="transports" label="Transport" />
    </div>

    <template v-if="transport === 'stdio'">
      <UiField label="Command" :for="ids.command" :error="touched.command ? commandError : null" :hint="commandHint">
        <input
          :id="ids.command"
          v-model="commandLine"
          class="input mf__mono"
          type="text"
          placeholder="npx -y @modelcontextprotocol/server-everything"
          autocomplete="off"
          autocapitalize="off"
          spellcheck="false"
          :aria-invalid="(touched.command && !!commandError) || undefined"
          @blur="touched.command = !!commandLine"
        >
      </UiField>
      <div class="mf__field">
        <span class="mf__label">Environment variables</span>
        <McpPairs v-model="env" kind="variable" @invalid="badPairs = $event" />
      </div>
    </template>
    <template v-else>
      <UiField
        label="URL"
        :for="ids.url"
        :error="touched.url ? urlError : null"
        :hint="remote ? 'Reached from inside the environment: localhost there is the environment itself.' : 'A streamable HTTP endpoint.'"
      >
        <input
          :id="ids.url"
          v-model="url"
          class="input mf__mono"
          type="url"
          placeholder="https://example.com/mcp"
          autocomplete="off"
          autocapitalize="off"
          spellcheck="false"
          :aria-invalid="(touched.url && !!urlError) || undefined"
          @blur="touched.url = !!url"
        >
      </UiField>
      <div class="mf__field">
        <span class="mf__label">Headers</span>
        <McpPairs v-model="headers" kind="header" @invalid="badPairs = $event" />
      </div>
    </template>

    <p class="mf__note">
      Values are kept in Mango's settings on this computer, readable only by your user.
      {{ remote ? 'They go to the environment over SSH with the agent\'s start command.' : 'They reach the agent\'s CLI through its environment, not its command line.' }}
    </p>

    <p v-if="error" class="mf__error selectable" role="alert"><CircleAlert aria-hidden="true" />{{ error }}</p>

    <div class="mf__actions">
      <UiButton size="sm" variant="ghost" @click="emit('cancel')">Cancel</UiButton>
      <UiButton size="sm" variant="primary" type="submit" :loading="busy">{{ isNew ? 'Add server' : 'Save' }}</UiButton>
    </div>
  </form>
</template>

<style scoped>
.mf { display: grid; gap: var(--space-4); }
.mf__grid { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: var(--space-4); align-items: start; }
.mf__grid :deep(.field + .field) { margin-top: 0; }
.mf__field { display: grid; justify-items: start; gap: 6px; }
.mf__label { font-size: var(--text-xs); font-weight: 560; color: var(--fg-muted); }
.mf :deep(.field + .field) { margin-top: 0; }
.mf__mono { font-family: var(--font-mono); font-size: var(--text-xs); }
.mf__note { margin: 0; max-width: 64ch; font-size: var(--text-xs); color: var(--fg-subtle); text-wrap: pretty; }
.mf__error {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  margin: 0;
  font-size: var(--text-sm);
  color: var(--ripe-error-fg);
}
.mf__error svg { flex: none; width: 15px; height: 15px; margin-top: 2px; stroke-width: 1.85; color: var(--ripe-error); }
.mf__actions { display: flex; justify-content: flex-end; gap: var(--space-2); }
</style>
