<script setup lang="ts">
import { Files, GitBranch, GitPullRequest, Laptop, Server } from 'lucide-vue-next'
import { useWorkspace, type ToolView } from '~/stores/workspace'
import { useGit, refreshGit } from '~/stores/git'
import { useThreads } from '~/stores/threads'
import { modLabel } from '~/composables/useShortcuts'

/**
 * The tool window stripe on the right edge of the workspace, the way an IDE
 * docks its tool windows: one button per tool, a click opens it beside the
 * chats and a second click puts it away. The first one says where the project runs (this
 * computer or an environment) and marks an environment that is stopped or can't be reached.
 */

const ws = useWorkspace()
const git = useGit()
const threads = useThreads()
const mod = ref('Ctrl')
onMounted(() => (mod.value = modLabel()))

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

const tools = computed(() => [
  { id: 'files' as ToolView, label: 'Files', icon: Files, keys: `${mod.value}+Shift+E`, count: 0, counts: '' },
  { id: 'changes' as ToolView, label: 'Changes', icon: GitBranch, keys: `${mod.value}+Shift+G`, count: changeCount.value, counts: 'changed file' },
  { id: 'links' as ToolView, label: 'Pull requests', icon: GitPullRequest, keys: `${mod.value}+Shift+P`, count: linkCount.value, counts: 'linked item' },
])

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
  <nav class="ts" aria-label="Tool windows">
    <div class="ts__first">
    <button
      type="button"
      class="ts__btn ts__btn--env"
      :class="{ 'is-active': ws.toolPanel === 'env' }"
      :aria-pressed="ws.toolPanel === 'env'"
      :aria-label="`Environment: ${placeTitle}`"
      :title="`${placeTitle} (${mod}+Shift+H)`"
      @click="ws.toggleEnv()"
    >
      <component :is="place ? Server : Laptop" />
      <EnvsEnvStatus v-if="placeMark" class="ts__mark" :status="placeMark.status" />
    </button>
    </div>
    <div class="ts__tools">
    <span
      class="ts__glide"
      :class="{ 'is-on': glide.on, 'is-still': glide.still }"
      :style="{ transform: `translateY(${glide.y}px)` }"
      aria-hidden="true"
    />
    <button
      v-for="(t, i) in tools"
      :key="t.id"
      :ref="el => { if (el) btns[i] = el as HTMLElement }"
      type="button"
      class="ts__btn"
      :class="{ 'is-active': ws.toolPanel === t.id }"
      :aria-pressed="ws.toolPanel === t.id"
      :aria-label="t.count ? `${t.label}, ${t.count} ${t.counts}${t.count === 1 ? '' : 's'}` : t.label"
      :title="`${t.label} (${t.keys})`"
      @click="ws.toggleTool(t.id)"
    >
      <component :is="t.icon" />
      <span v-if="t.count" class="ts__count tabular" aria-hidden="true">{{ t.count > 99 ? '99+' : t.count }}</span>
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
.ts__tools {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-1);
  padding: var(--space-2) 0;
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
/* The environment button has no neighbours to glide from: it keeps its own fill. */
.ts__btn--env.is-active { background: var(--accent-soft); }
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
</style>
