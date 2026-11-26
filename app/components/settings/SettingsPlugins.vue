<script setup lang="ts">
import { ArrowLeft, ChevronRight, PauseCircle, Plus } from 'lucide-vue-next'
import { usePlugins } from '~/stores/plugins'
import { usePluginRuntime } from '~/plugin-host/runtime'
import { usePluginsView, type PluginsTab } from '~/composables/pluginsView'
import SettingsSection from './SettingsSection.vue'
import SettingsSegmented from './SettingsSegmented.vue'
import PluginsBrowse from '~/components/plugins/PluginsBrowse.vue'
import PluginsInstalled from '~/components/plugins/PluginsInstalled.vue'
import PluginDetail from '~/components/plugins/PluginDetail.vue'
import PluginAddDialog from '~/components/plugins/PluginAddDialog.vue'

/**
 * Settings > Plugins: Browse (the official catalog) and Installed, a plugin's detail in place of the
 * lists (with a breadcrumb back, Alt+Left like Environments), and the Add plugin dialog.
 */
const { t } = useI18n()
const plugins = usePlugins()
const runtime = usePluginRuntime()
const view = usePluginsView()

onMounted(() => { void plugins.load() })

const tab = computed<PluginsTab>({
  get: () => view.tab ?? (plugins.installed.length ? 'installed' : 'browse'),
  set: (id) => { view.tab = id },
})
const tabs = computed(() => [
  { value: 'browse' as const, label: t('settings.plugins.browse') },
  { value: 'installed' as const, label: plugins.installed.length ? t('settings.plugins.installedCount', { n: plugins.installed.length }) : t('settings.plugins.installed') },
])

const detailName = computed(() => (view.detail ? plugins.byId(view.detail)?.manifest.name ?? view.detail : ''))
const root = ref<HTMLElement | null>(null)

function back() {
  const was = view.detail
  view.detail = null
  void nextTick(() => {
    const row = was ? root.value?.querySelector<HTMLElement>(`#plugin-name-${CSS.escape(was)}`) : null
    ;(row ?? root.value?.querySelector<HTMLElement>('.seg input:checked'))?.focus()
  })
}

/* Into a plugin: start at the top with focus on its name. */
watch(() => view.detail, async (now) => {
  if (!now) return
  await nextTick()
  root.value?.closest('.settings__scroll')?.scrollTo({ top: 0 })
  const title = root.value?.querySelector<HTMLElement>('[data-page-title]')
  if (title && (!document.activeElement || document.activeElement === document.body || root.value?.contains(document.activeElement))) title.focus()
})

function onKey(e: KeyboardEvent) {
  if (!view.detail || e.defaultPrevented || view.addOpen) return
  if (!(e.altKey && e.key === 'ArrowLeft') || e.ctrlKey || e.metaKey || e.shiftKey) return
  if ((e.target as HTMLElement | null)?.closest?.('input, textarea, [contenteditable]')) return
  e.preventDefault()
  back()
}
onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))

const resuming = ref(false)
async function resume() {
  resuming.value = true
  try { await runtime.resume() } finally { resuming.value = false }
}
const modKey = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌥' : 'Alt'
</script>

<template>
  <div ref="root">
    <SettingsSection
      :title="t('settings.nav.plugins')"
      :description="t('settings.plugins.description')"
    >
      <div v-if="runtime.safeMode" class="sp__safe" role="status">
        <PauseCircle aria-hidden="true" />
        <p class="sp__safe-text">
          <strong>{{ t('settings.plugins.paused') }}</strong>
          {{ t('settings.plugins.pausedHint') }}
        </p>
        <UiButton size="sm" :loading="resuming" @click="resume">{{ t('settings.plugins.resume') }}</UiButton>
      </div>

      <template v-if="view.detail">
        <nav class="crumbs" :aria-label="t('settings.plugins.breadcrumb')">
          <UiIconButton :label="t('common.actions.back')" :shortcut="`${modKey}+Left`" size="sm" @click="back"><ArrowLeft /></UiIconButton>
          <ol class="crumbs__list">
            <li class="crumbs__item"><button type="button" class="crumbs__link" @click="back">{{ t('settings.nav.plugins') }}</button></li>
            <li class="crumbs__item">
              <ChevronRight class="crumbs__sep" aria-hidden="true" />
              <span class="crumbs__here" aria-current="location">{{ detailName }}</span>
            </li>
          </ol>
        </nav>
        <PluginDetail :id="view.detail" :key="view.detail" @removed="back" />
      </template>

      <template v-else>
        <div class="sp__bar">
          <SettingsSegmented v-model="tab" :label="t('settings.nav.plugins')" :options="tabs" />
          <UiButton size="sm" class="sp__add" @click="view.addLink = ''; view.addOpen = true"><Plus />{{ t('settings.plugins.add') }}</UiButton>
        </div>
        <PluginsBrowse v-if="tab === 'browse'" />
        <PluginsInstalled v-else />
      </template>
    </SettingsSection>

    <PluginAddDialog />
  </div>
</template>

<style scoped>
.sp__bar { display: flex; align-items: center; gap: var(--space-2); margin-bottom: var(--space-4); }
.sp__add { margin-left: auto; }
.sp__add :deep(svg), .sp__bar :deep(.btn svg) { width: 14px; height: 14px; }

.sp__safe {
  display: flex;
  align-items: flex-start;
  gap: var(--space-3);
  margin-bottom: var(--space-4);
  padding: var(--space-3);
  border: 1px solid color-mix(in oklch, var(--ripe-waiting) 45%, transparent);
  border-radius: var(--radius-md);
  background: color-mix(in oklch, var(--ripe-waiting) 6%, var(--bg-panel));
}
.sp__safe > svg { flex: none; width: 16px; height: 16px; margin-top: 2px; stroke-width: 1.85; color: var(--ripe-waiting); }
.sp__safe-text { flex: 1; min-width: 0; margin: 0; font-size: var(--text-sm); color: var(--fg-muted); text-wrap: pretty; }
.sp__safe-text strong { font-weight: 600; color: var(--ripe-waiting-fg); }

/* ---- breadcrumb: the same as Environments ---- */
.crumbs {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  min-width: 0;
  margin: calc(var(--space-2) * -1) 0 var(--space-4) calc(var(--space-1) * -1);
}
.crumbs__list { display: flex; align-items: center; min-width: 0; margin: 0; padding: 0; list-style: none; }
.crumbs__item { display: flex; align-items: center; min-width: 0; }
.crumbs__item:first-child { flex: none; }
.crumbs__sep { flex: none; width: 13px; height: 13px; margin: 0 2px; stroke-width: 1.85; color: var(--fg-faint); }
.crumbs__link,
.crumbs__here {
  min-width: 0;
  height: 24px;
  padding: 0 6px;
  font-size: var(--text-sm);
  line-height: 24px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  border-radius: var(--radius-xs);
}
.crumbs__link { color: var(--fg-subtle); transition: background var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out); }
.crumbs__link:hover { background: var(--bg-hover); color: var(--fg); }
.crumbs__here { color: var(--fg-muted); font-weight: 560; }
</style>
