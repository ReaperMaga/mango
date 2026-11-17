<script setup lang="ts">
import { CircleAlert, Pencil, Plus, Trash2 } from 'lucide-vue-next'
import type { McpServerConfig } from '~/types/ipc'
import { useMcp } from '~/stores/mcp'
import { useWorkspace } from '~/stores/workspace'
import { isEnvPath } from '~/utils/envPath'
import { joinCommandLine } from '~/utils/mcpServers'
import SettingsSwitch from './SettingsSwitch.vue'
import McpServerForm from './McpServerForm.vue'

/**
 * The MCP servers of one scope: every project on this computer (`project` null), or one project's
 * own. A project's list also shows the servers set for all projects and whether it gets them.
 * Adding and editing happen in place; removing asks first.
 */
const props = defineProps<{ project: string | null }>()
const mcp = useMcp()
const ws = useWorkspace()

onMounted(() => { void mcp.load() })

const remote = computed(() => !!props.project && isEnvPath(props.project))
const own = computed(() => (props.project === null ? mcp.global : mcp.ofProject(props.project)))
/** For a project: the global servers, and whether it gets each one. */
const inherited = computed(() => (props.project === null ? [] : mcp.inEffect(props.project).filter(e => e.scope === 'global')))

const error = ref<string | null>(null)
const busy = ref(false)
/** The server being edited (its id), 'new' while adding, or null. */
const editing = ref<string | null>(null)
const removing = ref<string | null>(null)
const listEl = ref<HTMLElement | null>(null)

const blank = (): McpServerConfig => ({
  id: '', name: '', project: props.project, enabled: true, agents: ['claude', 'codex'],
  transport: 'stdio', command: '', args: [], env: [], url: '', headers: [],
})
const draft = ref<McpServerConfig>(blank())

/** Names already used in this scope, for the form's check. */
const taken = (except: string) => own.value.filter(s => s.id !== except).map(s => s.name.toLowerCase())

function startAdd() {
  draft.value = blank()
  editing.value = 'new'
  removing.value = null
  error.value = null
}
function startEdit(s: McpServerConfig) {
  editing.value = s.id
  removing.value = null
  error.value = null
}
function stopEditing() {
  const was = editing.value
  editing.value = null
  error.value = null
  // Back to where the edit started: the server's Edit button, or Add server.
  void nextTick(() => listEl.value?.querySelector<HTMLElement>(was && was !== 'new' ? `[data-edit="${was}"]` : '.mcp__add')?.focus())
}

async function run(job: () => Promise<unknown>) {
  busy.value = true
  error.value = null
  try {
    await job()
    return true
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
    return false
  } finally {
    busy.value = false
  }
}

async function save(server: McpServerConfig) {
  if (await run(() => mcp.put(server))) stopEditing()
}
async function toggle(s: McpServerConfig, on: boolean) {
  await run(() => mcp.setEnabled(s.id, on))
}
function askRemove(s: McpServerConfig) {
  removing.value = s.id
  editing.value = null
  void nextTick(() => listEl.value?.querySelector<HTMLElement>('.mcp__ask [data-autofocus]')?.focus())
}
async function remove(s: McpServerConfig) {
  if (await run(() => mcp.remove(s.id))) {
    removing.value = null
    void nextTick(() => listEl.value?.querySelector<HTMLElement>('.mcp__add')?.focus())
  }
}
function keep() {
  const id = removing.value
  removing.value = null
  void nextTick(() => listEl.value?.querySelector<HTMLElement>(`[data-remove="${id}"]`)?.focus())
}

/* ---------- how a row reads ---------- */

const agentsLabel = (s: McpServerConfig) =>
  s.agents.length > 1 ? 'Claude Code and Codex' : s.agents[0] === 'claude' ? 'Claude Code only' : 'Codex only'
const target = (s: McpServerConfig) => (s.transport === 'stdio' ? joinCommandLine(s.command, s.args) : s.url)
/** How many secrets it holds; their values are never shown in the list. */
function secrets(s: McpServerConfig) {
  const n = s.transport === 'stdio' ? s.env.length : s.headers.length
  if (!n) return ''
  return s.transport === 'stdio' ? `${n} ${n === 1 ? 'variable' : 'variables'}` : `${n} ${n === 1 ? 'header' : 'headers'}`
}
const meta = (s: McpServerConfig) => [s.transport === 'stdio' ? 'Command' : 'HTTP', agentsLabel(s), secrets(s)].filter(Boolean).join(' · ')

function inheritedState(e: { server: McpServerConfig; skipped?: 'replaced' | 'remote' }) {
  if (e.skipped === 'replaced') return 'Replaced by this project\'s own'
  if (e.skipped === 'remote') return 'Not used in an environment'
  return e.server.enabled ? 'Used here' : 'Off'
}

const rowId = (s: McpServerConfig) => `mcp-row-${s.id}`
</script>

<template>
  <div ref="listEl" class="mcp">
    <p v-if="mcp.loadError" class="mcp__error selectable" role="alert">
      <CircleAlert aria-hidden="true" />The servers could not be read. {{ mcp.loadError }}
    </p>

    <div v-if="own.length || editing === 'new'" class="mcp__card">
      <template v-for="s in own" :key="s.id">
        <div v-if="editing === s.id" class="mcp__edit">
          <McpServerForm :server="s" :taken="taken(s.id)" :remote="remote" :busy="busy" :error="error" @save="save" @cancel="stopEditing" />
        </div>
        <div v-else class="mcp__item">
          <div class="mcp__row" :class="{ 'is-off': !s.enabled }">
            <SettingsSwitch
              :model-value="s.enabled"
              :labelledby="rowId(s)"
              :title="s.enabled ? `Turn ${s.name} off` : `Turn ${s.name} on`"
              @update:model-value="v => toggle(s, v)"
            />
            <div class="mcp__text">
              <div class="mcp__line">
                <span :id="rowId(s)" class="mcp__name" :title="s.name">{{ s.name }}</span>
                <span class="mcp__meta">{{ meta(s) }}</span>
              </div>
              <div class="mcp__target selectable" :title="target(s)">{{ target(s) }}</div>
            </div>
            <div class="mcp__actions">
              <UiIconButton size="sm" :label="`Edit ${s.name}`" :data-edit="s.id" @click="startEdit(s)"><Pencil /></UiIconButton>
              <UiIconButton size="sm" :label="`Remove ${s.name}`" :data-remove="s.id" @click="askRemove(s)"><Trash2 /></UiIconButton>
            </div>
          </div>
          <div
            v-if="removing === s.id"
            class="mcp__ask"
            role="alertdialog"
            :aria-label="`Remove ${s.name}`"
            @keydown.esc.stop.prevent="keep"
          >
            <p class="mcp__ask-text">
              Remove <strong>{{ s.name }}</strong> and its settings? A chat that is answering keeps it until the answer ends.
            </p>
            <UiButton size="sm" variant="ghost" data-autofocus @click="keep">Keep</UiButton>
            <UiButton size="sm" variant="danger" :loading="busy" @click="remove(s)">Remove server</UiButton>
          </div>
        </div>
      </template>
      <div v-if="editing === 'new'" class="mcp__edit">
        <McpServerForm :server="draft" :taken="taken('')" :remote="remote" :busy="busy" :error="error" @save="save" @cancel="stopEditing" />
      </div>
    </div>

    <p v-else-if="mcp.loaded" class="mcp__empty">
      <template v-if="project === null">
        No servers yet. A server added here is offered to chats in every project on this computer;
        a project can add its own under Projects.
      </template>
      <template v-else-if="remote">
        This project has no servers of its own. Its agents run inside the environment, so its servers start there too.
      </template>
      <template v-else>This project has no servers of its own.</template>
    </p>

    <p v-if="error && !editing" class="mcp__error selectable" role="alert"><CircleAlert aria-hidden="true" />{{ error }}</p>

    <UiButton v-if="editing !== 'new'" size="sm" class="mcp__add" @click="startAdd"><Plus />Add server</UiButton>

    <div v-if="project !== null && inherited.length" class="mcp__inherited">
      <div class="mcp__sub">
        <h4 class="mcp__sub-title">For all projects</h4>
        <UiButton size="sm" variant="ghost" @click="ws.openSettings('mcp')">Manage</UiButton>
      </div>
      <ul class="mcp__plain">
        <li v-for="e in inherited" :key="e.server.id" class="mcp__plain-row" :class="{ 'is-off': e.skipped || !e.server.enabled }">
          <span class="mcp__name" :title="e.server.name">{{ e.server.name }}</span>
          <span class="mcp__target" :title="target(e.server)">{{ target(e.server) }}</span>
          <span class="mcp__state">{{ inheritedState(e) }}</span>
        </li>
      </ul>
    </div>
  </div>
</template>

<style scoped>
.mcp { display: grid; justify-items: start; gap: var(--space-3); }
.mcp > * { width: 100%; }
.mcp > .mcp__add { width: auto; }

.mcp__card {
  border: 1px solid var(--line-soft);
  border-radius: var(--radius-md);
  background: var(--bg-panel);
}
.mcp__card > * + * { border-top: 1px solid var(--line-soft); }

.mcp__row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  min-height: 52px;
  padding: var(--space-2) var(--space-2) var(--space-2) var(--space-4);
}
.mcp__text { flex: 1; min-width: 0; display: grid; gap: 2px; }
.mcp__line { display: flex; align-items: baseline; gap: var(--space-2); min-width: 0; }
.mcp__name {
  flex: none;
  max-width: 50%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--text-sm);
  font-weight: 560;
  color: var(--fg);
}
.mcp__meta {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--text-xs);
  color: var(--fg-subtle);
}
.mcp__target {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--fg-subtle);
}
.mcp__row.is-off .mcp__name { color: var(--fg-muted); font-weight: 520; }
.mcp__actions { flex: none; display: flex; gap: 2px; }

.mcp__edit { padding: var(--space-4); }

/* Removing: the question under the row, the safe answer first and focused. */
.mcp__ask {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  margin: 0 var(--space-2) var(--space-2);
  padding: var(--space-2) var(--space-2) var(--space-2) var(--space-3);
  border: 1px solid color-mix(in oklch, var(--ripe-error) 35%, transparent);
  border-radius: var(--radius-sm);
  background: color-mix(in oklch, var(--ripe-error) 7%, transparent);
}
.mcp__ask-text { flex: 1 1 30ch; margin: 0; font-size: var(--text-sm); color: var(--fg-muted); text-wrap: pretty; }
.mcp__ask-text strong { font-weight: 600; color: var(--fg); }

.mcp__empty { margin: 0; max-width: 62ch; font-size: var(--text-sm); color: var(--fg-subtle); text-wrap: pretty; }
.mcp__error {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  margin: 0;
  font-size: var(--text-sm);
  color: var(--ripe-error-fg);
}
.mcp__error svg { flex: none; width: 15px; height: 15px; margin-top: 2px; stroke-width: 1.85; color: var(--ripe-error); }
.mcp :deep(.btn svg) { width: 14px; height: 14px; }

/* A project's view of the global servers: plain lines, no controls but Manage. */
.mcp__inherited { display: grid; gap: var(--space-1); margin-top: var(--space-2); }
.mcp__sub { display: flex; align-items: center; justify-content: space-between; gap: var(--space-2); }
.mcp__sub-title { margin: 0; font-size: var(--text-xs); font-weight: 600; color: var(--fg-muted); }
.mcp__plain { display: grid; margin: 0; padding: 0; list-style: none; }
.mcp__plain-row {
  display: grid;
  grid-template-columns: minmax(0, max-content) minmax(0, 1fr) auto;
  align-items: baseline;
  gap: var(--space-3);
  min-height: 28px;
  padding: var(--space-1) 0;
  border-top: 1px solid var(--line-soft);
}
.mcp__plain-row .mcp__name { max-width: 24ch; }
.mcp__state { font-size: var(--text-xs); color: var(--fg-subtle); white-space: nowrap; }
.mcp__plain-row.is-off .mcp__name { color: var(--fg-muted); font-weight: 520; }
</style>
