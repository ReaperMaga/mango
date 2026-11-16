<script setup lang="ts">
import { Check } from 'lucide-vue-next'
import type { MenuItem } from '~/types/ui'
import { useOverlay } from '~/composables/useOverlay'

/**
 * Dropdown menu. The popover is teleported to <body> and positioned with
 * fixed coordinates, so no ancestor (transforms, overflow, later siblings)
 * can clip it or paint over it.
 */
const props = withDefaults(defineProps<{
  items: MenuItem[]
  placement?: 'bottom-start' | 'bottom-end' | 'top-start' | 'top-end'
  width?: number
  label?: string
}>(), { placement: 'bottom-start', width: 240, label: 'Menu' })

const open = ref(false)
/* An open menu hides the browsers' native pages, which would cover it. */
useOverlay(() => open.value)
const root = ref<HTMLElement | null>(null)
const list = ref<HTMLElement | null>(null)
const active = ref(-1)
const pos = ref<{ left: number; top?: number; bottom?: number; origin: string; maxHeight: number }>({ left: 0, top: 0, origin: 'top left', maxHeight: 400 })

const hasIcons = computed(() => props.items.some(i => i.icon))
const enabled = computed(() => props.items.map((it, i) => (it.disabled ? -1 : i)).filter(i => i >= 0))

/** Set while the menu is open as a context menu: the pointer position to open at. */
let point: { x: number; y: number } | null = null

const GAP = 6
const MARGIN = 8

function place() {
  const el = root.value
  if (!el) return
  const r = point
    ? { left: point.x, right: point.x, top: point.y, bottom: point.y }
    : el.getBoundingClientRect()
  const vw = window.innerWidth
  const vh = window.innerHeight
  const width = Math.min(props.width, vw - MARGIN * 2)
  const wantTop = props.placement.startsWith('top')
  const alignEnd = props.placement.endsWith('end')
  const spaceBelow = vh - r.bottom - GAP - MARGIN
  const spaceAbove = r.top - GAP - MARGIN
  // Flip when the preferred side is cramped and the other side has more room.
  const estimated = Math.min(list.value?.scrollHeight ?? props.items.length * 34 + 8, 420)
  const top = wantTop && !point ? (spaceAbove >= estimated || spaceAbove >= spaceBelow) : !(spaceBelow >= estimated || spaceBelow >= spaceAbove)
  // A context menu grows down and to the right of the pointer, like every other one.
  const alignRight = alignEnd && !point
  let left = alignRight ? r.right - width : r.left
  left = Math.max(MARGIN, Math.min(left, vw - width - MARGIN))
  pos.value = top
    ? { left, bottom: vh - r.top + (point ? 0 : GAP), origin: `bottom ${alignRight ? 'right' : 'left'}`, maxHeight: Math.max(120, spaceAbove) }
    : { left, top: r.bottom + (point ? 0 : GAP), origin: `top ${alignRight ? 'right' : 'left'}`, maxHeight: Math.max(120, spaceBelow) }
}

function toggle() {
  open.value ? close() : show()
}
/** Open as a context menu at viewport coordinates (e.g. a right-click). */
function showAt(x: number, y: number) {
  return show({ x, y })
}
async function show(at: { x: number; y: number } | null = null) {
  point = at
  place()
  open.value = true
  active.value = props.items.findIndex(i => i.checked && !i.disabled)
  if (active.value < 0) active.value = enabled.value[0] ?? -1
  await nextTick()
  place()
  list.value?.focus({ preventScroll: true })
}
function close(refocus = false) {
  if (!open.value) return
  open.value = false
  if (refocus) root.value?.querySelector<HTMLElement>('button, [tabindex]')?.focus()
}
function select(i: number) {
  const it = props.items[i]
  if (!it || it.disabled) return
  close()
  it.onSelect?.()
}
function onKey(e: KeyboardEvent) {
  const at = enabled.value.indexOf(active.value)
  if (e.key === 'ArrowDown') { e.preventDefault(); active.value = enabled.value[(at + 1) % enabled.value.length] ?? -1 }
  else if (e.key === 'ArrowUp') { e.preventDefault(); active.value = enabled.value[(at - 1 + enabled.value.length) % enabled.value.length] ?? -1 }
  else if (e.key === 'Home') { e.preventDefault(); active.value = enabled.value[0] ?? -1 }
  else if (e.key === 'End') { e.preventDefault(); active.value = enabled.value[enabled.value.length - 1] ?? -1 }
  else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(active.value) }
  else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true) }
  else if (e.key === 'Tab') { e.preventDefault(); close(true) }
}

function onDocDown(e: MouseEvent) {
  if (!open.value) return
  const t = e.target as Node
  if (root.value?.contains(t) || list.value?.contains(t)) return
  close()
}
/** Scrolling or resizing moves the trigger: keep it simple and close. */
function onViewportChange(e: Event) {
  if (!open.value) return
  if (e.type === 'scroll' && list.value?.contains(e.target as Node)) return
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

defineExpose({ show: () => show(), showAt, close, toggle })
</script>

<template>
  <div ref="root" class="menu" :class="{ 'is-open': open }">
    <slot :open="open" :toggle="toggle" />
    <Teleport to="body">
      <Transition name="menu">
        <div
          v-if="open"
          ref="list"
          class="menu__pop"
          :style="{
            width: `${Math.min(width, 9999)}px`,
            left: `${pos.left}px`,
            top: pos.top != null ? `${pos.top}px` : undefined,
            bottom: pos.bottom != null ? `${pos.bottom}px` : undefined,
            maxHeight: `${pos.maxHeight}px`,
            transformOrigin: pos.origin,
          }"
          role="menu"
          :aria-label="label"
          tabindex="-1"
          @keydown="onKey"
        >
          <template v-for="(it, i) in items" :key="i">
            <div v-if="it.divider" class="menu__sep" role="separator" />
            <div v-if="it.group" class="menu__group" role="presentation">{{ it.group }}</div>
            <button
              type="button"
              class="menu__item"
              :class="{ 'is-active': i === active, 'is-danger': it.danger }"
              role="menuitem"
              :disabled="it.disabled"
              @mouseenter="!it.disabled && (active = i)"
              @click="select(i)"
            >
              <span v-if="hasIcons" class="menu__icon">
                <component :is="it.icon" v-if="it.icon" />
              </span>
              <span class="menu__text">
                <span class="menu__label">{{ it.label }}</span>
                <span v-if="it.hint" class="menu__hint">{{ it.hint }}</span>
              </span>
              <Check v-if="it.checked" class="menu__check" />
              <span v-else-if="it.kbd" class="menu__kbd">{{ it.kbd }}</span>
            </button>
          </template>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>

<style scoped>
.menu { position: relative; display: inline-flex; min-width: 0; }
</style>

<!-- The popover lives in <body>, outside this component's scoped subtree. -->
<style>
.menu__pop {
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
}
.menu__sep { height: 1px; margin: var(--space-1) var(--space-2); background: var(--line-soft); }
.menu__group {
  padding: var(--space-2) var(--space-2) 2px;
  font-size: var(--text-xs);
  font-weight: 600;
  color: var(--fg-subtle);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.menu__sep + .menu__group { padding-top: var(--space-1); }
.menu__item {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  min-height: 30px;
  padding: 5px var(--space-2);
  border-radius: var(--radius-sm);
  text-align: left;
  color: var(--fg);
  font-size: var(--text-sm);
}
.menu__item.is-active { background: var(--bg-hover); }
.menu__item:disabled { color: var(--fg-faint); }
.menu__item.is-danger { color: var(--ripe-error-fg); }
.menu__icon { width: 16px; display: grid; place-items: center; color: var(--fg-subtle); flex: none; }
.menu__icon svg { width: 15px; height: 15px; stroke-width: 1.75; }
.menu__item.is-danger .menu__icon { color: inherit; }
.menu__text { flex: 1; min-width: 0; display: grid; }
.menu__label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.menu__hint { font-size: var(--text-xs); color: var(--fg-subtle); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.menu__check { width: 14px; height: 14px; color: var(--accent-ink); flex: none; }
.menu__kbd { font-size: var(--text-xs); color: var(--fg-faint); flex: none; }

.menu-enter-active, .menu-leave-active { transition: opacity var(--dur-fast) var(--ease-out), transform var(--dur-fast) var(--ease-out); }
.menu-enter-from, .menu-leave-to { opacity: 0; transform: scale(0.97); }
</style>
