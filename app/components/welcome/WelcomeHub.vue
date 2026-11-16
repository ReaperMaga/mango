<script setup lang="ts">
import { Download, FolderOpen, FolderPlus, GitBranch, GitFork, Server, Settings, X } from 'lucide-vue-next'
import type { Component } from 'vue'
import { useWorkspace } from '~/stores/workspace'
import { useEnvironments } from '~/stores/environments'
import type { ProjectInfo } from '~/types/ipc'

/**
 * Project hub: shown when no project is open. Four ways in (open, new,
 * clone, a remote environment), then the recent list. Arrow keys walk every row; Enter opens;
 * Delete forgets the focused recent project. With environments saved, "Where" above the actions
 * says where open, new and clone put the project (this computer or an environment).
 */
const ws = useWorkspace()
const envs = useEnvironments()
const where = computed(() => projectWhere())
const whereName = computed(() => (where.value ? envLabels(where.value.hostId, where.value.instance).label : null))

const mod = modLabel()
const ariaMod = mod === 'Ctrl' ? 'Control' : 'Meta'

interface Action {
  id: string
  title: string
  description: string
  icon: Component
  keys: string[]
  primary?: boolean
  run: () => void | Promise<void>
}

const actions = computed<Action[]>(() => [
  {
    id: 'open',
    title: 'Open folder',
    description: whereName.value ? `Browse the folders in ${whereName.value}.` : 'Work on a project that is already on disk.',
    icon: FolderOpen,
    keys: [mod, 'O'],
    primary: true,
    run: () => guard(openFolderFlow),
  },
  {
    id: 'new',
    title: 'New project',
    description: whereName.value ? `Create a folder in ${whereName.value}, with git if you want it.` : 'Create an empty folder, with git if you want it.',
    icon: FolderPlus,
    keys: [mod, 'N'],
    run: () => { ws.dialog = 'new' },
  },
  {
    id: 'clone',
    title: 'Clone repository',
    description: whereName.value ? `Clone a repo from GitHub or any git remote into ${whereName.value}.` : 'Pull a repo from GitHub or any git remote.',
    icon: GitFork,
    keys: [],
    run: () => { ws.dialog = 'clone' },
  },
  {
    id: 'environments',
    title: 'Remote environment',
    description: 'Work in a container or VM on your own server.',
    icon: Server,
    keys: [],
    run: () => envs.openView(),
  },
])

/* ---------- errors ---------- */

const error = ref<{ message: string; path: string | null } | null>(null)
const opening = ref<string | null>(null)

function errorText(e: unknown): string {
  if (typeof e === 'string') return e
  if (e instanceof Error) return e.message
  try { return JSON.stringify(e) } catch { return String(e) }
}

async function guard(fn: () => Promise<unknown>, path: string | null = null) {
  error.value = null
  try {
    await fn()
  } catch (e) {
    error.value = { message: errorText(e).replace(/\.$/, ''), path }
  }
}

async function open(p: ProjectInfo) {
  if (opening.value) return
  opening.value = p.path
  await guard(() => ws.openProject(p.path), p.path)
  opening.value = null
}

async function forget(p: ProjectInfo) {
  if (error.value?.path === p.path) error.value = null
  const rows = rowEls()
  const i = rows.indexOf(document.activeElement as HTMLElement)
  await ws.forgetProject(p.path)
  // Keep keyboard users anchored on the list after a row disappears.
  if (i !== -1) {
    await nextTick()
    const next = rowEls()
    next[Math.min(i, next.length - 1)]?.focus()
  }
}

/* ---------- formatting ---------- */

const tildify = (path: string) => path.replace(/^\/(?:home|Users)\/[^/]+(?=\/|$)/, '~')
/** The folder to show: a remote project's is inside its instance (where it is shows as a chip). */
const shownPath = (path: string) => remotePlace(path)?.dir ?? tildify(path)

const now = ref(Date.now())
let tick: ReturnType<typeof setInterval> | undefined

function ago(ms: number): string {
  const diff = Math.max(0, now.value - ms)
  const min = Math.floor(diff / 60_000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min} min ago`
  const then = new Date(ms)
  const today = new Date(now.value)
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()
  const hours = Math.floor(min / 60)
  if (ms >= startOfToday) return hours === 1 ? '1 hour ago' : `${hours} hours ago`
  const days = Math.ceil((startOfToday - ms) / 86_400_000)
  if (days <= 1) return 'yesterday'
  if (days < 7) return `${days} days ago`
  return then.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(then.getFullYear() !== today.getFullYear() ? { year: 'numeric' } : {}),
  })
}

/* ---------- agents ---------- */

const noAgents = computed(() => ws.agents.length > 0 && ws.agents.every(a => !a.installed))

/* ---------- keyboard ---------- */

const root = ref<HTMLElement | null>(null)
const rowEls = () => Array.from(root.value?.querySelectorAll<HTMLElement>('[data-row]') ?? [])

function onKey(e: KeyboardEvent) {
  if (ws.paletteOpen || ws.dialog || e.altKey || e.ctrlKey || e.metaKey) return
  const target = e.target as HTMLElement | null
  if (target?.closest('input, textarea, [contenteditable="true"]')) return
  const rows = rowEls()
  if (!rows.length) return
  const i = rows.indexOf(document.activeElement as HTMLElement)

  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault()
    const step = e.key === 'ArrowDown' ? 1 : -1
    const next = i === -1 ? (step === 1 ? 0 : rows.length - 1) : (i + step + rows.length) % rows.length
    rows[next]!.focus()
  } else if (e.key === 'Home' && i !== -1) {
    e.preventDefault(); rows[0]!.focus()
  } else if (e.key === 'End' && i !== -1) {
    e.preventDefault(); rows[rows.length - 1]!.focus()
  } else if ((e.key === 'Delete' || e.key === 'Backspace') && i !== -1) {
    const path = rows[i]!.dataset.path
    const p = path ? ws.recent.find(r => r.path === path) : undefined
    if (p) { e.preventDefault(); forget(p) }
  }
}

onMounted(() => {
  if (!envs.loaded) envs.load().catch(() => {})
  window.addEventListener('keydown', onKey)
  tick = setInterval(() => { now.value = Date.now() }, 30_000)
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey)
  clearInterval(tick)
})
</script>

<template>
  <div ref="root" class="hub">
    <div class="hub__col">
      <header class="hub__head">
        <UiMangoMark :size="40" class="hub__mark" aria-hidden="true" />
        <h1 class="hub__title">Mango</h1>
        <p class="hub__lede">Run Claude Code and Codex side by side on your projects.</p>
      </header>

      <div v-if="envs.hosts.length" class="hub__where">
        <span aria-hidden="true">Projects go to</span>
        <ProjectWhere variant="quiet" label="Projects go to" :model-value="where" @update:model-value="ws.setWhere" />
      </div>

      <ul class="actions" aria-label="Start">
        <li v-for="a in actions" :key="a.id">
          <button
            type="button"
            class="row action"
            :class="{ 'action--primary': a.primary }"
            data-row
            :aria-keyshortcuts="a.keys.length ? [ariaMod, ...a.keys.slice(1)].join('+') : undefined"
            @click="a.run()"
          >
            <span class="action__icon"><component :is="a.icon" /></span>
            <span class="action__text">
              <span class="action__title">{{ a.title }}</span>
              <span class="action__desc">{{ a.description }}</span>
            </span>
            <span v-if="a.keys.length" class="keys" aria-hidden="true">
              <kbd v-for="k in a.keys" :key="k">{{ k }}</kbd>
            </span>
          </button>
        </li>
      </ul>

      <p v-if="error" class="hub__error" role="alert">
        <span>
          <template v-if="error.path">Couldn't open <code>{{ tildify(error.path) }}</code>. </template>
          <template v-else>Couldn't open that folder. </template>
          <span class="hub__error-detail">{{ error.message }}.</span>
          <template v-if="error.path"> If it moved, open it from its new location.</template>
        </span>
        <span class="hub__error-actions">
          <UiButton
            v-if="error.path && ws.recent.some(r => r.path === error!.path)"
            size="sm"
            variant="ghost"
            @click="forget(ws.recent.find(r => r.path === error!.path)!)"
          >
            Remove from Recent
          </UiButton>
          <UiIconButton label="Dismiss" size="sm" @click="error = null"><X /></UiIconButton>
        </span>
      </p>

      <section class="recent" aria-labelledby="hub-recent">
        <h2 id="hub-recent" class="recent__label">Recent</h2>
        <ul v-if="ws.recent.length" class="recent__list">
          <li v-for="p in ws.recent" :key="p.path" class="recent__item">
            <button
              type="button"
              class="row recent__row"
              :class="{ 'is-opening': opening === p.path }"
              data-row
              :data-path="p.path"
              :aria-busy="opening === p.path || undefined"
              :aria-label="`Open ${p.name}, ${remotePlace(p.path) ? `in ${remotePlace(p.path)!.where}, ` : ''}${shownPath(p.path)}${p.branch ? `, branch ${p.branch}` : ''}, opened ${ago(p.lastOpened)}`"
              @click="open(p)"
            >
              <span class="recent__text">
                <span class="recent__line">
                  <span class="recent__name">{{ p.name }}</span>
                  <span v-if="remotePlace(p.path)" class="chip chip--remote" :title="`Remote environment: instance ${remotePlace(p.path)!.instance} on ${remotePlace(p.path)!.host}`">
                    <Server aria-hidden="true" />{{ remotePlace(p.path)!.where }}
                  </span>
                  <span v-else-if="p.isGit && p.branch" class="chip" :title="`Branch ${p.branch}`">
                    <GitBranch aria-hidden="true" />{{ p.branch }}
                  </span>
                </span>
                <span class="recent__path" :title="shownPath(p.path)">{{ shownPath(p.path) }}</span>
              </span>
              <span class="recent__time tabular">{{ ago(p.lastOpened) }}</span>
            </button>
            <button
              type="button"
              class="recent__forget"
              tabindex="-1"
              :aria-label="`Remove ${p.name} from Recent`"
              title="Remove from Recent (Delete)"
              @click.stop="forget(p)"
            >
              <X aria-hidden="true" />
            </button>
          </li>
        </ul>
        <p v-else class="recent__empty">Projects you open show up here.</p>
      </section>

      <footer class="agents">
        <button v-if="noAgents" type="button" class="agents__settings" @click="ws.openSetup()">
          <Download />
          <span>No agent is installed yet. Install one</span>
        </button>
        <button v-else type="button" class="agents__settings" @click="ws.openSettings('agents')">
          <Settings />
          <span>Settings</span>
        </button>
      </footer>
    </div>
  </div>
</template>

<style scoped>
.hub {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  overflow-y: auto;
  background: var(--bg-canvas);
  border: 1px solid var(--line-soft);
  border-bottom: 0;
  border-radius: var(--radius-lg) var(--radius-lg) 0 0;
}

/* Centered column, sitting a little above the optical middle. */
.hub__col {
  width: min(560px, 100% - 2 * var(--space-4));
  margin: auto;
  padding: var(--space-10) 0 calc(var(--space-12) + 6vh);
  animation: hub-in var(--dur-slow) var(--ease-out) both;
}
@keyframes hub-in {
  from { opacity: 0; transform: translateY(6px); }
}

/* ---------- head ---------- */
.hub__head {
  display: grid;
  justify-items: start;
  padding: 0 var(--space-3);
  margin-bottom: var(--space-6);
}
.hub__mark { margin-bottom: var(--space-4); }
.hub__title {
  margin: 0;
  font-size: var(--text-2xl);
  font-weight: 650;
  letter-spacing: -0.025em;
  line-height: var(--leading-tight);
}
.hub__lede {
  margin: var(--space-1) 0 0;
  font-size: var(--text-md);
  color: var(--fg-muted);
}

/* ---------- where ---------- */
.hub__where {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  min-width: 0;
  margin: calc(var(--space-2) * -1) 0 var(--space-2);
  padding: 0 var(--space-3);
  font-size: var(--text-sm);
  color: var(--fg-subtle);
}
.hub__where > span { flex: none; }

/* ---------- shared row ---------- */
ul { list-style: none; margin: 0; padding: 0; }

.row {
  display: grid;
  align-items: center;
  width: 100%;
  text-align: left;
  border-radius: var(--radius-md);
  transition: background var(--dur-fast) var(--ease-out);
}
.row:hover { background: var(--bg-hover); }
.row:active { background: var(--bg-active); }
.row:focus-visible {
  outline: none;
  background: var(--bg-hover);
  box-shadow: inset 0 0 0 1.5px var(--focus-ring);
  border-radius: var(--radius-md);
}

.keys { display: inline-flex; gap: 3px; }

/* ---------- actions ---------- */
.actions { display: grid; gap: 2px; }
.action {
  grid-template-columns: 30px 1fr auto;
  gap: var(--space-3);
  padding: var(--space-2) var(--space-3);
}
.action__icon {
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  border-radius: var(--radius-sm);
  color: var(--fg-muted);
  background: var(--bg-panel);
  border: 1px solid var(--line-soft);
  transition: color var(--dur-fast) var(--ease-out);
}
.action__icon :deep(svg) { width: 16px; height: 16px; stroke-width: 1.75; }
.action:hover .action__icon,
.action:focus-visible .action__icon { color: var(--fg); }
.action--primary .action__icon,
.action--primary:hover .action__icon,
.action--primary:focus-visible .action__icon {
  color: var(--accent-ink);
  background: var(--accent-soft);
  border-color: var(--accent-line);
}
.action__text { display: grid; min-width: 0; }
.action__title { font-size: var(--text-md); font-weight: 560; color: var(--fg); line-height: var(--leading-tight); }
.action__desc {
  margin-top: 2px;
  font-size: var(--text-sm);
  color: var(--fg-subtle);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* ---------- error ---------- */
.hub__error {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-3);
  margin: var(--space-4) 0 0;
  padding: var(--space-2) var(--space-2) var(--space-2) var(--space-3);
  font-size: var(--text-sm);
  line-height: var(--leading-normal);
  color: var(--fg);
  background: color-mix(in oklch, var(--ripe-error) 10%, transparent);
  border: 1px solid color-mix(in oklch, var(--ripe-error) 35%, transparent);
  border-radius: var(--radius-md);
}
.hub__error > span:first-child { padding-top: 2px; }
.hub__error code { font-size: var(--text-xs); }
.hub__error-detail { color: var(--fg-muted); }
.hub__error-actions { display: inline-flex; align-items: center; gap: var(--space-1); flex: none; }

/* ---------- recent ---------- */
.recent {
  margin-top: var(--space-8);
  padding-top: var(--space-5);
  border-top: 1px solid var(--line-soft);
}
.recent__label {
  margin: 0 0 var(--space-2);
  padding: 0 var(--space-3);
  font-size: var(--text-xs);
  font-weight: 560;
  color: var(--fg-subtle);
}
.recent__list { display: grid; gap: 1px; }
.recent__item { position: relative; }
.recent__row {
  grid-template-columns: 1fr auto;
  gap: var(--space-4);
  padding: 7px var(--space-3);
}
.recent__row.is-opening { opacity: 0.6; cursor: progress; }
.recent__text { display: grid; gap: 1px; min-width: 0; }
.recent__line { display: flex; align-items: center; gap: var(--space-2); min-width: 0; }
.recent__name {
  font-size: var(--text-md);
  font-weight: 540;
  color: var(--fg);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.recent__path {
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--fg-subtle);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.recent__time {
  font-size: var(--text-xs);
  color: var(--fg-subtle);
  white-space: nowrap;
  transition: opacity var(--dur-fast) var(--ease-out);
}
/* The forget button takes the time's place on hover/focus. */
.recent__item:hover .recent__time,
.recent__item:focus-within .recent__time { opacity: 0; }

.chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  max-width: 180px;
  height: 18px;
  padding: 0 6px;
  flex: none;
  font-size: var(--text-2xs);
  font-family: var(--font-mono);
  color: var(--fg-muted);
  background: var(--bg-hover);
  border: 1px solid var(--line-soft);
  border-radius: var(--radius-xs);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
/* An instance and server name, not code. */
.chip--remote { font-family: var(--font-ui); }
.chip :deep(svg) { width: 11px; height: 11px; stroke-width: 2; flex: none; color: var(--fg-subtle); }

.recent__forget {
  position: absolute;
  top: 50%;
  right: var(--space-2);
  translate: 0 -50%;
  display: grid;
  place-items: center;
  width: 22px;
  height: 22px;
  border-radius: var(--radius-xs);
  color: var(--fg-subtle);
  opacity: 0;
  transition: opacity var(--dur-fast) var(--ease-out), background var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out);
}
.recent__forget :deep(svg) { width: 14px; height: 14px; stroke-width: 1.85; }
.recent__item:hover .recent__forget,
.recent__item:focus-within .recent__forget { opacity: 1; }
.recent__forget:hover { background: var(--bg-active); color: var(--fg); }

.recent__empty {
  margin: 0;
  padding: var(--space-2) var(--space-3);
  font-size: var(--text-sm);
  color: var(--fg-subtle);
}

/* ---------- agents ---------- */
.agents {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1) var(--space-4);
  margin-top: var(--space-8);
  padding: 0 var(--space-3);
  font-size: var(--text-xs);
  color: var(--fg-muted);
}
.agents__settings {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  height: 28px;
  padding: 0 var(--space-2);
  margin-left: calc(var(--space-2) * -1);
  border-radius: var(--radius-sm);
  color: var(--fg-subtle);
  transition: background var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out);
}
.agents__settings:hover { background: var(--bg-hover); color: var(--fg); }
.agents__settings svg { width: 14px; height: 14px; stroke-width: 1.75; }
</style>
