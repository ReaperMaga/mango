<script setup lang="ts">
import { Bot, Mic, SlidersHorizontal, SquareTerminal, SunMoon, X } from 'lucide-vue-next'
import { useWorkspace } from '~/stores/workspace'
import SettingsAgents from './SettingsAgents.vue'
import SettingsAppearance from './SettingsAppearance.vue'
import SettingsGeneral from './SettingsGeneral.vue'
import SettingsTerminal from './SettingsTerminal.vue'
import SettingsVoice from './SettingsVoice.vue'

/**
 * Settings: a full view under the titlebar, not a dialog. It takes the place
 * of the workspace (a section rail where the sidebar is, the section on the
 * canvas) and leaves the titlebar and its window controls alone.
 *
 * Open when `ws.settings` names a section; closing sets it back to null.
 */
type Section = NonNullable<ReturnType<typeof useWorkspace>['settings']>

const ws = useWorkspace()
const build = useBuildInfo()

const sections: Array<{ id: Section; label: string; icon: typeof Bot }> = [
  { id: 'general', label: 'General', icon: SlidersHorizontal },
  { id: 'agents', label: 'Agents', icon: Bot },
  { id: 'terminal', label: 'Terminal', icon: SquareTerminal },
  { id: 'voice', label: 'Voice', icon: Mic },
  { id: 'appearance', label: 'Appearance', icon: SunMoon },
]

const open = computed(() => ws.settings !== null)
/** Stays on the last section while the view fades out. */
const section = ref<Section>(ws.settings ?? 'general')

const view = ref<HTMLElement | null>(null)
const scroller = ref<HTMLElement | null>(null)
const titleId = useId()

/** The rail sits where the sidebar is, so the canvas edge doesn't jump. */
const railWidth = computed(() =>
  ws.hasProject && ws.sidebarOpen ? Math.min(300, Math.max(208, ws.sidebarWidth)) : 248)

function close() {
  ws.settings = null
}

function show(id: Section) {
  ws.settings = id
}

/* ---------- focus: into the view on open, back where it was on close ---------- */

let returnFocus: HTMLElement | null = null

/** The workspace underneath is covered: keep keyboard focus and assistive tech out of it. */
function setUnderlayInert(on: boolean) {
  const body = document.querySelector<HTMLElement>('.app__body')
  if (!body) return
  if (on) body.setAttribute('inert', '')
  else body.removeAttribute('inert')
}

watch(() => ws.settings, async (now, before) => {
  if (now) {
    section.value = now
    if (!before) {
      returnFocus = document.activeElement instanceof HTMLElement && document.activeElement !== document.body
        ? document.activeElement
        : null
      setUnderlayInert(true)
      await nextTick()
      view.value?.querySelector<HTMLElement>('[aria-current="page"]')?.focus()
    } else if (now !== before) {
      const inRail = !!document.activeElement?.closest('.settings__nav')
      await nextTick()
      scroller.value?.scrollTo({ top: 0 })
      // Keep keyboard focus on the section that is now showing.
      if (inRail) view.value?.querySelector<HTMLElement>('[aria-current="page"]')?.focus()
    }
    return
  }
  setUnderlayInert(false)
  const target = returnFocus
  returnFocus = null
  if (target?.isConnected) target.focus()
}, { flush: 'pre' })

/* ---------- keys ---------- */

function onKey(e: KeyboardEvent) {
  if (e.key !== 'Escape' || !open.value || e.defaultPrevented) return
  // A dialog or the palette on top handles its own Escape first.
  if (ws.paletteOpen || ws.dialog) return
  // In the sign-in terminal Escape belongs to the program.
  if ((e.target as HTMLElement | null)?.closest?.('.xterm')) return
  e.preventDefault()
  close()
}

/** Up and Down walk the section list, like a native settings sidebar. */
function onRailKey(e: KeyboardEvent) {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
  const i = sections.findIndex(s => s.id === section.value)
  const next = sections[(i + (e.key === 'ArrowDown' ? 1 : -1) + sections.length) % sections.length]
  if (!next) return
  e.preventDefault()
  show(next.id)
}

onMounted(() => {
  window.addEventListener('keydown', onKey)
  if (open.value) setUnderlayInert(true)
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey)
  setUnderlayInert(false)
})
</script>

<template>
  <Transition name="settings">
    <section
      v-if="open"
      ref="view"
      class="settings"
      :aria-labelledby="titleId"
      :style="{ '--rail-w': `${railWidth}px` }"
    >
      <div class="settings__rail">
        <header class="settings__head">
          <h1 :id="titleId" class="settings__title">Settings</h1>
          <UiIconButton label="Close settings" shortcut="Esc" @click="close"><X /></UiIconButton>
        </header>
        <nav class="settings__nav" aria-label="Settings sections" @keydown="onRailKey">
          <button
            v-for="s in sections"
            :key="s.id"
            type="button"
            class="settings__item"
            :class="{ 'is-current': section === s.id }"
            :aria-current="section === s.id ? 'page' : undefined"
            @click="show(s.id)"
          >
            <component :is="s.icon" aria-hidden="true" />
            <span>{{ s.label }}</span>
          </button>
        </nav>
        <button type="button" class="settings__version tabular" title="About Mango" @click="show('general')">
          Mango {{ build.version }}<template v-if="build.dev"> · dev</template>
        </button>
      </div>

      <div class="settings__main">
        <div ref="scroller" class="settings__scroll">
          <div class="settings__col">
            <!-- Agents stays mounted while Settings is open, so a sign-in in progress survives a look at another section. -->
            <SettingsAgents v-show="section === 'agents'" :active="section === 'agents'" />
            <SettingsTerminal v-if="section === 'terminal'" />
            <SettingsVoice v-else-if="section === 'voice'" />
            <SettingsAppearance v-else-if="section === 'appearance'" />
            <SettingsGeneral v-else-if="section === 'general'" />
          </div>
        </div>
      </div>
    </section>
  </Transition>
</template>

<style scoped>
.settings {
  position: fixed;
  inset: var(--titlebar-h) 0 0 0;
  /* Over the workspace and its resize handles; under menus (50), dialogs (60) and the palette (70). */
  z-index: 40;
  display: flex;
  min-width: 0;
  background: var(--bg-app);
}

/* ---- section rail: same ground and rhythm as the sidebar ---- */
.settings__rail {
  flex: none;
  width: var(--rail-w, 248px);
  display: flex;
  flex-direction: column;
  min-height: 0;
  padding: var(--space-1) var(--space-2) var(--space-3) var(--space-3);
}
.settings__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 32px;
  padding-left: var(--space-2);
}
.settings__title {
  margin: 0;
  font-size: var(--text-lg);
  font-weight: 620;
  letter-spacing: -0.01em;
}
.settings__nav {
  display: grid;
  gap: 2px;
  margin-top: var(--space-3);
}
.settings__item {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  height: 30px;
  padding: 0 var(--space-2);
  font-size: var(--text-sm);
  text-align: left;
  color: var(--fg-muted);
  border-radius: var(--radius-sm);
  transition: background var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out);
}
.settings__item svg {
  flex: none;
  width: 16px;
  height: 16px;
  stroke-width: 1.75;
  color: var(--fg-subtle);
  transition: color var(--dur-fast) var(--ease-out);
}
.settings__item:hover { background: var(--bg-hover); color: var(--fg); }
.settings__item.is-current { background: var(--bg-active); color: var(--fg); font-weight: 560; }
.settings__item:hover svg,
.settings__item.is-current svg { color: var(--fg); }
.settings__item:focus-visible { border-radius: var(--radius-sm); }
.settings__version {
  align-self: flex-start;
  margin-top: auto;
  padding: var(--space-1) var(--space-2);
  border-radius: var(--radius-sm);
  font-size: var(--text-xs);
  color: var(--fg-faint);
  transition: color var(--dur-fast) var(--ease-out);
}
.settings__version:hover { color: var(--fg-subtle); }

/* ---- the section, on the canvas ---- */
.settings__main {
  flex: 1;
  min-width: 0;
  background: var(--bg-canvas);
  border-top-left-radius: var(--radius-lg);
  border-top: 1px solid var(--line-soft);
  border-left: 1px solid var(--line-soft);
  overflow: hidden;
}
.settings__scroll {
  height: 100%;
  overflow-y: auto;
  scrollbar-gutter: stable both-edges;
}
.settings__col {
  max-width: calc(640px + var(--space-8) * 2);
  margin: 0 auto;
  padding: var(--space-8) var(--space-8) var(--space-12);
}

/* ---- open / close: a short fade with a small settle ---- */
.settings-enter-active,
.settings-leave-active {
  transition: opacity var(--dur-fast) var(--ease-out);
}
.settings-enter-active .settings__rail,
.settings-enter-active .settings__main,
.settings-leave-active .settings__rail,
.settings-leave-active .settings__main {
  transition: transform var(--dur-fast) var(--ease-out);
}
.settings-enter-from,
.settings-leave-to { opacity: 0; }
.settings-enter-from .settings__rail,
.settings-enter-from .settings__main,
.settings-leave-to .settings__rail,
.settings-leave-to .settings__main { transform: translateY(4px); }

@media (prefers-reduced-motion: reduce) {
  .settings-enter-from .settings__rail,
  .settings-enter-from .settings__main,
  .settings-leave-to .settings__rail,
  .settings-leave-to .settings__main { transform: none; }
}
</style>
