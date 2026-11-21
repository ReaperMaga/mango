<script setup lang="ts">
import { ChevronDown, CircleDashed, Files, GitBranch, GitPullRequest, Tag, X } from 'lucide-vue-next'
import type { MenuItem } from '~/types/ui'
import { useWorkspace, type ToolView } from '~/stores/workspace'
import { useGit, refreshGit } from '~/stores/git'
import { useThreads } from '~/stores/threads'
import { read, reg, shown } from '~/plugin-host/registry'
import { iconComponent } from '~/plugin-host/icons'

/**
 * The tool window stripe on the right edge of the workspace, the way an IDE
 * docks its tool windows: one button per tool, a click opens it beside the
 * chats and a second click puts it away. The first one says where the project runs (this
 * computer or an environment) and marks an environment that is stopped or can't be reached.
 */

const ws = useWorkspace()
const git = useGit()
const threads = useThreads()

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
  const where = p ? `Runs on ${p.label} (${p.shared ? 'shared' : p.host})` : 'Runs on this computer'
  return placeMark.value ? `${where} · ${placeMark.value.label}` : where
})
watch(() => place.value?.hostId, (id) => { if (id) void refreshEnv(id) }, { immediate: true })

/** Releases: a corner mark while one builds or after its build failed (see useReleaseWatch). */
const releaseWatch = useReleaseWatch()
const releaseMark = releaseWatch.mark
const RELEASE_MARK = { running: 'a release is building', failed: 'a release build failed' } as const

const tools = computed(() => [
  { id: 'files' as ToolView, label: 'Files', icon: Files, keys: ws.keyLabel('files'), count: 0, counts: '' },
  { id: 'changes' as ToolView, label: 'Changes', icon: GitBranch, keys: ws.keyLabel('changes'), count: changeCount.value, counts: 'changed file' },
  { id: 'links' as ToolView, label: 'Pull requests', icon: GitPullRequest, keys: ws.keyLabel('links'), count: linkCount.value, counts: 'linked item' },
  ...(releaseWatch.path.value
    ? [{ id: 'releases' as ToolView, label: 'Releases', icon: Tag, keys: ws.keyLabel('releases'), count: 0, counts: '', mark: releaseMark.value }]
    : []),
  // Plugins' tool windows, after Mango's own.
  ...reg.toolWindows.filter(w => shown(w)).map((w) => {
    const badge = read(w.badge, w.pluginId, null, 'badge')
    return { id: w.fullId as ToolView, label: w.title, icon: iconComponent(w.icon)!, keys: '', count: typeof badge === 'number' && badge > 0 ? Math.floor(badge) : 0, counts: 'item' }
  }),
])

/*
 * One button stands for all tools: it shows the tool last used (a click opens or closes it) and its
 * dropdown lists the others. Picking one opens it and the button takes its icon.
 */
const current = computed(() => tools.value.find(t => t.id === (ws.toolPanel ?? ws.lastToolPanel)) ?? tools.value[0]!)
const menuItems = computed<MenuItem[]>(() => tools.value
  .filter(t => t.id !== current.value.id)
  .map(t => ({ label: t.label, icon: t.icon, kbd: t.keys, aside: t.count ? String(t.count) : undefined, onSelect: () => ws.toggleTool(t.id, true) })))
const currentTitle = computed(() => {
  const t = current.value as (typeof tools.value)[number] & { mark?: 'running' | 'failed' | null }
  const keys = t.keys ? ` (${t.keys})` : ''
  return t.mark ? `${t.label}: ${RELEASE_MARK[t.mark]}${keys}` : `${t.label}${keys}`
})
</script>

<template>
  <nav class="ts" aria-label="Tool windows">
    <div class="ts__first">
      <button
        type="button"
        class="ts__btn"
        :class="{ 'is-active': ws.toolPanel === current.id }"
        :aria-pressed="ws.toolPanel === current.id"
        :aria-label="current.count ? `${current.label}, ${current.count} ${current.counts}${current.count === 1 ? '' : 's'}` : current.label"
        :title="currentTitle"
        @click="ws.toggleTool(current.id)"
      >
        <component :is="current.icon" />
        <span v-if="current.count" class="ts__count tabular" aria-hidden="true">{{ current.count > 99 ? '99+' : current.count }}</span>
        <span v-if="'mark' in current && current.mark" class="ts__mark ts__run" :class="`is-${current.mark}`" aria-hidden="true">
          <CircleDashed v-if="current.mark === 'running'" />
          <X v-else />
        </span>
      </button>
      <UiMenu :items="menuItems" placement="bottom-end" :width="200" label="Tool windows">
        <template #default="{ toggle, open }">
          <button type="button" class="ts__more" :class="{ 'is-open': open }" aria-label="Choose tool window" aria-haspopup="menu" :aria-expanded="open" title="Other tool windows" @click="toggle">
            <ChevronDown />
          </button>
        </template>
      </UiMenu>
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
/* The environment button's own cell: the strip's part of the row shared with the chat tabs and tool header. */
.ts__first {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: var(--tabbar-h);
  border-bottom: 1px solid var(--line);
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
.ts__btn.is-active { color: var(--accent-ink); background: var(--accent-soft); }
.ts__more { display: grid; place-items: center; width: 14px; height: 28px; margin-left: 1px; border-radius: var(--radius-md); color: var(--fg-muted); }
.ts__more svg { width: 12px; height: 12px; }
.ts__more:hover, .ts__more.is-open { background: var(--bg-hover); color: var(--fg); }
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
