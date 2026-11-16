<script setup lang="ts">
import type { AgentCommand } from '~/types/chat'
import { useOverlay } from '~/composables/useOverlay'

/**
 * The slash command list over the composer. The composer owns the text and the keys
 * (arrows, Tab, Enter, Escape); this only shows the matches and reports clicks. Teleported
 * to <body> with fixed coordinates, like every menu, so nothing can clip it.
 */
export interface CommandMatch {
  command: AgentCommand
  /** Where the query sits in the name, for highlighting; null when it matched an alias. */
  at: number | null
}

const props = defineProps<{
  id: string
  anchor: HTMLElement | null
  matches: CommandMatch[]
  active: number
  query: string
  agentName: string
}>()

const emit = defineEmits<{
  pick: [index: number]
  hover: [index: number]
}>()

const list = ref<HTMLElement | null>(null)
useOverlay(() => props.matches.length > 0)
const pos = ref<{ left: number; top?: number; bottom?: number; width: number; maxHeight: number }>({ left: 0, bottom: 0, width: 480, maxHeight: 300 })

const GAP = 6
const MARGIN = 8

function place() {
  const el = props.anchor
  if (!el) return
  const r = el.getBoundingClientRect()
  const width = Math.min(Math.max(r.width, 320), 640, window.innerWidth - MARGIN * 2)
  const left = Math.max(MARGIN, Math.min(r.left, window.innerWidth - width - MARGIN))
  const above = r.top - GAP - MARGIN
  const below = window.innerHeight - r.bottom - GAP - MARGIN
  const wanted = Math.min(320, Math.max(1, props.matches.length) * 30 + 10)
  // Above the composer, unless that is cramped and below has more room (a short window).
  pos.value = above >= wanted || above >= below
    ? { left, bottom: window.innerHeight - r.top + GAP, width, maxHeight: Math.min(320, Math.max(90, above)) }
    : { left, top: r.bottom + GAP, width, maxHeight: Math.min(320, Math.max(90, below)) }
}

onMounted(() => {
  place()
  window.addEventListener('resize', place)
})
onBeforeUnmount(() => window.removeEventListener('resize', place))
watch(() => props.matches.length, () => nextTick(place))

/** Keep the active row in view while the arrows move it. */
watch(() => props.active, (i) => {
  nextTick(() => list.value?.querySelector<HTMLElement>(`[data-index="${i}"]`)?.scrollIntoView({ block: 'nearest' }))
})

/** The name split around the matched characters. */
function parts(m: CommandMatch) {
  const name = m.command.name
  if (m.at === null || !props.query) return [{ text: name, hit: false }]
  const end = m.at + props.query.length
  return [
    { text: name.slice(0, m.at), hit: false },
    { text: name.slice(m.at, end), hit: true },
    { text: name.slice(end), hit: false },
  ].filter(p => p.text)
}

const optionId = (i: number) => `${props.id}-opt-${i}`
defineExpose({ optionId })
</script>

<template>
  <Teleport to="body">
    <div
      ref="list"
      class="cmdm"
      :style="{
        left: `${pos.left}px`,
        top: pos.top != null ? `${pos.top}px` : undefined,
        bottom: pos.bottom != null ? `${pos.bottom}px` : undefined,
        width: `${pos.width}px`,
        maxHeight: `${pos.maxHeight}px`,
      }"
      @mousedown.prevent
    >
      <ul v-if="matches.length" :id="id" class="cmdm__list" role="listbox" :aria-label="`${agentName} commands`">
        <li
          v-for="(m, i) in matches"
          :id="optionId(i)"
          :key="m.command.name"
          :data-index="i"
          class="cmdm__item"
          :class="{ 'is-active': i === active }"
          role="option"
          :aria-selected="i === active"
          @mouseenter="emit('hover', i)"
          @click="emit('pick', i)"
        >
          <span class="cmdm__name">/<template v-for="(p, pi) in parts(m)" :key="pi"><mark v-if="p.hit">{{ p.text }}</mark><template v-else>{{ p.text }}</template></template></span>
          <span v-if="m.command.argumentHint" class="cmdm__args">{{ m.command.argumentHint }}</span>
          <span class="cmdm__desc">{{ m.command.description }}</span>
          <span v-if="m.command.mango" class="cmdm__tag">Mango</span>
        </li>
      </ul>
      <p v-else class="cmdm__empty">
        No {{ agentName }} command matches /{{ query }}. Enter sends it as plain text.
      </p>
    </div>
  </Teleport>
</template>

<!-- Lives in <body>, outside this component's scoped subtree. -->
<style>
.cmdm {
  position: fixed;
  z-index: 50;
  display: flex;
  flex-direction: column;
  padding: var(--space-1);
  overflow-y: auto;
  background: var(--bg-raised);
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-pop);
  font-size: var(--text-sm);
  animation: cmdm-in var(--dur-fast) var(--ease-out);
  transform-origin: bottom left;
}
@keyframes cmdm-in { from { opacity: 0; transform: scale(0.98); } }
.cmdm__list { margin: 0; padding: 0; list-style: none; }
.cmdm__item {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
  min-height: 30px;
  padding: 6px var(--space-2);
  border-radius: var(--radius-sm);
  cursor: default;
  color: var(--fg);
}
.cmdm__item.is-active { background: var(--bg-active); }
.cmdm__name { flex: none; max-width: 45%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 560; }
.cmdm__name mark { background: none; color: var(--accent-ink); font-weight: 640; }
.cmdm__args { flex: none; max-width: 30%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--text-xs); color: var(--fg-faint); }
.cmdm__desc { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--text-xs); color: var(--fg-subtle); }
.cmdm__tag { flex: none; font-size: var(--text-2xs); color: var(--fg-faint); }
.cmdm__empty { margin: 0; padding: 6px var(--space-2); font-size: var(--text-xs); color: var(--fg-subtle); }
@media (prefers-reduced-motion: reduce) {
  .cmdm { animation: none; }
}
</style>
