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
const { t } = useI18n()
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
  hint: ws.projectPrefs[p.path]?.archived ? t('settings.projects.archived') : undefined,
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
const agents = computed<Array<{ value: Choice<AgentId>; label: string }>>(() => [
  { value: 'default', label: t('settings.projects.default') },
  ...(Object.keys(AGENTS) as AgentId[]).map(id => ({ value: id, label: AGENTS[id].name })),
])
const modes = computed<Array<{ value: Choice<PermissionMode>; label: string }>>(() => [
  { value: 'default', label: t('settings.projects.default') },
  { value: 'plan', label: t('general.modes.plan.label') },
  { value: 'ask', label: t('general.modes.ask.label') },
  { value: 'edits', label: t('general.modes.edits.label') },
  { value: 'auto', label: t('general.modes.auto.label') },
])
/** The agent new chats here start with: the project's own, else the global default. */
const agent = computed<AgentId>(() => prefs.value.agent ?? threads.defaultAgent)
const modelOptions = computed(() => [
  { value: '', label: t('settings.projects.default') },
  ...models.list(agent.value, path.value).filter(m => m.id !== 'default').map(m => ({ value: m.id, label: m.label })),
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
    title: t('settings.projects.removeTitle', { name: p.name }),
    body: t('settings.projects.removeBody', { name: p.name }),
    label: t('settings.projects.remove'),
    danger: true,
    run: async () => {
      for (const thread of threads.threads.filter(x => x.projectPath === p.path && !x.parentId)) threads.remove(thread.id)
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
  <SettingsSection :title="t('settings.nav.projects')" :description="t('settings.projects.description')">
    <p v-if="!project" class="empty">{{ t('settings.projects.empty') }}</p>

    <template v-else>
      <div class="pick">
        <span class="pick__label">{{ t('settings.projects.applying') }}</span>
        <UiMenu :items="pickItems" :width="260" :label="t('settings.projects.project')">
          <template #default="{ toggle, open }">
            <button type="button" class="pick__btn" :class="{ 'is-open': open }" aria-haspopup="menu" :aria-expanded="open" @click="toggle">
              <UiProjectBadge :name="project.name" :path="project.path" :hue="prefs.color" />
              <span class="pick__name">{{ project.name }}</span>
              <ChevronDown aria-hidden="true" />
            </button>
          </template>
        </UiMenu>
        <span v-if="isEnvPath(project.path)" class="pick__where">{{ t('settings.projects.inEnv') }}</span>
        <span v-if="prefs.archived" class="pick__where">{{ t('settings.projects.archived') }}</span>
      </div>

      <div class="card">
        <SettingsRow :label="t('settings.projects.name')" :hint="t('settings.projects.nameHint')">
          <template #default>
            <input
              :id="nameId"
              v-model="nameDraft"
              class="field"
              type="text"
              :placeholder="folderName(project.path)"
              :aria-label="t('settings.projects.projectName')"
              spellcheck="false"
              @change="commitName"
              @keydown.enter.prevent="($event.target as HTMLInputElement).blur()"
            >
          </template>
        </SettingsRow>
        <SettingsRow :label="t('settings.projects.icon')" :hint="prefs.color === undefined ? t('settings.projects.automatic') : t('settings.projects.customColor')">
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
                :aria-label="t('settings.projects.color', { hue: h })"
                :aria-pressed="prefs.color === h"
                @click="set({ color: h })"
              />
              <UiButton size="sm" variant="ghost" :disabled="prefs.color === undefined || undefined" @click="set({ color: null })">{{ t('settings.projects.automatic') }}</UiButton>
            </div>
          </template>
        </SettingsRow>
        <SettingsRow :label="t('settings.projects.pin')" :hint="t('settings.projects.pinHint')">
          <template #default="{ labelId }">
            <SettingsSwitch :model-value="!!prefs.pinned" :labelledby="labelId" @update:model-value="v => set({ pinned: v })" />
          </template>
        </SettingsRow>
        <SettingsRow :label="t('settings.projects.archive')" :hint="t('settings.projects.archiveHint')">
          <template #default>
            <UiButton size="sm" @click="toggleArchive">{{ prefs.archived ? t('settings.projects.unarchive') : t('settings.projects.archive') }}</UiButton>
          </template>
        </SettingsRow>
      </div>

      <h3 class="head">{{ t('settings.projects.newChats') }}</h3>
      <div class="card">
        <SettingsRow :label="t('settings.projects.agent')" :hint="t('settings.projects.agentHint')">
          <template #default="{ labelId }">
            <SettingsSegmented :model-value="prefs.agent ?? 'default'" :options="agents" :labelledby="labelId" @update:model-value="setAgent" />
          </template>
        </SettingsRow>
        <SettingsRow :label="t('settings.projects.model')" :hint="t('settings.projects.modelHint', { agent: AGENTS[agent].name })">
          <template #default="{ labelId }">
            <SettingsSelect :model-value="prefs.model ?? ''" :options="modelOptions" :labelledby="labelId" :label="t('settings.projects.model')" @update:model-value="v => set({ model: v || null })" />
          </template>
        </SettingsRow>
        <SettingsRow :label="t('settings.projects.permissions')" :hint="t('settings.projects.permissionsHint')">
          <template #default="{ labelId }">
            <SettingsSegmented :model-value="prefs.mode ?? 'default'" :options="modes" :labelledby="labelId" @update:model-value="v => set({ mode: v === 'default' ? null : v as PermissionMode })" />
          </template>
        </SettingsRow>
      </div>

      <ProjectEnv :key="project.path" :root="project.path" :name="project.name" />

      <section ref="mcpEl" class="block" :aria-labelledby="mcpHeadId">
        <header class="block__head">
          <h3 :id="mcpHeadId" class="block__title">{{ t('settings.nav.mcp') }}</h3>
          <p class="block__desc">
            <template v-if="isEnvPath(project.path)">{{ t('settings.projects.mcpRemote', { name: project.name }) }}</template>
            <template v-else>{{ t('settings.projects.mcpLocal', { name: project.name }) }}</template>
          </p>
        </header>
        <McpServerList :key="project.path" :project="project.path" />
      </section>

      <h3 class="head">{{ t('settings.projects.danger') }}</h3>
      <div class="card">
        <SettingsRow :label="t('settings.projects.remove')" :hint="t('settings.projects.removeHint')">
          <template #default>
            <UiButton size="sm" variant="danger" @click="askRemove"><Trash2 /> {{ t('settings.projects.remove') }}</UiButton>
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
