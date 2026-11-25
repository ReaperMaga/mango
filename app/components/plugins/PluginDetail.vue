<script setup lang="ts">
import { BadgeCheck, CircleAlert, Copy, ExternalLink, FolderOpen, RefreshCw, RotateCw, Settings2, Trash2 } from 'lucide-vue-next'
import type { InstalledPlugin } from '~/types/ipc'
import type { PluginRunStatus } from '~/plugin-host/types'
import { usePlugins } from '~/stores/plugins'
import { usePluginRuntime } from '~/plugin-host/runtime'
import { useWorkspace } from '~/stores/workspace'
import { call, isTauri, openExternal } from '~/composables/useBackend'
import { copyText, jobLabel, updatePlugin, usePluginsView } from '~/composables/pluginsView'
import { formatLocale } from '~/i18n'
import { builtInPluginNote } from '~/utils/builtIns'
import { repoLabel } from '~/utils/pluginSource'
import SettingsSwitch from '~/components/settings/SettingsSwitch.vue'
import PluginGlyph from './PluginGlyph.vue'
import PluginStatus from './PluginStatus.vue'
import PluginSettingsForm from './PluginSettingsForm.vue'

/**
 * One installed plugin, in place of the lists (Settings > Plugins › its name): what it is, where it came
 * from, what it added, its settings, its own settings pages and its log.
 */
const props = defineProps<{ id: string }>()
const emit = defineEmits<{ removed: [] }>()

const { t } = useI18n()
const plugins = usePlugins()
const runtime = usePluginRuntime()
const ws = useWorkspace()
const view = usePluginsView()

const p = computed(() => plugins.byId(props.id))
const m = computed(() => p.value?.manifest)
const entry = computed(() => plugins.catalog?.catalog.plugins.find(e => e.id === props.id) ?? null)
const state = computed(() => runtime.states[props.id] ?? null)
const builtIn = computed(() => builtInPluginNote(props.id))
const status = computed<PluginRunStatus>(() => {
  if (builtIn.value) return 'builtIn'
  if (state.value) return state.value.status
  if (!p.value?.enabled) return 'disabled'
  return runtime.safeMode ? 'paused' : 'loading'
})
const job = computed(() => view.jobs[props.id] ?? null)
const update = computed(() => plugins.updates[props.id] ?? null)
const pages = computed(() => runtime.settingsPages.filter(s => s.pluginId === props.id))
const log = computed(() => runtime.logs[props.id] ?? [])

const busy = ref<string | null>(null)
const error = ref<string | null>(null)
const notice = ref<string | null>(null)
const removing = ref(false)
const root = ref<HTMLElement | null>(null)

async function run(what: string, work: () => Promise<unknown>) {
  busy.value = what
  error.value = null
  notice.value = null
  try {
    await work()
    return true
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
    return false
  } finally {
    busy.value = null
  }
}

const setEnabled = (on: boolean) => run('toggle', () => plugins.setEnabled(props.id, on))
const reload = () => run('reload', () => runtime.reload(props.id))
async function check() {
  await run('check', async () => {
    const [info] = await plugins.checkUpdates([props.id])
    if (info?.error) throw new Error(t('plugins.detail.checkFailed', { error: info.error }))
    if (info && !info.hasUpdate) notice.value = t('plugins.detail.upToDate')
  })
}
async function openDir() {
  if (!isTauri()) return copyDir()
  await run('open', () => call('plugins_reveal', { id: props.id }))
}
async function copyDir() {
  if (p.value) notice.value = (await copyText(p.value.dir)) ? t('plugins.detail.copied') : null
}
/** Whether it saved documents: they stay, unless the box that then shows is ticked. */
const documents = ref(false)
const deleteDocuments = ref(false)
const removeAsk = (p: InstalledPlugin) => documents.value
  ? (p.source.kind === 'local' ? 'plugins.remove.askLocalDocuments' : 'plugins.remove.askDocuments')
  : (p.source.kind === 'local' ? 'plugins.remove.askLocal' : 'plugins.remove.ask')
function askRemove() {
  removing.value = true
  documents.value = deleteDocuments.value = false
  void plugins.documentCount(props.id).then((n) => { documents.value = n > 0 })
  void nextTick(() => root.value?.querySelector<HTMLElement>('.pd__ask [data-autofocus]')?.focus())
}
function keep() {
  removing.value = false
  void nextTick(() => root.value?.querySelector<HTMLElement>('[data-remove]')?.focus())
}
async function remove() {
  if (await run('remove', () => plugins.remove(props.id, deleteDocuments.value))) emit('removed')
}

/* ---------- facts ---------- */

const source = computed(() => {
  const s = p.value?.source
  if (!s) return ''
  if (s.kind === 'local') return s.path
  return [repoLabel(s.url), s.subpath].filter(Boolean).join(' / ')
})
const fmtDate = (ts: number) => new Date(ts).toLocaleString(formatLocale(), { dateStyle: 'medium', timeStyle: 'short' })

const contributions = computed(() => Object.entries(state.value?.contributions ?? {})
  .filter(([, n]) => n > 0)
  .map(([k, n]) => t(`plugins.adds.${k}`, n))
  .join(', '))

const homepage = computed(() => {
  const h = m.value?.homepage ?? entry.value?.homepage
  return h && /^https?:\/\//i.test(h) ? h : null
})

const time = (at: number) => new Date(at).toLocaleTimeString(formatLocale(), { hour: '2-digit', minute: '2-digit', second: '2-digit' })
const nameId = useId()
</script>

<template>
  <div v-if="p && m" ref="root" class="pd">
    <header class="pd__head">
      <span class="pd__tile"><PluginGlyph :icon="entry?.icon" /></span>
      <div class="pd__title-block">
        <div class="pd__title-line">
          <h3 :id="nameId" class="pd__title" tabindex="-1" data-page-title>{{ m.name }}</h3>
          <span class="pd__version tabular">{{ m.version }}</span>
          <span v-if="entry?.official" class="pd__official" :title="t('plugins.officialHint')"><BadgeCheck aria-hidden="true" />{{ t('plugins.official') }}</span>
        </div>
        <div class="pd__byline">
          <PluginStatus :status="status" />
          <span v-if="m.author" class="pd__author">{{ t('plugins.detail.by', { author: m.author }) }}</span>
          <span class="pd__id">{{ m.id }}</span>
        </div>
      </div>
      <label class="pd__switch">
        <span class="pd__switch-label">{{ p.enabled && !builtIn ? t('plugins.detail.on') : t('plugins.detail.off') }}</span>
        <SettingsSwitch :model-value="p.enabled && !builtIn" :disabled="!!builtIn" :labelledby="nameId" :title="p.enabled ? t('plugins.turnOff', { name: m.name }) : t('plugins.turnOn', { name: m.name })" @update:model-value="setEnabled" />
      </label>
    </header>

    <p v-if="m.description" class="pd__desc">{{ m.description }}</p>

    <p v-if="builtIn" class="pd__notice" role="status">{{ builtIn }}</p>
    <div v-else-if="state?.error && (status === 'error' || status === 'incompatible')" class="pd__banner" :class="{ 'is-warn': status === 'incompatible' }" role="alert">
      <CircleAlert aria-hidden="true" />
      <div class="pd__banner-text">
        <strong>{{ status === 'incompatible' ? t('plugins.detail.incompatible') : t('plugins.detail.error') }}</strong>
        <span class="selectable">{{ state.error }}</span>
      </div>
    </div>

    <div class="pd__actions">
      <template v-if="!builtIn">
        <UiButton v-if="job && !job.error" size="sm" loading>{{ jobLabel(job) }}</UiButton>
        <UiButton v-else-if="update?.hasUpdate" size="sm" variant="primary" @click="updatePlugin(id)">
          {{ update.latestVersion && update.latestVersion !== m.version ? t('plugins.updateTo', { version: update.latestVersion }) : t('plugins.update') }}
        </UiButton>
        <UiButton v-else-if="p.source.kind === 'git'" size="sm" :loading="busy === 'check'" @click="check"><RefreshCw v-if="busy !== 'check'" />{{ t('plugins.checkUpdate') }}</UiButton>
        <UiButton v-else size="sm" @click="updatePlugin(id)"><RefreshCw />{{ t('plugins.detail.readAgain') }}</UiButton>
        <UiButton size="sm" variant="ghost" :disabled="!p.enabled || runtime.safeMode" :loading="busy === 'reload'" @click="reload"><RotateCw v-if="busy !== 'reload'" />{{ t('plugins.reload') }}</UiButton>
      </template>
      <UiButton size="sm" variant="ghost" @click="openDir"><FolderOpen />{{ t('plugins.openFolder') }}</UiButton>
      <UiButton size="sm" variant="ghost" @click="copyDir"><Copy />{{ t('plugins.copyFolder') }}</UiButton>
      <UiButton v-if="homepage" size="sm" variant="ghost" :title="homepage" @click="openExternal(homepage)"><ExternalLink />{{ t('plugins.detail.homepage') }}</UiButton>
      <UiButton size="sm" variant="ghost" class="pd__remove" data-remove @click="askRemove"><Trash2 />{{ t('plugins.detail.remove') }}</UiButton>
    </div>
    <p v-if="job?.error" class="pd__error selectable" role="alert"><CircleAlert aria-hidden="true" />{{ job.error }}</p>
    <p v-else-if="job" class="pd__progress selectable" aria-live="polite">{{ job.line || jobLabel(job) }}</p>
    <p v-if="error" class="pd__error selectable" role="alert"><CircleAlert aria-hidden="true" />{{ error }}</p>
    <p v-else-if="notice" class="pd__notice" role="status">{{ notice }}</p>

    <div v-if="removing" class="pd__ask" role="alertdialog" :aria-label="t('plugins.remove.label', { name: m.name })" @keydown.esc.stop.prevent="keep">
      <div class="pd__ask-body">
        <i18n-t :keypath="removeAsk(p)" tag="p" scope="global" class="pd__ask-text">
          <template #name><strong>{{ m.name }}</strong></template>
        </i18n-t>
        <label v-if="documents" class="pd__ask-docs">
          <input v-model="deleteDocuments" type="checkbox" :disabled="busy === 'remove'">
          <span>{{ t('plugins.remove.documents') }}</span>
        </label>
      </div>
      <UiButton size="sm" variant="ghost" data-autofocus @click="keep">{{ t('plugins.remove.keep') }}</UiButton>
      <UiButton size="sm" variant="danger" :loading="busy === 'remove'" @click="remove">{{ t('plugins.remove.confirm') }}</UiButton>
    </div>

    <dl class="pd__facts">
      <div class="pd__fact">
        <dt>{{ p.source.kind === 'local' ? t('plugins.localFolder') : t('plugins.detail.source') }}</dt>
        <dd class="mono selectable" :title="source">{{ source }}</dd>
      </div>
      <div v-if="p.source.kind === 'git' && p.source.ref" class="pd__fact">
        <dt>{{ t('plugins.branchOrTag') }}</dt>
        <dd class="mono selectable">{{ p.source.ref }}</dd>
      </div>
      <div v-if="p.commit" class="pd__fact">
        <dt>{{ t('plugins.commit') }}</dt>
        <dd class="mono selectable" :title="p.commit">{{ p.commit.slice(0, 10) }}</dd>
      </div>
      <div v-if="p.source.kind === 'git'" class="pd__fact">
        <dt>{{ t('plugins.folder') }}</dt>
        <dd class="mono selectable" :title="p.dir">{{ p.dir }}</dd>
      </div>
      <div class="pd__fact">
        <dt>{{ t('plugins.installed') }}</dt>
        <dd class="tabular">{{ p.updatedAt > p.installedAt + 1000 ? t('plugins.detail.updated', { installed: fmtDate(p.installedAt), updated: fmtDate(p.updatedAt) }) : fmtDate(p.installedAt) }}</dd>
      </div>
      <div v-if="m.minAppVersion" class="pd__fact">
        <dt>{{ t('plugins.detail.needs') }}</dt>
        <dd>{{ t('plugins.detail.needsVersion', { version: m.minAppVersion }) }}</dd>
      </div>
      <div class="pd__fact">
        <dt>{{ t('plugins.detail.adds') }}</dt>
        <dd>{{ contributions || (status === 'active' ? t('plugins.detail.addsNothing') : t('plugins.detail.addsLater')) }}</dd>
      </div>
    </dl>

    <section v-if="m.settings?.length" class="pd__sec" aria-labelledby="pd-settings">
      <h4 id="pd-settings" class="pd__h">{{ t('plugins.detail.settings') }}</h4>
      <PluginSettingsForm :plugin-id="id" :fields="m.settings" />
    </section>

    <section v-if="pages.length" class="pd__sec" aria-labelledby="pd-pages">
      <h4 id="pd-pages" class="pd__h">{{ t('plugins.detail.pages') }}</h4>
      <div class="pd__pages">
        <UiButton v-for="pg in pages" :key="pg.fullId" size="sm" @click="ws.openSettings(`plugin:${pg.fullId}`)">
          <PluginGlyph v-if="pg.icon" :icon="pg.icon" /><Settings2 v-else />{{ pg.title }}
        </UiButton>
      </div>
    </section>

    <section class="pd__sec" aria-labelledby="pd-log">
      <div class="pd__sub">
        <h4 id="pd-log" class="pd__h">{{ t('plugins.detail.log') }}</h4>
        <UiButton size="sm" variant="ghost" :disabled="!log.length" @click="runtime.clearLog(id)">{{ t('plugins.detail.clear') }}</UiButton>
      </div>
      <ol v-if="log.length" class="pd__log selectable" :aria-label="t('plugins.detail.logLines')">
        <li v-for="(l, i) in log" :key="i" class="pd__log-line" :class="`is-${l.level}`">
          <span class="pd__log-time tabular">{{ time(l.at) }}</span>
          <span class="pd__log-level">{{ l.level }}</span>
          <span class="pd__log-text">{{ l.text }}</span>
        </li>
      </ol>
      <i18n-t v-else keypath="plugins.detail.logEmpty" tag="p" scope="global" class="pd__muted">
        <template #code><code>mango.log</code></template>
      </i18n-t>
    </section>
  </div>
  <p v-else class="pd__muted">{{ t('plugins.detail.gone') }}</p>
</template>

<style scoped>
.pd { display: grid; gap: var(--space-4); }
.pd :deep(.btn svg) { width: 14px; height: 14px; }

.pd__head { display: flex; align-items: flex-start; gap: var(--space-3); }
.pd__tile {
  flex: none;
  display: grid;
  place-items: center;
  width: 40px;
  height: 40px;
  border-radius: var(--radius-md);
  background: var(--bg-panel);
  border: 1px solid var(--line-soft);
  color: var(--accent-ink);
}
.pd__tile :deep(.glyph) { width: 20px; height: 20px; }
.pd__title-block { flex: 1; min-width: 0; display: grid; gap: 4px; }
.pd__title-line { display: flex; align-items: baseline; gap: var(--space-2); min-width: 0; }
.pd__title {
  margin: 0;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--text-lg);
  font-weight: 620;
  letter-spacing: -0.01em;
}
.pd__title:focus-visible { outline: none; }
.pd__version { flex: none; font-size: var(--text-sm); color: var(--fg-faint); }
.pd__official { flex: none; display: inline-flex; align-items: center; gap: 3px; font-size: var(--text-xs); font-weight: 540; color: var(--fg-subtle); }
.pd__official svg { width: 13px; height: 13px; stroke-width: 1.85; color: var(--accent-ink); align-self: center; }
.pd__byline { display: flex; align-items: center; gap: var(--space-3); min-width: 0; font-size: var(--text-xs); color: var(--fg-subtle); }
.pd__author { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pd__id { font-family: var(--font-mono); font-size: var(--text-2xs); color: var(--fg-faint); }
.pd__switch { flex: none; display: flex; align-items: center; gap: var(--space-2); margin-top: 4px; }
.pd__switch-label { font-size: var(--text-xs); font-weight: 560; color: var(--fg-subtle); }

.pd__desc { margin: 0; max-width: 64ch; font-size: var(--text-sm); color: var(--fg-muted); text-wrap: pretty; }

.pd__banner {
  display: flex;
  align-items: flex-start;
  gap: var(--space-3);
  padding: var(--space-3);
  border: 1px solid color-mix(in oklch, var(--ripe-error) 45%, transparent);
  border-radius: var(--radius-md);
  background: color-mix(in oklch, var(--ripe-error) 6%, var(--bg-panel));
}
.pd__banner > svg { flex: none; width: 16px; height: 16px; margin-top: 1px; stroke-width: 1.85; color: var(--ripe-error); }
.pd__banner-text { flex: 1; min-width: 0; display: grid; gap: 2px; font-size: var(--text-sm); color: var(--fg-muted); }
.pd__banner-text strong { font-weight: 600; color: var(--ripe-error-fg); }
.pd__banner-text span { overflow-wrap: anywhere; }
.pd__banner.is-warn { border-color: color-mix(in oklch, var(--ripe-waiting) 45%, transparent); background: color-mix(in oklch, var(--ripe-waiting) 6%, var(--bg-panel)); }
.pd__banner.is-warn > svg { color: var(--ripe-waiting); }
.pd__banner.is-warn .pd__banner-text strong { color: var(--ripe-waiting-fg); }

.pd__actions { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-1); }
.pd__remove { margin-left: auto; }
.pd__progress {
  margin: calc(var(--space-2) * -1) 0 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-mono);
  font-size: var(--text-2xs);
  color: var(--fg-subtle);
}
.pd__error {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  margin: calc(var(--space-2) * -1) 0 0;
  font-size: var(--text-sm);
  color: var(--ripe-error-fg);
}
.pd__error svg { flex: none; width: 15px; height: 15px; margin-top: 2px; stroke-width: 1.85; color: var(--ripe-error); }
.pd__notice { margin: calc(var(--space-2) * -1) 0 0; font-size: var(--text-xs); color: var(--fg-subtle); }

.pd__ask {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-2) var(--space-2) var(--space-3);
  border: 1px solid color-mix(in oklch, var(--ripe-error) 35%, transparent);
  border-radius: var(--radius-sm);
  background: color-mix(in oklch, var(--ripe-error) 7%, transparent);
}
.pd__ask-body { flex: 1 1 30ch; display: grid; justify-items: start; gap: var(--space-1); }
.pd__ask-docs { display: flex; align-items: center; gap: var(--space-2); font-size: var(--text-sm); color: var(--fg-muted); cursor: pointer; }
.pd__ask-docs input { flex: none; width: 14px; height: 14px; margin: 0; accent-color: var(--accent); }
.pd__ask-text { margin: 0; font-size: var(--text-sm); color: var(--fg-muted); text-wrap: pretty; }
.pd__ask-text strong { font-weight: 600; color: var(--fg); }

/* ---- facts: label column and value, between soft rules ---- */
.pd__facts {
  display: grid;
  margin: 0;
  border-top: 1px solid var(--line-soft);
  border-bottom: 1px solid var(--line-soft);
  padding: var(--space-2) 0;
}
.pd__fact {
  display: grid;
  grid-template-columns: 120px minmax(0, 1fr);
  gap: var(--space-3);
  align-items: baseline;
  min-height: 26px;
  padding: 3px 0;
}
.pd__fact dt { font-size: var(--text-xs); color: var(--fg-subtle); }
.pd__fact dd { margin: 0; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--text-sm); color: var(--fg-muted); }
.pd__fact dd.mono { font-family: var(--font-mono); font-size: var(--text-xs); }

.pd__sec { display: grid; gap: var(--space-2); margin-top: var(--space-2); }
.pd__sub { display: flex; align-items: center; justify-content: space-between; gap: var(--space-2); }
.pd__h { margin: 0; font-size: var(--text-sm); font-weight: 600; color: var(--fg); }
.pd__pages { display: flex; flex-wrap: wrap; gap: var(--space-2); }
.pd__pages :deep(.glyph) { width: 14px; height: 14px; }
.pd__muted { margin: 0; font-size: var(--text-sm); color: var(--fg-subtle); }
.pd__muted code { font-family: var(--font-mono); font-size: var(--text-xs); color: var(--fg-muted); }

/* ---- log: the plugin's own lines, newest last ---- */
.pd__log {
  margin: 0;
  padding: var(--space-2) 0;
  list-style: none;
  max-height: 280px;
  overflow: auto;
  background: var(--bg-inset);
  border: 1px solid var(--line-soft);
  border-radius: var(--radius-md);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  line-height: 1.55;
}
.pd__log-line { display: grid; grid-template-columns: auto 5ch minmax(0, 1fr); gap: var(--space-3); padding: 0 var(--space-3); }
.pd__log-time { color: var(--fg-faint); }
.pd__log-level { color: var(--fg-subtle); }
.pd__log-text { color: var(--fg-muted); white-space: pre-wrap; overflow-wrap: anywhere; }
.pd__log-line.is-warn .pd__log-level, .pd__log-line.is-warn .pd__log-text { color: var(--ripe-waiting-fg); }
.pd__log-line.is-error .pd__log-level, .pd__log-line.is-error .pd__log-text { color: var(--ripe-error-fg); }
</style>
