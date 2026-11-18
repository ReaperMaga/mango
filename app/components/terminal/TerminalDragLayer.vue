<script setup lang="ts">
import { Server, SquareTerminal } from 'lucide-vue-next'
import { terminalDrag, type Box } from '~/composables/useTerminalDrag'

/**
 * What a terminal drag shows over everything: the tab following the pointer, and where it would land
 * (a line between tabs, or a wash over the pane or panel it would fill). Never takes the pointer.
 */
const at = (b: Box) => ({ left: `${b.left}px`, top: `${b.top}px`, width: `${b.width}px`, height: `${b.height}px` })

/* The tab follows the pointer below and right of it; near the window's bottom or right edge it flips to the other side. */
const ghost = computed(() => {
  const { x, y } = terminalDrag
  const left = x + 240 > window.innerWidth ? `calc(${x - 14}px - 100%)` : `${x + 14}px`
  const top = y + 44 > window.innerHeight ? `calc(${y - 12}px - 100%)` : `${y + 12}px`
  return { transform: `translate(${left}, ${top})` }
})

const line = computed(() => {
  const d = terminalDrag.drop
  return d && (d.kind === 'strip' || d.kind === 'panel') && d.line ? at(d.line) : null
})
const area = computed(() => {
  const d = terminalDrag.drop
  if (d?.kind === 'pane') return at(d.box)
  if (d?.kind === 'panel' && d.box) return at(d.box)
  return null
})
</script>

<template>
  <Teleport to="body">
    <div v-if="terminalDrag.id" class="tdl" aria-hidden="true">
      <div v-if="area" class="tdl__area" :style="area" />
      <div v-if="line" class="tdl__line" :style="line" />
      <div class="tdl__ghost" :style="ghost">
        <component :is="terminalDrag.remote ? Server : SquareTerminal" class="tdl__icon" />
        <span class="tdl__title">{{ terminalDrag.title }}</span>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.tdl {
  position: fixed;
  inset: 0;
  z-index: 90;
  pointer-events: none;
}
.tdl__area {
  position: fixed;
  border-radius: var(--radius-md);
  background: var(--accent-soft);
  box-shadow: inset 0 0 0 1px var(--accent-line);
}
.tdl__line {
  position: fixed;
  border-radius: var(--radius-xs);
  background: var(--accent);
}
.tdl__ghost {
  position: fixed;
  left: 0;
  top: 0;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 26px;
  max-width: 220px;
  padding: 0 var(--space-3) 0 var(--space-2);
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
  background: var(--bg-raised);
  box-shadow: var(--shadow-pop);
  color: var(--fg);
  font-size: var(--text-sm);
  white-space: nowrap;
}
.tdl__icon { flex: none; width: 14px; height: 14px; stroke-width: 1.75; color: var(--accent-ink); }
.tdl__title { overflow: hidden; text-overflow: ellipsis; }
</style>

<style>
/* While a terminal is dragged the pointer says so everywhere, over xterm's text cursor too. */
body.is-moving-terminal,
body.is-moving-terminal * {
  cursor: grabbing !important;
}
</style>
