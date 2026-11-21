<script setup lang="ts">
import { ArrowUpToLine, ChevronDown, Maximize2, Minimize2, Plus, RefreshCw, Server, Settings, SquareTerminal, X } from 'lucide-vue-next'
import type { MenuItem } from '~/types/ui'
import { useWorkspace, type TerminalTab } from '~/stores/workspace'
import { envPath, isEnvPath, parseEnvPath } from '~/utils/envPath'
import { whereItems } from '~/composables/usePlace'
import { refreshEnvs } from '~/composables/envProjects'
import { useEnvironments } from '~/stores/environments'
import { holdOverlay } from '~/composables/useOverlay'
import { useThreads } from '~/stores/threads'
import { terminalSlot } from '~/composables/useTerminalDrag'
import { dragJustEnded, draggedPanelItem, pressPanelTab, pressTerminalTab } from '~/composables/useTabDrag'
import { parseTerminalTab } from '~/utils/terminalTabs'
import { read, reg, shown, type Owned } from '~/plugin-host/registry'
import type { PanelTabContext, PluginPanelTab } from '~/plugin-host/types'
import { usePluginRuntime } from '~/plugin-host/runtime'
import PluginIcon from '~/plugin-host/ui/PluginIcon.vue'
import PluginViewHost from '~/components/plugins/PluginViewHost.vue'

/**
 * Docked panel at the bottom of the main column: the terminals, and among them the plugins' panel tabs
 * (`ui.panelTabs`), which move, dock and close like terminals. Height is a fraction of `container` (the column), stored in the workspace.
 */
const props = defineProps<{ container: HTMLElement | null }>()

const ws = useWorkspace()
const threads = useThreads()

/** Hover text: the shell and folder, or for a shell in a remote environment, where it runs. */
function tabTitle(tab: TerminalTab) {
  const place = remotePlace(tab.cwd)
  const where = place ? `Shell in ${place.where} — ${place.dir}` : [tab.shell, tab.cwd ?? tab.title].filter(Boolean).join(' — ')
  return tab.exited ? `${where} — (exited)` : where
}

const DEFAULT_H = 0.34
const TALL_H = 0.7
const MAX_H = 0.8

/* ---------- container tracking ---------- */
const containerHeight = ref(0)
watch(() => props.container, (el, _old, onCleanup) => {
  if (!el) return
  containerHeight.value = el.clientHeight
  const ro = new ResizeObserver(() => { containerHeight.value = el.clientHeight })
  ro.observe(el)
  onCleanup(() => ro.disconnect())
}, { immediate: true })

const panelStyle = computed(() => {
  const height = containerHeight.value
    ? `${Math.round(ws.terminalHeight * containerHeight.value)}px`
    : `${ws.terminalHeight * 100}%`
  // --dock-h: how far the dock slides when it opens or closes (AppWorkspace's dock transition).
  return { height, '--dock-h': containerHeight.value ? height : '0px' }
})

/* ---------- height changes ---------- */
// Animate only deliberate jumps (double-click, maximize), never drags or window resizes.
// While the height moves the terminals hold their grid (see TerminalView) and refit once it has settled.
const animating = ref(false)
provide('terminal-settling', readonly(animating))
let animTimer: ReturnType<typeof setTimeout> | undefined
function settle() {
  clearTimeout(animTimer)
  animating.value = false
}
function jumpTo(fraction: number) {
  animating.value = true
  clearTimeout(animTimer)
  // Fallback for a jump to the height it already has: no transition runs, so no transitionend comes.
  animTimer = setTimeout(settle, 500)
  ws.setTerminalHeight(fraction)
  ws.persist()
}
function onPanelTransitionEnd(e: TransitionEvent) {
  if (e.target === e.currentTarget && e.propertyName === 'height') settle()
}

const isMaximized = computed(() => ws.terminalHeight >= MAX_H - 0.01)
const toggleMaximize = () => jumpTo(isMaximized.value ? DEFAULT_H : MAX_H)
const toggleTall = () => jumpTo(ws.terminalHeight > (DEFAULT_H + TALL_H) / 2 ? DEFAULT_H : TALL_H)

/* ---------- drag handle ---------- */
const dragging = ref(false)
/* A browser's page would swallow the pointer once it crosses it: the browsers hide during the drag. */
let release = () => {}
let dragStartY = 0
let dragStartFrac = 0

function onHandleDown(e: PointerEvent) {
  if (e.button !== 0 || !containerHeight.value) return
  e.preventDefault()
  ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  dragStartY = e.clientY
  dragStartFrac = ws.terminalHeight
  dragging.value = true
  release = holdOverlay()
  document.body.style.cursor = 'row-resize'
}

function onHandleMove(e: PointerEvent) {
  if (!dragging.value || !containerHeight.value) return
  ws.setTerminalHeight(dragStartFrac + (dragStartY - e.clientY) / containerHeight.value)
}

function endDrag(e: PointerEvent) {
  if (!dragging.value) return
  dragging.value = false
  release()
  document.body.style.cursor = ''
  const el = e.currentTarget as HTMLElement
  if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId)
  ws.persist()
}

/* ---------- plugin panel tabs ---------- */
const runtime = usePluginRuntime()
const byRef = (ref: string) => reg.panelTabs.find(t => t.fullId === ref) ?? null
/** The plugin panel tab showing instead of a terminal, or null. */
const showingPlugin = computed(() => ws.activePanelTab)
function badgeOf(t: Owned<PluginPanelTab>) {
  const b = read(t.badge, t.pluginId, null, 'badge')
  return typeof b === 'number' && b > 0 ? Math.floor(b) : 0
}

/** The strip, in its order: terminals and plugin panel tabs side by side. */
type StripItem = { kind: 'terminal'; key: string; term: TerminalTab } | { kind: 'plugin'; key: string; tab: Owned<PluginPanelTab> }
const stripItems = computed<StripItem[]>(() => ws.panelStrip.flatMap((key): StripItem[] => {
  const term = ws.panelTerminals.find(t => t.id === key)
  if (term) return [{ kind: 'terminal', key, term }]
  const tab = byRef(key)
  return tab ? [{ kind: 'plugin', key, tab }] : []
}))
const hasPluginTabs = computed(() => stripItems.value.some(i => i.kind === 'plugin'))

// The main area holds a tab for each panel tab placed there whose plugin runs (after a reload, a plugin coming back...).
watch(
  () => [reg.panelTabs.map(t => t.fullId).join(' '), JSON.stringify(ws.panelTabPlaces), threads.tabs.length],
  () => ws.syncPanelEditorTabs(),
  { immediate: true },
)

/*
 * A plugin's view lives here, like the terminals: it mounts the first time it shows (in the panel or in a
 * pane, which it is teleported into) and stays mounted until it is closed or its plugin stops, so moving
 * it or switching tabs keeps its state. `ctx.visible` says when it is in view.
 */
const editorTabOf = (ref: string) => (ws.panelTabPlaces[ref]?.at === 'editor' ? ws.panelEditorTab(ref) : null)
const pluginSlot = (ref: string) => (editorTabOf(ref) ? terminalSlot(ref) : null)
const pluginInView = (ref: string) => {
  const tabId = editorTabOf(ref)
  return tabId ? threads.panes.some(p => p.threadId === tabId) : ws.terminalOpen && showingPlugin.value?.fullId === ref
}
const seen = ref<string[]>([])
watchEffect(() => {
  const live = reg.panelTabs.filter(t => ws.panelTabPlaces[t.fullId]?.at !== 'closed').map(t => t.fullId)
  const keep = seen.value.filter(r => live.includes(r))
  for (const r of live) if (!keep.includes(r) && (pluginSlot(r) || showingPlugin.value?.fullId === r)) keep.push(r)
  if (keep.join(' ') !== seen.value.join(' ')) seen.value = keep
})
const mountedTabs = computed(() => reg.panelTabs.filter(t => seen.value.includes(t.fullId)))
const ctxs = computed<Record<string, PanelTabContext>>(() => {
  const projectPath = threads.workdir ?? ws.activeProjectPath
  const out: Record<string, PanelTabContext> = {}
  for (const t of mountedTabs.value) {
    const ref = t.fullId
    out[ref] = {
      projectPath,
      visible: pluginInView(ref),
      // In the main area: close its tab. In the panel: hide the panel.
      close: () => (editorTabOf(ref) ? ws.closePanelTab(ref) : ws.toggleTerminal(false)),
    }
  }
  return out
})

/* ---------- tabs ---------- */
/*
 * Open with no shell and no plugin tab showing (restored as open on launch, a plugin tab that went
 * away): start a shell. A saved plugin tab waits for the plugins to load before giving up on it.
 */
watch(
  () => ws.terminalOpen && !showingPlugin.value && ws.panelTerminals.length === 0 && (runtime.ready || !ws.panelPluginTab),
  (need) => {
    if (!need) return
    // The chosen plugin tab stays chosen: it shows again once its plugin (or its `when()`) is back.
    const keep = ws.panelPluginTab
    ws.newTerminal()
    ws.panelPluginTab = keep
  },
  { immediate: true },
)

const views = ref<Record<string, { focus: () => void } | null>>({})
function activate(id: string) {
  if (dragJustEnded()) return // the click that ends a drag is not a click
  ws.showTerminals(id)
  // Clicking a tab means "I want to type there", also when it was already the active one.
  nextTick(() => views.value[id]?.focus())
}
function activatePlugin(ref: string) {
  if (dragJustEnded()) return
  if (ws.panelPluginTab !== ref || !ws.terminalOpen) ws.openPanelTab(ref)
}

const strip = ref<HTMLElement | null>(null)
watch(() => showingPlugin.value?.fullId ?? ws.activeTerminalId, async (id) => {
  await nextTick()
  if (id) strip.value?.querySelector<HTMLElement>(`[data-tab-id="${id}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
})

/** Vertical wheel scrolls the tab strip sideways. */
function onStripWheel(e: WheelEvent) {
  const el = strip.value
  if (!el || el.scrollWidth <= el.clientWidth || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return
  el.scrollLeft += e.deltaY
  e.preventDefault()
}

/** Arrow keys rove over the whole strip, terminals and panel tabs alike. */
function onTabKey(e: KeyboardEvent, index: number) {
  const tabs = stripItems.value
  let next = -1
  if (e.key === 'ArrowRight') next = (index + 1) % tabs.length
  else if (e.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length
  else if (e.key === 'Home') next = 0
  else if (e.key === 'End') next = tabs.length - 1
  else return
  e.preventDefault()
  const tab = tabs[next]
  if (!tab) return
  if (tab.kind === 'plugin') activatePlugin(tab.key)
  else activate(tab.key)
  nextTick(() => strip.value?.querySelector<HTMLElement>(`[data-tab-id="${tab.key}"]`)?.focus())
}

onBeforeUnmount(() => {
  clearTimeout(animTimer)
  if (dragging.value) document.body.style.cursor = ''
})

/* ---------- terminals in the main area ---------- */

/*
 * Every terminal's view lives here, also the ones shown as tabs in the main area: those are
 * teleported into their pane (see useTerminalDrag), so moving one keeps its shell and scrollback.
 * A main-area terminal no pane shows waits here, hidden.
 */
const slotOf = (tab: TerminalTab) => (tab.inEditor ? terminalSlot(tab.id) : null)
/** Where a terminal is drawn: the panel, a pane (and how many there are: a split resizes it), or nowhere. */
function placeOf(tab: TerminalTab) {
  if (!tab.inEditor) return 'panel'
  const pane = threads.panes.find(p => parseTerminalTab(p.threadId)?.terminalId === tab.id)
  return slotOf(tab) && pane ? `${pane.id}/${threads.panes.length}` : 'parked'
}
/** The terminal in the active pane, if it is one. */
const paneTerminal = computed(() => parseTerminalTab(threads.activePane.threadId)?.terminalId ?? null)

const canMoveToEditor = computed(() => !!ws.activeProjectPath)
const moveLabel = 'Move to editor area'

/* Right-click on a tab of the strip: a terminal's, or a plugin panel tab's (no shell actions). */
const tabMenu = ref<{ showAt: (x: number, y: number) => void } | null>(null)
const menuTermId = ref<string | null>(null)
async function onTabContext(e: MouseEvent, id: string) {
  menuTermId.value = id
  await nextTick()
  tabMenu.value?.showAt(e.clientX, e.clientY)
}
const tabMenuItems = computed<MenuItem[]>(() => {
  const id = menuTermId.value
  if (!id) return []
  if (byRef(id)) {
    return [
      { label: moveLabel, icon: ArrowUpToLine, disabled: !canMoveToEditor.value, onSelect: () => ws.movePanelTabToEditor(id) },
      { label: 'Close', icon: X, divider: true, onSelect: () => ws.closePanelTab(id) },
    ]
  }
  return [
    { label: moveLabel, icon: ArrowUpToLine, disabled: !canMoveToEditor.value, onSelect: () => ws.moveTerminalToEditor(id) },
    { label: 'Close', icon: X, divider: true, onSelect: () => ws.closeTerminal(id) },
  ]
})

/** The active project's environment, when it is remote: what a plain "new terminal" opens. */
const projectEnv = computed(() => parseEnvPath(ws.activeProjectPath))

/** "+" opens a shell where the project runs. */
const newLabel = computed(() => projectEnv.value
  ? `New shell in ${projectEnv.value.instance}`
  : ws.defaultTerminalProfile ? `New ${ws.defaultTerminalProfile.name} terminal` : 'New terminal')

/**
 * Where a new terminal can run: the project's environment first (when remote), the shells found on this
 * machine, then every environment (a shell in its agent's home), and the way to settings.
 */
const profileItems = computed<MenuItem[]>(() => {
  const fallback = ws.defaultTerminalProfile
  const items: MenuItem[] = []
  const env = projectEnv.value
  if (env) {
    items.push({
      label: `Shell in ${env.instance}`,
      hint: env.dir,
      icon: Server,
      kbd: 'Default',
      onSelect: () => ws.newTerminal(),
    })
  }
  const local: MenuItem[] = ws.terminalProfiles.map((p, i) => ({
    ...(i === 0 && env ? { group: 'This computer', divider: true } : {}),
    label: p.name,
    hint: p.path,
    icon: SquareTerminal,
    kbd: !env && p.id === fallback?.id ? 'Default' : undefined,
    onSelect: () => ws.newTerminal(undefined, p.id),
  }))
  if (!local.length) local.push({ label: ws.terminalProfilesLoading ? 'Looking for shells…' : 'No shells found', disabled: true, divider: !!env })
  items.push(...local)

  // Every environment, grouped by server; the last item of whereItems is "Manage environments…".
  const envItems = whereItems(null, (where) => {
    if (where) ws.newTerminal(envPath({ ...where, dir: '/home/agent' }))
  }, () => useEnvironments().openView())
  items.push(...envItems.slice(1, -1))
  items.push(
    { label: 'Look for shells again', icon: RefreshCw, divider: true, onSelect: () => ws.loadTerminalProfiles() },
    { label: 'Terminal settings…', icon: Settings, onSelect: () => ws.openSettings('terminal') },
  )
  return items
})
</script>

<template>
  <section
    class="terminal-panel"
    :class="{ 'is-dragging': dragging, 'is-animating': animating }"
    :style="panelStyle"
    :aria-label="hasPluginTabs ? 'Bottom panel' : 'Terminal'"
    data-tab-drop="panel"
    @transitionend="onPanelTransitionEnd"
  >
    <div
      class="terminal-panel__handle"
      role="separator"
      aria-orientation="horizontal"
      aria-label="Resize terminal"
      :aria-valuenow="Math.round(ws.terminalHeight * 100)"
      aria-valuemin="14"
      aria-valuemax="80"
      @pointerdown="onHandleDown"
      @pointermove="onHandleMove"
      @pointerup="endDrag"
      @pointercancel="endDrag"
      @dblclick="toggleTall"
    />

    <header class="terminal-panel__header">
      <div
        ref="strip"
        class="terminal-panel__tabs"
        role="tablist"
        :aria-label="hasPluginTabs ? 'Panel tabs' : 'Terminals'"
        data-term-strip
        @wheel="onStripWheel"
      >
        <template v-for="(item, i) in stripItems" :key="item.key">
          <!-- A plugin's panel tab: moves and closes like a terminal's tab; no shell. -->
          <div
            v-if="item.kind === 'plugin'"
            class="term-tab"
            :class="{ 'is-active': showingPlugin?.fullId === item.key, 'is-dragged': draggedPanelItem()?.id === item.key }"
            role="tab"
            :data-tab-id="item.key"
            :data-term-id="item.key"
            :aria-selected="showingPlugin?.fullId === item.key"
            :aria-label="badgeOf(item.tab) ? `${item.tab.title}, ${badgeOf(item.tab)}` : item.tab.title"
            :tabindex="showingPlugin?.fullId === item.key ? 0 : -1"
            :title="item.tab.title"
            @click="activatePlugin(item.key)"
            @pointerdown="pressPanelTab($event, item.key, 'panel')"
            @contextmenu.prevent="onTabContext($event, item.key)"
            @mousedown.middle.prevent
            @auxclick.middle.prevent="ws.closePanelTab(item.key)"
            @keydown.enter.prevent="activatePlugin(item.key)"
            @keydown.space.prevent="activatePlugin(item.key)"
            @keydown="onTabKey($event, i)"
          >
            <PluginIcon :icon="item.tab.icon" class="term-tab__icon" />
            <span class="term-tab__title">{{ item.tab.title }}</span>
            <span v-if="badgeOf(item.tab)" class="term-tab__badge tabular" aria-hidden="true">{{ badgeOf(item.tab) > 99 ? '99+' : badgeOf(item.tab) }}</span>
            <button
              type="button"
              class="term-tab__close"
              tabindex="-1"
              :aria-label="`Close ${item.tab.title}`"
              title="Close"
              @click.stop="ws.closePanelTab(item.key)"
            >
              <X aria-hidden="true" />
            </button>
          </div>
          <div
            v-else
            class="term-tab"
            :class="{ 'is-active': !showingPlugin && item.key === ws.activeTerminalId, 'is-exited': item.term.exited, 'is-dragged': draggedPanelItem()?.id === item.key }"
            role="tab"
            :data-tab-id="item.key"
            :data-term-id="item.key"
            :aria-selected="!showingPlugin && item.key === ws.activeTerminalId"
            :tabindex="!showingPlugin && item.key === ws.activeTerminalId ? 0 : -1"
            :title="tabTitle(item.term)"
            @click="activate(item.key)"
            @pointerdown="pressTerminalTab($event, item.key, 'panel')"
            @contextmenu.prevent="onTabContext($event, item.key)"
            @mousedown.middle.prevent
            @auxclick.middle.prevent="ws.closeTerminal(item.key)"
            @keydown.enter.prevent="activate(item.key)"
            @keydown.space.prevent="activate(item.key)"
            @keydown="onTabKey($event, i)"
          >
            <component :is="isEnvPath(item.term.cwd) ? Server : SquareTerminal" class="term-tab__icon" aria-hidden="true" />
            <span class="term-tab__title">{{ item.term.title }}</span>
            <span v-if="item.term.shell" class="term-tab__shell">{{ item.term.shell }}</span>
            <button
              type="button"
              class="term-tab__close"
              tabindex="-1"
              :aria-label="`Close ${item.term.title}`"
              title="Close"
              @click.stop="ws.closeTerminal(item.key)"
            >
              <X aria-hidden="true" />
            </button>
          </div>
        </template>
        <div class="terminal-panel__new">
          <UiIconButton :label="newLabel" size="sm" @click="ws.newTerminal()">
            <Plus />
          </UiIconButton>
          <UiMenu :items="profileItems" placement="bottom-start" :width="280" label="New terminal with…">
            <template #default="{ toggle, open }">
              <button
                type="button"
                class="terminal-panel__pick"
                :class="{ 'is-open': open }"
                aria-label="Choose where a new terminal runs"
                :title="open ? undefined : 'Choose a shell or an environment'"
                aria-haspopup="menu"
                :aria-expanded="open"
                @click="() => { if (!open) refreshEnvs({ once: true }); toggle() }"
              >
                <ChevronDown />
              </button>
            </template>
          </UiMenu>
        </div>
      </div>

      <div class="terminal-panel__actions">
        <UiIconButton
          :label="moveLabel"
          size="sm"
          :disabled="!canMoveToEditor || (!showingPlugin && !ws.activeTerminalId)"
          @click="showingPlugin ? ws.movePanelTabToEditor(showingPlugin.fullId) : ws.activeTerminalId && ws.moveTerminalToEditor(ws.activeTerminalId)"
        >
          <ArrowUpToLine />
        </UiIconButton>
        <UiIconButton :label="isMaximized ? 'Restore panel size' : 'Maximize panel'" size="sm" @click="toggleMaximize">
          <Minimize2 v-if="isMaximized" />
          <Maximize2 v-else />
        </UiIconButton>
        <UiIconButton :label="hasPluginTabs ? 'Hide panel' : 'Hide terminal'" size="sm" @click="ws.toggleTerminal(false)">
          <ChevronDown />
        </UiIconButton>
      </div>
    </header>

    <div class="terminal-panel__body" data-term-body>
      <Teleport v-for="tab in ws.terminalTabs" :key="tab.id" :to="slotOf(tab) ?? 'body'" :disabled="!slotOf(tab)">
        <TerminalView
          v-show="slotOf(tab) || (!tab.inEditor && !showingPlugin && tab.id === ws.activeTerminalId)"
          :ref="(el: any) => { views[tab.id] = el }"
          :tab="tab"
          :active="slotOf(tab) ? paneTerminal === tab.id : !showingPlugin && tab.id === ws.activeTerminalId"
          :visible="slotOf(tab) ? true : ws.terminalOpen && !tab.inEditor && !showingPlugin"
          :place="placeOf(tab)"
        />
      </Teleport>
      <!-- Plugin panel tabs' views, teleported into their pane while one shows them in the main area. -->
      <Teleport v-for="pt in mountedTabs" :key="pt.fullId" :to="pluginSlot(pt.fullId) ?? 'body'" :disabled="!pluginSlot(pt.fullId)">
        <div
          v-show="pluginSlot(pt.fullId) || (!editorTabOf(pt.fullId) && showingPlugin?.fullId === pt.fullId)"
          class="terminal-panel__plugin"
          role="tabpanel"
          :aria-label="pt.title"
        >
          <PluginViewHost :view="pt.view" :ctx="ctxs[pt.fullId]" :plugin-id="pt.pluginId" />
        </div>
      </Teleport>
    </div>

    <UiMenu ref="tabMenu" :items="tabMenuItems" :width="220" label="Terminal actions" />
  </section>
</template>

<style scoped>
.terminal-panel {
  position: relative;
  flex: none;
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: var(--bg-inset);
  border-top: 1px solid var(--line-soft);
}
.terminal-panel.is-animating {
  transition: height var(--dur-med) var(--ease-out);
}

/* ---------- resize handle ---------- */
.terminal-panel__handle {
  position: absolute;
  z-index: 5;
  top: -4px;
  left: 0;
  right: 0;
  height: 6px;
  cursor: row-resize;
  touch-action: none;
}
.terminal-panel__handle::after {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  top: 3px;
  height: 1px;
  background: transparent;
  transition: background var(--dur-fast) var(--ease-out);
}
.terminal-panel__handle:hover::after {
  background: var(--accent-line);
  transition-delay: 150ms;
}
.terminal-panel.is-dragging .terminal-panel__handle::after {
  background: var(--accent-line);
  transition-delay: 0ms;
}
.terminal-panel.is-dragging .terminal-panel__body {
  pointer-events: none;
}

/* ---------- header ---------- */
.terminal-panel__header {
  flex: none;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  height: 32px;
  padding: 0 var(--space-1) 0 var(--space-2);
}

.terminal-panel__tabs {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 2px;
  height: 100%;
  overflow-x: auto;
  overflow-y: hidden;
  scrollbar-width: none;
}
.terminal-panel__tabs::-webkit-scrollbar {
  display: none;
}
.terminal-panel__new {
  margin-left: var(--space-1);
}

.term-tab {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 24px;
  max-width: 200px;
  padding: 0 var(--space-1) 0 var(--space-2);
  border-radius: var(--radius-sm);
  color: var(--fg-subtle);
  font-size: var(--text-xs);
  line-height: 1;
  white-space: nowrap;
  cursor: pointer;
  transition: background var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out);
}
.term-tab:hover {
  color: var(--fg-muted);
}
.term-tab.is-active {
  color: var(--fg);
  background: var(--bg-hover);
}
.term-tab:focus-visible {
  outline-offset: -1px;
}
/* Being dragged out: the tab stays put, faded, until it is dropped. */
.term-tab.is-dragged {
  opacity: 0.45;
}

.term-tab__icon {
  flex: none;
  width: 13px;
  height: 13px;
  stroke-width: 1.75;
  opacity: 0.75;
}
.term-tab.is-active .term-tab__icon {
  color: var(--accent-ink);
  opacity: 1;
}

.term-tab__shell {
  flex: none;
  font-size: var(--text-2xs);
  color: var(--fg-faint);
}
.terminal-panel__new { display: flex; align-items: center; flex: none; }
.terminal-panel__pick {
  display: grid;
  place-items: center;
  width: 16px;
  height: 22px;
  margin-left: -2px;
  border-radius: var(--radius-xs);
  color: var(--fg-subtle);
  transition: background var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out);
}
.terminal-panel__pick svg { width: 12px; height: 12px; stroke-width: 2; }
.terminal-panel__pick:hover, .terminal-panel__pick.is-open { background: var(--bg-hover); color: var(--fg); }
.term-tab__title {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
.term-tab.is-exited .term-tab__title,
.term-tab.is-exited .term-tab__icon {
  color: var(--fg-faint);
}

.term-tab__close {
  flex: none;
  display: inline-grid;
  place-items: center;
  width: 16px;
  height: 16px;
  border-radius: var(--radius-xs);
  color: var(--fg-subtle);
  opacity: 0;
  transition: opacity var(--dur-fast) var(--ease-out), background var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out);
}
.term-tab__close :deep(svg) {
  width: 12px;
  height: 12px;
  stroke-width: 2;
}
.term-tab:hover .term-tab__close,
.term-tab.is-active .term-tab__close {
  opacity: 1;
}
.term-tab__close:hover {
  color: var(--fg);
  background: var(--bg-active);
}

.terminal-panel__actions {
  flex: none;
  display: flex;
  align-items: center;
  gap: 2px;
}

/* A plugin panel tab's count (e.g. unread), after its title. */
.term-tab__badge {
  flex: none;
  min-width: 14px;
  height: 14px;
  padding: 0 4px;
  border-radius: var(--radius-pill);
  background: var(--bg-active);
  color: var(--fg-muted);
  font-size: var(--text-2xs);
  font-weight: 600;
  line-height: 14px;
  text-align: center;
}

/* ---------- body ---------- */
.terminal-panel__body {
  flex: 1;
  min-height: 0;
  position: relative;
}
.terminal-panel__plugin {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  overflow: auto;
}
</style>
