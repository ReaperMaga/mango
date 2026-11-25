import { defineStore } from 'pinia'
import type { InstalledPlugin, PluginCatalogResult, PluginProbe, PluginSource, PluginUpdateInfo } from '~/types/ipc'
import { builtInPluginNote } from '~/utils/builtIns'
import { call, onWindows, postWindows } from '~/composables/useBackend'

/**
 * Installed plugins as the backend keeps them (`plugins.json` in the app data folder, see
 * src-tauri/src/plugins.rs), the official catalog, and each plugin's settings values.
 *
 * This store only manages: what runs, and how, is `app/plugin-host/runtime.ts` (`usePluginRuntime`),
 * which watches `enabled` here and (re)activates plugins when it changes.
 *
 * Settings values are not secrets and live in localStorage (`mango.plugins.settings.v1`), one object
 * per plugin id; defaults come from the manifest and are not stored.
 */

const SETTINGS_KEY = 'mango.plugins.settings.v1'

function loadSettings(): Record<string, Record<string, unknown>> {
  try {
    const raw = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}')
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  } catch {
    return {}
  }
}

/**
 * Other windows: after a change here (install, switch, remove, update, a setting), every other window
 * reads the list and the settings again ( over ; stores/windows.ts ignores it).
 */
const WINDOW_INST = Math.random().toString(36).slice(2)
let listening = false
let announceTimer: ReturnType<typeof setTimeout> | undefined
function announce() {
  clearTimeout(announceTimer)
  announceTimer = setTimeout(() => { void postWindows({ t: 'plugins', inst: WINDOW_INST }).catch(() => {}) }, 50)
}

let jobSeq = 0
export const pluginJobId = () => `plugin-${Date.now().toString(36)}-${++jobSeq}`

export const usePlugins = defineStore('plugins', {
  state: () => ({
    installed: [] as InstalledPlugin[],
    loaded: false,
    loading: false,
    loadError: null as string | null,
    /** Last update check, by plugin id. */
    updates: {} as Record<string, PluginUpdateInfo>,
    catalog: null as PluginCatalogResult | null,
    catalogLoading: false,
    catalogError: null as string | null,
    settingsValues: loadSettings(),
    /** Bumped on every change so other windows and the runtime can react. */
    revision: 0,
  }),

  getters: {
    byId: s => (id: string) => s.installed.find(p => p.manifest.id === id) ?? null,
    enabled: s => s.installed.filter(p => p.enabled),
    /** A setting's value: what the user set, else the manifest default. */
    setting: s => (id: string, key: string): unknown => {
      const own = s.settingsValues[id]
      if (own && key in own) return own[key]
      const plugin = s.installed.find(p => p.manifest.id === id)
      return plugin?.manifest.settings?.find(f => f.key === key)?.default
    },
    updateCount: s => Object.values(s.updates).filter(u => u.hasUpdate).length,
  },

  actions: {
    async load(force = false) {
      this._listen()
      if ((this.loaded && !force) || this.loading) return
      this.loading = true
      try {
        this.installed = await call('plugins_list', {})
        this.loaded = true
        this.loadError = null
      } catch (e) {
        this.loadError = e instanceof Error ? e.message : String(e)
      } finally {
        this.loading = false
      }
    },

    /** Follow changes made in Mango's other windows (once per window). */
    _listen() {
      if (listening) return
      listening = true
      void onWindows((m) => {
        const msg = m as { t?: string; inst?: string } | null
        if (msg?.t !== 'plugins' || msg.inst === WINDOW_INST) return
        this.settingsValues = loadSettings()
        const again = () => { if (this.loading) setTimeout(again, 150); else void this.load(true) }
        again()
      })
    },

    _put(plugin: InstalledPlugin) {
      const at = this.installed.findIndex(p => p.manifest.id === plugin.manifest.id)
      if (at >= 0) this.installed[at] = plugin
      else this.installed.push(plugin)
      this.revision++
      announce()
    },

    /** Clone a git source and list the plugins in it (nothing installed yet). */
    probe(source: Extract<PluginSource, { kind: 'git' }>, jobId = pluginJobId()): Promise<PluginProbe> {
      return call('plugins_probe', { source, jobId })
    },

    async install(probeId: string, subpaths: string[]): Promise<InstalledPlugin[]> {
      const added = await call('plugins_install', { probeId, subpaths })
      for (const p of added) {
        this._put(p)
        delete this.updates[p.manifest.id]
      }
      return added
    },

    async addLocal(path: string): Promise<InstalledPlugin> {
      const plugin = await call('plugins_add_local', { path })
      this._put(plugin)
      return plugin
    },

    async setEnabled(id: string, enabled: boolean) {
      this._put(await call('plugins_set_enabled', { id, enabled }))
    },

    /** How many documents a plugin saved (`mango.data`); 0 when that cannot be told: they are kept then. */
    async documentCount(id: string): Promise<number> {
      try { return await call('plugin_data_count', { pluginId: id }) } catch { return 0 }
    },

    /** Its documents stay, for when it is installed again, unless `deleteDocuments`. */
    async remove(id: string, deleteDocuments = false) {
      await call('plugins_remove', { id })
      let failed: unknown = null
      if (deleteDocuments) {
        try { await call('plugin_data_clear', { pluginId: id }) } catch (e) { failed = e }
      }
      this.installed = this.installed.filter(p => p.manifest.id !== id)
      delete this.updates[id]
      delete this.settingsValues[id]
      this._saveSettings()
      try {
        // The plugin's private storage (`mango.storage` in the API).
        const prefix = `mango.plugin.${id}.`
        for (const k of Object.keys(localStorage)) if (k.startsWith(prefix)) localStorage.removeItem(k)
      } catch { /* nothing stored */ }
      this.revision++
      announce()
      if (failed) throw failed
    },

    async checkUpdates(ids: string[] | null = null, jobId = pluginJobId()): Promise<PluginUpdateInfo[]> {
      // A plugin that is part of Mango now left the repository: it has nothing to update to.
      const infos = (await call('plugins_check_updates', { ids, jobId })).filter(u => !builtInPluginNote(u.id))
      for (const u of infos) this.updates[u.id] = u
      return infos
    },

    async update(id: string, jobId = pluginJobId()): Promise<InstalledPlugin> {
      const plugin = await call('plugins_update', { id, jobId })
      this._put(plugin)
      delete this.updates[id]
      return plugin
    },

    async loadCatalog(force = false) {
      if (this.catalogLoading) return
      if (this.catalog && !force) return
      this.catalogLoading = true
      try {
        const result = await call('plugins_catalog', { force })
        // A saved copy may still list one that is built in now.
        const plugins = result.catalog.plugins.filter(p => !builtInPluginNote(p.id))
        this.catalog = { ...result, catalog: { ...result.catalog, plugins } }
        this.catalogError = null
      } catch (e) {
        this.catalogError = e instanceof Error ? e.message : String(e)
      } finally {
        this.catalogLoading = false
      }
    },

    setSetting(id: string, key: string, value: unknown) {
      this.settingsValues[id] = { ...(this.settingsValues[id] ?? {}), [key]: value }
      this._saveSettings()
    },

    /** Back to the manifest default for one setting. */
    clearSetting(id: string, key: string) {
      const own = { ...(this.settingsValues[id] ?? {}) }
      if (!(key in own)) return
      delete own[key]
      if (Object.keys(own).length) this.settingsValues[id] = own
      else delete this.settingsValues[id]
      this._saveSettings()
    },

    resetSettings(id: string) {
      delete this.settingsValues[id]
      this._saveSettings()
    },

    _saveSettings() {
      try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(this.settingsValues)) } catch { /* not persisted */ }
      announce()
    },
  },
})
