<script setup lang="ts">
import { ChevronDown, Trash2 } from 'lucide-vue-next'
import { AGENTS, type AgentId, type PermissionMode } from '~/types/chat'
import type { MenuItem } from '~/types/ui'
import { useWorkspace, type ProjectPrefs } from '~/stores/workspace'
import { useThreads } from '~/stores/threads'
import { useModels } from '~/stores/models'
import { baseName } from '~/utils/paths'
import { isEnvPath, parseEnvPath } from '~/utils/envPath'
import SettingsSection from './SettingsSection.vue'
import SettingsRow from './SettingsRow.vue'
import SettingsSegmented from './SettingsSegmented.vue'
import SettingsSelect from './SettingsSelect.vue'
import SettingsSwitch from './SettingsSwitch.vue'
import ProjectEnv from './ProjectEnv.vue'
import McpServerList from './McpServerList.vue'
import { useMcp } from '~/stores/mcp'

/**
 * Settings > Projects: what one project overrides. Pick the project at the top; every row below applies
 * to it. Anything left alone follows the global default (Preferences).
 */
const ws = useWorkspace()
const threads = useThreads()
const models = useModels()
const nameId = useId()

/** Open projects first, then the recent ones that are closed (archived ones too: this is where they come back). */
const projects = computed(() => [
  ...ws.openProjects,
  ...ws.recent.filter(r => !ws.openProjects.some(o => o.path === r.path)),
])
/** The project being edited; follows the active one until another is picked. */
const picked = ref<string | null>(null)
const path = computed(() => {
  const p = picked.value && projects.value.some(x => x.path === picked.value) ? picked.value : ws.activeProjectPath
  return p ?? projects.value[0]?.path ?? null
})
const project = computed(() => projects.value.find(p => p.path === path.value) ?? null)
const prefs = computed<ProjectPrefs>(() => (path.value ? ws.projectPrefs[path.value] : undefined) ?? {})

const pickItems = computed<MenuItem[]>(() => projects.value.map(p => ({
  label: p.name,
  hint: ws.projectPrefs[p.path]?.archived ? 'Archived' : undefined,
  checked: p.path === path.value,
  onSelect: () => { picked.value = p.path },
})))

const folderName = (p: string) => {
  const loc = parseEnvPath(p)
  return loc ? (loc.dir === '/' ? loc.instance : baseName(loc.dir)) : baseName(p)
}
const set = (patch: Partial<Record<keyof ProjectPrefs, ProjectPrefs[keyof ProjectPrefs] | null>>) => {
  if (path.value) ws.setProjectPref(path.value, patch)
}

/* ---------- name ---------- */
const nameDraft = ref('')
watch(project, p => { nameDraft.value = p?.name ?? '' }, { immediate: true })
function commitName() {
  if (!path.value) return
  const v = nameDraft.value.trim()
  // Empty, or the folder's own name: back to automatic.
  set({ name: !v || v === folderName(path.value) ? null : v })
  nameDraft.value = project.value?.name ?? ''
}

/* ---------- icon ---------- */
const hues = [25, 60, 100, 150, 195, 255, 295, 340]

/* ---------- new chats ---------- */
type Choice<T extends string> = T | 'default'
const agents: Array<{ value: Choice<AgentId>; label: string }> = [
  { value: 'default', label: 'Default' },
  ...(Object.keys(AGENTS) as AgentId[]).map(id => ({ value: id, label: AGENTS[id].name })),
]
const modes: Array<{ value: Choice<PermissionMode>; label: string }> = [
  { value: 'default', label: 'Default' },
  { value: 'plan', label: 'Plan' },
  { value: 'ask', label: 'Ask first' },
  { value: 'edits', label: 'Accept edits' },
  { value: 'auto', label: 'Full auto' },
]
/** The agent new chats here start with: the project's own, else the global default. */
const agent = computed<AgentId>(() => prefs.value.agent ?? threads.defaultAgent)
const modelOptions = computed(() => [
  { value: '', label: 'Default' },
  ...models.list(agent.value).filter(m => m.id !== 'default').map(m => ({ value: m.id, label: m.label })),
])
function setAgent(v: string) {
  // The model belongs to an agent: a different agent starts from its own default.
  set({ agent: v === 'default' ? null : v as AgentId, model: null })
}

/* ---------- MCP servers ---------- */
const mcpHeadId = useId()
const mcpEl = ref<HTMLElement | null>(null)
/* Opened as "Project MCP servers" (palette): bring the block into view. */
onMounted(() => {
  if (ws.settingsAnchor !== 'project-mcp') return
  ws.settingsAnchor = null
  const reveal = () => mcpEl.value?.scrollIntoView({ block: 'start' })
  requestAnimationFrame(reveal)
  // Again once the blocks above have read their files and taken their height.
  setTimeout(reveal, 400)
})

/* ---------- archive and remove ---------- */
function toggleArchive() {
  if (!path.value) return
  const archive = !prefs.value.archived
  set({ archived: archive })
  if (archive) ws.closeProject(path.value)
}

/** Deletes the project's entry and its chats. Its folder is not touched. */
function askRemove() {
  const p = project.value
  if (!p) return
  ws.confirm = {
    title: `Remove ${p.name}?`,
    body: `${p.name}, all its chats and its MCP servers are removed from Mango. The folder on disk is not touched.`,
    label: 'Remove project',
    danger: true,
    run: async () => {
      for (const t of threads.threads.filter(x => x.projectPath === p.path && !x.parentId)) threads.remove(t.id)
      ws.closeProject(p.path)
      await ws.forgetProject(p.path)
      ws.setProjectPref(p.path, { name: null, pinned: null, agent: null, mode: null, model: null, color: null, archived: null, excluded: null, languageServers: null })
      ws.forgetEnvExtraFiles(p.path)
      await useMcp().forgetProject(p.path).catch(() => {})
      picked.value = null
    },
  }
}
</script>

<template>
  <SettingsSection title="Projects" description="Settings for one project. What you leave alone follows the defaults in Preferences.">
    <p v-if="!project" class="empty">Open a project to change its settings.</p>

    <template v-else>
      <div class="pick">
        <span class="pick__label">Applying settings for</span>
        <UiMenu :items="pickItems" :width="260" label="Project">
          <template #default="{ toggle, open }">
            <button type="button" class="pick__btn" :class="{ 'is-open': open }" aria-haspopup="menu" :aria-expanded="open" @click="toggle">
              <UiProjectBadge :name="project.name" :path="project.path" :hue="prefs.color" />
              <span class="pick__name">{{ project.name }}</span>
              <ChevronDown aria-hidden="true" />
            </button>
          </template>
        </UiMenu>
        <span v-if="isEnvPath(project.path)" class="pick__where">in an environment</span>
        <span v-if="prefs.archived" class="pick__where">Archived</span>
      </div>

      <div class="card">
        <SettingsRow label="Name" hint="Shown in the sidebar and the project lists. The folder is not renamed.">
          <template #default>
            <input
              :id="nameId"
              v-model="nameDraft"
              class="field"
              type="text"
              :placeholder="folderName(project.path)"
              aria-label="Project name"
              spellcheck="false"
              @change="commitName"
              @keydown.enter.prevent="($event.target as HTMLInputElement).blur()"
            >
          </template>
        </SettingsRow>
        <SettingsRow :label="'Project icon'" :hint="prefs.color === undefined ? 'Automatic' : 'Custom color'">
          <template #default="{ labelId }">
            <div class="icon" role="group" :aria-labelledby="labelId">
              <UiProjectBadge :name="project.name" :path="project.path" :hue="prefs.color" />
              <button
                v-for="h in hues"
                :key="h"
                type="button"
                class="hue"
                :class="{ 'is-on': prefs.color === h }"
                :style="{ '--badge-hue': h }"
                :aria-label="`Color ${h}`"
                :aria-pressed="prefs.color === h"
                @click="set({ color: h })"
              />
              <UiButton size="sm" variant="ghost" :disabled="prefs.color === undefined || undefined" @click="set({ color: null })">Automatic</UiButton>
            </div>
          </template>
        </SettingsRow>
        <SettingsRow label="Pin" hint="Pinned projects come first in the project lists.">
          <template #default="{ labelId }">
            <SettingsSwitch :model-value="!!prefs.pinned" :labelledby="labelId" @update:model-value="v => set({ pinned: v })" />
          </template>
        </SettingsRow>
        <SettingsRow label="Archive" hint="Hides the project from the Recent list. Chats and files are kept; opening the project brings it back.">
          <template #default>
            <UiButton size="sm" @click="toggleArchive">{{ prefs.archived ? 'Unarchive' : 'Archive' }}</UiButton>
          </template>
        </SettingsRow>
      </div>

      <h3 class="head">New chats</h3>
      <div class="card">
        <SettingsRow label="Agent" hint="The agent a new chat in this project starts with.">
          <template #default="{ labelId }">
            <SettingsSegmented :model-value="prefs.agent ?? 'default'" :options="agents" :labelledby="labelId" @update:model-value="setAgent" />
          </template>
        </SettingsRow>
        <SettingsRow label="Model" :hint="`Model for new chats in this project, for ${AGENTS[agent].name}.`">
          <template #default="{ labelId }">
            <SettingsSelect :model-value="prefs.model ?? ''" :options="modelOptions" :labelledby="labelId" label="Model" @update:model-value="v => set({ model: v || null })" />
          </template>
        </SettingsRow>
        <SettingsRow label="Permissions" hint="How much the agent may do before it checks with you.">
          <template #default="{ labelId }">
            <SettingsSegmented :model-value="prefs.mode ?? 'default'" :options="modes" :labelledby="labelId" @update:model-value="v => set({ mode: v === 'default' ? null : v as PermissionMode })" />
          </template>
        </SettingsRow>
      </div>

      <ProjectEnv :key="project.path" :root="project.path" :name="project.name" />

      <section ref="mcpEl" class="block" :aria-labelledby="mcpHeadId">
        <header class="block__head">
          <h3 :id="mcpHeadId" class="block__title">MCP servers</h3>
          <p class="block__desc">
            <template v-if="isEnvPath(project.path)">Tool servers for chats in {{ project.name }}. They start inside its environment, like its agents.</template>
            <template v-else>Tool servers for chats in {{ project.name }} only, on top of the ones for all projects. One with the same name takes the place of a server for all projects.</template>
          </p>
        </header>
        <McpServerList :key="project.path" :project="project.path" />
      </section>

      <h3 class="head">Danger</h3>
      <div class="card">
        <SettingsRow label="Remove project" hint="Deletes the project entry and its chats. Files on disk are not touched.">
          <template #default>
            <UiButton size="sm" variant="danger" @click="askRemove"><Trash2 /> Remove project</UiButton>
          </template>
        </SettingsRow>
      </div>
    </template>
  </SettingsSection>
</template>

<style scoped>
.empty { margin: 0; font-size: var(--text-sm); color: var(--fg-subtle); }

.pick { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2) var(--space-3); margin-bottom: var(--space-5); }
.pick__label { font-size: var(--text-sm); color: var(--fg-subtle); }
.pick__btn {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  height: 32px;
  max-width: 100%;
  padding: 0 var(--space-2);
  font-size: var(--text-sm);
  font-weight: 600;
  color: var(--fg);
  background: var(--bg-panel);
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
  transition: background var(--dur-fast) var(--ease-out);
}
.pick__btn:hover, .pick__btn.is-open { background: var(--bg-hover); }
.pick__btn svg { flex: none; width: 14px; height: 14px; color: var(--fg-subtle); }
.pick__name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pick__where { font-size: var(--text-xs); color: var(--fg-subtle); }

/* Rows sit in a bordered card, divided by hairlines. */
.card {
  border: 1px solid var(--line-soft);
  border-radius: var(--radius-md);
  background: var(--bg-panel);
}
.card :deep(.srow) { padding: var(--space-3) var(--space-4); }
.card :deep(.srow + .srow) { border-top: 1px solid var(--line-soft); }
.card :deep(.btn svg) { width: 14px; height: 14px; }

.head { margin: var(--space-6) 0 var(--space-3); font-size: var(--text-md); font-weight: 600; }

/* A block with a sentence under its heading, as Environment variables has. */
.block { scroll-margin-top: var(--space-5); }
.block__head { margin: var(--space-6) 0 var(--space-3); }
.block__title { margin: 0; font-size: var(--text-md); font-weight: 600; }
.block__desc { margin: var(--space-1) 0 0; max-width: 62ch; font-size: var(--text-sm); color: var(--fg-subtle); text-wrap: pretty; }

.icon { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: var(--space-2); }
.hue {
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: oklch(0.7 0.14 var(--badge-hue));
  outline: 2px solid transparent;
  outline-offset: 2px;
  transition: outline-color var(--dur-fast) var(--ease-out);
}
.hue:hover { outline-color: var(--line-strong); }
.hue.is-on { outline-color: var(--accent); }
.hue:focus-visible { outline-color: var(--focus-ring); }

.field {
  width: 220px;
  max-width: 100%;
  height: 28px;
  padding: 0 var(--space-2);
  font: inherit;
  font-size: var(--text-sm);
  color: var(--fg);
  background: var(--bg-inset);
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
}
.field:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 1px; }
.field::placeholder { color: var(--fg-faint); }
</style>
