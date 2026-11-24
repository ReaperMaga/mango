<script setup lang="ts">
import { ChevronRight, CircleAlert, Copy, FolderOpen, FolderPlus, Info, MoreHorizontal, Plus, RefreshCw, RotateCw, Store, Trash2, X } from 'lucide-vue-next'
import type { InstalledPlugin } from '~/types/ipc'
import type { MenuItem } from '~/types/ui'
import type { PluginRunStatus } from '~/plugin-host/types'
import { usePlugins } from '~/stores/plugins'
import { usePluginRuntime } from '~/plugin-host/runtime'
import { call, isTauri } from '~/composables/useBackend'
import { addLocalFolder, copyText, dismissJob, jobLabel, openPlugins, updatePlugin, usePluginsView } from '~/composables/pluginsView'
import { builtInPluginNote } from '~/utils/builtIns'
import { repoLabel } from '~/utils/pluginSource'
import SettingsSwitch from '~/components/settings/SettingsSwitch.vue'
import PluginStatus from './PluginStatus.vue'

/**
 * Settings > Plugins > Installed: every installed plugin with its switch, run state and source, update
 * checks for all of them, and per row Reload, Check for update, Open folder, Copy folder path and Remove (asked first,
 * under the row, like MCP servers).
 */
const { t } = useI18n()
const plugins = usePlugins()
const runtime = usePluginRuntime()
const view = usePluginsView()

onMounted(() => { void plugins.load() })

const busy = ref<string | null>(null)
const error = ref<string | null>(null)
const notice = ref<string | null>(null)
const checking = ref(false)
const removing = ref<string | null>(null)
const listEl = ref<HTMLElement | null>(null)

const list = computed(() => [...plugins.installed].sort((a, b) => a.manifest.name.localeCompare(b.manifest.name)))

function statusOf(p: InstalledPlugin): PluginRunStatus {
  if (builtInPluginNote(p.manifest.id)) return 'builtIn'
  const s = runtime.states[p.manifest.id]?.status
  if (s) return s
  if (!p.enabled) return 'disabled'
  return runtime.safeMode ? 'paused' : 'loading'
}
const errorOf = (p: InstalledPlugin) => {
  const builtIn = builtInPluginNote(p.manifest.id)
  if (builtIn) return builtIn
  const st = runtime.states[p.manifest.id]
  return st && (st.status === 'error' || st.status === 'incompatible') ? st.error : null
}

function sourceText(p: InstalledPlugin) {
  if (p.source.kind === 'local') return p.source.path
  const parts = [repoLabel(p.source.url)]
  if (p.source.subpath) parts.push(p.source.subpath)
  return parts.join(' / ') + (p.source.ref ? ` @ ${p.source.ref}` : '')
}

const update = (p: InstalledPlugin) => plugins.updates[p.manifest.id]

async function run(id: string, job: () => Promise<unknown>) {
  busy.value = id
  error.value = null
  notice.value = null
  try {
    await job()
    return true
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
    return false
  } finally {
    busy.value = null
  }
}

const toggle = (p: InstalledPlugin, on: boolean) => run(p.manifest.id, () => plugins.setEnabled(p.manifest.id, on))

async function checkAll() {
  checking.value = true
  error.value = null
  notice.value = null
  try {
    const infos = await plugins.checkUpdates(null)
    const failed = infos.filter(i => i.error)
    const found = infos.filter(i => i.hasUpdate).length
    if (failed.length) error.value = t('plugins.list.notChecked', { list: failed.map(f => `${plugins.byId(f.id)?.manifest.name ?? f.id}: ${f.error}`).join('; ') }, failed.length)
    else if (!found) notice.value = t('plugins.list.allCurrent')
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    checking.value = false
  }
}

async function updateAll() {
  for (const p of list.value) if (update(p)?.hasUpdate) await updatePlugin(p.manifest.id)
}

async function checkOne(p: InstalledPlugin) {
  await run(p.manifest.id, async () => {
    const [info] = await plugins.checkUpdates([p.manifest.id])
    if (info?.error) throw new Error(t('plugins.list.oneNotChecked', { name: p.manifest.name, error: info.error }))
    if (info && !info.hasUpdate) notice.value = t('plugins.list.oneCurrent', { name: p.manifest.name })
  })
}

/** Shows a plugin's folder (null: the plugins folder) in the file manager; the browser preview has none, so it copies the path. */
async function reveal(id: string | null) {
  await run('', async () => {
    if (isTauri()) await call('plugins_reveal', { id })
    else if (id) await copyDir(plugins.byId(id)!)
    else await copyPluginsDir()
  })
}
async function copyDir(p: InstalledPlugin) {
  notice.value = (await copyText(p.dir)) ? t('plugins.list.copiedFolder', { name: p.manifest.name }) : null
}
async function copyPluginsDir() {
  await run('', async () => {
    const dir = await call('plugins_dir', {})
    notice.value = (await copyText(dir)) ? t('plugins.list.copied', { path: dir }) : dir
  })
}

function menu(p: InstalledPlugin): MenuItem[] {
  const id = p.manifest.id
  const builtIn = !!builtInPluginNote(id)
  return [
    { label: t('plugins.list.details'), icon: Info, onSelect: () => openPlugins({ detail: id }) },
    { label: t('plugins.reload'), icon: RotateCw, disabled: builtIn || !p.enabled || runtime.safeMode, onSelect: () => void run(id, () => runtime.reload(id)) },
    {
      label: p.source.kind === 'local' ? t('plugins.list.readFolder') : t('plugins.checkUpdate'),
      icon: RefreshCw,
      disabled: builtIn,
      onSelect: () => void (p.source.kind === 'local' ? updatePlugin(id) : checkOne(p)),
    },
    { label: t('plugins.openFolder'), icon: FolderOpen, onSelect: () => void reveal(id) },
    { label: t('plugins.copyFolder'), icon: Copy, onSelect: () => void copyDir(p) },
    { label: t('plugins.list.remove'), icon: Trash2, danger: true, divider: true, onSelect: () => askRemove(p) },
  ]
}

function askRemove(p: InstalledPlugin) {
  removing.value = p.manifest.id
  void nextTick(() => listEl.value?.querySelector<HTMLElement>('.pi__ask [data-autofocus]')?.focus())
}
function keep() {
  const id = removing.value
  removing.value = null
  void nextTick(() => listEl.value?.querySelector<HTMLElement>(`[data-more="${id}"]`)?.focus())
}
async function remove(p: InstalledPlugin) {
  if (await run(p.manifest.id, () => plugins.remove(p.manifest.id))) removing.value = null
}

const adding = ref(false)
async function addLocal() {
  adding.value = true
  error.value = null
  try {
    const id = await addLocalFolder()
    if (id) openPlugins({ detail: id })
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    adding.value = false
  }
}

const nameId = (p: InstalledPlugin) => `plugin-name-${p.manifest.id}`
</script>

<template>
  <div ref="listEl" class="pi">
    <p v-if="plugins.loadError" class="pi__error selectable" role="alert">
      <CircleAlert aria-hidden="true" />{{ t('plugins.list.loadError', { error: plugins.loadError }) }}
    </p>

    <template v-if="list.length">
      <div class="pi__bar">
        <span class="pi__count tabular">
          {{ t('plugins.list.count', { n: list.length }) }}<template v-if="plugins.updateCount"> · <span class="pi__updates">{{ t('plugins.list.updates', plugins.updateCount) }}</span></template>
        </span>
        <UiButton v-if="plugins.updateCount > 1" size="sm" @click="updateAll">{{ t('plugins.list.updateAll') }}</UiButton>
        <UiButton size="sm" variant="ghost" :loading="checking" @click="checkAll"><RefreshCw v-if="!checking" />{{ t('plugins.list.checkUpdates') }}</UiButton>
      </div>

      <ul class="pi__card" :aria-label="t('plugins.list.label')">
        <li v-for="p in list" :key="p.manifest.id" class="pi__item">
          <div class="pi__row" :class="{ 'is-off': !p.enabled }">
            <SettingsSwitch
              :model-value="p.enabled && !builtInPluginNote(p.manifest.id)"
              :labelledby="nameId(p)"
              :title="p.enabled ? t('plugins.turnOff', { name: p.manifest.name }) : t('plugins.turnOn', { name: p.manifest.name })"
              :disabled="busy === p.manifest.id || !!builtInPluginNote(p.manifest.id)"
              @update:model-value="v => toggle(p, v)"
            />
            <div class="pi__text">
              <div class="pi__line">
                <button :id="nameId(p)" type="button" class="pi__name" :title="t('plugins.details', { name: p.manifest.name })" @click="openPlugins({ detail: p.manifest.id })">
                  {{ p.manifest.name }}
                </button>
                <span class="pi__version tabular">{{ p.manifest.version }}</span>
                <PluginStatus :status="statusOf(p)" />
              </div>
              <div class="pi__source selectable" :title="sourceText(p)">
                <span v-if="p.source.kind === 'local'" class="pi__kind">{{ t('plugins.localFolder') }}</span>{{ sourceText(p) }}
              </div>
              <p v-if="errorOf(p)" class="pi__why selectable" :class="{ 'is-warn': statusOf(p) === 'incompatible', 'is-note': statusOf(p) === 'builtIn' }" :title="errorOf(p) ?? ''">{{ errorOf(p) }}</p>
              <p v-if="view.jobs[p.manifest.id]?.error" class="pi__why selectable" role="alert">
                {{ view.jobs[p.manifest.id]!.error }}
                <button type="button" class="pi__dismiss" @click="dismissJob(p.manifest.id)">{{ t('plugins.dismiss') }}</button>
              </p>
              <p v-else-if="view.jobs[p.manifest.id]" class="pi__progress selectable" aria-live="polite">
                {{ view.jobs[p.manifest.id]!.line || jobLabel(view.jobs[p.manifest.id]!) }}
              </p>
            </div>
            <div class="pi__actions">
              <UiButton v-if="view.jobs[p.manifest.id] && !view.jobs[p.manifest.id]!.error" size="sm" loading>{{ jobLabel(view.jobs[p.manifest.id]!) }}</UiButton>
              <UiButton
                v-else-if="update(p)?.hasUpdate"
                size="sm"
                :title="update(p)?.latestVersion ? t('plugins.updateTo', { version: update(p)!.latestVersion! }) : t('plugins.list.updateLatest')"
                @click="updatePlugin(p.manifest.id)"
              >
                {{ update(p)?.latestVersion && update(p)!.latestVersion !== p.manifest.version ? t('plugins.updateTo', { version: update(p)!.latestVersion! }) : t('plugins.update') }}
              </UiButton>
              <UiMenu :items="menu(p)" placement="bottom-end" :width="220" :label="t('plugins.list.actions', { name: p.manifest.name })">
                <template #default="{ toggle: open, open: isOpen }">
                  <UiIconButton size="sm" :label="t('plugins.list.more', { name: p.manifest.name })" :active="isOpen" :data-more="p.manifest.id" aria-haspopup="menu" @click="open"><MoreHorizontal /></UiIconButton>
                </template>
              </UiMenu>
              <UiIconButton size="sm" :label="t('plugins.details', { name: p.manifest.name })" @click="openPlugins({ detail: p.manifest.id })"><ChevronRight /></UiIconButton>
            </div>
          </div>
          <div
            v-if="removing === p.manifest.id"
            class="pi__ask"
            role="alertdialog"
            :aria-label="t('plugins.remove.label', { name: p.manifest.name })"
            @keydown.esc.stop.prevent="keep"
          >
            <i18n-t :keypath="p.source.kind === 'local' ? 'plugins.remove.askLocal' : 'plugins.remove.ask'" tag="p" scope="global" class="pi__ask-text">
              <template #name><strong>{{ p.manifest.name }}</strong></template>
            </i18n-t>
            <UiButton size="sm" variant="ghost" data-autofocus @click="keep">{{ t('plugins.remove.keep') }}</UiButton>
            <UiButton size="sm" variant="danger" :loading="busy === p.manifest.id" @click="remove(p)">{{ t('plugins.remove.confirm') }}</UiButton>
          </div>
        </li>
      </ul>
    </template>

    <div v-else-if="plugins.loaded" class="pi__empty">
      <p class="pi__empty-text">
        {{ t('plugins.list.empty') }}
      </p>
      <div class="pi__empty-actions">
        <UiButton size="sm" variant="primary" @click="openPlugins({ tab: 'browse' })"><Store />{{ t('plugins.list.browse') }}</UiButton>
        <UiButton size="sm" @click="openPlugins({ add: true })"><Plus />{{ t('plugins.addFromLink') }}</UiButton>
        <UiButton size="sm" variant="ghost" :loading="adding" @click="addLocal"><FolderPlus v-if="!adding" />{{ t('plugins.list.addLocal') }}</UiButton>
      </div>
    </div>

    <p v-if="error" class="pi__error selectable" role="alert">
      <CircleAlert aria-hidden="true" /><span>{{ error }}</span>
      <UiIconButton size="sm" :label="t('plugins.dismiss')" @click="error = null"><X /></UiIconButton>
    </p>
    <p v-else-if="notice" class="pi__notice selectable" role="status">{{ notice }}</p>

    <p v-if="list.length" class="pi__foot">
      {{ t('plugins.list.foot') }}
      <button type="button" class="pi__link" @click="reveal(null)">{{ t('plugins.list.openDir') }}</button>
    </p>
  </div>
</template>

<style scoped>
.pi { display: grid; gap: var(--space-3); }

.pi__bar { display: flex; align-items: center; gap: var(--space-2); min-height: 26px; }
.pi__count { flex: 1; min-width: 0; font-size: var(--text-xs); color: var(--fg-subtle); }
.pi__updates { color: var(--ripe-running-fg); font-weight: 560; }
.pi :deep(.btn svg) { width: 14px; height: 14px; }

.pi__card {
  margin: 0;
  padding: 0;
  list-style: none;
  border: 1px solid var(--line-soft);
  border-radius: var(--radius-md);
  background: var(--bg-panel);
}
.pi__card > * + * { border-top: 1px solid var(--line-soft); }
.pi__row {
  display: flex;
  align-items: flex-start;
  gap: var(--space-3);
  min-height: 52px;
  padding: var(--space-3) var(--space-2) var(--space-3) var(--space-4);
}
.pi__row > .switch, .pi__row > :first-child { margin-top: 2px; }
.pi__text { flex: 1; min-width: 0; display: grid; gap: 3px; }
.pi__line { display: flex; align-items: baseline; gap: var(--space-2); min-width: 0; }
.pi__name {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--text-sm);
  font-weight: 600;
  color: var(--fg);
  text-align: left;
  border-radius: var(--radius-xs);
}
.pi__name:hover { text-decoration: underline; text-underline-offset: 3px; text-decoration-color: var(--line-strong); }
.pi__row.is-off .pi__name { color: var(--fg-muted); font-weight: 540; }
.pi__version { flex: none; font-size: var(--text-xs); color: var(--fg-faint); }
.pi__line :deep(.pst) { margin-left: auto; padding-left: var(--space-2); }
.pi__source {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--fg-subtle);
}
.pi__kind { font-family: var(--font-sans); margin-right: var(--space-2); color: var(--fg-faint); }
.pi__why {
  margin: 2px 0 0;
  font-size: var(--text-xs);
  color: var(--ripe-error-fg);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.pi__why.is-warn { color: var(--ripe-waiting-fg); }
.pi__dismiss { margin-left: var(--space-2); font-size: inherit; color: var(--fg-subtle); text-decoration: underline; text-underline-offset: 3px; }
.pi__progress {
  margin: 2px 0 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-mono);
  font-size: var(--text-2xs);
  color: var(--fg-subtle);
}
.pi__actions { flex: none; display: flex; align-items: center; gap: 2px; }

.pi__ask {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  margin: 0 var(--space-2) var(--space-2);
  padding: var(--space-2) var(--space-2) var(--space-2) var(--space-3);
  border: 1px solid color-mix(in oklch, var(--ripe-error) 35%, transparent);
  border-radius: var(--radius-sm);
  background: color-mix(in oklch, var(--ripe-error) 7%, transparent);
}
.pi__ask-text { flex: 1 1 30ch; margin: 0; font-size: var(--text-sm); color: var(--fg-muted); text-wrap: pretty; }
.pi__ask-text strong { font-weight: 600; color: var(--fg); }

.pi__empty { display: grid; justify-items: start; gap: var(--space-3); padding: var(--space-2) 0; }
.pi__empty-text { margin: 0; max-width: 62ch; font-size: var(--text-sm); color: var(--fg-subtle); text-wrap: pretty; }
.pi__empty-actions { display: flex; flex-wrap: wrap; gap: var(--space-2); }

.pi__error {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  margin: 0;
  font-size: var(--text-sm);
  color: var(--ripe-error-fg);
}
.pi__error > svg { flex: none; width: 15px; height: 15px; margin-top: 2px; stroke-width: 1.85; color: var(--ripe-error); }
.pi__error > span { flex: 1; min-width: 0; text-wrap: pretty; }
.pi__notice { margin: 0; font-size: var(--text-xs); color: var(--fg-subtle); }
.pi__foot { margin: var(--space-3) 0 0; max-width: 64ch; font-size: var(--text-xs); color: var(--fg-subtle); text-wrap: pretty; }
.pi__link {
  font-size: inherit;
  color: var(--fg-muted);
  text-decoration: underline;
  text-underline-offset: 3px;
  text-decoration-color: var(--line-strong);
  border-radius: var(--radius-xs);
}
.pi__link:hover { color: var(--fg); }
.pi__why.is-note { color: var(--fg-subtle); }
</style>
