<script setup lang="ts">
import { BadgeCheck, Check, ChevronRight, CircleAlert, RefreshCw, Search, X } from 'lucide-vue-next'
import type { PluginCatalogEntry } from '~/types/ipc'
import { usePlugins } from '~/stores/plugins'
import { catalogTags, filterCatalog, type CatalogOrigin, type CatalogState } from '~/utils/pluginCatalog'
import { agoText, dismissJob, installFromCatalog, jobLabel, openPlugins, updatePlugin, usePluginsView } from '~/composables/pluginsView'
import SettingsSegmented from '~/components/settings/SettingsSegmented.vue'
import SettingsSelect from '~/components/settings/SettingsSelect.vue'
import PluginGlyph from './PluginGlyph.vue'

/**
 * Settings > Plugins > Browse: the official catalog (`plugins/catalog.json` in Mango's repository),
 * searchable and filtered by origin, installed state and tag. Install is one click: the entry's source
 * is checked, then the plugin with the entry's id is installed and switched on.
 */
const plugins = usePlugins()
const view = usePluginsView()

onMounted(() => { void plugins.loadCatalog() })

const text = ref('')
const origin = ref<CatalogOrigin>('all')
const stateFilter = ref<CatalogState>('any')
const tag = ref<string | null>(null)

const entries = computed(() => plugins.catalog?.catalog.plugins ?? [])
const tags = computed(() => catalogTags(entries.value))
const shown = computed(() => filterCatalog(
  entries.value,
  { text: text.value, origin: origin.value, state: stateFilter.value, tag: tag.value },
  id => !!plugins.byId(id),
))
const filtered = computed(() => !!text.value.trim() || origin.value !== 'all' || stateFilter.value !== 'any' || !!tag.value)

function clearFilters() {
  text.value = ''
  origin.value = 'all'
  stateFilter.value = 'any'
  tag.value = null
}
function pickTag(t: string | null) {
  tag.value = tag.value === t ? null : t
}

const installed = (e: PluginCatalogEntry) => plugins.byId(e.id)
/** Installed, and the catalog (or the last update check) has something newer. */
function canUpdate(e: PluginCatalogEntry) {
  const p = installed(e)
  if (!p || p.source.kind !== 'git') return false
  return plugins.updates[e.id]?.hasUpdate || p.manifest.version !== e.version
}

const fetched = computed(() => (plugins.catalog ? agoText(plugins.catalog.fetchedAt) : ''))
const searchEl = ref<HTMLInputElement | null>(null)
function onSearchKey(e: KeyboardEvent) {
  if (e.key === 'Escape' && text.value) {
    e.stopPropagation()
    e.preventDefault()
    text.value = ''
  }
}
</script>

<template>
  <div class="pb">
    <div class="pb__bar">
      <label class="pb__search">
        <Search aria-hidden="true" />
        <input
          ref="searchEl"
          v-model="text"
          type="search"
          class="pb__input"
          placeholder="Search plugins"
          aria-label="Search plugins"
          spellcheck="false"
          autocomplete="off"
          @keydown="onSearchKey"
        >
        <UiIconButton v-if="text" size="sm" label="Clear search" class="pb__clear" @click="text = ''; searchEl?.focus()"><X /></UiIconButton>
      </label>
      <SettingsSegmented
        v-model="origin"
        label="Who maintains it"
        :options="[{ value: 'all', label: 'All' }, { value: 'official', label: 'Official' }, { value: 'community', label: 'Community' }]"
      />
      <SettingsSelect
        v-model="stateFilter"
        label="Installed or not"
        :options="[{ value: 'any', label: 'Any state' }, { value: 'installed', label: 'Installed' }, { value: 'available', label: 'Not installed' }]"
      />
      <UiIconButton label="Refresh the catalog" :disabled="plugins.catalogLoading" @click="plugins.loadCatalog(true)">
        <RefreshCw :class="{ spin: plugins.catalogLoading }" />
      </UiIconButton>
    </div>

    <div v-if="tags.length" class="pb__tags" role="group" aria-label="Filter by tag">
      <button type="button" class="chip" :aria-pressed="tag === null" @click="tag = null">All tags</button>
      <button v-for="t in tags" :key="t" type="button" class="chip" :aria-pressed="tag === t" @click="pickTag(t)">{{ t }}</button>
    </div>

    <p v-if="plugins.catalog?.stale" class="pb__note" role="status">
      Showing a saved copy from {{ fetched }}: {{ plugins.catalog.stale }}
    </p>

    <!-- loading the first time: the rows' shape, not a spinner -->
    <div v-if="!plugins.catalog && plugins.catalogLoading" class="pb__list" aria-busy="true" aria-label="Loading the catalog">
      <div v-for="n in 3" :key="n" class="row row--skeleton">
        <span class="row__tile" />
        <div class="row__text"><span class="sk sk--name" /><span class="sk sk--line" /><span class="sk sk--short" /></div>
      </div>
    </div>

    <div v-else-if="!plugins.catalog && plugins.catalogError" class="pb__empty">
      <p class="pb__error selectable" role="alert"><CircleAlert aria-hidden="true" />The catalog could not be loaded. {{ plugins.catalogError }}</p>
      <div class="pb__empty-actions">
        <UiButton size="sm" @click="plugins.loadCatalog(true)">Try again</UiButton>
        <UiButton size="sm" variant="ghost" @click="openPlugins({ add: true })">Add from a link</UiButton>
      </div>
    </div>

    <ul v-else-if="shown.length" class="pb__list" aria-label="Plugins in the catalog">
      <li v-for="e in shown" :key="e.id" class="row" :class="{ 'is-installed': !!installed(e) }">
        <span class="row__tile"><PluginGlyph :icon="e.icon" /></span>
        <div class="row__text">
          <div class="row__line">
            <button v-if="installed(e)" type="button" class="row__name row__name--link" :title="`${e.name}: details`" @click="openPlugins({ detail: e.id })">{{ e.name }}</button>
            <span v-else class="row__name" :title="e.name">{{ e.name }}</span>
            <span v-if="e.official" class="row__official" title="Maintained in Mango's repository"><BadgeCheck aria-hidden="true" />Official</span>
            <span class="row__meta tabular">{{ e.version }}<template v-if="e.author"> · {{ e.author }}</template></span>
          </div>
          <p class="row__desc" :title="e.description">{{ e.description }}</p>
          <div v-if="e.tags.length" class="row__tags">
            <button
              v-for="t in e.tags"
              :key="t"
              type="button"
              class="row__tag"
              :class="{ 'is-on': tag === t.toLowerCase() }"
              :title="`Show plugins tagged ${t}`"
              @click="pickTag(t.toLowerCase())"
            >
              {{ t }}
            </button>
          </div>
          <p v-if="view.jobs[e.id]?.error" class="row__error selectable" role="alert">
            <CircleAlert aria-hidden="true" /><span>{{ view.jobs[e.id]!.error }}</span>
            <UiIconButton size="sm" label="Dismiss" @click="dismissJob(e.id)"><X /></UiIconButton>
          </p>
          <p v-else-if="view.jobs[e.id]" class="row__progress selectable" aria-live="polite">{{ view.jobs[e.id]!.line || jobLabel(view.jobs[e.id]!) }}</p>
        </div>
        <div class="row__action">
          <UiButton v-if="view.jobs[e.id] && !view.jobs[e.id]!.error" size="sm" loading>{{ jobLabel(view.jobs[e.id]!) }}</UiButton>
          <UiButton v-else-if="canUpdate(e)" size="sm" @click="updatePlugin(e.id)">Update</UiButton>
          <template v-else-if="installed(e)">
            <span class="row__done"><Check aria-hidden="true" />Installed</span>
            <UiIconButton size="sm" :label="`${e.name}: details`" @click="openPlugins({ detail: e.id })"><ChevronRight /></UiIconButton>
          </template>
          <UiButton v-else size="sm" :title="`Install ${e.name}`" @click="installFromCatalog(e)">Install</UiButton>
        </div>
      </li>
    </ul>

    <div v-else-if="plugins.catalog" class="pb__empty">
      <p v-if="filtered" class="pb__empty-text">
        No plugin matches<template v-if="text.trim()"> “{{ text.trim() }}”</template><template v-if="filtered && (tag || origin !== 'all' || stateFilter !== 'any')"> with these filters</template>.
      </p>
      <p v-else class="pb__empty-text">The catalog has no plugins yet.</p>
      <div class="pb__empty-actions">
        <UiButton v-if="filtered" size="sm" @click="clearFilters">Clear filters</UiButton>
        <UiButton size="sm" variant="ghost" @click="openPlugins({ add: true })">Add from a link</UiButton>
      </div>
    </div>

    <p v-if="plugins.catalog && shown.length" class="pb__foot">
      A plugin that isn't listed can be added from its repository:
      <button type="button" class="pb__link" @click="openPlugins({ add: true })">Add from a link</button>.
      Updated {{ fetched }}.
    </p>
  </div>
</template>

<style scoped>
.pb { display: grid; gap: var(--space-3); }

/* ---- search and filters ---- */
.pb__bar { display: flex; align-items: center; gap: var(--space-2); min-width: 0; }
.pb__search {
  position: relative;
  flex: 1 1 180px;
  min-width: 140px;
  display: flex;
  align-items: center;
}
.pb__search > svg {
  position: absolute;
  left: 9px;
  width: 14px;
  height: 14px;
  stroke-width: 1.85;
  color: var(--fg-faint);
  pointer-events: none;
}
.pb__input {
  width: 100%;
  height: 30px;
  padding: 0 30px 0 30px;
  background: var(--bg-inset);
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  font-size: var(--text-sm);
  transition: border-color var(--dur-fast) var(--ease-out), box-shadow var(--dur-fast) var(--ease-out);
}
.pb__input::placeholder { color: var(--fg-faint); }
.pb__input::-webkit-search-cancel-button { display: none; }
.pb__input:focus-visible { outline: none; }
.pb__input:focus { border-color: var(--accent-line); box-shadow: 0 0 0 3px var(--accent-soft); }
.pb__clear { position: absolute; right: 4px; }
.spin { animation: spin 0.9s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }

.pb__tags { display: flex; flex-wrap: wrap; gap: var(--space-1); }
.chip {
  height: 22px;
  padding: 0 var(--space-2);
  font-size: var(--text-xs);
  font-weight: 540;
  color: var(--fg-subtle);
  border: 1px solid var(--line-soft);
  border-radius: var(--radius-pill);
  transition: background var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out), border-color var(--dur-fast) var(--ease-out);
}
.chip:hover { background: var(--bg-hover); color: var(--fg); }
.chip[aria-pressed='true'] { background: var(--bg-active); border-color: var(--line-strong); color: var(--fg); }

.pb__note { margin: 0; font-size: var(--text-xs); color: var(--ripe-waiting-fg); }

/* ---- the list ---- */
.pb__list {
  margin: 0;
  padding: 0;
  list-style: none;
  border: 1px solid var(--line-soft);
  border-radius: var(--radius-md);
  background: var(--bg-panel);
}
.pb__list > * + * { border-top: 1px solid var(--line-soft); }
.row {
  display: flex;
  align-items: flex-start;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-3) var(--space-3) var(--space-4);
}
.row__tile {
  flex: none;
  display: grid;
  place-items: center;
  width: 32px;
  height: 32px;
  margin-top: 1px;
  border-radius: var(--radius-sm);
  background: var(--bg-inset);
  border: 1px solid var(--line-soft);
  color: var(--fg-muted);
}
.row.is-installed .row__tile { color: var(--accent-ink); }
.row__text { flex: 1; min-width: 0; display: grid; gap: 3px; }
.row__line { display: flex; align-items: center; gap: var(--space-2); min-width: 0; }
.row__name {
  flex: none;
  max-width: 50%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--text-sm);
  font-weight: 600;
  color: var(--fg);
  text-align: left;
}
.row__name--link { border-radius: var(--radius-xs); }
.row__name--link:hover { text-decoration: underline; text-underline-offset: 3px; text-decoration-color: var(--line-strong); }
.row__official {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-size: var(--text-xs);
  font-weight: 540;
  color: var(--fg-subtle);
}
.row__official svg { width: 13px; height: 13px; stroke-width: 1.85; color: var(--accent-ink); align-self: center; }
.row__meta {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--text-xs);
  color: var(--fg-faint);
}
.row__desc {
  margin: 0;
  font-size: var(--text-sm);
  color: var(--fg-muted);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  text-wrap: pretty;
}
.row__tags { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 2px; }
.row__tag {
  height: 18px;
  padding: 0 6px;
  font-size: var(--text-2xs);
  font-weight: 540;
  color: var(--fg-subtle);
  background: var(--bg-hover);
  border-radius: var(--radius-xs);
  transition: color var(--dur-fast) var(--ease-out), background var(--dur-fast) var(--ease-out);
}
.row__tag:hover, .row__tag.is-on { color: var(--fg); background: var(--bg-active); }
.row__action { flex: none; display: flex; align-items: center; gap: 2px; min-height: 32px; }
.row__done {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 0 var(--space-1);
  font-size: var(--text-xs);
  font-weight: 560;
  color: var(--fg-subtle);
}
.row__done svg { width: 13px; height: 13px; stroke-width: 2; color: var(--ripe-done); }
.row__progress {
  margin: 2px 0 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-mono);
  font-size: var(--text-2xs);
  color: var(--fg-subtle);
}
.row__error {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  margin: 4px 0 0;
  font-size: var(--text-xs);
  color: var(--ripe-error-fg);
}
.row__error > svg { flex: none; width: 14px; height: 14px; margin-top: 1px; stroke-width: 1.85; color: var(--ripe-error); }
.row__error > span { flex: 1; min-width: 0; text-wrap: pretty; }

.row--skeleton { pointer-events: none; }
.sk { display: block; height: 10px; border-radius: var(--radius-xs); background: var(--bg-hover); }
.sk--name { width: 28%; height: 12px; }
.sk--line { width: 82%; margin-top: 4px; }
.sk--short { width: 46%; }

/* ---- empty, error, foot ---- */
.pb__empty { display: grid; justify-items: start; gap: var(--space-3); padding: var(--space-4) 0; }
.pb__empty-text { margin: 0; font-size: var(--text-sm); color: var(--fg-subtle); }
.pb__empty-actions { display: flex; gap: var(--space-2); }
.pb__error {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  margin: 0;
  font-size: var(--text-sm);
  color: var(--ripe-error-fg);
}
.pb__error svg { flex: none; width: 15px; height: 15px; margin-top: 2px; stroke-width: 1.85; color: var(--ripe-error); }
.pb__foot { margin: var(--space-1) 0 0; font-size: var(--text-xs); color: var(--fg-subtle); }
.pb__link {
  font-size: inherit;
  color: var(--accent-ink);
  text-decoration: underline;
  text-underline-offset: 3px;
  text-decoration-color: var(--accent-line);
  border-radius: var(--radius-xs);
}
.pb__link:hover { text-decoration-color: currentColor; }

@media (prefers-reduced-motion: reduce) {
  .spin { animation: none; }
}
</style>
