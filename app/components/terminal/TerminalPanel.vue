<script setup lang="ts">
import { ChevronDown, Maximize2, Minimize2, Plus, RefreshCw, Settings, SquareTerminal, X } from 'lucide-vue-next'
import type { MenuItem } from '~/types/ui'
import { useWorkspace } from '~/stores/workspace'

/**
 * Docked terminal panel at the bottom of the main column.
 * Height is a fraction of `container` (the column), stored in the workspace.
 */
const props = defineProps<{ container: HTMLElement | null }>()

const ws = useWorkspace()

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

const panelStyle = computed(() => ({
  height: containerHeight.value
    ? `${Math.round(ws.terminalHeight * containerHeight.value)}px`
    : `${ws.terminalHeight * 100}%`,
}))

/* ---------- height changes ---------- */
// Animate only deliberate jumps (double-click, maximize), never drags or window resizes.
const animating = ref(false)
let animTimer: ReturnType<typeof setTimeout> | undefined
function jumpTo(fraction: number) {
  animating.value = true
  clearTimeout(animTimer)
  animTimer = setTimeout(() => { animating.value = false }, 280)
  ws.setTerminalHeight(fraction)
  ws.persist()
}

const isMaximized = computed(() => ws.terminalHeight >= MAX_H - 0.01)
const toggleMaximize = () => jumpTo(isMaximized.value ? DEFAULT_H : MAX_H)
const toggleTall = () => jumpTo(ws.terminalHeight > (DEFAULT_H + TALL_H) / 2 ? DEFAULT_H : TALL_H)

/* ---------- drag handle ---------- */
const dragging = ref(false)
let dragStartY = 0
let dragStartFrac = 0

function onHandleDown(e: PointerEvent) {
  if (e.button !== 0 || !containerHeight.value) return
  e.preventDefault()
  ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  dragStartY = e.clientY
  dragStartFrac = ws.terminalHeight
  dragging.value = true
  document.body.style.cursor = 'row-resize'
}

function onHandleMove(e: PointerEvent) {
  if (!dragging.value || !containerHeight.value) return
  ws.setTerminalHeight(dragStartFrac + (dragStartY - e.clientY) / containerHeight.value)
}

function endDrag(e: PointerEvent) {
  if (!dragging.value) return
  dragging.value = false
  document.body.style.cursor = ''
  const el = e.currentTarget as HTMLElement
  if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId)
  ws.persist()
}

/* ---------- tabs ---------- */
// Visible with no tabs (e.g. restored as open on launch): start a shell.
watch(() => ws.terminalOpen, (open) => {
  if (open && ws.terminalTabs.length === 0) ws.newTerminal()
}, { immediate: true })

const views = ref<Record<string, { focus: () => void } | null>>({})
function activate(id: string) {
  ws.activeTerminalId = id
  // Clicking a tab means "I want to type there", also when it was already the active one.
  nextTick(() => views.value[id]?.focus())
}

const strip = ref<HTMLElement | null>(null)
watch(() => ws.activeTerminalId, async (id) => {
  await nextTick()
  strip.value?.querySelector<HTMLElement>(`[data-tab-id="${id}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
})

/** Vertical wheel scrolls the tab strip sideways. */
function onStripWheel(e: WheelEvent) {
  const el = strip.value
  if (!el || el.scrollWidth <= el.clientWidth || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return
  el.scrollLeft += e.deltaY
  e.preventDefault()
}

function onTabKey(e: KeyboardEvent, index: number) {
  const tabs = ws.terminalTabs
  let next = -1
  if (e.key === 'ArrowRight') next = (index + 1) % tabs.length
  else if (e.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length
  else if (e.key === 'Home') next = 0
  else if (e.key === 'End') next = tabs.length - 1
  else return
  e.preventDefault()
  const tab = tabs[next]
  if (!tab) return
  activate(tab.id)
  nextTick(() => strip.value?.querySelector<HTMLElement>(`[data-tab-id="${tab.id}"]`)?.focus())
}

onBeforeUnmount(() => {
  clearTimeout(animTimer)
  if (dragging.value) document.body.style.cursor = ''
})

/** Shells to open a terminal with: every one found on this machine, plus the way to settings. */
const profileItems = computed<MenuItem[]>(() => {
  const fallback = ws.defaultTerminalProfile
  const items: MenuItem[] = ws.terminalProfiles.map(p => ({
    label: p.name,
    hint: p.path,
    icon: SquareTerminal,
    kbd: p.id === fallback?.id ? 'Default' : undefined,
    onSelect: () => ws.newTerminal(undefined, p.id),
  }))
  if (!items.length) items.push({ label: ws.terminalProfilesLoading ? 'Looking for shells…' : 'No shells found', disabled: true })
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
    aria-label="Terminal"
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
        aria-label="Terminals"
        @wheel="onStripWheel"
      >
        <div
          v-for="(tab, i) in ws.terminalTabs"
          :key="tab.id"
          class="term-tab"
          :class="{ 'is-active': tab.id === ws.activeTerminalId, 'is-exited': tab.exited }"
          role="tab"
          :data-tab-id="tab.id"
          :aria-selected="tab.id === ws.activeTerminalId"
          :tabindex="tab.id === ws.activeTerminalId ? 0 : -1"
          :title="[tab.shell, tab.cwd ?? tab.title, tab.exited ? '(exited)' : ''].filter(Boolean).join(' — ')"
          @click="activate(tab.id)"
          @mousedown.middle.prevent
          @auxclick.middle.prevent="ws.closeTerminal(tab.id)"
          @keydown.enter.prevent="activate(tab.id)"
          @keydown.space.prevent="activate(tab.id)"
          @keydown="onTabKey($event, i)"
        >
          <SquareTerminal class="term-tab__icon" aria-hidden="true" />
          <span class="term-tab__title">{{ tab.title }}</span>
          <span v-if="tab.shell" class="term-tab__shell">{{ tab.shell }}</span>
          <button
            type="button"
            class="term-tab__close"
            tabindex="-1"
            :aria-label="`Close ${tab.title}`"
            title="Close"
            @click.stop="ws.closeTerminal(tab.id)"
          >
            <X aria-hidden="true" />
          </button>
        </div>
        <div class="terminal-panel__new">
          <UiIconButton :label="ws.defaultTerminalProfile ? `New ${ws.defaultTerminalProfile.name} terminal` : 'New terminal'" size="sm" @click="ws.newTerminal()">
            <Plus />
          </UiIconButton>
          <UiMenu :items="profileItems" placement="bottom-start" :width="280" label="New terminal with…">
            <template #default="{ toggle, open }">
              <button
                type="button"
                class="terminal-panel__pick"
                :class="{ 'is-open': open }"
                aria-label="Choose a shell for a new terminal"
                :title="open ? undefined : 'Choose a shell'"
                aria-haspopup="menu"
                :aria-expanded="open"
                @click="toggle"
              >
                <ChevronDown />
              </button>
            </template>
          </UiMenu>
        </div>
      </div>

      <div class="terminal-panel__actions">
        <UiIconButton :label="isMaximized ? 'Restore panel size' : 'Maximize panel'" size="sm" @click="toggleMaximize">
          <Minimize2 v-if="isMaximized" />
          <Maximize2 v-else />
        </UiIconButton>
        <UiIconButton label="Hide terminal" size="sm" @click="ws.toggleTerminal(false)">
          <ChevronDown />
        </UiIconButton>
      </div>
    </header>

    <div class="terminal-panel__body">
      <TerminalView
        v-for="tab in ws.terminalTabs"
        v-show="tab.id === ws.activeTerminalId"
        :key="tab.id"
        :ref="(el: any) => { views[tab.id] = el }"
        :tab="tab"
        :active="tab.id === ws.activeTerminalId"
        :visible="ws.terminalOpen"
      />
    </div>
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

/* ---------- body ---------- */
.terminal-panel__body {
  flex: 1;
  min-height: 0;
  position: relative;
}
</style>
