<script setup lang="ts">
import { Check, X } from 'lucide-vue-next'
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
  /** Cap on the list's height; longer lists scroll. Without it the menu may fill the space to the window edge. */
  maxHeight?: number
  /** Grow past `width` to fit the longest row, up to this many pixels (and the window). Without it the width is fixed. */
  maxWidth?: number
}>(), { placement: 'bottom-start', width: 240, label: 'Menu' })

const open = ref(false)
/* An open menu hides the browsers' native pages, which would cover it. */
useOverlay(() => open.value)
const root = ref<HTMLElement | null>(null)
const list = ref<HTMLElement | null>(null)
const active = ref(-1)
/* Set once the keyboard moves the highlight: only then does the highlighted row show its remove button (the pointer shows it on hover). */
const keyed = ref(false)
const pos = ref<{ left: number; top?: number; bottom?: number; origin: string; maxHeight: number }>({ left: 0, top: 0, origin: 'top left', maxHeight: 400 })

const hasIcons = computed(() => props.items.some(i => i.icon))
const enabled = computed(() => props.items.map((it, i) => (it.disabled ? -1 : i)).filter(i => i >= 0))

/** Set while the menu is open as a context menu: the pointer position to open at. */
let point: { x: number; y: number } | null = null
/** What had focus when it opened as a context menu: Escape gives it back. */
let opener: HTMLElement | null = null

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
  // A menu that fits its rows is measured once it is in the page; before that it is placed at its minimum.
  const measured = props.maxWidth && list.value ? list.value.offsetWidth : props.width
  const width = Math.min(measured, vw - MARGIN * 2)
  const wantTop = props.placement.startsWith('top')
  const alignEnd = props.placement.endsWith('end')
  const spaceBelow = vh - r.bottom - GAP - MARGIN
  const spaceAbove = r.top - GAP - MARGIN
  // Flip when the preferred side is cramped and the other side has more room.
  const cap = props.maxHeight ?? 420
  const estimated = Math.min(list.value?.scrollHeight ?? props.items.length * 34 + 8, cap)
  const top = wantTop && !point ? (spaceAbove >= estimated || spaceAbove >= spaceBelow) : !(spaceBelow >= estimated || spaceBelow >= spaceAbove)
  // A context menu grows down and to the right of the pointer, like every other one.
  const alignRight = alignEnd && !point
  let left = alignRight ? r.right - width : r.left
  left = Math.max(MARGIN, Math.min(left, vw - width - MARGIN))
  const room = Math.max(120, top ? spaceAbove : spaceBelow)
  const maxHeight = props.maxHeight ? Math.min(props.maxHeight, room) : room
  pos.value = top
    ? { left, bottom: vh - r.top + (point ? 0 : GAP), origin: `bottom ${alignRight ? 'right' : 'left'}`, maxHeight }
    : { left, top: r.bottom + (point ? 0 : GAP), origin: `top ${alignRight ? 'right' : 'left'}`, maxHeight }
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
  if (!open.value) opener = at ? document.activeElement as HTMLElement | null : null
  keyed.value = false
  place()
  open.value = true
  active.value = props.items.findIndex(i => i.checked && !i.disabled)
  if (active.value < 0) active.value = enabled.value[0] ?? -1
  await nextTick()
  place()
  list.value?.focus({ preventScroll: true })
  revealActive()
}
/** Keep the highlighted row in view when the list scrolls (the checked one on open, then the keyboard's). */
function revealActive() {
  list.value?.querySelector<HTMLElement>('.menu__item.is-active')?.scrollIntoView({ block: 'nearest' })
}

function close(refocus = false) {
  if (!open.value) return
  open.value = false
  if (refocus) (root.value?.querySelector<HTMLElement>('button, [tabindex]') ?? opener)?.focus()
}
function select(i: number) {
  const it = props.items[i]
  if (!it || it.disabled) return
  close()
  it.onSelect?.()
}
/** The row's other action (`action`): like choosing the row, it closes the menu. */
function runAction(i: number) {
  const a = props.items[i]?.action
  if (!a || a.disabled || props.items[i]?.disabled) return
  close()
  a.onSelect()
}
/** The row's own second action (UiMenu keeps the menu open so several can be run in a row). */
function runRemove(i: number) {
  const it = props.items[i]
  if (!it?.remove) return
  it.remove.onSelect()
  nextTick(() => {
    if (!open.value) return
    if (!enabled.value.includes(active.value)) active.value = enabled.value[Math.min(i, enabled.value.length - 1)] ?? -1
    list.value?.focus({ preventScroll: true })
  })
}
function onKey(e: KeyboardEvent) {
  if ((e.key === 'Delete' || e.key === 'Backspace') && props.items[active.value]?.remove) { e.preventDefault(); runRemove(active.value); return }
  const at = enabled.value.indexOf(active.value)
  if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) keyed.value = true
  if (e.key === 'ArrowDown') { e.preventDefault(); active.value = enabled.value[(at + 1) % enabled.value.length] ?? -1 }
  else if (e.key === 'ArrowUp') { e.preventDefault(); active.value = enabled.value[(at - 1 + enabled.value.length) % enabled.value.length] ?? -1 }
  else if (e.key === 'Home') { e.preventDefault(); active.value = enabled.value[0] ?? -1 }
  else if (e.key === 'End') { e.preventDefault(); active.value = enabled.value[enabled.value.length - 1] ?? -1 }
  else if (e.key === 'Enter' && e.shiftKey && props.items[active.value]?.action) { e.preventDefault(); runAction(active.value) }
  else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(active.value) }
  else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true) }
  else if (e.key === 'Tab') { e.preventDefault(); close(true) }
  if (open.value) nextTick(revealActive)
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
          :class="{ 'is-fit': maxWidth, 'is-keyed': keyed }"
          :style="{
            width: maxWidth ? 'max-content' : `${Math.min(width, 9999)}px`,
            minWidth: maxWidth ? `${Math.min(width, maxWidth)}px` : undefined,
            maxWidth: maxWidth ? `min(${maxWidth}px, calc(100vw - 16px))` : undefined,
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
              :role="it.check ? `menuitem${it.check}` : 'menuitem'"
              :aria-checked="it.check ? !!it.checked : undefined"
              :disabled="it.disabled"
              @mouseenter="!it.disabled && (active = i)"
              @click="select(i)"
            >
              <span v-if="hasIcons" class="menu__icon">
                <component :is="it.icon" v-if="it.icon" />
              </span>
              <span class="menu__text">
                <span class="menu__label" :class="{ 'is-mono': it.labelMono }">{{ it.label }}</span>
                <span v-if="it.hint" class="menu__hint" :class="{ 'is-mono': it.hintMono }">
                  <component :is="it.hintIcon" v-if="it.hintIcon" class="menu__hint-icon" aria-hidden="true" />
                  <span class="menu__hint-text">{{ it.hint }}</span>
                </span>
              </span>
              <span v-if="it.aside" class="menu__aside" :class="{ 'is-mono': it.asideMono }">{{ it.aside }}</span>
              <!-- The row's other action, shown while the row is hovered or focused; the keyboard runs it with Shift+Enter. -->
              <span
                v-if="it.action"
                class="menu__act"
                :class="{ 'is-disabled': it.action.disabled }"
                :title="it.action.disabled ? `${it.action.label}: ${it.action.reason ?? 'not now'}` : `${it.action.label} (Shift+Enter)`"
                :aria-label="it.action.label"
                :aria-disabled="it.action.disabled || undefined"
                @click.stop="runAction(i)"
              ><component :is="it.action.icon" /></span>
              <!-- A row that can be removed keeps one slot at its end: the check (or the open dot), which gives
                   way to the remove button while the row is hovered or focused. Not a nested <button> (invalid
                   inside the row); the keyboard reaches it with Delete. -->
              <span v-if="it.remove || it.open" class="menu__end" :class="{ 'has-remove': it.remove }">
                <Check v-if="it.checked" class="menu__check" />
                <span v-else-if="it.open" class="menu__dot" />
                <span
                  v-if="it.remove"
                  class="menu__remove"
                  :title="`${it.remove.label} (Delete)`"
                  :aria-label="it.remove.label"
                  @click.stop="runRemove(i)"
                ><X /></span>
              </span>
              <template v-else>
                <Check v-if="it.checked" class="menu__check" />
                <span v-else-if="it.kbd" class="menu__kbd">{{ it.kbd }}</span>
              </template>
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
.menu__icon { width: 20px; display: grid; place-items: center; color: var(--fg-subtle); flex: none; }
.menu__icon svg { width: 15px; height: 15px; stroke-width: 1.75; }
.menu__item.is-danger .menu__icon { color: inherit; }
.menu__text { flex: 1; min-width: 0; display: grid; }
.menu__label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.menu__hint { display: flex; align-items: center; gap: 4px; min-width: 0; font-size: var(--text-xs); color: var(--fg-subtle); white-space: nowrap; }
.menu__hint-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.menu__hint-icon { width: 11px; height: 11px; flex: none; stroke-width: 2; color: var(--fg-faint); }
.menu__aside { flex: 0 1 auto; text-align: right; max-width: 50%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--text-xs); color: var(--fg-subtle); }
.menu__label.is-mono { font-family: var(--font-mono); font-size: var(--text-xs); }
.menu__aside.is-mono, .menu__hint.is-mono .menu__hint-text { font-family: var(--font-mono); }
/* A menu that fits its rows gives the label its full length; the aside gives way first when the cap is reached. */
.is-fit .menu__text { flex: 1 1 auto; }
.is-fit .menu__aside { max-width: none; flex-shrink: 1000; min-width: 64px; }
.menu__end { flex: none; display: grid; place-items: center; width: 20px; height: 20px; margin-right: -2px; }
.menu__end > * { grid-area: 1 / 1; }
.menu__remove {
  display: grid;
  place-items: center;
  width: 20px;
  height: 20px;
  border-radius: var(--radius-xs);
  color: var(--fg-subtle);
  visibility: hidden;
}
.menu__remove svg { width: 13px; height: 13px; stroke-width: 2; }
.menu__item:hover .menu__remove, .is-keyed .menu__item.is-active .menu__remove { visibility: visible; }
.menu__item:hover .menu__end.has-remove > :not(.menu__remove), .is-keyed .menu__item.is-active .menu__end.has-remove > :not(.menu__remove) { visibility: hidden; }
.menu__remove:hover { background: var(--bg-active); color: var(--fg); }
/* The open dot: quieter than the check, the same slot. */
.menu__dot { width: 6px; height: 6px; border-radius: 50%; background: var(--fg-faint); }
/* The row's other action keeps its place while hidden, so the row does not shift when it shows. */
.menu__act {
  flex: none;
  display: grid;
  place-items: center;
  width: 22px;
  height: 22px;
  margin: -1px 0;
  border-radius: var(--radius-xs);
  color: var(--fg-subtle);
  visibility: hidden;
}
.menu__act svg { width: 13px; height: 13px; stroke-width: 2; }
.menu__item:hover .menu__act, .is-keyed .menu__item.is-active .menu__act { visibility: visible; }
.menu__act:hover:not(.is-disabled) { background: var(--bg-active); color: var(--fg); }
.menu__act.is-disabled { color: var(--fg-faint); opacity: 0.6; }
.menu__item:disabled .menu__act { visibility: hidden; }
.menu__check { width: 14px; height: 14px; color: var(--accent-ink); flex: none; }
.menu__kbd { font-size: var(--text-xs); color: var(--fg-faint); flex: none; }

.menu-enter-active, .menu-leave-active { transition: opacity var(--dur-fast) var(--ease-out), transform var(--dur-fast) var(--ease-out); }
.menu-enter-from, .menu-leave-to { opacity: 0; transform: scale(0.97); }
</style>
