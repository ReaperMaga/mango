<script setup lang="ts">
import { Archive, Bell, Bot, FilePen, Folder, GitPullRequest, History, Keyboard, MessageSquareMore, Mic, Plug, Puzzle, Server, SlidersHorizontal, SquareTerminal, SunMoon, Wrench, X } from 'lucide-vue-next'
import { useWorkspace } from '~/stores/workspace'
import SettingsAgents from './SettingsAgents.vue'
import SettingsArchive from './SettingsArchive.vue'
import SettingsAppearance from './SettingsAppearance.vue'
import SettingsBehavior from './SettingsBehavior.vue'
import SettingsChangelog from './SettingsChangelog.vue'
import SettingsEditor from './SettingsEditor.vue'
import SettingsEnvironments from './SettingsEnvironments.vue'
import SettingsGeneral from './SettingsGeneral.vue'
import SettingsHosting from './SettingsHosting.vue'
import SettingsMaintenance from './SettingsMaintenance.vue'
import SettingsMcp from './SettingsMcp.vue'
import SettingsNotifications from './SettingsNotifications.vue'
import SettingsPlugins from './SettingsPlugins.vue'
import SettingsSection from './SettingsSection.vue'
import SettingsProjects from './SettingsProjects.vue'
import SettingsShortcuts from './SettingsShortcuts.vue'
import SettingsTerminal from './SettingsTerminal.vue'
import SettingsVoice from './SettingsVoice.vue'
import { useOverlay } from '~/composables/useOverlay'
import { usePluginRuntime } from '~/plugin-host/runtime'
import { usePlugins } from '~/stores/plugins'
import PluginViewHost from '~/components/plugins/PluginViewHost.vue'
import PluginGlyph from '~/components/plugins/PluginGlyph.vue'

/**
 * Settings: a full view under the titlebar, not a dialog. It takes the place
 * of the workspace (a section rail where the sidebar is, the section on the
 * canvas) and leaves the titlebar and its window controls alone.
 *
 * Open when `ws.settings` names a section; closing sets it back to null.
 * Once Environments has been shown, the view stays mounted (hidden) after it
 * closes, so installers, sign-ins and shells started there keep running.
 */
type Section = NonNullable<ReturnType<typeof useWorkspace>['settings']>

const ws = useWorkspace()
const build = useBuildInfo()

interface Item { id: Section; label: string; icon: typeof Bot }
/**
 * The rail: two headlines (not clickable) with their sections as a small tree under them, then Agents and
 * Changelog at the bottom.
 */
const groups: Array<{ label: string; items: Item[] }> = [
  {
    label: 'General',
    items: [
      { id: 'general', label: 'Preferences', icon: SlidersHorizontal },
      { id: 'projects', label: 'Projects', icon: Folder },
      { id: 'appearance', label: 'Appearance', icon: SunMoon },
      { id: 'editor', label: 'Editor', icon: FilePen },
      { id: 'notifications', label: 'Notifications', icon: Bell },
      { id: 'voice', label: 'Voice', icon: Mic },
      { id: 'shortcuts', label: 'Shortcuts', icon: Keyboard },
    ],
  },
  {
    label: 'Technical',
    items: [
      { id: 'environments', label: 'Environments', icon: Server },
      { id: 'hosting', label: 'Git hosting', icon: GitPullRequest },
      { id: 'terminal', label: 'Terminal', icon: SquareTerminal },
      { id: 'mcp', label: 'MCP servers', icon: Plug },
      { id: 'plugins', label: 'Plugins', icon: Puzzle },
      { id: 'behavior', label: 'Behaviour', icon: MessageSquareMore },
      { id: 'maintenance', label: 'Maintenance', icon: Wrench },
    ],
  },
]
const bottom: Item[] = [
  { id: 'agents', label: 'Agents', icon: Bot },
  { id: 'archive', label: 'Archive', icon: Archive },
  { id: 'changelog', label: 'Changelog', icon: History },
]

/** Settings pages plugins registered: a third group in the rail, `plugin:<pluginId>.<pageId>`. */
const runtime = usePluginRuntime()
const pluginsStore = usePlugins()
const pluginPages = computed(() => runtime.settingsPages.map(p => ({ ...p, section: `plugin:${p.fullId}` as Section })))
const pluginName = (id: string) => pluginsStore.byId(id)?.manifest.name ?? id

/** The sections in rail order: what Up and Down walk. */
const sections = computed<Section[]>(() => [
  ...groups.flatMap(g => g.items).map(i => i.id),
  ...pluginPages.value.map(p => p.section),
  ...bottom.map(i => i.id),
])

const open = computed(() => ws.settings !== null)
/* Settings covers the workspace; the browsers' native pages would show through. */
useOverlay(() => open.value)
/** Stays on the last section while the view fades out. */
const section = ref<Section>(ws.settings ?? 'general')
/** The page of a plugin section, while its plugin has it. */
const pluginPage = computed(() => pluginPages.value.find(p => p.section === section.value) ?? null)
/** What shows: a plugin page whose plugin is gone (or not started yet) falls back to Plugins. */
const current = computed<Section>(() => (section.value.startsWith('plugin:') && !pluginPage.value ? 'plugins' : section.value))
/** The other sections render while the view is open or fading out. */
const rendered = ref(open.value)
/** Environments, once shown, stays mounted for the life of the window (see above). */
const envsMounted = ref(false)
watch(() => ws.settings === 'environments', (on) => { if (on) envsMounted.value = true }, { immediate: true })

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
    rendered.value = true
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

/* ---------- the current section's highlight ---------- */

/*
 * One shape behind the current section that glides to the next one, across the groups and down to the
 * bottom of the rail, so changing section reads as a move. It is placed without motion when Settings opens
 * and whenever the rail itself changes size (its width follows the sidebar; the bottom items follow the window).
 */
const rail = ref<HTMLElement | null>(null)
const glide = reactive({ x: 0, y: 0, w: 0, h: 0, still: true })
function placeGlide(still: boolean) {
  const box = rail.value
  const el = box?.querySelector<HTMLElement>('.settings__item[aria-current="page"]')
  if (!box || !el) return
  const a = box.getBoundingClientRect()
  const b = el.getBoundingClientRect()
  if (!b.width) return // hidden (closed with Environments kept mounted)
  Object.assign(glide, { x: b.left - a.left, y: b.top - a.top + box.scrollTop, w: b.width, h: b.height, still })
}
watch([current, open, () => pluginPages.value.length], async ([, isOpen], [, wasOpen]) => {
  if (!isOpen) return
  await nextTick()
  placeGlide(!wasOpen)
}, { flush: 'post' })
let railRo: ResizeObserver | undefined
onMounted(() => {
  railRo = new ResizeObserver(() => placeGlide(true))
  if (rail.value) railRo.observe(rail.value)
  if (open.value) placeGlide(true)
})
onBeforeUnmount(() => railRo?.disconnect())

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
  const list = sections.value
  const i = list.indexOf(current.value)
  const next = list[(i + (e.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length]
  if (!next) return
  e.preventDefault()
  show(next)
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
  <Transition name="settings" @after-leave="rendered = false">
    <section
      v-if="open || envsMounted"
      v-show="open"
      ref="view"
      class="settings"
      :aria-labelledby="titleId"
      :style="{ '--rail-w': `${railWidth}px` }"
    >
      <div ref="rail" class="settings__rail">
        <span
          class="settings__glide"
          :class="{ 'is-still': glide.still }"
          :style="{ transform: `translate(${glide.x}px, ${glide.y}px)`, width: `${glide.w}px`, height: `${glide.h}px` }"
          aria-hidden="true"
        />
        <header class="settings__head">
          <h1 :id="titleId" class="settings__title">Settings</h1>
          <UiIconButton label="Close settings" shortcut="Esc" @click="close"><X /></UiIconButton>
        </header>
        <nav class="settings__nav" aria-label="Settings sections" @keydown="onRailKey">
          <div v-for="g in groups" :key="g.label" class="settings__group" role="group" :aria-label="g.label">
            <h2 class="settings__heading" aria-hidden="true">{{ g.label }}</h2>
            <button
              v-for="s in g.items"
              :key="s.id"
              type="button"
              class="settings__item settings__item--child"
              :class="{ 'is-current': current === s.id }"
              :aria-current="current === s.id ? 'page' : undefined"
              @click="show(s.id)"
            >
              <component :is="s.icon" aria-hidden="true" />
              <span>{{ s.label }}</span>
            </button>
          </div>
          <!-- Pages plugins registered, under their own headline -->
          <div v-if="pluginPages.length" class="settings__group" role="group" aria-label="Plugin settings">
            <h2 class="settings__heading" aria-hidden="true">Plugins</h2>
            <button
              v-for="p in pluginPages"
              :key="p.section"
              type="button"
              class="settings__item settings__item--child"
              :class="{ 'is-current': current === p.section }"
              :aria-current="current === p.section ? 'page' : undefined"
              :title="`${p.title}, from ${pluginName(p.pluginId)}`"
              @click="show(p.section)"
            >
              <PluginGlyph :icon="p.icon" />
              <span class="settings__label">{{ p.title }}</span>
            </button>
          </div>
        </nav>
        <nav class="settings__nav settings__nav--bottom" aria-label="Agents, archive and changelog" @keydown="onRailKey">
          <button
            v-for="s in bottom"
            :key="s.id"
            type="button"
            class="settings__item"
            :class="{ 'is-current': current === s.id }"
            :aria-current="current === s.id ? 'page' : undefined"
            @click="show(s.id)"
          >
            <component :is="s.icon" aria-hidden="true" />
            <span>{{ s.label }}</span>
          </button>
        </nav>
        <button type="button" class="settings__version tabular" title="About Mango" @click="show('maintenance')">
          Mango {{ build.version }}<template v-if="build.dev"> · dev</template>
        </button>
      </div>

      <div class="settings__main">
        <div ref="scroller" class="settings__scroll">
          <div class="settings__col" :class="{ 'settings__col--wide': section === 'environments' }">
            <!-- Changing section: the old page goes at once, the new one settles in (not when Settings opens: the view moves then). -->
            <template v-if="rendered">
              <!-- Agents stays mounted while Settings is open, so a sign-in in progress survives a look at another section. -->
              <Transition name="page">
                <SettingsAgents v-show="section === 'agents'" :active="open && section === 'agents'" />
              </Transition>
              <!-- Git hosting too: an install or a sign-in running there survives a look elsewhere. -->
              <Transition name="page">
                <SettingsHosting v-show="section === 'hosting'" :active="open && section === 'hosting'" />
              </Transition>
              <Transition name="page">
                <SettingsTerminal v-if="section === 'terminal'" />
                <SettingsEditor v-else-if="section === 'editor'" />
                <SettingsMcp v-else-if="section === 'mcp'" />
                <SettingsVoice v-else-if="section === 'voice'" />
                <SettingsNotifications v-else-if="section === 'notifications'" />
                <SettingsShortcuts v-else-if="section === 'shortcuts'" />
                <SettingsAppearance v-else-if="section === 'appearance'" />
                <SettingsChangelog v-else-if="section === 'changelog'" />
                <SettingsMaintenance v-else-if="section === 'maintenance'" />
                <SettingsArchive v-else-if="section === 'archive'" />
                <SettingsProjects v-else-if="section === 'projects'" />
                <SettingsBehavior v-else-if="section === 'behavior'" />
                <SettingsGeneral v-else-if="section === 'general'" />
                <SettingsPlugins v-else-if="current === 'plugins'" />
                <SettingsSection
                  v-else-if="pluginPage"
                  :key="pluginPage.section"
                  :title="pluginPage.title"
                  :description="`Settings of the ${pluginName(pluginPage.pluginId)} plugin.`"
                >
                  <PluginViewHost :view="pluginPage.view" :ctx="{}" :plugin-id="pluginPage.pluginId" />
                </SettingsSection>
              </Transition>
            </template>
            <Transition name="page">
              <SettingsEnvironments
                v-if="envsMounted"
                v-show="section === 'environments'"
                :active="open && section === 'environments'"
              />
            </Transition>
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
  position: relative;
  flex: none;
  width: var(--rail-w, 248px);
  display: flex;
  flex-direction: column;
  min-height: 0;
  /* A short window with plugin pages in the rail: it scrolls rather than cutting off the bottom items. */
  overflow-y: auto;
  scrollbar-width: thin;
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
.settings__group { display: grid; gap: 1px; margin-bottom: var(--space-3); }
/* A headline, not a button: it names the sections under it. */
.settings__heading {
  margin: 0;
  padding: var(--space-1) var(--space-2);
  font-size: var(--text-xs);
  font-weight: 560;
  color: var(--fg-faint);
}
/* Sections under a headline: one step smaller and in from the headline, so the rail reads as a tree. */
.settings__item.settings__item--child {
  height: 26px;
  padding-left: var(--space-4);
  font-size: var(--text-xs);
}
.settings__item.settings__item--child svg { width: 14px; height: 14px; }
/* A plugin's page: its own icon (any kind), and a title that may run long. */
.settings__item :deep(.glyph) { width: 14px; height: 14px; color: var(--fg-subtle); }
.settings__item:hover :deep(.glyph), .settings__item.is-current :deep(.glyph) { color: var(--fg); }
.settings__label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* Agents and Changelog sit at the bottom of the rail, above the version. */
.settings__nav--bottom { display: grid; gap: 2px; margin-top: auto; margin-bottom: var(--space-2); }
.settings__item {
  display: flex;
  flex: 1;
  min-width: 0;
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
.settings__item.is-current { color: var(--fg); font-weight: 560; }
.settings__item.is-current:hover { background: transparent; }
.settings__item { position: relative; z-index: 1; }
.settings__glide {
  position: absolute;
  top: 0;
  left: 0;
  border-radius: var(--radius-sm);
  background: var(--bg-active);
  pointer-events: none;
  transition:
    transform var(--dur-med) var(--ease-out),
    width var(--dur-med) var(--ease-out),
    height var(--dur-med) var(--ease-out);
}
.settings__glide.is-still { transition: none; }
.page-enter-active { transition: opacity var(--dur-med) var(--ease-out), transform var(--dur-med) var(--ease-out); }
.page-enter-from { opacity: 0; transform: translateY(4px); }
.settings__item:hover svg,
.settings__item.is-current svg { color: var(--fg); }
.settings__item:focus-visible { border-radius: var(--radius-sm); }
.settings__version {
  align-self: flex-start;
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
/* Environments holds lists of instances, terminals and a desktop: it takes more of the canvas. */
.settings__col--wide { max-width: calc(880px + var(--space-8) * 2); }

/* ---- open / close: a short fade with a small settle ---- */
/*
 * Opening: the view fades in over the panel time; the rail (where the sidebar is) slides in from the left
 * and the page rises a beat after it, so the eye goes from the list to the section. Closing is quick.
 */
.settings-enter-active { transition: opacity var(--dur-med) var(--ease-out); }
.settings-leave-active { transition: opacity var(--dur-fast) var(--ease-out); }
.settings-enter-active .settings__rail,
.settings-enter-active .settings__main {
  transition: transform var(--dur-med) var(--ease-out), opacity var(--dur-med) var(--ease-out);
}
.settings-enter-active .settings__main { transition-delay: calc(40ms * var(--motion-scale)); }
.settings-leave-active .settings__rail,
.settings-leave-active .settings__main {
  transition: transform var(--dur-fast) var(--ease-out);
}
.settings-enter-from { opacity: 0; }
.settings-enter-from .settings__rail { transform: translateX(-8px); opacity: 0; }
.settings-enter-from .settings__main { transform: translateY(6px); opacity: 0; }
.settings-leave-to { opacity: 0; }
.settings-leave-to .settings__rail,
.settings-leave-to .settings__main { transform: translateY(4px); }

@media (prefers-reduced-motion: reduce) {
  .settings-enter-from .settings__rail,
  .settings-enter-from .settings__main,
  .settings-leave-to .settings__rail,
  .settings-leave-to .settings__main { transform: none; }
}
</style>
