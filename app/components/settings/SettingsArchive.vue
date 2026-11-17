<script setup lang="ts">
import { Archive, ArchiveRestore, Trash2 } from 'lucide-vue-next'
import { AGENTS } from '~/types/chat'
import { useThreads } from '~/stores/threads'
import { useWorkspace } from '~/stores/workspace'
import { baseName } from '~/utils/paths'
import { shortAgo, useNow } from '~/utils/time'
import SettingsSection from './SettingsSection.vue'
import SettingsSelect from './SettingsSelect.vue'

/** Settings > Archive: every archived chat, newest first, to bring back or delete. */
const threads = useThreads()
const ws = useWorkspace()
const now = useNow()
const filterId = useId()

/** '' is every project. */
const project = ref('')

const archived = computed(() =>
  threads.threads.filter(t => t.archived && !t.parentId).sort((a, b) => b.updatedAt - a.updatedAt))
/** Projects that have archived chats, by name. */
const projects = computed(() => {
  const paths = [...new Set(archived.value.map(t => t.projectPath))]
  return paths.map(path => ({ path, name: projectName(path) })).sort((a, b) => a.name.localeCompare(b.name))
})
const filterOptions = computed(() => [{ value: '', label: 'All projects' }, ...projects.value.map(p => ({ value: p.path, label: p.name }))])
const shown = computed(() => archived.value.filter(t => !project.value || t.projectPath === project.value))
// A filter whose last chat was restored or deleted falls back to every project.
watch(projects, (list) => { if (project.value && !list.some(p => p.path === project.value)) project.value = '' })

function projectName(path: string) {
  return ws.openProjects.find(p => p.path === path)?.name ?? ws.recent.find(p => p.path === path)?.name ?? baseName(path)
}

function askDelete(id: string, title: string) {
  ws.confirmThen(
    'delete',
    { title: 'Delete chat?', body: `“${title}” and its messages are deleted for good.`, label: 'Delete chat', danger: true },
    () => threads.remove(id),
  )
}
</script>

<template>
  <SettingsSection title="Archive" description="Chats you archived. Restore one to bring it back to the sidebar.">
    <div v-if="projects.length > 1" class="filter">
      <span :id="filterId" class="filter__label">Show chats from</span>
      <SettingsSelect v-model="project" :options="filterOptions" :labelledby="filterId" label="Project" />
    </div>

    <ul v-if="shown.length" class="list" role="list">
      <li v-for="t in shown" :key="t.id" class="row">
        <div class="row__text">
          <span class="row__title" :title="t.title">{{ t.title }}</span>
          <span class="row__meta">{{ projectName(t.projectPath) }} · {{ AGENTS[t.agent].name }} · <span class="tabular">{{ shortAgo(t.updatedAt, now) }}</span></span>
        </div>
        <UiButton size="sm" variant="ghost" @click="threads.unarchive(t.id)"><ArchiveRestore /> Restore</UiButton>
        <UiIconButton size="sm" label="Delete chat" @click="askDelete(t.id, t.title)"><Trash2 /></UiIconButton>
      </li>
    </ul>

    <div v-else class="empty">
      <Archive class="empty__icon" aria-hidden="true" />
      <div>
        <p class="empty__title">No archived chats</p>
        <p class="empty__hint">Archived chats will appear here.</p>
      </div>
    </div>
  </SettingsSection>
</template>

<style scoped>
.filter { display: flex; align-items: center; gap: var(--space-3); margin-bottom: var(--space-4); }
.filter__label { font-size: var(--text-sm); color: var(--fg-subtle); }

.list { list-style: none; margin: 0; padding: 0; border-top: 1px solid var(--line-soft); }
.row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-height: 52px;
  padding: var(--space-2) 0;
  border-bottom: 1px solid var(--line-soft);
}
.row__text { flex: 1; min-width: 0; display: grid; gap: 1px; }
.row__title { font-size: var(--text-sm); font-weight: 560; color: var(--fg); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.row__meta { font-size: var(--text-xs); color: var(--fg-subtle); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.row :deep(.btn svg),
.row :deep(.icon-btn svg) { width: 14px; height: 14px; }

.empty {
  display: flex;
  align-items: flex-start;
  gap: var(--space-3);
  padding: var(--space-4) 0;
  border-top: 1px solid var(--line-soft);
  border-bottom: 1px solid var(--line-soft);
}
.empty__icon { flex: none; width: 16px; height: 16px; margin-top: 2px; stroke-width: 1.75; color: var(--fg-subtle); }
.empty__title { margin: 0; font-size: var(--text-sm); font-weight: 560; color: var(--fg); }
.empty__hint { margin: 2px 0 0; font-size: var(--text-xs); color: var(--fg-subtle); }
</style>
