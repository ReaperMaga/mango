<script setup lang="ts">
import PluginStatusItems from '~/plugin-host/ui/PluginStatusItems.vue'
import { pluginMenuItems } from '~/plugin-host/menus'
import { AppWindow, ChevronDown, Copy, Undo2, FolderCog, FolderOpen, FolderPlus, GitBranch, GitFork, Github, MapPin, Minus, PanelLeftOpen, Search, Server, Square, X } from 'lucide-vue-next'
import { useWorkspace } from '~/stores/workspace'
import { useEnvironments } from '~/stores/environments'
import { useThreads } from '~/stores/threads'
import { useUsage } from '~/stores/usage'
import { useGit } from '~/stores/git'
import { useWindows } from '~/stores/windows'
import { appWindow, call, isTauri, openExternal } from '~/composables/useBackend'
import { openFolderFlow } from '~/composables/useShortcuts'
import type { MenuItem } from '~/types/ui'
import type { GhRepoLink, ProjectInfo } from '~/types/ipc'
import { isEnvPath } from '~/utils/envPath'

const ws = useWorkspace()
const threads = useThreads()
const usage = useUsage()
const win = useWindows()
const native = ref(false)
/* macOS draws its own traffic lights over the left of the titlebar (tauri.macos.conf.json). */
const mac = ref(false)

/* Limits are read now and then in the background (it spends no quota), so an early reset is noticed
   while you work, not only when you open Usage. */
const USAGE_POLL_MS = 15 * 60_000
let usageTimer: ReturnType<typeof setInterval> | undefined
let usageFirst: ReturnType<typeof setTimeout> | undefined
onMounted(() => {
  native.value = isTauri()
  mac.value = native.value && /Mac/.test(navigator.platform)
  usageFirst = setTimeout(() => void usage.refreshReadable(), 4000)
  usageTimer = setInterval(() => void usage.refreshReadable(true), USAGE_POLL_MS)
})
onBeforeUnmount(() => { clearTimeout(usageFirst); clearInterval(usageTimer) })

/* The maximize button shows Restore while the window is maximized. */
const maximized = ref(false)
let stopWatch: (() => void) | undefined
onMounted(async () => { stopWatch = await appWindow.watchMaximized(m => { maximized.value = m }) })
onBeforeUnmount(() => stopWatch?.())

/** A window on one chat (stores/windows.ts): no project menu, a way back to the main window instead. */
const chatWindow = computed(() => win.spec.kind === 'chat')
const ownBusy = computed(() => win.spec.kind === 'chat' && threads.isBusyChat(win.spec.threadId))

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

/*
 * The project's repository on GitHub, read from its git remotes (no network) when the project comes
 * into view and when the window comes back, so a remote added meanwhile shows up.
 */
const repoLinks = reactive<Record<string, GhRepoLink | null>>({})
function readRepoLink() {
  const path = ws.activeProjectPath
  if (!path || !ws.activeProject?.isGit || document.visibilityState !== 'visible') return
  call('gh_repo_link', { path }).then((link) => { repoLinks[path] = link }).catch(() => {})
}
watch(() => [ws.activeProjectPath, ws.activeProject?.isGit], readRepoLink, { immediate: true })
onMounted(() => window.addEventListener('focus', readRepoLink))
onBeforeUnmount(() => window.removeEventListener('focus', readRepoLink))
const repoLink = computed(() => {
  const link = ws.activeProject?.isGit && ws.activeProjectPath ? repoLinks[ws.activeProjectPath] : null
  if (!link) return null
  const name = `${link.owner}/${link.repo}`
  return { url: `https://${link.host}/${name}`, label: `Open ${name} on ${link.host === 'github.com' ? 'GitHub' : link.host}` }
})

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

/*
 * One list of projects: those open in this window first, in their own order (a dot marks them, the check
 * the one in view), then recent ones by last use, so every window can reach them (a window opened on one
 * project otherwise lists only that one). One open in another window brings that window forward.
 */
const RECENT_IN_MENU = 8
function projectItem(p: ProjectInfo, here: boolean): MenuItem {
  const place = remotePlace(p.path)
  const elsewhere = !here && !!win.projectElsewhere(p.path)
  // Moving a project with a chat at work (or its terminals open here) would cut them off: say why it waits instead.
  const blocked = here ? win.moveBlocker(p.path) : null
  // A window of its own is pointless for a window's only project, unless this is the main window.
  const ownWindow = !elsewhere && (!here || win.isMain || ws.openProjects.length > 1)
  return {
    label: p.name,
    // Under the name: the branch, or for a remote project where it runs.
    hint: elsewhere ? 'In another window' : place?.where ?? (p.branch || undefined),
    hintIcon: elsewhere ? AppWindow : place ? Server : undefined,
    hintMono: !elsewhere && !place && !!p.branch,
    icon: projectIcon(p.name, p.path, ws.projectPrefs[p.path]?.color),
    checked: here && p.path === ws.activeProjectPath,
    open: here,
    onSelect: here
      ? () => ws.setActiveProject(p.path)
      : () => void ws.openProjectAsking(p.path).catch((e: unknown) =>
          ws.notify('Could not open the project', e instanceof Error ? e.message : String(e))),
    // Open here: close it. A recent one: take it off the list (one open in another window is that window's to close).
    remove: here
      ? { label: `Close ${p.name}`, onSelect: () => ws.closeProject(p.path) }
      : elsewhere ? undefined : { label: `Remove ${p.name} from Recent`, onSelect: () => void ws.forgetProject(p.path) },
    action: ownWindow
      ? { label: 'Open in new window', icon: AppWindow, disabled: !!blocked, reason: blocked?.hint, onSelect: () => win.openInNewWindow(p.path) }
      : undefined,
  }
}
const listedProjects = computed<MenuItem[]>(() => [
  ...ws.openProjects.map(p => projectItem(p, true)),
  ...ws.listedRecent
    .filter(p => !ws.openProjects.some(o => o.path === p.path))
    .slice(0, RECENT_IN_MENU)
    .map(p => projectItem(p, false)),
])
/* Another window may have opened a project since this one read the list. */
function toggleProjects(toggle: () => void, open: boolean) {
  if (!open) void ws.refreshRecent()
  toggle()
}

const projectItems = computed<MenuItem[]>(() => [
  ...listedProjects.value,
  { label: 'New window', icon: AppWindow, kbd: ws.keyLabel('new-window'), divider: listedProjects.value.length > 0, onSelect: () => win.openInNewWindow(null) },
  { label: 'Open folder…', icon: FolderOpen, kbd: ws.keyLabel('open-folder'), divider: true, onSelect: openFolderFlow },
  { label: 'New project…', icon: FolderPlus, onSelect: () => (ws.dialog = 'new') },
  { label: 'Clone repository…', icon: GitFork, onSelect: () => (ws.dialog = 'clone') },
  ...(envs.hosts.length
    ? [{ label: 'Projects go to…', aside: where.value ? envLabels(where.value.hostId, where.value.instance).where : 'This computer', icon: MapPin, onSelect: chooseWhere }]
    : []),
  ...(ws.activeProject
    ? [
        { label: 'Project settings…', icon: FolderCog, divider: true, onSelect: () => ws.openSettings('projects') },
        ...pluginMenuItems('project', { projectPath: ws.activeProject.path }),
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
  <header class="tb" :class="{ 'tb--mac': mac }" data-tauri-drag-region @dblclick.self="appWindow.toggleMaximize()">
    <div class="tb__left" data-tauri-drag-region>
      <UiMangoMark :size="18" class="tb__mark" />
      <!-- The sidebar hides from its own top row; while it is away, it comes back from here. -->
      <UiIconButton
        v-if="!chatWindow && ws.hasProject && !ws.sidebarOpen"
        class="tb__show-sb"
        label="Show sidebar"
        :shortcut="ws.keyLabel('sidebar')"
        @click="ws.toggleSidebar()"
      >
        <PanelLeftOpen />
      </UiIconButton>

      <!-- A chat window: its project, as a plain label, and the way back. -->
      <template v-if="chatWindow">
        <span class="tb__widget tb__project tb__project--still" :title="ws.activeProject?.path">
          <UiProjectBadge v-if="ws.activeProject" size="sm" :name="ws.activeProject.name" :path="ws.activeProject.path" :hue="ws.projectPrefs[ws.activeProject.path]?.color" />
          <span class="tb__project-name">{{ ws.activeProject?.name ?? 'No project' }}</span>
        </span>
      </template>
      <UiMenu v-else :items="projectItems" :width="280" :max-width="440" label="Projects">
        <template #default="{ toggle, open }">
          <!-- The Where list opens from the project menu and hangs from the same button. -->
          <UiMenu ref="whereMenu" :items="whereMenuItems" :width="300" label="Projects go to">
            <template #default>
              <button type="button" class="tb__widget tb__project" :class="{ 'is-open': open }" aria-haspopup="menu" :aria-expanded="open" @click="toggleProjects(toggle, open)">
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
      <!-- The project's repository on GitHub, when one of its remotes is there. -->
      <button
        v-if="repoLink"
        type="button"
        class="tb__widget tb__repo"
        :title="repoLink.label"
        :aria-label="repoLink.label"
        @click="openExternal(repoLink.url).catch(() => {})"
      >
        <Github aria-hidden="true" />
      </button>
      <PluginStatusItems location="project" />
    </div>

    <div class="tb__center" data-tauri-drag-region>
      <button type="button" class="tb__search" aria-label="Search threads or run a command" @click="ws.paletteOpen = true">
        <Search />
        <span class="tb__ph">Search threads or run a command</span>
        <span class="tb__keys"><kbd v-for="k in ws.keyParts('palette')" :key="k">{{ k }}</kbd></span>
      </button>
    </div>

    <div class="tb__right" data-tauri-drag-region>
      <button
        v-if="chatWindow"
        type="button"
        class="tb__widget tb__return"
        :disabled="ownBusy"
        aria-label="Return to main window"
        :title="ownBusy ? 'Still working: it returns once it is done' : 'Close this window and show the chat in the main window again'"
        @click="win.returnChat()"
      >
        <Undo2 aria-hidden="true" /><span class="tb__return-label">Return to main window</span>
      </button>
      <PluginStatusItems location="titlebar" class="tb__grp" />
      <div class="tb__grp"><UpdateIndicator /></div>
      <div class="tb__grp"><AppActivity /></div>

      <div v-if="native && !mac" class="tb__win">
        <button type="button" class="tb__win-btn" aria-label="Minimize" @click="appWindow.minimize()"><Minus /></button>
        <button type="button" class="tb__win-btn" :aria-label="maximized ? 'Restore' : 'Maximize'" @click="appWindow.toggleMaximize()"><Copy v-if="maximized" class="tb__sq" /><Square v-else class="tb__sq" /></button>
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
/* Room for the native traffic lights (three 12px buttons from x 14). */
.tb--mac { padding-left: 76px; }
.tb__left, .tb__grp { display: flex; align-items: center; gap: var(--space-1); min-width: 0; }
.tb__left { flex: 0 1 auto; }
.tb__right { display: flex; align-items: center; gap: var(--space-4); flex: none; align-self: stretch; }
.tb__center { flex: 1; display: flex; justify-content: center; min-width: 0; }
.tb__mark { margin: 0 var(--space-2) 0 var(--space-1); flex: none; }
.tb__show-sb { margin-right: var(--space-1); }
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
.tb__project--still { cursor: default; }
.tb__project--still:hover { background: none; }
.tb__return { color: var(--fg-muted); font-size: var(--text-xs); }
.tb__return:hover:not(:disabled) { color: var(--fg); }
.tb__return:disabled { opacity: 0.5; cursor: default; }
.tb__return svg { width: 14px; height: 14px; flex: none; stroke-width: 1.85; }
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
.tb__repo { width: 28px; padding: 0; justify-content: center; flex: none; color: var(--fg-subtle); }
.tb__repo:hover { color: var(--fg); }
.tb__repo svg { width: 14px; height: 14px; stroke-width: 1.85; }
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
/* A chat window may be as small as 640px: the search and the way back keep only their icons. */
@media (max-width: 820px) {
  .tb__keys, .tb__return-label { display: none; }
  .tb__search { width: 28px; flex: none; justify-content: center; padding: 0; }
  .tb__return { width: 28px; justify-content: center; padding: 0; }
  .tb__branch-name { max-width: 72px; }
}
</style>
