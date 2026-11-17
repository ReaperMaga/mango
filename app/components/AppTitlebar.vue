<script setup lang="ts">
import { ChevronDown, FolderCog, FolderOpen, FolderPlus, GitBranch, GitFork, MapPin, Minus, PanelBottom, PanelLeft, PanelRight, Search, Server, Settings, Square, X } from 'lucide-vue-next'
import { useWorkspace } from '~/stores/workspace'
import { useEnvironments } from '~/stores/environments'
import { useThreads } from '~/stores/threads'
import { useUsage } from '~/stores/usage'
import { useGit } from '~/stores/git'
import { appWindow, isTauri } from '~/composables/useBackend'
import { openFolderFlow, modLabel } from '~/composables/useShortcuts'
import type { MenuItem } from '~/types/ui'
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
    // One line each: the branch beside the name, or for a remote project where it runs.
    aside: remotePlace(p.path)?.where ?? (p.branch || undefined),
    asideMono: !remotePlace(p.path) && !!p.branch,
    icon: projectIcon(p.name, p.path, ws.projectPrefs[p.path]?.color),
    checked: p.path === ws.activeProjectPath,
    onSelect: () => ws.setActiveProject(p.path),
    remove: { label: `Close ${p.name}`, onSelect: () => ws.closeProject(p.path) },
  })),
  { label: 'Open folder…', icon: FolderOpen, kbd: `${mod.value}+O`, divider: ws.openProjects.length > 0, onSelect: openFolderFlow },
  { label: 'New project…', icon: FolderPlus, onSelect: () => (ws.dialog = 'new') },
  { label: 'Clone repository…', icon: GitFork, onSelect: () => (ws.dialog = 'clone') },
  ...(envs.hosts.length
    ? [{ label: 'Projects go to…', aside: where.value ? envLabels(where.value.hostId, where.value.instance).where : 'This computer', icon: MapPin, onSelect: chooseWhere }]
    : []),
  ...(ws.activeProject
    ? [
        { label: 'Project settings…', icon: FolderCog, divider: true, onSelect: () => ws.openSettings('projects') },
      ]
    : []),
])

/* The quiet sync part of the branch widget: commits to push / pull and changed files of the working copy in view. */
const gitStatus = computed(() => git.status(workdir.value))
const ahead = computed(() => gitStatus.value?.ahead ?? 0)
const behind = computed(() => gitStatus.value?.behind ?? 0)
const changed = computed(() => gitStatus.value?.files.length ?? 0)
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`
const branchTitle = computed(() => {
  const bits = [
    ahead.value ? `${plural(ahead.value, 'commit')} to push` : '',
    behind.value ? `${plural(behind.value, 'commit')} to pull` : '',
    changed.value ? `${plural(changed.value, 'changed file')}` : '',
  ].filter(Boolean)
  const name = branch.value ? `Branch: ${branch.value}` : 'Branches'
  return bits.length ? `${name} (${bits.join(', ')})` : name
})
</script>

<template>
  <header class="tb" data-tauri-drag-region @dblclick.self="appWindow.toggleMaximize()">
    <div class="tb__left" data-tauri-drag-region>
      <UiMangoMark :size="18" class="tb__mark" />

      <UiMenu :items="projectItems" :width="280" label="Projects">
        <template #default="{ toggle, open }">
          <!-- The Where list opens from the project menu and hangs from the same button. -->
          <UiMenu ref="whereMenu" :items="whereMenuItems" :width="300" label="Projects go to">
            <template #default>
              <button type="button" class="tb__widget tb__project" :class="{ 'is-open': open }" aria-haspopup="menu" :aria-expanded="open" @click="toggle">
                <UiProjectBadge v-if="ws.activeProject" size="sm" :name="ws.activeProject.name" :path="ws.activeProject.path" :hue="ws.projectPrefs[ws.activeProject.path]?.color" />
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
        class="tb__widget tb__remote"
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
            class="tb__widget tb__branch"
            :class="{ 'is-open': open }"
            aria-haspopup="dialog"
            :aria-expanded="open"
            :title="open ? undefined : branchTitle"
            @click="toggle"
          >
            <GitBranch class="tb__branch-icon" />
            <!-- Unity VCS branches are paths: when space runs out, keep the end (…/feature/x) in view. -->
            <span class="tb__branch-name" :class="{ 'tb__branch-path': branch?.startsWith('/') }"><bdi>{{ branch ?? 'detached' }}</bdi></span>
            <span v-if="ahead || behind || changed" class="tb__sync tabular">
              <span v-if="ahead">↑{{ ahead }}</span>
              <span v-if="behind">↓{{ behind }}</span>
              <span v-if="changed">• {{ changed }}</span>
            </span>
            <ChevronDown class="tb__chev" />
          </button>
        </template>
      </GitBranchPopup>
    </div>

    <div class="tb__center" data-tauri-drag-region>
      <button type="button" class="tb__search" @click="ws.paletteOpen = true">
        <Search />
        <span class="tb__ph">Search threads or run a command</span>
        <span class="tb__keys"><kbd>{{ mod }}</kbd><kbd>K</kbd></span>
      </button>
    </div>

    <div class="tb__right" data-tauri-drag-region>
      <div class="tb__grp"><UpdateIndicator /></div>
      <div class="tb__grp"><AppActivity /></div>
      <div class="tb__grp"><AppUsageMeter /></div>
      <div v-if="ws.hasProject" class="tb__cluster" role="group" aria-label="Layout">
        <button type="button" :aria-pressed="ws.sidebarOpen" :aria-label="'Toggle sidebar'" :title="`Toggle sidebar (${mod}+B)`" @click="ws.toggleSidebar()"><PanelLeft /></button>
        <button type="button" :aria-pressed="ws.terminalOpen" :aria-label="'Toggle terminal'" :title="`Toggle terminal (${mod}+\`)`" @click="ws.toggleTerminal()"><PanelBottom /></button>
        <button type="button" :aria-pressed="ws.toolPanel !== null" :aria-label="'Toggle tool panel'" :title="`Toggle tool panel (${mod}+Alt+B)`" @click="ws.toggleToolPanel()"><PanelRight /></button>
      </div>
      <UiIconButton label="Settings" :shortcut="`${mod}+,`" :active="!!ws.settings" size="sm" @click="ws.openSettings()">
        <Settings />
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
  display: flex;
  align-items: center;
  gap: var(--space-4);
  height: var(--titlebar-h);
  padding-left: var(--space-3);
  background: var(--bg-app);
  position: relative;
  z-index: 20;
}
.tb:not(:has(.tb__win)) { padding-right: var(--space-3); }
.tb__left, .tb__grp { display: flex; align-items: center; gap: var(--space-1); min-width: 0; }
.tb__left { flex: 0 1 auto; }
.tb__right { display: flex; align-items: center; gap: var(--space-4); flex: none; align-self: stretch; }
.tb__center { flex: 1; display: flex; justify-content: center; min-width: 0; }
.tb__mark { margin: 0 var(--space-2) 0 var(--space-1); flex: none; }
/* The project keeps its width; a long branch (Unity VCS paths such as /main/feature/x) is what gets cut short. */
.tb__left > :deep(.menu) { flex: none; }

/* Project, remote and branch share one widget: 28px tall, quiet until hovered. */
.tb__widget {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  height: 28px;
  min-width: 0;
  padding: 0 var(--space-2);
  border-radius: var(--radius-md);
  font-size: var(--text-sm);
  color: var(--fg);
  transition: background var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out);
}
.tb__widget:hover, .tb__widget.is-open { background: var(--bg-hover); }
.tb__chev { width: 14px; height: 14px; color: var(--fg-subtle); flex: none; }

.tb__project { font-weight: 500; max-width: 240px; }
.tb__project-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.tb__remote { font-size: var(--text-xs); color: var(--fg-subtle); }
.tb__remote:hover, .tb__remote.is-open { color: var(--fg); }
.tb__remote svg { width: 14px; height: 14px; flex: none; stroke-width: 1.85; }
.tb__remote.is-compact { padding: 0 var(--space-2); }
.tb__remote-where { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.tb__branch { min-width: 72px; font-size: var(--text-xs); }
.tb__branch-icon { width: 14px; height: 14px; flex: none; color: var(--fg-muted); }
.tb__branch-name {
  font-family: var(--font-mono);
  min-width: 0;
  max-width: 190px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tb__branch .tb__branch-path { direction: rtl; text-align: left; }
.tb__sync { display: flex; gap: 6px; flex: none; color: var(--fg-muted); white-space: nowrap; }

.tb__search {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  max-width: 480px;
  min-width: 0;
  height: 28px;
  padding: 0 var(--space-2) 0 var(--space-3);
  border-radius: var(--radius-md);
  background: var(--bg-inset);
  border: 1px solid var(--line-soft);
  color: var(--fg-subtle);
  font-size: var(--text-sm);
  transition: border-color var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out);
}
.tb__search:hover { border-color: var(--line-strong); color: var(--fg-muted); }
.tb__search svg { width: 14px; height: 14px; flex: none; }
.tb__ph { flex: 1; text-align: left; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tb__keys { display: flex; align-items: center; gap: 2px; flex: none; }

/* Layout cluster: one connected segmented group of panel toggles. */
.tb__cluster {
  display: flex;
  gap: 2px;
  padding: 2px;
  background: var(--bg-inset);
  border: 1px solid var(--line-soft);
  border-radius: var(--radius-md);
}
.tb__cluster button {
  display: grid;
  place-items: center;
  width: 28px;
  height: 24px;
  border-radius: var(--radius-sm);
  color: var(--fg-subtle);
  transition: background var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out);
}
.tb__cluster button:hover { background: var(--bg-hover); color: var(--fg); }
.tb__cluster button[aria-pressed='true'] { background: var(--bg-raised); color: var(--fg); box-shadow: 0 0 0 1px var(--line); }
.tb__cluster svg { width: 16px; height: 16px; }

.tb__win { display: flex; align-self: stretch; margin-left: var(--space-1); }
.tb__win-btn {
  width: 44px;
  display: grid;
  place-items: center;
  color: var(--fg-muted);
  transition: background var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out);
}
.tb__win-btn svg { width: 15px; height: 15px; stroke-width: 1.5; }
.tb__win-btn .tb__sq { width: 12px; height: 12px; }
.tb__win-btn:hover { background: var(--bg-hover); color: var(--fg); }
.tb__win-btn--close:hover { background: var(--ripe-error); color: white; }

@media (max-width: 1180px) {
  .tb__branch-name { max-width: 130px; }
  .tb__right, .tb { gap: var(--space-3); }
}
@media (max-width: 1000px) {
  .tb__sync { display: none; }
  .tb__branch-name { max-width: 96px; }
  .tb__ph { display: none; }
  .tb__keys { margin-left: auto; }
  .tb__search { max-width: 200px; }
}
</style>
