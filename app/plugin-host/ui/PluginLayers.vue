<script setup lang="ts">
import { CircleCheck, CircleX, Info, TriangleAlert, X } from 'lucide-vue-next'
import PluginViewHost from '~/components/plugins/PluginViewHost.vue'
import { closeDialog, closeMenu, dismissToast, layers, menuPressed, type PluginContextMenu, type PluginDialog, type Toast } from '~/plugin-host/uiState'
import { pluginRowItems } from '~/plugin-host/menus'
import { report } from '~/plugin-host/registry'
import { useOverlay } from '~/composables/useOverlay'

/**
 * Toasts in the bottom-right corner, the dialogs plugins ask for (confirm, prompt, a view) and their menu
 * (`ui.contextMenu`).
 * Mounted once in app.vue. A toast floats over the browsers' native pages, so they step aside while
 * one shows (like a menu); a dialog registers itself through UiDialog.
 */
useOverlay(() => layers.toasts.length > 0)

const { t } = useI18n()
const ICONS = { info: Info, success: CircleCheck, warning: TriangleAlert, error: CircleX }

/* ---------- toasts: each times out unless the pointer or the focus is on it */

const timers = new Map<number, { left: number; started: number; handle: ReturnType<typeof setTimeout> | null }>()
const held = ref(false)

function arm(item: Toast) {
  if (!item.timeout || timers.has(item.id)) return
  timers.set(item.id, { left: item.timeout, started: Date.now(), handle: held.value ? null : setTimeout(() => dismiss(item.id), item.timeout) })
}
function dismiss(id: number) {
  const tm = timers.get(id)
  if (tm?.handle) clearTimeout(tm.handle)
  timers.delete(id)
  dismissToast(id)
}
function hold(on: boolean) {
  held.value = on
  for (const [id, tm] of timers) {
    if (on && tm.handle) {
      clearTimeout(tm.handle)
      tm.handle = null
      tm.left = Math.max(800, tm.left - (Date.now() - tm.started))
    } else if (!on && !tm.handle) {
      tm.started = Date.now()
      tm.handle = setTimeout(() => dismiss(id), tm.left)
    }
  }
}
watch(() => layers.toasts.map(item => item.id), () => {
  for (const item of layers.toasts) arm(item)
  for (const id of [...timers.keys()]) if (!layers.toasts.some(item => item.id === id)) dismiss(id)
}, { immediate: true })
onBeforeUnmount(() => { for (const tm of timers.values()) if (tm.handle) clearTimeout(tm.handle) })

function act(item: Toast) {
  const run = item.action?.run
  dismiss(item.id)
  try { run?.() } catch (e) { if (item.pluginId) report(item.pluginId, e, 'toast action') }
}

/* ---------- a plugin's menu: kept after it closes, so it can fade out */

const menu = shallowRef<PluginContextMenu | null>(null)
const menuRef = ref<{ show(): void; showAt(x: number, y: number): void; close(): void } | null>(null)
const menuItems = computed(() => (menu.value ? pluginRowItems(menu.value.pluginId, menu.value.rows) : []))
/** Over the element it hangs from (UiMenu measures its own root); at a point it needs no place. */
const menuStyle = computed(() => {
  const at = menu.value?.at
  if (!(at instanceof HTMLElement)) return { position: 'fixed', left: '0', top: '0', pointerEvents: 'none' } as const
  const r = at.getBoundingClientRect()
  return { position: 'fixed', left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px`, pointerEvents: 'none' } as const
})
watch(() => layers.menu, async (m) => {
  if (!m) { menuRef.value?.close(); return }
  menu.value = m
  await nextTick()
  if (layers.menu !== m) return
  if (m.at instanceof HTMLElement) menuRef.value?.show()
  else menuRef.value?.showAt(m.at.x, m.at.y)
})
onBeforeUnmount(() => { if (layers.menu) closeMenu(layers.menu.id) })

/* Pressing the element a menu hangs from closes it: the click that follows is not for opening it again. */
function onPress(e: Event) {
  const at = layers.menu?.at
  menuPressed(at instanceof HTMLElement && at.contains(e.target as Node) ? at : null)
}
const onClicked = () => { setTimeout(() => menuPressed(null)) }
onMounted(() => {
  window.addEventListener('pointerdown', onPress, true)
  window.addEventListener('click', onClicked, true)
})
onBeforeUnmount(() => {
  window.removeEventListener('pointerdown', onPress, true)
  window.removeEventListener('click', onClicked, true)
})

/* ---------- dialogs: one at a time, the oldest first */

const dialog = computed<PluginDialog | null>(() => layers.dialogs[0] ?? null)
const answer = ref('')
watch(dialog, (d) => { answer.value = d?.kind === 'prompt' ? d.value ?? '' : '' })

function cancel() {
  const d = dialog.value
  if (!d) return
  closeDialog(d.id, d.kind === 'confirm' ? false : d.kind === 'prompt' ? null : undefined)
}
function accept() {
  const d = dialog.value
  if (!d) return
  closeDialog(d.id, d.kind === 'confirm' ? true : d.kind === 'prompt' ? answer.value : undefined)
}
const viewCtx = computed(() => {
  const d = dialog.value
  return d ? { close: () => closeDialog(d.id) } : null
})
</script>

<template>
  <Teleport to="body">
    <section v-if="layers.toasts.length" class="toasts" :aria-label="t('plugins.view.notifications')" @pointerenter="hold(true)" @pointerleave="hold(false)" @focusin="hold(true)" @focusout="hold(false)">
      <TransitionGroup name="toast" tag="ol" class="toasts__list">
        <li v-for="item in layers.toasts" :key="item.id" class="toast" :class="`toast--${item.kind}`" :role="item.kind === 'error' || item.kind === 'warning' ? 'alert' : 'status'">
          <component :is="ICONS[item.kind]" class="toast__icon" aria-hidden="true" />
          <div class="toast__text selectable">
            <p class="toast__title">{{ item.title }}</p>
            <p v-if="item.body" class="toast__body">{{ item.body }}</p>
            <button v-if="item.action" type="button" class="toast__action" @click="act(item)">{{ item.action.label }}</button>
          </div>
          <button type="button" class="toast__close" :aria-label="t('plugins.dismiss')" @click="dismiss(item.id)"><X /></button>
        </li>
      </TransitionGroup>
    </section>
    <UiMenu v-if="menu" :key="menu.id" ref="menuRef" :items="menuItems" :style="menuStyle" :width="220" :max-width="360" @closed="menu && closeMenu(menu.id)" />
  </Teleport>

  <UiDialog :open="!!dialog" :title="dialog?.title ?? ''" :width="dialog?.kind === 'view' ? dialog.width ?? 520 : 420" @close="cancel">
    <template v-if="dialog">
      <p v-if="dialog.kind !== 'view' && dialog.body" class="pl__body">{{ dialog.body }}</p>
      <form v-if="dialog.kind === 'prompt'" class="pl__form" @submit.prevent="accept">
        <input v-model="answer" class="input" type="text" :placeholder="dialog.placeholder" :aria-label="dialog.title" autocomplete="off" spellcheck="false">
      </form>
      <PluginViewHost v-if="dialog.kind === 'view'" :key="dialog.id" :view="dialog.view" :ctx="viewCtx" :plugin-id="dialog.pluginId" />
    </template>
    <template v-if="dialog && dialog.kind !== 'view'" #footer>
      <UiButton variant="ghost" :data-autofocus="dialog.kind === 'confirm' ? '' : undefined" @click="cancel">{{ t('common.actions.cancel') }}</UiButton>
      <UiButton :variant="dialog.kind === 'confirm' && dialog.danger ? 'danger' : 'primary'" @click="accept">
        {{ dialog.kind === 'confirm' ? dialog.confirmLabel || t('plugins.view.ok') : t('plugins.view.ok') }}
      </UiButton>
    </template>
  </UiDialog>
</template>

<style scoped>
.toasts {
  position: fixed;
  right: var(--space-4);
  bottom: var(--space-4);
  z-index: 65;
  width: min(360px, calc(100vw - 2 * var(--space-4)));
  pointer-events: none;
}
.toasts__list {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  margin: 0;
  padding: 0;
  list-style: none;
}
.toast {
  pointer-events: auto;
  display: grid;
  grid-template-columns: 16px 1fr 22px;
  align-items: start;
  gap: var(--space-2) var(--space-3);
  padding: var(--space-3) var(--space-2) var(--space-3) var(--space-3);
  background: var(--bg-raised);
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-pop);
}
.toast__icon { width: 16px; height: 16px; margin-top: 1px; stroke-width: 1.85; color: var(--fg-subtle); }
.toast--success .toast__icon { color: var(--ripe-done); }
.toast--warning .toast__icon { color: var(--ripe-waiting); }
.toast--error .toast__icon { color: var(--ripe-error); }
.toast__text { min-width: 0; display: flex; flex-direction: column; align-items: flex-start; gap: 2px; }
.toast__title {
  margin: 0;
  font-size: var(--text-sm);
  font-weight: 600;
  color: var(--fg);
  overflow-wrap: anywhere;
}
.toast__body {
  margin: 0;
  font-size: var(--text-sm);
  color: var(--fg-muted);
  overflow-wrap: anywhere;
  text-wrap: pretty;
}
.toast__action {
  margin-top: var(--space-1);
  padding: 0;
  font: inherit;
  font-size: var(--text-sm);
  font-weight: 560;
  color: var(--accent-ink);
  background: none;
  border: 0;
  cursor: pointer;
}
.toast__action:hover { text-decoration: underline; text-underline-offset: 2px; }
.toast__close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  padding: 0;
  color: var(--fg-faint);
  background: none;
  border: 0;
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: background var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out);
}
.toast__close svg { width: 14px; height: 14px; }
.toast__close:hover { background: var(--bg-hover); color: var(--fg); }
.toast__action:focus-visible,
.toast__close:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 1px; border-radius: var(--radius-sm); }

.toast-enter-active,
.toast-leave-active { transition: opacity var(--dur-med) var(--ease-out), transform var(--dur-med) var(--ease-out); }
.toast-enter-from { opacity: 0; transform: translateY(6px); }
.toast-leave-to { opacity: 0; }
.toast-move { transition: transform var(--dur-med) var(--ease-out); }

.pl__body {
  margin: 0 0 var(--space-3);
  font-size: var(--text-sm);
  color: var(--fg-muted);
  text-wrap: pretty;
}
.pl__body:last-child { margin-bottom: 0; }
.pl__form { display: flex; }
.pl__form .input { flex: 1; }
</style>
