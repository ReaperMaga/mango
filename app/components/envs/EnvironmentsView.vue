<script setup lang="ts">
import { Plus, Server, TriangleAlert, X } from 'lucide-vue-next'
import { instanceKey, useEnvironments } from '~/stores/environments'
import { useWorkspace } from '~/stores/workspace'
import EnvStatus from './EnvStatus.vue'
import EnvServerPage from './EnvServerPage.vue'
import EnvInstancePage from './EnvInstancePage.vue'
import EnvHostDialog from './EnvHostDialog.vue'
import EnvCreateDialog from './EnvCreateDialog.vue'

/**
 * Remote environments: a full view under the titlebar, in the same place as
 * Settings (opening one closes the other). The rail lists servers with their
 * instances; the canvas shows the selected server or instance.
 *
 * Once opened it stays mounted (hidden) so installers, sign-ins and shells
 * started here keep running while the user is back in the workspace.
 */
const envs = useEnvironments()
const ws = useWorkspace()

const open = computed(() => envs.viewOpen)
const everOpened = ref(false)

const view = ref<HTMLElement | null>(null)
const titleId = useId()

const railWidth = computed(() =>
  ws.hasProject && ws.sidebarOpen ? Math.min(300, Math.max(208, ws.sidebarWidth)) : 248)

const sel = computed(() => envs.selected)

/* ---------- data: fresh every time the view opens ---------- */

async function refreshHost(id: string) {
  const p = await envs.probe(id)
  if (p.ok) await envs.refreshInstances(id)
}

/** Servers are read once; reachability and instances are fetched again on every open. */
async function loadHosts() {
  if (!envs.loaded) await envs.load().catch(() => { /* the empty state explains */ })
  const valid = sel.value && envs.host(sel.value.hostId)
  if (!valid) envs.selected = envs.hosts[0] ? { hostId: envs.hosts[0].id, instance: null } : null
}

const refreshAll = () => Promise.all(envs.hosts.map(h => refreshHost(h.id)))

/* A starting or stopping instance settles in a few seconds: look again until it has. */
let settleTimer: ReturnType<typeof setInterval> | undefined
watch(() => {
  const id = sel.value?.hostId
  const moving = open.value && id && (envs.instances[id] ?? []).some(i => i.status === 'starting' || i.status === 'stopping')
  return moving ? id : null
}, (id) => {
  clearInterval(settleTimer)
  if (id) settleTimer = setInterval(() => { if (!envs.loadingInstances[id]) envs.refreshInstances(id) }, 2500)
})

/* ---------- open / close, focus ---------- */

let returnFocus: HTMLElement | null = null

function setUnderlayInert(on: boolean) {
  const body = document.querySelector<HTMLElement>('.app__body')
  if (!body) return
  if (on) body.setAttribute('inert', '')
  else if (!ws.settings) body.removeAttribute('inert')
}

watch(open, async (now) => {
  if (now) {
    everOpened.value = true
    returnFocus = document.activeElement instanceof HTMLElement && document.activeElement !== document.body
      ? document.activeElement
      : null
    setUnderlayInert(true)
    await loadHosts()
    const refreshed = refreshAll()
    await nextTick()
    // Settings may have just closed and released the workspace; keep it covered.
    setUnderlayInert(true)
    view.value?.querySelector<HTMLElement>('[aria-current="page"], .envs__empty .btn')?.focus()
    await refreshed
    return
  }
  setUnderlayInert(false)
  const target = returnFocus
  returnFocus = null
  if (target?.isConnected) target.focus()
})

/* Settings takes the same place: whichever opens last wins. */
watch(() => ws.settings, (s) => { if (s && envs.viewOpen) envs.closeView() })

function close() {
  envs.closeView()
}

function onKey(e: KeyboardEvent) {
  if (e.key !== 'Escape' || !open.value || e.defaultPrevented) return
  if (ws.paletteOpen || ws.dialog || envs.dialog) return
  // In a terminal Escape belongs to the program.
  if ((e.target as HTMLElement | null)?.closest?.('.xterm')) return
  e.preventDefault()
  close()
}

/** Up and Down walk the rail, like a native sidebar. */
function onRailKey(e: KeyboardEvent) {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
  const items = Array.from(view.value?.querySelectorAll<HTMLElement>('.envs__item') ?? [])
  if (!items.length) return
  const i = items.indexOf(document.activeElement as HTMLElement)
  const next = items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]
  if (!next) return
  e.preventDefault()
  next.click()
  next.focus()
}

onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey)
  clearInterval(settleTimer)
  if (open.value) setUnderlayInert(false)
})

/* ---------- rail ---------- */

type HostMark = 'ok' | 'bad' | 'checking' | 'unknown'
function hostMark(id: string): HostMark {
  if (envs.probing[id]) return 'checking'
  const p = envs.probes[id]
  if (!p) return 'unknown'
  return p.ok ? 'ok' : 'bad'
}
const markLabel: Record<HostMark, string> = { ok: 'Reachable', bad: 'Can\'t reach it', checking: 'Checking…', unknown: 'Not checked' }

const isCurrent = (hostId: string, instance: string | null) =>
  sel.value?.hostId === hostId && (sel.value?.instance ?? null) === instance
</script>

<template>
  <Transition name="envs">
    <section
      v-if="everOpened"
      v-show="open"
      ref="view"
      class="envs"
      :aria-labelledby="titleId"
      :style="{ '--rail-w': `${railWidth}px` }"
    >
      <div class="envs__rail">
        <header class="envs__head">
          <h1 :id="titleId" class="envs__title">Environments</h1>
          <UiIconButton label="Close environments" shortcut="Esc" @click="close"><X /></UiIconButton>
        </header>

        <nav v-if="envs.hosts.length" class="envs__nav" aria-label="Servers and environments" @keydown="onRailKey">
          <template v-for="h in envs.hosts" :key="h.id">
            <button
              type="button"
              class="envs__item envs__item--host"
              :class="{ 'is-current': isCurrent(h.id, null) }"
              :aria-current="isCurrent(h.id, null) ? 'page' : undefined"
              @click="envs.select(h.id)"
            >
              <Server class="envs__icon" aria-hidden="true" />
              <span class="envs__name">{{ h.name }}</span>
              <TriangleAlert
                v-if="hostMark(h.id) === 'bad'"
                class="envs__warn"
                role="img"
                :aria-label="markLabel.bad"
                :title="markLabel.bad"
              />
              <span
                v-else
                class="envs__mark"
                :class="`envs__mark--${hostMark(h.id)}`"
                role="img"
                :aria-label="markLabel[hostMark(h.id)]"
                :title="markLabel[hostMark(h.id)]"
              />
            </button>
            <button
              v-for="i in envs.instances[h.id] ?? []"
              :key="`${h.id}/${i.name}`"
              type="button"
              class="envs__item envs__item--inst"
              :class="{ 'is-current': isCurrent(h.id, i.name) }"
              :aria-current="isCurrent(h.id, i.name) ? 'page' : undefined"
              @click="envs.select(h.id, i.name)"
            >
              <EnvStatus :status="i.status" :busy="envs.busy[instanceKey(h.id, i.name)]" />
              <span class="envs__name">{{ i.name }}</span>
              <span v-if="i.kind === 'vm'" class="envs__kind">VM</span>
            </button>
          </template>
        </nav>

        <button type="button" class="envs__add" @click="envs.dialog = { kind: 'host', id: '' }">
          <Plus aria-hidden="true" />
          <span>Add server</span>
        </button>
      </div>

      <div class="envs__main">
        <div class="envs__scroll">
          <div class="envs__col">
            <div v-if="envs.loaded && !envs.hosts.length" class="envs__empty">
              <Server class="envs__empty-icon" aria-hidden="true" />
              <h2 class="envs__empty-title">Run agents on your own server</h2>
              <p class="envs__empty-text">
                Add a server you can reach with <code>ssh</code> that has <code>incus</code>. Mango creates containers and VMs
                there, installs Claude Code, Codex and the GitHub CLI in them, and opens projects inside so chats run the
                agent on the server.
              </p>
              <p class="envs__empty-text envs__empty-text--quiet">
                It works over SSH with your own keys and installs nothing of its own on the server.
              </p>
              <UiButton variant="primary" @click="envs.dialog = { kind: 'host', id: '' }"><Plus />Add server</UiButton>
            </div>
            <template v-else-if="sel">
              <KeepAlive :max="8">
                <EnvInstancePage
                  v-if="sel.instance"
                  :key="instanceKey(sel.hostId, sel.instance)"
                  :host-id="sel.hostId"
                  :name="sel.instance"
                />
              </KeepAlive>
              <EnvServerPage v-if="!sel.instance" :host-id="sel.hostId" />
            </template>
          </div>
        </div>
      </div>

      <EnvHostDialog />
      <EnvCreateDialog />
    </section>
  </Transition>
</template>

<style scoped>
.envs {
  position: fixed;
  inset: var(--titlebar-h) 0 0 0;
  /* Over the workspace and its resize handles; under menus (50), dialogs (60) and the palette (70). */
  z-index: 40;
  display: flex;
  min-width: 0;
  background: var(--bg-app);
}

/* ---- rail: same ground and rhythm as the sidebar and the Settings rail ---- */
.envs__rail {
  flex: none;
  width: var(--rail-w, 248px);
  display: flex;
  flex-direction: column;
  min-height: 0;
  padding: var(--space-1) var(--space-2) var(--space-3) var(--space-3);
}
.envs__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 32px;
  padding-left: var(--space-2);
}
.envs__title {
  margin: 0;
  font-size: var(--text-lg);
  font-weight: 620;
  letter-spacing: -0.01em;
}
.envs__nav {
  display: grid;
  align-content: start;
  gap: 2px;
  min-height: 0;
  margin-top: var(--space-3);
  overflow-y: auto;
}
.envs__item {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
  height: 30px;
  padding: 0 var(--space-2);
  font-size: var(--text-sm);
  text-align: left;
  color: var(--fg-muted);
  border-radius: var(--radius-sm);
  transition: background var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out);
}
.envs__item:hover { background: var(--bg-hover); color: var(--fg); }
.envs__item.is-current { background: var(--bg-active); color: var(--fg); font-weight: 560; }
/* The rail scrolls, which would clip an outline: ring the row from inside. */
.envs__item:focus-visible { outline: none; box-shadow: inset 0 0 0 1.5px var(--focus-ring); }
.envs__item--host { font-weight: 560; color: var(--fg); }
.envs__item--host:not(:first-child) { margin-top: var(--space-2); }
.envs__item--inst { padding-left: 30px; }
.envs__icon { flex: none; width: 16px; height: 16px; stroke-width: 1.75; color: var(--fg-subtle); }
.envs__item.is-current .envs__icon { color: var(--fg); }
.envs__name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.envs__kind { flex: none; font-size: var(--text-2xs); font-weight: 500; color: var(--fg-faint); }

/* Server reachability: a small mark at the row's end (colour + fill, with a label). */
.envs__mark {
  flex: none;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  box-shadow: inset 0 0 0 1.25px var(--ripe-idle);
}
.envs__mark--ok { background: var(--ripe-queued); box-shadow: none; }
.envs__warn { flex: none; width: 12px; height: 12px; stroke-width: 2; color: var(--ripe-error); }
.envs__mark--checking {
  width: 10px;
  height: 10px;
  box-shadow: none;
  border: 1.5px solid var(--fg-subtle);
  border-right-color: transparent;
  animation: envs-turn 0.7s linear infinite;
}
@keyframes envs-turn { to { transform: rotate(360deg); } }

.envs__add {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  height: 30px;
  margin-top: var(--space-2);
  padding: 0 var(--space-2);
  font-size: var(--text-sm);
  color: var(--fg-subtle);
  border-radius: var(--radius-sm);
  transition: background var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out);
}
.envs__add:hover { background: var(--bg-hover); color: var(--fg); }
.envs__add svg { width: 16px; height: 16px; stroke-width: 1.75; color: var(--accent-ink); }

/* ---- the page, on the canvas ---- */
.envs__main {
  flex: 1;
  min-width: 0;
  background: var(--bg-canvas);
  border-top-left-radius: var(--radius-lg);
  border-top: 1px solid var(--line-soft);
  border-left: 1px solid var(--line-soft);
  overflow: hidden;
}
.envs__scroll {
  height: 100%;
  overflow-y: auto;
  scrollbar-gutter: stable both-edges;
}
.envs__col {
  max-width: calc(760px + var(--space-8) * 2);
  margin: 0 auto;
  padding: var(--space-8) var(--space-8) var(--space-12);
}

/* ---- no servers yet ---- */
.envs__empty {
  display: grid;
  justify-items: start;
  gap: var(--space-3);
  max-width: 520px;
  margin: 10vh auto 0;
}
.envs__empty-icon { width: 22px; height: 22px; stroke-width: 1.5; color: var(--fg-subtle); }
.envs__empty-title {
  margin: 0;
  font-size: var(--text-xl);
  font-weight: 620;
  letter-spacing: -0.015em;
  line-height: var(--leading-tight);
}
.envs__empty-text { margin: 0; font-size: var(--text-md); color: var(--fg-muted); text-wrap: pretty; }
.envs__empty-text--quiet { font-size: var(--text-sm); color: var(--fg-subtle); }
.envs__empty-text code { font-size: var(--text-xs); color: var(--fg); }
.envs__empty :deep(.btn) { margin-top: var(--space-2); }

/* ---- open / close: a short fade with a small settle ---- */
.envs-enter-active,
.envs-leave-active {
  transition: opacity var(--dur-fast) var(--ease-out);
}
.envs-enter-active .envs__rail,
.envs-enter-active .envs__main,
.envs-leave-active .envs__rail,
.envs-leave-active .envs__main {
  transition: transform var(--dur-fast) var(--ease-out);
}
.envs-enter-from,
.envs-leave-to { opacity: 0; }
.envs-enter-from .envs__rail,
.envs-enter-from .envs__main,
.envs-leave-to .envs__rail,
.envs-leave-to .envs__main { transform: translateY(4px); }

@media (prefers-reduced-motion: reduce) {
  .envs-enter-from .envs__rail,
  .envs-enter-from .envs__main,
  .envs-leave-to .envs__rail,
  .envs-leave-to .envs__main { transform: none; }
}
</style>
