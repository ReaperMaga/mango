<script setup lang="ts">
import { ChevronDown, FolderCog, FolderOpen, FolderPlus, Gauge, GitBranch, GitFork, MapPin, Minus, PanelBottom, PanelLeft, Search, Server, Square, Sun, Moon, X, Folder } from 'lucide-vue-next'
import { useWorkspace } from '~/stores/workspace'
import { useEnvironments } from '~/stores/environments'
import { useThreads } from '~/stores/threads'
import { useUsage } from '~/stores/usage'
import { useGit } from '~/stores/git'
import { appWindow, isTauri } from '~/composables/useBackend'
import { openFolderFlow, modLabel } from '~/composables/useShortcuts'
import type { MenuItem } from '~/types/ui'
import { hasUnreadResult } from '~/types/chat'
import { isEnvPath } from '~/utils/envPath'

const ws = useWorkspace()
const threads = useThreads()
const usage = useUsage()
const mod = ref('Ctrl')
const native = ref(false)

/* Limits are read now and then in the background (it spends no quota), so an early reset is noticed
   while you work, not only when you open Usage. */
const USAGE_POLL_MS = 15 * 60_000
let usageTimer: ReturnType<typeof setInterval> | undefined
let usageFirst: ReturnType<typeof setTimeout> | undefined
onMounted(() => {
  mod.value = modLabel()
  native.value = isTauri()
  usageFirst = setTimeout(() => void usage.refreshReadable(), 4000)
  usageTimer = setInterval(() => void usage.refreshReadable(true), USAGE_POLL_MS)
})
onBeforeUnmount(() => { clearTimeout(usageFirst); clearInterval(usageTimer) })

/** The active project when it is a folder inside a remote environment. */
const remote = computed(() => remotePlace(ws.activeProjectPath))

/* A folder on this computer brings its branch when it opens; a remote one's comes from git in the
   environment: read it when the project becomes active and when the window comes back. */
const git = useGit()
function readRemoteBranch() {
  const path = ws.activeProjectPath
  if (isEnvPath(path) && document.visibilityState === 'visible') git.poll(path!)
}
watch(() => ws.activeProjectPath, readRemoteBranch, { immediate: true })
onMounted(() => window.addEventListener('focus', readRemoteBranch))
onBeforeUnmount(() => window.removeEventListener('focus', readRemoteBranch))

/*
 * The working copy in view: the active chat's worktree, or the project folder. The branch shown
 * (and switched) is that one's, so a chat working in its own worktree shows its own branch.
 */
const workdir = computed(() => threads.workdir ?? ws.activeProjectPath)
const branch = computed(() => {
  const at = workdir.value
  if (at && at !== ws.activeProjectPath) return git.status(at)?.branch ?? threads.activeThread?.branch ?? null
  return ws.activeProject?.branch ?? null
})
/* A worktree's status is read when it comes into view, so its branch is right from the start. */
watch(workdir, (at) => { if (at && at !== ws.activeProjectPath && !git.status(at)) git.poll(at) }, { immediate: true })

/* Where Open folder, New project and Clone put a project: chosen from its own menu, opened from the project menu. */
const envs = useEnvironments()
const where = computed(() => projectWhere())
const whereMenu = ref<{ show: () => void } | null>(null)
const whereMenuItems = computed(() => whereItems(where.value, w => ws.setWhere(w), () => envs.openView()))
// The saved servers name the places in the project menu (reading them is local and quick).
onMounted(() => { if (!envs.loaded) envs.load().catch(() => {}) })
function chooseWhere() {
  whereMenu.value?.show()
  void refreshEnvs()
}

const projectItems = computed<MenuItem[]>(() => [
  ...ws.openProjects.map(p => ({
    label: p.name,
    // A remote project says where it runs instead of a branch.
    hint: remotePlace(p.path)?.where ?? (p.branch ? p.branch : undefined),
    icon: isEnvPath(p.path) ? Server : Folder,
    checked: p.path === ws.activeProjectPath,
    onSelect: () => ws.setActiveProject(p.path),
  })),
  { label: 'Open folder…', icon: FolderOpen, kbd: `${mod.value}+O`, divider: ws.openProjects.length > 0, onSelect: openFolderFlow },
  { label: 'New project…', icon: FolderPlus, onSelect: () => (ws.dialog = 'new') },
  { label: 'Clone repository…', icon: GitFork, onSelect: () => (ws.dialog = 'clone') },
  ...(envs.hosts.length
    ? [{ label: 'Projects go to…', hint: where.value ? envLabels(where.value.hostId, where.value.instance).where : 'This computer', icon: MapPin, onSelect: chooseWhere }]
    : []),
  ...(ws.activeProject
    ? [
        { label: 'Project settings…', icon: FolderCog, divider: true, onSelect: () => ws.openSettings('project-env') },
        { label: `Close ${ws.activeProject.name}`, icon: X, onSelect: () => ws.closeProject(ws.activeProject!.path) },
      ]
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

      <UiMenu :items="projectItems" :width="280" label="Projects">
        <template #default="{ toggle, open }">
          <!-- The Where list opens from the project menu and hangs from the same button. -->
          <UiMenu ref="whereMenu" :items="whereMenuItems" :width="300" label="Projects go to">
            <template #default>
              <button type="button" class="tb__project" :class="{ 'is-open': open }" aria-haspopup="menu" :aria-expanded="open" @click="toggle">
                <span class="tb__project-name">{{ ws.activeProject?.name ?? 'No project' }}</span>
                <ChevronDown class="tb__chev" />
              </button>
            </template>
          </UiMenu>
        </template>
      </UiMenu>

      <!-- A remote project: where it runs. Next to a branch it is just the server mark (the place is in
           its tooltip and the Environment tool window); a folder without git shows the place itself. -->
      <button
        v-if="remote"
        type="button"
        class="tb__remote"
        :class="{ 'is-open': ws.toolPanel === 'env', 'is-compact': ws.activeProject?.isGit }"
        :title="`Remote environment: ${remote.where}, folder ${remote.dir}`"
        :aria-label="`Remote environment: ${remote.where}`"
        @click="ws.toggleEnv()"
      >
        <Server aria-hidden="true" />
        <span v-if="!ws.activeProject?.isGit" class="tb__remote-where">{{ remote.where }}</span>
      </button>
      <GitBranchPopup v-if="ws.activeProject?.isGit" :path="workdir">
        <template #default="{ toggle, open }">
          <button
            type="button"
            class="tb__branch"
            :class="{ 'is-open': open }"
            aria-haspopup="dialog"
            :aria-expanded="open"
            :title="open ? undefined : branch ? `Branch: ${branch}` : 'Branches'"
            @click="toggle"
          >
            <GitBranch />
            <!-- Unity VCS branches are paths: when space runs out, keep the end (…/feature/x) in view. -->
            <span :class="{ 'tb__branch-path': branch?.startsWith('/') }"><bdi>{{ branch ?? 'detached' }}</bdi></span>
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
      <UpdateIndicator />
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
        :label="usage.hasReset ? 'Usage limits: a limit was reset' : 'Usage limits'"
        :shortcut="`${mod}+Shift+U`"
        :active="ws.dialog === 'usage'"
        size="sm"
        @click="ws.openUsage()"
      >
        <span class="tb__gauge">
          <Gauge />
          <span v-if="usage.hasReset" class="tb__gauge-dot" aria-hidden="true" />
        </span>
      </UiIconButton>
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
/* Full bar height, so the window controls' hover fills the titlebar top to bottom. */
.tb__right { justify-content: flex-end; align-self: stretch; }
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
/* The project keeps its width; a long branch (Unity VCS paths such as /main/feature/x) is what gets cut short. */
.tb__left > :deep(.menu) { flex: none; }
.tb__project-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tb__chev { width: 14px; height: 14px; color: var(--fg-subtle); flex: none; }

.tb__remote {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
  height: 26px;
  padding: 0 6px;
  border-radius: var(--radius-sm);
  font-size: var(--text-xs);
  color: var(--fg-subtle);
  transition: background var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out);
}
.tb__remote:hover, .tb__remote.is-open { background: var(--bg-hover); color: var(--fg); }
.tb__remote svg { width: 13px; height: 13px; flex: none; stroke-width: 1.85; }
.tb__remote.is-compact { padding: 0 5px; }
.tb__remote-where { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.tb__branch {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  /* Enough for a short branch name. */
  min-width: 72px;
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
.tb__branch .tb__branch-path { direction: rtl; text-align: left; }

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
.tb__gauge { position: relative; display: inline-grid; place-items: center; }
/* A limit was reset early: a mark on the gauge, until it is dismissed in Usage. */
.tb__gauge-dot {
  position: absolute;
  top: -3px;
  right: -4px;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--ripe-queued);
  box-shadow: 0 0 0 2px var(--bg-app);
}
</style>
