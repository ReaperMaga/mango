<script setup lang="ts">
import { Minimize2 } from 'lucide-vue-next'
import type { ContextUsage } from '~/types/chat'
import { contextLevel, contextPercent, formatTokens } from '~/agents/context'
import { useOverlay } from '~/composables/useOverlay'

/**
 * How full the chat's context window is: a small meter in the composer, and on click a
 * breakdown of what takes the room (when the CLI says) with a way to compact the conversation.
 * Before the first reading the ring is empty and says so. The popover is teleported to <body>
 * with fixed coordinates, like ChatEffort.
 */
const props = defineProps<{
  /** Null: no reading yet (a new chat, or one from before Mango kept them). */
  usage: ContextUsage | null
  agentName: string
  /** A turn runs: compacting waits until it is done. */
  busy?: boolean
  /** The reading is being asked from the CLI. */
  pending?: boolean
}>()
const emit = defineEmits<{ compact: [] }>()

const open = ref(false)
useOverlay(() => open.value)
const root = ref<HTMLElement | null>(null)
const pop = ref<HTMLElement | null>(null)
const pos = ref({ right: 0, bottom: 0 })
const WIDTH = 300
const GAP = 6
const MARGIN = 8

/** The reading, or an empty one before there is any. */
const u = computed<ContextUsage>(() => props.usage ?? { used: 0, max: 0, at: 0 })
const pct = computed(() => contextPercent(props.usage))
/** How close it is to where the CLI compacts by itself (or to the end of the window). */
const tone = computed(() => ({ ok: '', high: 'is-high', full: 'is-full' })[contextLevel(u.value)])

const total = computed(() => (u.value.max
  ? `${formatTokens(u.value.used)} of ${formatTokens(u.value.max)}`
  : `${formatTokens(u.value.used)} tokens`))
/** What the empty ring says. */
const waiting = computed(() => (props.pending
  ? `Reading how full this conversation is from ${props.agentName}…`
  : `No reading yet. It shows after ${props.agentName}'s next reply.`))
const label = computed(() => (!props.usage
  ? `Context window: ${waiting.value}`
  : pct.value === null
    ? `Context: ${formatTokens(u.value.used)} tokens in use`
    : `Context: ${pct.value}% full, ${total.value} tokens`))

/** Each part's colour; parts the list does not know share the neutral one. */
const SWATCH: Record<string, string> = {
  messages: 'var(--accent)',
  system_prompt: 'var(--file-blue)',
  system_tools: 'var(--file-purple)',
  mcp_tools: 'var(--file-red)',
  custom_agents: 'var(--file-orange)',
  memory_files: 'var(--file-green)',
  skills: 'var(--file-yellow)',
}
interface Row { id: string; label: string; tokens: number; kind: 'used' | 'buffer' | 'free'; color: string }
const rows = computed<Row[]>(() => {
  const u = props.usage
  if (!u) return []
  if (u.parts?.length) {
    return u.parts.map(p => ({ ...p, color: p.kind === 'used' ? SWATCH[p.id] ?? 'var(--fg-subtle)' : '' }))
  }
  const out: Row[] = [{ id: 'used', label: 'In use', tokens: u.used, kind: 'used', color: 'var(--accent)' }]
  if (u.max) out.push({ id: 'free', label: 'Free space', tokens: Math.max(0, u.max - u.used), kind: 'free', color: '' })
  return out
})
/** The bar: what is in use, then the room kept for compacting. Free space is the track. */
const segments = computed(() => (u.value.max ? rows.value.filter(r => r.kind !== 'free' && r.tokens > 0) : []))
const share = (tokens: number) => (u.value.max ? `${Math.max(0.3, (tokens / u.value.max) * 100)}%` : '0%')
const partPct = (tokens: number) => {
  if (!u.value.max) return ''
  const p = (tokens / u.value.max) * 100
  return p > 0 && p < 1 ? '<1%' : `${Math.round(p)}%`
}

const note = computed(() => {
  if (u.value.compactAt) return `${props.agentName} compacts the conversation by itself at ${formatTokens(u.value.compactAt)} tokens.`
  return `${props.agentName} compacts the conversation by itself when the window fills up.`
})
/** A live reading, taken during the turn: the breakdown follows when it is done. */
const partial = computed(() => props.busy && !u.value.parts?.length && !!u.value.max)

function place() {
  const r = root.value?.getBoundingClientRect()
  if (!r) return
  const right = Math.max(MARGIN, Math.min(window.innerWidth - r.right, window.innerWidth - WIDTH - MARGIN))
  pos.value = { right, bottom: window.innerHeight - r.top + GAP }
}
async function show() {
  place()
  open.value = true
  await nextTick()
  pop.value?.focus({ preventScroll: true })
}
function close(refocus = false) {
  if (!open.value) return
  open.value = false
  if (refocus) root.value?.querySelector<HTMLElement>('button')?.focus()
}
const toggle = () => (open.value ? close() : show())

function compact() {
  emit('compact')
  close(true)
}

function onKey(e: KeyboardEvent) {
  if (e.key !== 'Escape') return
  // Escape closes the popover; it must not reach the pane, which would stop the agent.
  e.preventDefault()
  e.stopPropagation()
  close(true)
}
function onDocDown(e: MouseEvent) {
  const t = e.target as Node
  if (open.value && !root.value?.contains(t) && !pop.value?.contains(t)) close()
}
function onViewportChange(e: Event) {
  if (!open.value || (e.type === 'scroll' && pop.value?.contains(e.target as Node))) return
  close()
}
onMounted(() => {
  document.addEventListener('mousedown', onDocDown, true)
  window.addEventListener('scroll', onViewportChange, true)
  window.addEventListener('resize', onViewportChange)
  window.addEventListener('blur', onViewportChange)
})
onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onDocDown, true)
  window.removeEventListener('scroll', onViewportChange, true)
  window.removeEventListener('resize', onViewportChange)
  window.removeEventListener('blur', onViewportChange)
})
</script>

<template>
  <div ref="root" class="cx-anchor">
    <button
      type="button"
      class="cx"
      :class="[tone, { 'is-open': open, 'is-empty': !usage, 'is-pending': pending }]"
      :title="label"
      :aria-label="label"
      aria-haspopup="dialog"
      :aria-expanded="open"
      @click="toggle"
    >
      <svg class="cx__ring" viewBox="0 0 16 16" aria-hidden="true">
        <circle class="cx__track" cx="8" cy="8" r="6" pathLength="100" />
        <!-- A sliver stays visible at 0%, so a reading never looks like none. -->
        <circle v-if="pct !== null" class="cx__fill" cx="8" cy="8" r="6" pathLength="100" :stroke-dasharray="`${Math.max(pct, 2)} 100`" />
      </svg>
      <span class="cx__text tabular">{{ !usage ? '–' : pct !== null ? `${pct}%` : formatTokens(usage.used) }}</span>
    </button>
    <Teleport to="body">
      <Transition name="cxp">
        <div
          v-if="open"
          ref="pop"
          class="cxp"
          role="dialog"
          aria-label="Context window"
          tabindex="-1"
          :style="{ width: `${WIDTH}px`, right: `${pos.right}px`, bottom: `${pos.bottom}px` }"
          @keydown="onKey"
        >
          <div class="cxp__head">
            <span class="cxp__title">Context window</span>
            <span v-if="usage" class="cxp__value tabular">
              <template v-if="pct !== null"><b :class="tone">{{ pct }}%</b> · </template>{{ total }}
            </span>
          </div>
          <p v-if="!usage" class="cxp__note cxp__empty">{{ waiting }}</p>
          <div v-if="u.max" class="cxp__bar" aria-hidden="true">
            <i
              v-for="s in segments"
              :key="s.id"
              :class="{ 'is-buffer': s.kind === 'buffer' }"
              :style="{ width: share(s.tokens), background: s.kind === 'buffer' ? undefined : s.color }"
            />
          </div>
          <ul v-if="rows.length" class="cxp__rows">
            <li v-for="r in rows" :key="r.id" class="cxp__row" :class="`is-${r.kind}`">
              <span class="cxp__swatch" :style="r.color ? { background: r.color } : undefined" aria-hidden="true" />
              <span class="cxp__label">{{ r.label }}</span>
              <span class="cxp__tokens tabular">{{ formatTokens(r.tokens) }}</span>
              <span class="cxp__pct tabular">{{ partPct(r.tokens) }}</span>
            </li>
          </ul>
          <p v-if="partial" class="cxp__note">Measured during this turn. The breakdown comes when it is done.</p>
          <div v-if="usage" class="cxp__foot">
            <p class="cxp__note">{{ note }}</p>
            <button
              type="button"
              class="cxp__compact"
              :disabled="busy"
              :title="busy ? 'Wait for the turn to finish' : 'Summarize the conversation so far to free up room (/compact)'"
              @click="compact"
            >
              <Minimize2 aria-hidden="true" />Compact
            </button>
          </div>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>

<style scoped>
.cx-anchor { display: inline-flex; flex: none; }
.cx {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 26px;
  padding: 0 var(--space-2);
  border-radius: var(--radius-sm);
  color: var(--fg-subtle);
  font-size: var(--text-xs);
  transition: background var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out);
}
.cx:hover, .cx.is-open { background: var(--bg-hover); color: var(--fg); }
.cx.is-empty .cx__text { color: var(--fg-faint); }
/* Asking the CLI: the empty track breathes until the reading comes. */
.cx.is-pending .cx__track { animation: cx-wait 1.2s var(--ease-in-out) infinite alternate; }
@keyframes cx-wait { from { opacity: 0.45; } to { opacity: 1; } }
.cx:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 1px; }
.cx__ring { flex: none; width: 15px; height: 15px; transform: rotate(-90deg); }
.cx__ring circle { fill: none; stroke-width: 2.25; }
.cx__track { stroke: var(--line-strong); }
.cx__fill { stroke: var(--fg-muted); stroke-linecap: round; transition: stroke-dasharray var(--dur-med) var(--ease-out), stroke var(--dur-fast) var(--ease-out); }
.cx:hover .cx__fill, .cx.is-open .cx__fill { stroke: var(--fg); }
.cx.is-high .cx__fill { stroke: var(--ripe-running); }
.cx.is-full .cx__fill { stroke: var(--ripe-error); }
.cx.is-high .cx__text { color: var(--ripe-running-fg); }
.cx.is-full .cx__text { color: var(--ripe-error-fg); }
/* Narrow panes: the ring alone says enough. */
@container (max-width: 400px) { .cx__text { display: none; } }
@media (prefers-reduced-motion: reduce) {
  .cx, .cx__fill { transition: none; }
  .cx.is-pending .cx__track { animation: none; }
}
</style>

<!-- The popover lives in <body>, outside this component's scoped subtree. -->
<style>
.cxp {
  position: fixed;
  z-index: 80;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  max-width: calc(100vw - 16px);
  padding: var(--space-3) var(--space-3) var(--space-2);
  background: var(--bg-raised);
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-pop);
  font-size: var(--text-sm);
  cursor: default;
  transform-origin: bottom right;
}
.cxp:focus { outline: none; }
.cxp__head { display: flex; align-items: baseline; justify-content: space-between; gap: var(--space-2); }
.cxp__title { font-weight: 560; color: var(--fg); }
.cxp__value { font-size: var(--text-xs); color: var(--fg-muted); white-space: nowrap; }
.cxp__value b { font-weight: 560; color: var(--fg); }
.cxp__value b.is-high { color: var(--ripe-running-fg); }
.cxp__value b.is-full { color: var(--ripe-error-fg); }

.cxp__bar {
  display: flex;
  gap: 1px;
  height: 8px;
  margin: 2px 0;
  border-radius: var(--radius-pill);
  background: var(--bg-active);
  overflow: hidden;
}
.cxp__bar i { display: block; flex: none; height: 100%; }
/* The room kept free for compacting: striped, not a colour of its own. */
.cxp__bar i.is-buffer, .cxp__row.is-buffer .cxp__swatch {
  background: repeating-linear-gradient(135deg, var(--line-strong) 0 2px, transparent 2px 4px);
}

.cxp__rows { display: flex; flex-direction: column; margin: 0; padding: 0; list-style: none; }
.cxp__row {
  display: grid;
  grid-template-columns: 8px minmax(0, 1fr) auto 36px;
  align-items: center;
  gap: var(--space-2);
  height: 24px;
  color: var(--fg-muted);
}
.cxp__row.is-buffer, .cxp__row.is-free { color: var(--fg-subtle); }
/* What is in use, then the room that is not. */
.cxp__row.is-used + .cxp__row:not(.is-used) { margin-top: var(--space-1); padding-top: var(--space-1); border-top: 1px solid var(--line-soft); height: 28px; }
.cxp__swatch { width: 8px; height: 8px; border-radius: 2px; }
.cxp__row.is-free .cxp__swatch { background: var(--bg-active); box-shadow: inset 0 0 0 1px var(--line-strong); }
.cxp__label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cxp__tokens { color: var(--fg); text-align: right; }
.cxp__row.is-buffer .cxp__tokens, .cxp__row.is-free .cxp__tokens { color: var(--fg-muted); }
.cxp__pct { font-size: var(--text-xs); color: var(--fg-subtle); text-align: right; }

.cxp__foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding-top: var(--space-2);
  border-top: 1px solid var(--line-soft);
}
.cxp__empty { padding-bottom: var(--space-1); }
.cxp__note { margin: 0; min-width: 0; font-size: var(--text-xs); line-height: var(--leading-tight); color: var(--fg-subtle); }
.cxp__compact {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 24px;
  padding: 0 var(--space-2);
  border-radius: var(--radius-sm);
  border: 1px solid var(--line);
  font-size: var(--text-xs);
  font-weight: 540;
  color: var(--fg-muted);
  transition: background var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out);
}
.cxp__compact svg { width: 12px; height: 12px; }
.cxp__compact:hover:not(:disabled) { background: var(--bg-hover); color: var(--fg); }
.cxp__compact:disabled { opacity: 0.5; cursor: not-allowed; }
.cxp__compact:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 1px; }

.cxp-enter-active, .cxp-leave-active { transition: opacity var(--dur-fast) var(--ease-out), transform var(--dur-fast) var(--ease-out); }
.cxp-enter-from, .cxp-leave-to { opacity: 0; transform: scale(0.97); }
@media (prefers-reduced-motion: reduce) {
  .cxp__compact, .cxp-enter-active, .cxp-leave-active { transition: none; }
}
</style>
