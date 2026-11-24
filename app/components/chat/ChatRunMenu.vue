<script lang="ts">
import { FilePen, Map as MapIcon, ShieldCheck, Zap } from 'lucide-vue-next'
import type { PermissionMode } from '~/types/chat'

/** The permission modes as the composer names them. */
export const PERMISSION_MODES = {
  plan: { label: 'Plan', hint: 'Read-only: explores and proposes a plan', icon: MapIcon },
  ask: { label: 'Ask first', hint: 'Asks before edits and commands', icon: ShieldCheck },
  edits: { label: 'Accept edits', hint: 'Edits files freely, asks before commands', icon: FilePen },
  auto: { label: 'Full auto', hint: 'Never asks. Use with care.', icon: Zap },
} as const satisfies Record<PermissionMode, unknown>
</script>

<script setup lang="ts">
import { Check, ChevronRight, Gauge } from 'lucide-vue-next'
import type { Component } from 'vue'
import { useWorkspace } from '~/stores/workspace'
import { useModels } from '~/stores/models'
import { useOverlay } from '~/composables/useOverlay'
import { isEnvPath } from '~/utils/envPath'
import { AGENTS, type AgentId } from '~/types/chat'
import ChatEffort from '~/components/chat/ChatEffort.vue'
import AgentIcon from '~/components/ui/AgentIcon.vue'

/**
 * The composer's run settings in one menu, one step at a time: the agents (each opens its
 * models), then effort and permissions (each opens its own panel). The menu and its flyout
 * are teleported to <body> with fixed coordinates, like UiMenu.
 */
const props = defineProps<{
  agent: AgentId
  model: string
  mode: PermissionMode
  /** null: the CLI's default */
  effort: string | null
  /** Levels the chat's model accepts; empty hides the Effort row. */
  efforts: string[]
  /** The level the CLI picks by default, when it says. */
  fallbackEffort?: string
  /** How the chosen effort reads ("High", "Default"). */
  effortText: string
  busy?: boolean
  /** The chat already has messages: another agent would start without them. */
  started?: boolean
}>()

const emit = defineEmits<{
  /** A model, possibly of the other agent. */
  pick: [agent: AgentId, model: string]
  'update:effort': [effort: string | null]
  'update:mode': [mode: PermissionMode]
}>()

const ws = useWorkspace()
const models = useModels()

type RowKey = AgentId | 'effort' | 'mode'
interface Row { key: RowKey; label: string; aside: string; icon: Component | null; agent?: AgentId }
interface Choice { key: string; label: string; hint?: string; icon?: Component; checked: boolean; disabled?: boolean; divider?: boolean; onSelect: () => void }

const agentIds = Object.keys(AGENTS) as AgentId[]
/** A remote project runs the CLI in its instance: whether it is installed here does not matter. */
function missing(id: AgentId) {
  const info = ws.agents.find(a => a.id === id)
  return !!info && !info.installed && !isEnvPath(ws.activeProjectPath)
}

const rows = computed<Row[]>(() => [
  ...agentIds.map((id): Row => ({
    key: id,
    agent: id,
    label: AGENTS[id].name,
    aside: id === props.agent ? models.label(id, props.model, ws.activeProjectPath) : missing(id) ? 'Not installed' : '',
    icon: null,
  })),
  ...(props.efforts.length ? [{ key: 'effort' as const, label: 'Effort', aside: props.effortText, icon: Gauge }] : []),
  { key: 'mode', label: 'Permissions', aside: PERMISSION_MODES[props.mode].label, icon: PERMISSION_MODES[props.mode].icon },
])

/* ---------- open / close ---------- */

const open = ref(false)
useOverlay(() => open.value)
const root = ref<HTMLElement | null>(null)
const pop = ref<HTMLElement | null>(null)
const fly = ref<HTMLElement | null>(null)
const effortPanel = ref<InstanceType<typeof ChatEffort> | null>(null)
/** The highlighted row of the menu, and the row whose flyout is out (null: none). */
const active = ref(0)
const sub = ref<RowKey | null>(null)
/** The highlighted choice in a list flyout (-1: none). */
const subActive = ref(-1)

const WIDTH = 248
const GAP = 6
const MARGIN = 8
const FLY_CAP = 380
const pos = ref<{ left: number; top?: number; bottom?: number; origin: string }>({ left: 0, bottom: 0, origin: 'bottom left' })
const flyPos = ref<{ left: number; top: number; maxHeight: number; side: 'right' | 'left' }>({ left: 0, top: 0, maxHeight: FLY_CAP, side: 'right' })
/** The flyout is already out and moves to another row: let it glide there instead of jumping. */
const flyGlide = ref(false)

function place() {
  const r = root.value?.getBoundingClientRect()
  if (!r) return
  const vw = window.innerWidth
  const vh = window.innerHeight
  const height = pop.value?.offsetHeight ?? rows.value.length * 34 + 30
  const above = r.top - GAP - MARGIN
  const below = vh - r.bottom - GAP - MARGIN
  const left = Math.max(MARGIN, Math.min(r.left, vw - WIDTH - MARGIN))
  pos.value = above >= height || above >= below
    ? { left, bottom: vh - r.top + GAP, origin: 'bottom left' }
    : { left, top: r.bottom + GAP, origin: 'top left' }
}

/**
 * Beside its row, on the side with room, its first choice level with the row like a native submenu.
 * Where the window is too short below, it slides up only as far as it must, and scrolls past the room
 * there is.
 */
function placeFly() {
  const row = pop.value?.querySelector<HTMLElement>(`[data-row="${sub.value}"]`)
  const box = pop.value?.getBoundingClientRect()
  const el = fly.value
  if (!row || !box || !el) return
  const rr = row.getBoundingClientRect()
  const vw = window.innerWidth
  const vh = window.innerHeight
  const width = el.offsetWidth
  let left = box.right + 4
  let side: 'right' | 'left' = 'right'
  if (left + width > vw - MARGIN) {
    left = box.left - width - 4
    side = 'left'
  }
  left = Math.max(MARGIN, left)
  // Line the first choice up with the row: the flyout's padding plus its border.
  const inset = 5
  const maxHeight = Math.min(FLY_CAP, vh - 2 * MARGIN)
  const need = Math.min(el.scrollHeight + 2, maxHeight)
  const top = Math.max(MARGIN, Math.min(rr.top - inset, vh - MARGIN - need))
  flyPos.value = { left, top, maxHeight, side }
}

async function show() {
  place()
  open.value = true
  sub.value = null
  active.value = Math.max(0, rows.value.findIndex(r => r.key === props.agent))
  await nextTick()
  place()
  pop.value?.focus({ preventScroll: true })
}
function close(refocus = false) {
  if (!open.value) return
  clearTimeout(hoverTimer)
  open.value = false
  sub.value = null
  if (refocus) root.value?.querySelector<HTMLElement>('button')?.focus()
}
const toggle = () => (open.value ? close() : show())

/* ---------- the flyouts ---------- */

const modeChoices = computed<Choice[]>(() => (Object.keys(PERMISSION_MODES) as PermissionMode[]).map(k => ({
  key: k,
  label: PERMISSION_MODES[k].label,
  hint: PERMISSION_MODES[k].hint,
  icon: PERMISSION_MODES[k].icon,
  checked: props.mode === k,
  onSelect: () => { emit('update:mode', k); close(true) },
})))

function modelChoices(agent: AgentId): Choice[] {
  const list = models.list(agent, ws.activeProjectPath)
  // Claude Code lists its aliases first, then pinned versions: set those apart.
  const firstPinned = list.findIndex(m => m.id.startsWith('claude-'))
  const locked = agent !== props.agent && !!props.busy
  return list.map((m, i) => ({
    key: m.id,
    label: m.label,
    hint: m.hint,
    checked: agent === props.agent && props.model === m.id,
    disabled: locked,
    divider: i > 0 && i === firstPinned,
    onSelect: () => { emit('pick', agent, m.id); close(true) },
  }))
}

const choices = computed<Choice[]>(() => {
  if (sub.value === 'mode') return modeChoices.value
  if (sub.value && sub.value !== 'effort') return modelChoices(sub.value)
  return []
})
const enabled = computed(() => choices.value.map((c, i) => (c.disabled ? -1 : i)).filter(i => i >= 0))

/** What switching to the flyout's agent would mean for this chat, when that needs saying. */
const switchNote = computed(() => {
  const target = sub.value
  if (!target || target === 'effort' || target === 'mode' || target === props.agent) return null
  const other = AGENTS[target].name
  if (props.busy) return `Stop ${AGENTS[props.agent].name} to switch this chat to ${other}.`
  if (props.started) return `${other} starts a new conversation: it won't see the messages above.`
  return null
})

async function openSub(key: RowKey, focus = false) {
  clearTimeout(hoverTimer)
  active.value = rows.value.findIndex(r => r.key === key)
  flyGlide.value = sub.value !== null
  if (sub.value !== key) {
    sub.value = key
    if (key !== 'effort' && key !== 'mode') void models.refresh(key, ws.activeProjectPath)
  }
  const checked = choices.value.findIndex(c => c.checked && !c.disabled)
  subActive.value = focus ? (checked >= 0 ? checked : enabled.value[0] ?? -1) : -1
  await nextTick()
  placeFly()
  await nextTick()
  placeFly()
  fly.value?.querySelector<HTMLElement>('.run__choice.is-checked')?.scrollIntoView({ block: 'nearest' })
  if (!focus) return
  if (key === 'effort') effortPanel.value?.focus()
  else fly.value?.focus({ preventScroll: true })
}
function backToMenu() {
  sub.value = null
  pop.value?.focus({ preventScroll: true })
}

/* A flyout follows the pointer after a short pause, so a diagonal move towards it does not swap it. */
let hoverTimer: ReturnType<typeof setTimeout> | undefined
function onRowEnter(i: number) {
  active.value = i
  const key = rows.value[i]!.key
  clearTimeout(hoverTimer)
  if (sub.value === key) return
  if (sub.value === null) void openSub(key)
  else hoverTimer = setTimeout(() => void openSub(key), 140)
}

/** The pointer reached the flyout: keep it, whatever row it crossed on the way. */
function holdFly() {
  clearTimeout(hoverTimer)
  active.value = rows.value.findIndex(r => r.key === sub.value)
}

// The model list may arrive while its flyout is out: keep it lined up with its row.
watch(() => choices.value.length, () => { if (sub.value) nextTick(placeFly) })

/* ---------- keyboard ---------- */

function onMenuKey(e: KeyboardEvent) {
  const n = rows.value.length
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault()
    active.value = (active.value + (e.key === 'ArrowDown' ? 1 : -1) + n) % n
    sub.value = null
  } else if (e.key === 'Home' || e.key === 'End') {
    e.preventDefault()
    active.value = e.key === 'Home' ? 0 : n - 1
    sub.value = null
  } else if (e.key === 'ArrowRight' || e.key === 'Enter' || e.key === ' ') {
    e.preventDefault()
    const row = rows.value[active.value]
    if (row) void openSub(row.key, true)
  } else if (e.key === 'Escape') {
    // Escape here closes the menu; it must not reach the pane, which would stop the agent.
    e.preventDefault()
    e.stopPropagation()
    close(true)
  } else if (e.key === 'Tab') {
    e.preventDefault()
    close(true)
  }
}

function onListKey(e: KeyboardEvent) {
  const list = enabled.value
  const at = list.indexOf(subActive.value)
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault()
    if (list.length) subActive.value = list[(at + (e.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length]!
  } else if (e.key === 'Home' || e.key === 'End') {
    e.preventDefault()
    subActive.value = (e.key === 'Home' ? list[0] : list[list.length - 1]) ?? -1
  } else if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault()
    const c = choices.value[subActive.value]
    if (c && !c.disabled) c.onSelect()
  } else if (e.key === 'ArrowLeft' || e.key === 'Escape') {
    e.preventDefault()
    e.stopPropagation()
    backToMenu()
  } else if (e.key === 'Tab') {
    e.preventDefault()
    close(true)
  }
  nextTick(() => fly.value?.querySelector<HTMLElement>('.run__choice.is-active')?.scrollIntoView({ block: 'nearest' }))
}

/* ---------- outside the menu ---------- */

function inside(t: Node) {
  return !!(root.value?.contains(t) || pop.value?.contains(t) || fly.value?.contains(t))
}
function onDocDown(e: MouseEvent) {
  if (open.value && !inside(e.target as Node)) close()
}
/** Scrolling or resizing moves the trigger: keep it simple and close. */
function onViewportChange(e: Event) {
  if (!open.value || (e.type === 'scroll' && inside(e.target as Node))) return
  close()
}
onMounted(() => {
  document.addEventListener('mousedown', onDocDown, true)
  window.addEventListener('scroll', onViewportChange, true)
  window.addEventListener('resize', onViewportChange)
  window.addEventListener('blur', onViewportChange)
})
onBeforeUnmount(() => {
  clearTimeout(hoverTimer)
  document.removeEventListener('mousedown', onDocDown, true)
  window.removeEventListener('scroll', onViewportChange, true)
  window.removeEventListener('resize', onViewportChange)
  window.removeEventListener('blur', onViewportChange)
})

defineExpose({ toggle, close })
</script>

<template>
  <div ref="root" class="run-anchor">
    <slot :open="open" :toggle="toggle" />
    <Teleport to="body">
      <Transition name="run">
        <div
          v-if="open"
          ref="pop"
          class="run"
          role="menu"
          aria-label="Agent, model, effort and permissions"
          tabindex="-1"
          :style="{
            width: `${WIDTH}px`,
            left: `${pos.left}px`,
            top: pos.top != null ? `${pos.top}px` : undefined,
            bottom: pos.bottom != null ? `${pos.bottom}px` : undefined,
            transformOrigin: pos.origin,
          }"
          @keydown="onMenuKey"
        >
          <template v-for="(row, i) in rows" :key="row.key">
            <div v-if="i === 0" class="run__group" role="presentation">Agent</div>
            <div v-else-if="row.key === 'effort' || (row.key === 'mode' && !efforts.length)" class="run__sep" role="separator" />
            <button
              type="button"
              class="run__row"
              :class="{ 'is-active': i === active, 'is-open': sub === row.key }"
              :data-row="row.key"
              role="menuitem"
              aria-haspopup="true"
              :aria-expanded="sub === row.key"
              @mouseenter="onRowEnter(i)"
              @click="openSub(row.key, true)"
            >
              <span class="run__icon">
                <AgentIcon v-if="row.agent" :agent="row.agent" />
                <component :is="row.icon" v-else-if="row.icon" />
              </span>
              <span class="run__label">{{ row.label }}</span>
              <span v-if="row.aside" class="run__aside">{{ row.aside }}</span>
              <ChevronRight class="run__arrow" />
            </button>
          </template>
        </div>
      </Transition>
      <Transition name="run-fly">
        <div
          v-if="open && sub"
          ref="fly"
          class="run run__fly"
          :class="{
            'run__fly--effort': sub === 'effort',
            'run__fly--left': flyPos.side === 'left',
            'is-gliding': flyGlide,
          }"
          :role="sub === 'effort' ? 'dialog' : 'menu'"
          :aria-label="sub === 'effort' ? 'Reasoning effort' : sub === 'mode' ? 'Permissions' : `${AGENTS[sub].name} models`"
          tabindex="-1"
          :style="{
            left: `${flyPos.left}px`,
            top: `${flyPos.top}px`,
            maxHeight: `${flyPos.maxHeight}px`,
          }"
          @mouseenter="holdFly"
          @keydown="sub !== 'effort' && onListKey($event)"
        >
          <!-- Keyed by the row, so another row's choices fade in rather than swap in place. -->
          <div :key="sub" class="run__body">
            <ChatEffort
              v-if="sub === 'effort'"
              ref="effortPanel"
              :efforts="efforts"
              :model-value="effort"
              :fallback="fallbackEffort"
              :agent-name="AGENTS[agent].name"
              @update:model-value="e => emit('update:effort', e)"
              @done="backToMenu"
            />
            <template v-else>
              <p v-if="switchNote" class="run__note">{{ switchNote }}</p>
              <template v-for="(c, i) in choices" :key="c.key">
                <div v-if="c.divider" class="run__sep" role="separator" />
                <button
                  type="button"
                  class="run__row run__choice"
                  :class="{ 'is-active': i === subActive, 'is-checked': c.checked }"
                  role="menuitemradio"
                  :aria-checked="c.checked"
                  :disabled="c.disabled"
                  @mouseenter="!c.disabled && (subActive = i)"
                  @click="c.onSelect()"
                >
                  <span v-if="c.icon" class="run__icon"><component :is="c.icon" /></span>
                  <span class="run__text">
                    <span class="run__label">{{ c.label }}</span>
                    <span v-if="c.hint" class="run__hint">{{ c.hint }}</span>
                  </span>
                  <Check v-if="c.checked" class="run__check" />
                </button>
              </template>
            </template>
          </div>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>

<style scoped>
.run-anchor { display: inline-flex; min-width: 0; }

.run {
  position: fixed;
  z-index: 80;
  max-width: calc(100vw - 16px);
  padding: var(--space-1);
  overflow-y: auto;
  background: var(--bg-raised);
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-pop);
  outline: none;
  font-size: var(--text-sm);
  overscroll-behavior: contain;
}
.run__fly { width: 288px; z-index: 81; }
.run__fly--effort { width: 300px; overflow: visible; }
/* Moving between rows, the open flyout glides to the new one. */
.run__fly.is-gliding { transition: top var(--dur-med) var(--ease-out), left var(--dur-med) var(--ease-out); }

.run__group {
  padding: var(--space-2) var(--space-2) 2px;
  font-size: var(--text-xs);
  font-weight: 600;
  color: var(--fg-subtle);
}
.run__sep { height: 1px; margin: var(--space-1) var(--space-2); background: var(--line-soft); }

.run__row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  min-height: 30px;
  padding: 5px var(--space-2);
  border-radius: var(--radius-sm);
  text-align: left;
  color: var(--fg);
  transition: background-color var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out);
}
.run__row.is-active, .run__row.is-open { background: var(--bg-hover); }
.run__row:disabled { color: var(--fg-faint); cursor: default; }
.run__row:disabled .run__hint { color: var(--fg-faint); }
.run__icon { width: 20px; display: grid; place-items: center; flex: none; color: var(--fg-subtle); font-size: 15px; }
.run__icon svg { width: 15px; height: 15px; stroke-width: 1.75; }
.run__text { flex: 1; min-width: 0; display: grid; }
.run__label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.run__hint { font-size: var(--text-xs); color: var(--fg-subtle); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.run__aside {
  flex: 0 1 auto;
  max-width: 48%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--text-xs);
  color: var(--fg-subtle);
}
.run__arrow {
  width: 13px;
  height: 13px;
  flex: none;
  stroke-width: 2;
  color: var(--fg-subtle);
  transition: transform var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out);
}
.run__row.is-open .run__arrow { color: var(--fg-muted); transform: translateX(2px); }
.run__check { width: 14px; height: 14px; flex: none; color: var(--accent-ink); }
.run__note {
  margin: 0;
  padding: var(--space-2) var(--space-2) 6px;
  font-size: var(--text-xs);
  line-height: var(--leading-normal);
  color: var(--fg-muted);
}

.run-enter-active { transition: opacity var(--dur-med) var(--ease-out), transform var(--dur-med) var(--ease-out); }
.run-leave-active { transition: opacity var(--dur-fast) var(--ease-out), transform var(--dur-fast) var(--ease-out); }
.run-enter-from { opacity: 0; transform: translateY(4px) scale(0.98); }
.run-leave-to { opacity: 0; transform: scale(0.98); }

/* The flyout slides out from its row's side. */
.run-fly-enter-active { transition: opacity var(--dur-med) var(--ease-out), transform var(--dur-med) var(--ease-out); }
.run-fly-leave-active { transition: opacity var(--dur-fast) var(--ease-out); }
.run-fly-enter-from { opacity: 0; transform: translateX(-6px); }
.run__fly--left.run-fly-enter-from { transform: translateX(6px); }
.run-fly-leave-to { opacity: 0; }

/* Another row's choices fade in where the last ones were. */
.is-gliding .run__body { animation: run-swap var(--dur-med) var(--ease-out); }
@keyframes run-swap {
  from { opacity: 0; transform: translateY(-3px); }
}

@media (prefers-reduced-motion: reduce) {
  .run-enter-active, .run-leave-active, .run-fly-enter-active, .run-fly-leave-active, .run__fly.is-gliding,
  .run__row, .run__arrow { transition: none; }
  .is-gliding .run__body { animation: none; }
}
</style>
