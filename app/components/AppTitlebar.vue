<script setup lang="ts">
import { ChevronDown, FolderOpen, FolderPlus, GitBranch, GitFork, Minus, PanelBottom, PanelLeft, Search, Square, Sun, Moon, X, Folder } from 'lucide-vue-next'
import { useWorkspace } from '~/stores/workspace'
import { useThreads } from '~/stores/threads'
import { appWindow, isTauri } from '~/composables/useBackend'
import { openFolderFlow, modLabel } from '~/composables/useShortcuts'
import type { MenuItem } from '~/types/ui'
import { hasUnreadResult } from '~/types/chat'

const ws = useWorkspace()
const threads = useThreads()
const mod = ref('Ctrl')
const native = ref(false)
onMounted(() => { mod.value = modLabel(); native.value = isTauri() })

const projectItems = computed<MenuItem[]>(() => [
  ...ws.openProjects.map(p => ({
    label: p.name,
    hint: p.branch ? p.branch : undefined,
    icon: Folder,
    checked: p.path === ws.activeProjectPath,
    onSelect: () => ws.setActiveProject(p.path),
  })),
  { label: 'Open folder…', icon: FolderOpen, kbd: `${mod.value}+O`, divider: ws.openProjects.length > 0, onSelect: openFolderFlow },
  { label: 'New project…', icon: FolderPlus, onSelect: () => (ws.dialog = 'new') },
  { label: 'Clone repository…', icon: GitFork, onSelect: () => (ws.dialog = 'clone') },
  ...(ws.activeProject
    ? [{ label: `Close ${ws.activeProject.name}`, icon: X, divider: true, onSelect: () => ws.closeProject(ws.activeProject!.path) }]
    : []),
])

/** Threads that want the user: waiting for approval or finished and unread. */
const attention = computed(() => threads.threads.filter(t => (!t.archived && t.status === 'waiting') || hasUnreadResult(t)))
function jumpToAttention() {
  const t = attention.value.find(x => x.status === 'waiting') ?? attention.value[0]
  if (!t) return
  if (t.projectPath !== ws.activeProjectPath) ws.setActiveProject(t.projectPath)
  threads.show(t.id)
}

const isDark = computed(() => ws.resolvedTheme() === 'dark' && ws.theme !== 'light')
</script>

<template>
  <header class="tb" data-tauri-drag-region @dblclick.self="appWindow.toggleMaximize()">
    <div class="tb__left" data-tauri-drag-region>
      <UiMangoMark :size="18" class="tb__mark" />
      <UiIconButton
        v-if="ws.hasProject"
        label="Toggle sidebar"
        :shortcut="`${mod}+B`"
        :active="ws.sidebarOpen"
        size="sm"
        @click="ws.toggleSidebar()"
      >
        <PanelLeft />
      </UiIconButton>

      <UiMenu :items="projectItems" :width="260" label="Projects">
        <template #default="{ toggle, open }">
          <button type="button" class="tb__project" :class="{ 'is-open': open }" aria-haspopup="menu" :aria-expanded="open" @click="toggle">
            <span class="tb__project-name">{{ ws.activeProject?.name ?? 'No project' }}</span>
            <ChevronDown class="tb__chev" />
          </button>
        </template>
      </UiMenu>

      <GitBranchPopup v-if="ws.activeProject?.isGit" :path="ws.activeProjectPath">
        <template #default="{ toggle, open }">
          <button
            type="button"
            class="tb__branch"
            :class="{ 'is-open': open }"
            aria-haspopup="dialog"
            :aria-expanded="open"
            :title="open ? undefined : 'Branches'"
            @click="toggle"
          >
            <GitBranch />
            <span>{{ ws.activeProject.branch ?? 'detached' }}</span>
            <ChevronDown class="tb__chev" />
          </button>
        </template>
      </GitBranchPopup>
    </div>

    <div class="tb__center" data-tauri-drag-region>
      <button type="button" class="tb__search" @click="ws.paletteOpen = true">
        <Search />
        <span>Search threads or run a command</span>
        <kbd>{{ mod }}</kbd><kbd>K</kbd>
      </button>
    </div>

    <div class="tb__right" data-tauri-drag-region>
      <button
        v-if="attention.length"
        type="button"
        class="tb__attention"
        :title="`${attention.length} thread${attention.length === 1 ? '' : 's'} need you`"
        @click="jumpToAttention"
      >
        <UiRipenessDot :status="attention.some(t => t.status === 'waiting') ? 'waiting' : 'done'" :size="9" />
        <span class="tabular">{{ attention.length }}</span>
      </button>

      <UiIconButton
        v-if="ws.hasProject"
        label="Toggle terminal"
        :shortcut="`${mod}+\``"
        :active="ws.terminalOpen"
        size="sm"
        @click="ws.toggleTerminal()"
      >
        <PanelBottom />
      </UiIconButton>
      <UiIconButton :label="isDark ? 'Switch to light theme' : 'Switch to dark theme'" size="sm" @click="ws.cycleTheme()">
        <Moon v-if="isDark" />
        <Sun v-else />
      </UiIconButton>

      <div v-if="native" class="tb__win">
        <button type="button" class="tb__win-btn" aria-label="Minimize" @click="appWindow.minimize()"><Minus /></button>
        <button type="button" class="tb__win-btn" aria-label="Maximize" @click="appWindow.toggleMaximize()"><Square class="tb__sq" /></button>
        <button type="button" class="tb__win-btn tb__win-btn--close" aria-label="Close" @click="appWindow.close()"><X /></button>
      </div>
    </div>
  </header>
</template>

<style scoped>
.tb {
  display: grid;
  grid-template-columns: 1fr minmax(240px, 460px) 1fr;
  align-items: center;
  gap: var(--space-3);
  height: var(--titlebar-h);
  padding-left: var(--space-3);
  background: var(--bg-app);
  position: relative;
  z-index: 20;
}
.tb__left, .tb__right { display: flex; align-items: center; gap: var(--space-1); min-width: 0; }
.tb__right { justify-content: flex-end; }
.tb__mark { margin-right: var(--space-2); }

.tb__project {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 26px;
  margin-left: var(--space-1);
  padding: 0 6px 0 8px;
  border-radius: var(--radius-sm);
  font-weight: 600;
  font-size: var(--text-sm);
  color: var(--fg);
  max-width: 240px;
  transition: background var(--dur-fast) var(--ease-out);
}
.tb__project:hover, .tb__project.is-open { background: var(--bg-hover); }
.tb__project-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tb__chev { width: 14px; height: 14px; color: var(--fg-subtle); flex: none; }

.tb__branch {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
  height: 26px;
  border-radius: var(--radius-sm);
  transition: background var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out);
  padding: 0 4px 0 6px;
  font-size: var(--text-xs);
  color: var(--fg-subtle);
  font-family: var(--font-mono);
}
.tb__branch:hover, .tb__branch.is-open { background: var(--bg-hover); color: var(--fg); }
.tb__branch svg { width: 13px; height: 13px; flex: none; }
.tb__branch span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.tb__search {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  height: 28px;
  padding: 0 6px 0 10px;
  border-radius: var(--radius-sm);
  background: var(--bg-hover);
  border: 1px solid var(--line-soft);
  color: var(--fg-faint);
  font-size: var(--text-sm);
  transition: border-color var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out);
}
.tb__search:hover { border-color: var(--line-strong); color: var(--fg-subtle); }
.tb__search svg { width: 14px; height: 14px; flex: none; }
.tb__search span { flex: 1; text-align: left; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tb__search kbd + kbd { margin-left: -4px; }

.tb__attention {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 22px;
  padding: 0 8px;
  margin-right: var(--space-1);
  border-radius: var(--radius-pill);
  font-size: var(--text-xs);
  font-weight: 600;
  color: var(--fg-muted);
  background: var(--bg-hover);
}
.tb__attention:hover { color: var(--fg); background: var(--bg-active); }

.tb__win { display: flex; margin-left: var(--space-2); align-self: stretch; }
.tb__win-btn {
  width: 44px;
  display: grid;
  place-items: center;
  color: var(--fg-subtle);
  transition: background var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out);
}
.tb__win-btn svg { width: 15px; height: 15px; stroke-width: 1.5; }
.tb__win-btn .tb__sq { width: 12px; height: 12px; }
.tb__win-btn:hover { background: var(--bg-hover); color: var(--fg); }
.tb__win-btn--close:hover { background: var(--ripe-error); color: white; }
.tb:not(:has(.tb__win)) { padding-right: var(--space-3); }
</style>
