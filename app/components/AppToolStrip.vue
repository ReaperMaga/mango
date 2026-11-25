<script setup lang="ts">
import { CircleDashed, Files, GitBranch, GitPullRequest, Laptop, Server, SquareTerminal, Tag, X } from 'lucide-vue-next'
import { useWorkspace, type ToolView } from '~/stores/workspace'
import { useForge } from '~/stores/forge'
import { useGit, refreshGit } from '~/stores/git'
import { useThreads } from '~/stores/threads'
import { useWindows } from '~/stores/windows'
import { guarded, read, reg, shown } from '~/plugin-host/registry'
import { allPanelTabs, panelTabBadge, panelTabOffered } from '~/composables/panelTabs'
import { iconComponent } from '~/plugin-host/icons'
import { parsePanelEditorTab, pluginRef } from '~/plugin-host/ids'

/**
 * The tool window stripe on the right edge of the workspace, the way an IDE
 * docks its tool windows: one button per tool, a click opens it beside the
 * chats and a second click puts it away. Below them, set apart, are plugins' places that open as a tab
 * (`ui.navItems`). At the foot sit the bottom panel's tabs, the terminal's toggle and a button that
 * says where the project runs (this computer or an environment), marking an environment that is
 * stopped or can't be reached.
 */

const { t } = useI18n()
const ws = useWorkspace()
const git = useGit()
const threads = useThreads()
const win = useWindows()

/** Number of changed files in the working copy in view (the active chat's worktree, or the project), shown on the Changes button. */
const workdir = computed(() => threads.workdir ?? ws.activeProjectPath)
const changeCount = computed(() => git.status(workdir.value)?.files.length ?? 0)
// Keep that number honest without the Changes view being open.
watch(workdir, (path) => { if (path) refreshGit(path).catch(() => {}) }, { immediate: true })
function onWindowFocus() { if (workdir.value) refreshGit(workdir.value).catch(() => {}) }
onMounted(() => window.addEventListener('focus', onWindowFocus))
onBeforeUnmount(() => window.removeEventListener('focus', onWindowFocus))

/** Pull requests and issues linked to the chat in the active pane (or the chat a sub-agent belongs to). */
const linkCount = computed(() => {
  const id = threads.activePane.threadId
  return (id && threads.byId(id) ? threads.rootOf(id)?.links?.length : 0) ?? 0
})

/* Where the active project runs. Checked when a remote project comes to the front (at most once a minute), never polled. */
const place = computed(() => remotePlace(ws.activeProjectPath))
const placeState = computed(() => (place.value ? envState(place.value.hostId, place.value.instance) : null))
const placeMark = computed(() => (placeState.value && ['off', 'moving', 'bad'].includes(placeState.value.tone) ? placeState.value : null))
const placeTitle = computed(() => {
  const p = place.value
  const where = p ? t('shell.tools.runsOn', { name: p.label, host: p.shared ? t('shell.tools.shared') : p.host }) : t('shell.tools.runsHere')
  return placeMark.value ? `${where} · ${placeMark.value.label}` : where
})
watch(() => place.value?.hostId, (id) => { if (id) void refreshEnv(id) }, { immediate: true })

/** Releases: a corner mark while one builds or after its build failed (see useReleaseWatch). */
const releaseWatch = useReleaseWatch()
const releaseMark = releaseWatch.mark
const releaseMarks = computed(() => ({ running: t('shell.tools.releaseRunning'), failed: t('shell.tools.releaseFailed') }))

/** The bottom panel's tabs (the Git log, then plugins'): a button each at the foot, above the terminal's (bottom-docked tools sit low, as in an IDE). */
const panelTabs = computed(() => allPanelTabs().filter(panelTabOffered).map(tab => ({
  ref: tab.fullId,
  label: tab.title,
  title: tab.pluginId === null ? ws.withKey(tab.title, tab.shortcut) : tab.title,
  icon: iconComponent(tab.icon)!,
  count: panelTabBadge(tab),
})))
/** In view: showing in the open panel, or the tab of the active pane when it sits in the main area. */
function panelShowing(ref: string) {
  if (ws.panelTabPlaces[ref]?.at === 'editor') return parsePanelEditorTab(threads.activePane.threadId)?.ref === ref
  return ws.terminalOpen && ws.activePanelTab?.fullId === ref
}
/** In the panel and showing: hide the panel. Otherwise bring it into view (in the main area when it is there; a closed one opens in the panel). */
function togglePanelTab(ref: string) {
  if (panelShowing(ref) && ws.panelTabPlaces[ref]?.at !== 'editor') ws.toggleTerminal(false)
  else ws.openPanelTab(ref)
}
const terminalShowing = computed(() => ws.terminalOpen && !ws.activePanelTab)

/** "Merge requests" for a project on GitLab (read with the titlebar's repository button). */
const forge = useForge()
const requestsLabel = computed(() => (forge.providerOf(ws.activeProjectPath) === 'gitlab' ? t('shell.tools.mergeRequests') : t('shell.tools.links')))

const tools = computed(() => [
  { id: 'files' as ToolView, label: t('shell.tools.files'), icon: Files, keys: ws.keyLabel('files'), count: 0, counts: null },
  { id: 'changes' as ToolView, label: t('shell.tools.changes'), icon: GitBranch, keys: ws.keyLabel('changes'), count: changeCount.value, counts: 'changedFiles' },
  { id: 'links' as ToolView, label: requestsLabel.value, icon: GitPullRequest, keys: ws.keyLabel('links'), count: linkCount.value, counts: 'linkedItems' },
  ...(releaseWatch.path.value
    ? [{ id: 'releases' as ToolView, label: t('shell.tools.releases'), icon: Tag, keys: ws.keyLabel('releases'), count: 0, counts: null, mark: releaseMark.value }]
    : []),
  // Plugins' tool windows, after Mango's own.
  ...reg.toolWindows.filter(w => shown(w)).map((w) => {
    const badge = read(w.badge, w.pluginId, null, 'badge')
    return { id: w.fullId as ToolView, label: w.title, icon: iconComponent(w.icon)!, keys: '', count: typeof badge === 'number' && badge > 0 ? Math.floor(badge) : 0, counts: 'items' }
  }),
])

/** Plugins' places in the main area (`ui.navItems`): they open a tab, so they stand apart from the tool windows. A chat window shows its chat alone. */
const places = computed(() => (win.spec.kind === 'chat' ? [] : reg.navItems.filter(i => shown(i))).map((i) => {
  const badge = read(i.badge, i.pluginId, null, 'nav badge')
  return {
    key: i.fullId,
    label: i.title,
    title: i.shortcut ? ws.withKey(i.title, pluginRef(i.pluginId, i.shortcut)) : i.title,
    icon: iconComponent(i.icon)!,
    count: typeof badge === 'number' && badge > 0 ? Math.floor(badge) : 0,
    active: read(i.active, i.pluginId, false, 'nav active') === true,
    run: () => { void guarded(i.pluginId, `nav item ${i.id}`, () => i.run()) },
  }
}))

/*
 * The highlight behind the open tool is one shape that glides from button to button, so switching
 * tools reads as a move rather than one light going off and another coming on. It fades in where it
 * is when a tool opens from nothing, and out when the tool window closes or the environment opens.
 */
const btns: HTMLElement[] = []
const glide = ref<{ y: number; on: boolean; still: boolean }>({ y: 0, on: false, still: true })
watch(() => ws.toolPanel, async (id) => {
  await nextTick()
  const i = tools.value.findIndex(t => t.id === id)
  const el = btns[i]
  if (!el) { glide.value = { ...glide.value, on: false }; return }
  // Opening from nothing: appear in place; only a switch between tools travels.
  glide.value = { y: el.offsetTop, on: true, still: !glide.value.on }
}, { immediate: true })
</script>

<template>
  <nav class="ts" :aria-label="t('shell.tools.label')">
    <div class="ts__tools">
    <span
      class="ts__glide"
      :class="{ 'is-on': glide.on, 'is-still': glide.still }"
      :style="{ transform: `translateY(${glide.y}px)` }"
      aria-hidden="true"
    />
    <button
      v-for="(tool, i) in tools"
      :key="tool.id"
      :ref="el => { if (el) btns[i] = el as HTMLElement }"
      type="button"
      class="ts__btn"
      :class="{ 'is-active': ws.toolPanel === tool.id }"
      :aria-pressed="ws.toolPanel === tool.id"
      :aria-label="tool.count ? t(`shell.tools.${tool.counts}`, { label: tool.label }, tool.count) : 'mark' in tool && tool.mark ? `${tool.label}, ${releaseMarks[tool.mark]}` : tool.label"
      :title="'mark' in tool && tool.mark ? `${tool.label}: ${releaseMarks[tool.mark]}${tool.keys ? ` (${tool.keys})` : ''}` : `${tool.label}${tool.keys ? ` (${tool.keys})` : ''}`"
      @click="ws.toggleTool(tool.id)"
    >
      <component :is="tool.icon" />
      <span v-if="tool.count" class="ts__count tabular" aria-hidden="true">{{ tool.count > 99 ? '99+' : tool.count }}</span>
      <span v-if="'mark' in tool && tool.mark" class="ts__mark ts__run" :class="`is-${tool.mark}`" aria-hidden="true">
        <CircleDashed v-if="tool.mark === 'running'" />
        <X v-else />
      </span>
    </button>
    </div>
    <div v-if="places.length" class="ts__places" role="group" :aria-label="t('plugins.view.navigation')">
    <button
      v-for="p in places"
      :key="p.key"
      type="button"
      class="ts__btn ts__btn--solo"
      :class="{ 'is-active': p.active }"
      :aria-current="p.active ? 'page' : undefined"
      :aria-label="p.count ? t('shell.tools.items', { label: p.label }, p.count) : p.label"
      :title="p.title"
      @click="p.run()"
    >
      <component :is="p.icon" />
      <span v-if="p.count" class="ts__count tabular" aria-hidden="true">{{ p.count > 99 ? '99+' : p.count }}</span>
    </button>
    </div>
    <div class="ts__foot">
    <button
      v-for="p in panelTabs"
      :key="p.ref"
      type="button"
      class="ts__btn ts__btn--solo"
      :class="{ 'is-active': panelShowing(p.ref) }"
      :aria-pressed="panelShowing(p.ref)"
      :aria-label="p.count ? t('shell.tools.items', { label: p.label }, p.count) : p.label"
      :title="p.title"
      @click="togglePanelTab(p.ref)"
    >
      <component :is="p.icon" />
      <span v-if="p.count" class="ts__count tabular" aria-hidden="true">{{ p.count > 99 ? '99+' : p.count }}</span>
    </button>
    <button
      type="button"
      class="ts__btn ts__btn--solo"
      :class="{ 'is-active': terminalShowing }"
      :aria-pressed="terminalShowing"
      :aria-label="t('shell.tools.terminal')"
      :title="ws.withKey(t('shell.tools.toggleTerminal'), 'terminal')"
      @click="ws.toggleTerminal()"
    >
      <SquareTerminal />
    </button>
    <button
      type="button"
      class="ts__btn ts__btn--solo ts__btn--env"
      :class="{ 'is-active': ws.toolPanel === 'env' }"
      :aria-pressed="ws.toolPanel === 'env'"
      :aria-label="t('shell.tools.place', { place: placeTitle })"
      :title="ws.withKey(placeTitle, 'env')"
      @click="ws.toggleEnv()"
    >
      <component :is="place ? Server : Laptop" />
      <EnvsEnvStatus v-if="placeMark" class="ts__mark" :status="placeMark.status" />
    </button>
    </div>
  </nav>
</template>

<style scoped>
.ts {
  flex: none;
  display: flex;
  flex-direction: column;
  align-items: center;
  width: 40px;
  background: var(--bg-app);
}
/* The panel tabs, the terminal and the environment sit apart at the foot of the stripe. */
.ts__foot {
  flex: none;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-1);
  margin-top: auto;
  padding: var(--space-2) 0;
}
.ts__tools {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-1);
  padding: var(--space-2) 0;
}
/* What opens as a tab, not as a tool window: under a short line. */
.ts__places {
  position: relative;
  flex: none;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-1);
  padding: var(--space-2) 0;
}
.ts__places::before {
  content: '';
  position: absolute;
  top: 0;
  width: 16px;
  height: 1px;
  background: var(--line);
}
.ts__btn {
  position: relative;
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  border-radius: var(--radius-md);
  color: var(--fg-muted);
  transition: background var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out);
}
.ts__btn svg { width: 16px; height: 16px; stroke-width: 1.75; }
.ts__btn:hover { background: var(--bg-hover); color: var(--fg); }
.ts__btn.is-active { color: var(--accent-ink); }
/* The foot's buttons (terminal, environment) and the places have no glide: they keep their own fill. */
.ts__btn--solo.is-active { background: var(--accent-soft); }
.ts__glide {
  position: absolute;
  top: 0;
  left: 50%;
  width: 28px;
  height: 28px;
  margin-left: -14px;
  border-radius: var(--radius-md);
  background: var(--accent-soft);
  opacity: 0;
  pointer-events: none;
  transition: transform var(--dur-med) var(--ease-out), opacity var(--dur-fast) var(--ease-out);
}
.ts__glide.is-on { opacity: 1; }
.ts__glide.is-still { transition: opacity var(--dur-fast) var(--ease-out); }
/* Buttons sit above the glide; a hovered one still shows its own hover fill. */
.ts__tools .ts__btn { z-index: 1; }
.ts__tools .ts__btn.is-active:hover { background: transparent; }
/* The environment's state, tucked into the corner of its icon on the stripe's own ground. */
.ts__mark {
  position: absolute;
  right: 1px;
  bottom: 1px;
  padding: 1.5px;
  border-radius: var(--radius-pill);
  background: var(--bg-app);
}
.ts__count {
  position: absolute;
  top: -3px;
  right: -4px;
  min-width: 14px;
  height: 14px;
  padding: 0 3px;
  border-radius: var(--radius-pill);
  background: var(--bg-raised);
  color: var(--fg);
  box-shadow: 0 0 0 1.5px var(--bg-app);
  font-size: var(--text-2xs);
  font-weight: 600;
  line-height: 14px;
  text-align: center;
}
.ts__btn.is-active .ts__count { background: var(--accent); color: var(--accent-fg); }
/* A release building (a turning ring) or failed (a cross), tucked into the corner like the environment's mark. */
.ts__run { display: grid; }
.ts__btn .ts__run svg { width: 9px; height: 9px; stroke-width: 2.6; }
.ts__run.is-running { color: var(--ripe-running); }
.ts__run.is-running svg { animation: ts-turn 2.4s linear infinite; }
.ts__run.is-failed { color: var(--ripe-error); }
@keyframes ts-turn { to { transform: rotate(360deg); } }
</style>
