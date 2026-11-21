import { defineStore, getActivePinia, type Pinia } from 'pinia'
import { markRaw, watch, type App } from 'vue'
import type { InstalledPlugin } from '~/types/ipc'
import type { MangoPluginModule, PluginLogLine, PluginRunState, PluginSettingsPage } from '~/plugin-host/types'
import { DisposableScope } from './scope'
import { incompatibility } from './semver'
import { capped, logText } from './hooks'
import { createApi } from './api'
import { emitStatusChange, hooks, pluginNames, pluginTabs, setReporter } from './registry'
import { dropPluginLayers } from './uiState'
import { parsePluginTab } from './ids'
import { usePlugins } from '~/stores/plugins'
import { useThreads } from '~/stores/threads'
import { useWorkspace } from '~/stores/workspace'
import { call, onWindows, postWindows, windowLabel } from '~/composables/useBackend'

/**
 * The plugin runtime: loads each enabled plugin's entry module, calls `activate` with its API object,
 * keeps what it registered, and undoes it all when the plugin is disabled, reloaded or removed.
 *
 * Safe mode: a marker in localStorage is set while plugins start and cleared a few seconds after.
 * Found at the next start (the last one never got that far: a plugin may have hung or crashed the
 * window), plugins stay paused until `resume()`. `?safe-mode` in the address does the same.
 */

const BOOT_KEY = 'mango.plugins.booting'
/** How long after starting the plugins the start counts as having gone well. */
const SETTLE_MS = 4000
const LOG_MAX = 300
const WINDOWS_KIND = 'mango.plugins.changed'

/** A plugin that is running (or starting) in this window. Not reactive: the store holds what the UI reads. */
interface Instance {
  info: InstalledPlugin
  scope: DisposableScope
  module: Partial<MangoPluginModule> | null
  /** What `updatedAt` etc. said when it was activated: a change means reload. */
  signature: string
}

/*
 * Kept on `globalThis` so a hot reload of this module in `pnpm dev` does not forget what is running
 * (the registry keeps its entries; a fresh map here would leave them behind, never undone).
 */
const kept = ((globalThis as { __mangoPluginHost?: { instances: Map<string, Instance>; jobs: Map<string, Promise<void>>; failedWith: Map<string, string> } })
  .__mangoPluginHost ??= { instances: new Map(), jobs: new Map(), failedWith: new Map() })
const instances = kept.instances
/** One job at a time per plugin (activate, deactivate, reload), in order. */
const jobs = kept.jobs
let started = false
let appRef: App | null = null
let versionRef = '0.0.0'
/** This window's last-seen revision of the plugin list that it announced to the others. */
const windowId = `${windowLabel() ?? 'preview'}-${Math.random().toString(36).slice(2, 8)}`

const signatureOf = (p: InstalledPlugin) =>
  [p.dir, p.updatedAt, p.installedAt, p.commit, p.manifest.version, p.manifest.main, p.manifest.styles, p.manifest.minAppVersion].join('\u0001')

const emptyState = (): PluginRunState => ({ status: 'disabled', error: null, activatedAt: null, contributions: {} })

export const usePluginRuntime = defineStore('pluginRuntime', {
  state: () => ({
    /** By plugin id. A plugin missing here has not been looked at yet. */
    states: {} as Record<string, PluginRunState>,
    /** Last lines of each plugin's log (newest last), by plugin id. */
    logs: {} as Record<string, PluginLogLine[]>,
    /**
     * Started with plugins paused: the previous start did not finish (a plugin may have broken it).
     * Settings > Plugins shows a banner with "Resume plugins" (`resume()`).
     */
    safeMode: false,
    /** Settings pages plugins registered, shown in the Settings rail under "Plugins". Full id `<pluginId>.<pageId>`. */
    settingsPages: [] as Array<PluginSettingsPage & { pluginId: string; fullId: string }>,
    /** The first sync after start has finished (every enabled plugin activated or failed). */
    ready: false,
  }),

  actions: {
    /**
     * Load the installed list and activate the enabled plugins (once, at app start). `app` and the
     * version come from the caller (app.vue), which runs inside Nuxt.
     */
    async start(opts: { app?: App; version?: string } = {}) {
      if (started) return
      started = true
      if (opts.app) appRef = opts.app
      if (opts.version) versionRef = opts.version
      setReporter((pluginId, e, where) => this.log(pluginId, 'error', [`${where}:`, e]))

      let crashed = false
      try {
        crashed = !!localStorage.getItem(BOOT_KEY)
      } catch { /* no storage: no safe mode */ }
      const asked = typeof location !== 'undefined' && /[?&]safe-mode(?:[=&]|$)/.test(location.search)
      this.safeMode = crashed || asked

      const plugins = usePlugins()
      await plugins.load()
      // Changes made here, or in another window (which says so), reach the running plugins.
      watch(() => plugins.installed.map(p => `${p.manifest.id}:${p.enabled}:${signatureOf(p)}`).join('\n'), () => { void this.sync() })
      watch(() => plugins.revision, () => { void postWindows({ kind: WINDOWS_KIND, from: windowId }).catch(() => {}) })
      void onWindows((m) => {
        const msg = m as { kind?: string; from?: string } | null
        if (msg?.kind === WINDOWS_KIND && msg.from !== windowId) void plugins.load(true)
      })
      // Settings values written by another window.
      window.addEventListener('storage', (e) => {
        if (e.key === 'mango.plugins.settings.v1') {
          try { plugins.settingsValues = JSON.parse(e.newValue ?? '{}') ?? {} } catch { /* keep ours */ }
        }
      })
      watchStatuses()

      if (!this.safeMode) {
        try { localStorage.setItem(BOOT_KEY, String(Date.now())) } catch { /* not kept */ }
      }
      await this.sync()
      this.ready = true
      if (!this.safeMode) setTimeout(() => { try { localStorage.removeItem(BOOT_KEY) } catch { /* gone anyway */ } }, SETTLE_MS)
    },

    /** Deactivate and activate one plugin again, reading its files afresh. */
    async reload(id: string) {
      const info = usePlugins().byId(id)
      await queue(id, async () => {
        await this._deactivate(id)
        if (info?.enabled && !this.safeMode) await this._activate(info)
        else this._setStatus(id, info?.enabled ? 'paused' : 'disabled')
      })
    },

    /** Leave safe mode and activate the enabled plugins. */
    async resume() {
      if (!this.safeMode) return
      this.safeMode = false
      try { localStorage.setItem(BOOT_KEY, String(Date.now())) } catch { /* not kept */ }
      await this.sync()
      setTimeout(() => { try { localStorage.removeItem(BOOT_KEY) } catch { /* gone anyway */ } }, SETTLE_MS)
    },

    clearLog(id: string) { this.logs[id] = [] },

    /** A line in a plugin's log (also in the console). */
    log(id: string, level: PluginLogLine['level'], args: unknown[]) {
      const text = logText(args)
      capped(this.logs[id] ??= [], { at: Date.now(), level, text }, LOG_MAX)
      const out = level === 'error' ? console.error : level === 'warn' ? console.warn : console.info
      out(`[plugin ${id}]`, ...args)
    },

    /** Bring the running plugins in line with the installed list: what should run runs, what should not stops. */
    async sync() {
      const installed = usePlugins().installed
      const ids = new Set(installed.map(p => p.manifest.id))
      const work: Promise<void>[] = []
      for (const p of installed) {
        const id = p.manifest.id
        pluginNames[id] = p.manifest.name || id
        const running = instances.get(id)
        if (!p.enabled) {
          if (running) work.push(queue(id, () => this._deactivate(id, true)))
          this._setStatus(id, 'disabled')
          continue
        }
        if (this.safeMode) {
          if (!running) this._setStatus(id, 'paused')
          continue
        }
        if (!running) {
          const st = this.states[id]?.status
          // Failed with these very files: wait for a change or a Reload.
          if ((st === 'error' || st === 'incompatible') && failedWith.get(id) === signatureOf(p)) continue
          if (st === 'loading') continue
          work.push(queue(id, () => this._activate(p)))
        } else if (running.signature !== signatureOf(p)) {
          work.push(queue(id, async () => { await this._deactivate(id); await this._activate(p) }))
        }
      }
      // Removed: everything it did goes, and so does what this window knew of it.
      for (const id of [...instances.keys()]) if (!ids.has(id)) work.push(queue(id, () => this._deactivate(id, true)))
      for (const id of Object.keys(this.states)) {
        if (ids.has(id)) continue
        delete this.states[id]
        delete this.logs[id]
        delete pluginNames[id]
      }
      await Promise.all(work)
    },

    _setStatus(id: string, status: PluginRunState['status'], error: string | null = null) {
      const st = this.states[id] ?? (this.states[id] = emptyState())
      st.status = status
      st.error = error
      if (status !== 'active') st.activatedAt = null
    },

    async _activate(info: InstalledPlugin) {
      const id = info.manifest.id
      const latest = usePlugins().byId(id) ?? info
      if (!latest.enabled || this.safeMode) return
      failedWith.delete(id)
      const why = incompatibility(versionRef, latest.manifest.minAppVersion)
      if (why) {
        this._setStatus(id, 'incompatible', why)
        failedWith.set(id, signatureOf(latest))
        this.log(id, 'warn', [why])
        return
      }
      this._setStatus(id, 'loading')
      const st = this.states[id]!
      st.contributions = {}
      const scope = new DisposableScope(e => this.log(id, 'error', ['While undoing:', e]))
      const inst: Instance = { info: latest, scope, module: null, signature: signatureOf(latest) }
      instances.set(id, inst)
      try {
        const main = latest.manifest.main || 'main.js'
        const code = await call('plugins_read', { id, path: main })
        if (latest.manifest.styles) {
          const css = await call('plugins_read', { id, path: latest.manifest.styles })
          const el = document.createElement('style')
          el.dataset.plugin = id
          el.dataset.pluginKind = 'manifest'
          el.textContent = css
          document.head.appendChild(el)
          scope.add(() => el.remove())
        }
        const mod = await importModule(code, id, main)
        const module = pickModule(mod)
        if (!module) throw new Error(`${main} exports no activate function (export function activate(mango) {…}, or a default object with one).`)
        inst.module = module
        const api = createApi({
          info: latest,
          scope,
          app: appRef ?? ({} as App),
          pinia: (getActivePinia() ?? {}) as Pinia,
          version: versionRef,
          log: (level, args) => this.log(id, level, args),
          count: (kind, delta) => {
            const c = this.states[id]?.contributions
            if (!c) return
            const n = (c[kind] ?? 0) + delta
            if (n > 0) c[kind] = n
            else delete c[kind]
          },
          settingsPages: this.settingsPages,
        })
        const undo = await module.activate!(api)
        if (typeof undo === 'function') scope.add(undo)
        if (scope.disposed || instances.get(id) !== inst) return
        this._setStatus(id, 'active')
        st.activatedAt = Date.now()
        this.log(id, 'info', [`Activated ${latest.manifest.name} ${latest.manifest.version}.`])
      } catch (e) {
        this.log(id, 'error', ['Could not activate:', e])
        failedWith.set(id, signatureOf(latest))
        if (instances.get(id) === inst) {
          instances.delete(id)
          scope.dispose()
          afterGone(id)
        }
        this._setStatus(id, 'error', e instanceof Error ? e.message : String(e))
      }
    },

    async _deactivate(id: string, final = false) {
      const inst = instances.get(id)
      if (!inst) return
      instances.delete(id)
      if (inst.module?.deactivate) {
        try {
          await Promise.race([
            Promise.resolve(inst.module.deactivate()),
            new Promise((_, reject) => setTimeout(() => reject(new Error('deactivate took longer than 5 s; went on without it.')), 5000)),
          ])
        } catch (e) {
          this.log(id, 'error', ['deactivate:', e])
        }
      }
      inst.scope.dispose()
      afterGone(id, final)
      const st = this.states[id]
      if (st) {
        st.contributions = {}
        if (st.status === 'active' || st.status === 'loading') this._setStatus(id, 'disabled')
      }
    },
  },
})

/** Plugins whose activation failed, with the files it failed with (by signature). */
const failedWith = kept.failedWith

function queue(id: string, job: () => Promise<void>): Promise<void> {
  const prev = jobs.get(id) ?? Promise.resolve()
  const next = prev.catch(() => {}).then(job).catch((e: unknown) => { console.error(`[plugin ${id}]`, e) })
  jobs.set(id, next)
  void next.finally(() => { if (jobs.get(id) === next) jobs.delete(id) })
  return next
}

/** What a plugin left that is not in its scope: toasts and dialogs; and when it is gone for good, its tabs. */
function afterGone(id: string, final = false) {
  dropPluginLayers(id)
  if (!final) return
  const threads = useThreads()
  for (const tab of [...threads.tabs]) {
    if (parsePluginTab(tab)?.pluginId === id) threads.closeTab(tab)
  }
  for (const tabId of Object.keys(pluginTabs)) if (parsePluginTab(tabId)?.pluginId === id) delete pluginTabs[tabId]
  // A colour scheme of a plugin the user turned off: Mango's own from now on.
  const ws = useWorkspace()
  if (ws.scheme.startsWith(`plugin:${id}.`)) ws.setScheme('mango')
}

/**
 * The entry module from its text: a blob URL imported as an ES module. The `sourceURL` names it in
 * stack traces and the devtools.
 */
async function importModule(code: string, id: string, main: string): Promise<Record<string, unknown>> {
  const src = `${code}\n//# sourceURL=mango-plugin://${encodeURIComponent(id)}/${main.replace(/[^\w./-]/g, '_')}\n`
  const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }))
  try {
    return await import(/* @vite-ignore */ url) as Record<string, unknown>
  } finally {
    URL.revokeObjectURL(url)
  }
}

/** `activate` / `deactivate` as named exports, on a default object, or a default function that is `activate`. */
function pickModule(mod: Record<string, unknown>): Partial<MangoPluginModule> | null {
  const def = mod.default as Partial<MangoPluginModule> | ((...a: unknown[]) => unknown) | undefined
  if (typeof mod.activate === 'function') return markRaw({ activate: mod.activate as MangoPluginModule['activate'], deactivate: mod.deactivate as MangoPluginModule['deactivate'] })
  if (def && typeof def === 'object' && typeof def.activate === 'function') return markRaw({ activate: def.activate.bind(def), deactivate: def.deactivate?.bind(def) })
  if (typeof def === 'function') return markRaw({ activate: def as MangoPluginModule['activate'], deactivate: mod.deactivate as MangoPluginModule['deactivate'] })
  return null
}

/** `onStatusChange`: every chat's status, compared with the last look. */
function watchStatuses() {
  const threads = useThreads()
  let last = new Map<string, string>()
  watch(() => threads.threads.map(t => `${t.id}\u0001${t.status}`).join('\n'), (now) => {
    if (!hooks.statusChange.length) {
      last = new Map(now ? now.split('\n').map(r => r.split('\u0001') as [string, string]) : [])
      return
    }
    const next = new Map<string, string>()
    for (const row of now ? now.split('\n') : []) {
      const [tid, status] = row.split('\u0001') as [string, string]
      next.set(tid, status)
      const before = last.get(tid)
      if (before !== undefined && before !== status) emitStatusChange(tid, status as never)
    }
    last = next
  }, { immediate: true })
}
