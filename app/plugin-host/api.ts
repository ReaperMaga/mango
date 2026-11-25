import * as Vue from 'vue'
import { markRaw, watch } from 'vue'
import type { App } from 'vue'
import type { Pinia } from 'pinia'
import type { FsEntry, InstalledPlugin } from '~/types/ipc'
import type { AgentId, Thread } from '~/types/chat'
import { AGENTS } from '~/types/chat'
import type {
  Disposable, MangoPluginApi, MenuLocation, PluginColorScheme, PluginDirEntry, PluginMenuItem, PluginSettingsPage, PluginView,
} from './types'
import { createPluginData } from './data'
import { DisposableScope } from './scope'
import { PART_ID, fullId, jsonState, parsePluginTab, pluginRef, pluginTabId, schemeCss, tokenDeclarations } from './ids'
import {
  builtinCommands, hooks, pluginTabs, raw, reg, report, type Owned,
} from './registry'
import { closeDialog, layers, openDialog, openMenu, toast } from './uiState'
import { pluginComponents } from './ui/components'
import { call, isTauri, on } from '~/composables/useBackend'
import { useWorkspace } from '~/stores/workspace'
import { useThreads } from '~/stores/threads'
import { useGit } from '~/stores/git'
import { useFiles } from '~/stores/files'
import { useBrowser } from '~/stores/browser'
import { usePlugins } from '~/stores/plugins'
import { MANGO_COMMANDS } from '~/stores/commands'
import { holdOverlay } from '~/composables/useOverlay'
import { drafts } from '~/utils/drafts'
import { normalizeAddress } from '~/utils/browserTabs'
import { sepOf, withTrailingSep } from '~/utils/paths'
import { fileTabId } from '~/utils/fileTabs'

/**
 * Builds the `mango` object one plugin's `activate` receives. Everything it registers goes into
 * `registry.ts` and is tracked in the plugin's `DisposableScope`, so disabling, reloading or removing
 * the plugin takes it all back out.
 */

export interface ApiHost {
  info: InstalledPlugin
  scope: DisposableScope
  app: App
  pinia: Pinia
  version: string
  log(level: 'info' | 'warn' | 'error', args: unknown[]): void
  /** What the plugin registered right now, by kind. */
  count(kind: string, delta: number): void
  settingsPages: Array<PluginSettingsPage & { pluginId: string; fullId: string }>
}

/** Plugin objects stay the plugin's own (methods keep `this`); the registry entry only adds who owns it. */
function owned<T extends object>(item: T, pluginId: string, full: string, extra: object = {}): Owned<T> {
  return raw(Object.assign(Object.create(item), { pluginId, fullId: full }, extra)) as Owned<T>
}

/** A view handed in: its component (or mount) is never made reactive. */
function rawView<V extends PluginView<any>>(view: V, what: string): V {
  if (!view || typeof view !== 'object' || (!('component' in view) && typeof (view as { mount?: unknown }).mount !== 'function')) {
    throw new TypeError(`${what}: "view" needs a component or a mount function.`)
  }
  if ('component' in view && view.component && typeof view.component === 'object') markRaw(view.component)
  return markRaw(view)
}

const platform = (): MangoPluginApi['platform'] => {
  if (!isTauri()) return 'browser'
  const p = `${navigator.platform} ${navigator.userAgent}`
  return /Win/i.test(p) ? 'windows' : /Mac|iPhone|iPad/i.test(p) ? 'macos' : 'linux'
}

/**
 * The open project (or a chat's worktree) a path is inside, and the path relative to it. `inView`: the
 * folder in view wins over a project nested in it, for what is to be shown there.
 */
function locate(path: string, inView = false): { root: string; file: string } {
  if (typeof path !== 'string' || !path) throw new TypeError('A path is needed.')
  const ws = useWorkspace()
  const threads = useThreads()
  const norm = (p: string) => p.replace(/\\/g, '/')
  const target = norm(path)
  const here = inView ? threads.workdir : null
  const roots = here && (target === norm(here) || target.startsWith(norm(withTrailingSep(here))))
    ? [here]
    : [...ws.openProjects.map(p => p.path), ...threads.threads.map(t => t.worktree).filter((w): w is string => !!w)]
  let best: string | null = null
  for (const r of roots) {
    const base = norm(withTrailingSep(r))
    if ((target === norm(r) || target.startsWith(base)) && (!best || r.length > best.length)) best = r
  }
  if (!best) throw new Error(`${path} is not inside an open project.`)
  const file = target === norm(best) ? '' : target.slice(norm(withTrailingSep(best)).length)
  return { root: best, file }
}

/** A companion's suffix: part of a name, and never all of one. */
const SUFFIX = /^\.[\w.~-]{0,30}[\w~-]$/

let busSeq = 0
const bus = new Map<string, Map<number, { pluginId: string; fn: (payload: unknown) => void }>>()

export function createApi(host: ApiHost): MangoPluginApi {
  const { info, scope } = host
  const id = info.manifest.id
  const ws = () => useWorkspace()
  const threads = () => useThreads()

  function checkId(v: unknown, what: string): string {
    if (typeof v !== 'string' || !PART_ID.test(v)) throw new TypeError(`${what}: id "${String(v)}" must be letters, digits, ".", "_", "-" or ":" (up to 64).`)
    return v
  }
  function needFn(v: unknown, what: string) {
    if (typeof v !== 'function') throw new TypeError(`${what} must be a function.`)
  }

  /** Put an entry in a registry list (refusing a second one with the same full id) and take it out on dispose. */
  function track<T extends { fullId: string }>(list: T[], item: T, kind: string, unique = true): Disposable {
    if (unique && list.some(x => x.fullId === item.fullId)) throw new Error(`${kind}: "${item.fullId}" is registered already.`)
    list.push(item)
    host.count(kind, 1)
    return scope.add(() => {
      const i = list.indexOf(item)
      if (i >= 0) list.splice(i, 1)
      host.count(kind, -1)
    })
  }
  function hook<F>(list: Array<{ pluginId: string; fn: F }>, fn: F, kind: string): Disposable {
    needFn(fn, kind)
    const entry = { pluginId: id, fn }
    list.push(entry)
    host.count('hooks', 1)
    return scope.add(() => {
      const i = list.indexOf(entry)
      if (i >= 0) list.splice(i, 1)
      host.count('hooks', -1)
    })
  }
  /** A Vue watcher that stops with the plugin. */
  function watchScoped<T>(source: () => T, cb: (v: T, old: T | undefined) => void, where: string): Disposable {
    const stop = watch(source, (v, old) => {
      try { cb(v, old) } catch (e) { report(id, e, where) }
    })
    return scope.add(stop)
  }
  function styleEl(css: string, kind: string): Disposable {
    const el = document.createElement('style')
    el.dataset.plugin = id
    el.dataset.pluginKind = kind
    el.textContent = css
    document.head.appendChild(el)
    return scope.add(() => el.remove())
  }

  const api: MangoPluginApi = {
    plugin: { id, manifest: info.manifest, dir: info.dir, info },
    version: host.version,
    platform: platform(),
    vue: Vue,

    /* ---------------------------------------------------------------- commands */
    commands: {
      register(cmd) {
        checkId(cmd?.id, 'commands.register')
        needFn(cmd.run, 'commands.register: run')
        return track(reg.commands, owned(cmd, id, fullId(id, cmd.id)), 'commands')
      },
      async execute(target, ...args) {
        const plugin = reg.commands.find(c => c.fullId === target)
        if (plugin) return plugin.run(...args)
        const builtin = builtinCommands().find(c => c.id === target)
        if (builtin) return builtin.run()
        throw new Error(`No command "${target}".`)
      },
      list() {
        return [
          ...reg.commands.map(c => ({ id: c.fullId, title: c.title, pluginId: c.pluginId as string | null })),
          ...builtinCommands().map(c => ({ id: c.id, title: c.title, pluginId: null })),
        ]
      },
    },

    shortcuts: {
      register(sc) {
        checkId(sc?.id, 'shortcuts.register')
        needFn(sc.run, 'shortcuts.register: run')
        if (typeof sc.key !== 'string' || !sc.key.startsWith('Mod+')) host.log('warn', [`Shortcut "${sc.id}": "${sc.key}" has no Mod; it starts unbound (the user can set a key in Settings > Shortcuts).`])
        return track(reg.shortcuts, owned(sc, id, pluginRef(id, sc.id)), 'shortcuts')
      },
    },

    /* ---------------------------------------------------------------- chats */
    chat: {
      active: () => threads().activeThread,
      get: tid => threads().byId(tid),
      list(projectPath) {
        const open = new Set(ws().openProjects.map(p => p.path))
        return threads().threads.filter(t => (projectPath ? t.projectPath === projectPath : open.has(t.projectPath)))
      },
      create(opts = {}) {
        const path = opts.projectPath ?? ws().activeProjectPath
        if (!path) throw new Error('No project is open.')
        if (opts.agent && !(opts.agent in AGENTS)) throw new Error(`Unknown agent "${opts.agent}".`)
        if (ws().activeProjectPath !== path && ws().openProjects.some(p => p.path === path)) ws().setActiveProject(path)
        const t: Thread = threads().create(path, opts.agent as AgentId | undefined)
        if (opts.title) threads().rename(t.id, opts.title)
        return t
      },
      async send(tid, text) {
        if (!threads().byId(tid)) throw new Error(`No chat "${tid}".`)
        await threads().send(tid, String(text ?? ''))
      },
      stop: tid => threads().stop(tid),
      show(tid) {
        const t = threads().byId(tid)
        if (!t) return
        if (ws().activeProjectPath !== t.projectPath && ws().openProjects.some(p => p.path === t.projectPath)) ws().setActiveProject(t.projectPath)
        threads().show(tid)
      },
      rename: (tid, title) => threads().rename(tid, String(title ?? '')),
      draft: tid => drafts.get(tid) ?? '',
      setDraft(tid, text) {
        if (!threads().byId(tid)) throw new Error(`No chat "${tid}".`)
        const v = String(text ?? '')
        if (v) drafts.set(tid, v)
        else drafts.delete(tid)
      },

      onBeforeSend: fn => hook(hooks.beforeSend, fn, 'chat.onBeforeSend'),
      onAgentEvent: fn => hook(hooks.agentEvent, fn, 'chat.onAgentEvent'),
      onTurnEnd: fn => hook(hooks.turnEnd, fn, 'chat.onTurnEnd'),
      onThreadCreated: fn => hook(hooks.threadCreated, fn, 'chat.onThreadCreated'),
      onStatusChange: fn => hook(hooks.statusChange, fn, 'chat.onStatusChange'),

      slashCommands: {
        register(cmd) {
          if (typeof cmd?.name !== 'string' || !/^[\w.:-]{1,64}$/.test(cmd.name)) throw new TypeError(`slashCommands.register: "${String(cmd?.name)}" is not a command name (letters, digits, ".", "_", "-", ":").`)
          needFn(cmd.run, 'slashCommands.register: run')
          if (MANGO_COMMANDS.some(m => m.name === cmd.name)) throw new Error(`/${cmd.name} is one of Mango's own commands.`)
          const taken = reg.slashCommands.find(c => c.name === cmd.name)
          if (taken) throw new Error(`/${cmd.name} is registered already${taken.pluginId === id ? '' : ` by ${taken.pluginId}`}.`)
          return track(reg.slashCommands, owned(cmd, id, fullId(id, cmd.name)), 'slashCommands')
        },
      },
      messageActions: {
        register(action) {
          checkId(action?.id, 'messageActions.register')
          needFn(action.run, 'messageActions.register: run')
          return track(reg.messageActions, owned(action, id, fullId(id, action.id)), 'messageActions')
        },
      },
      codeBlocks: {
        register(renderer) {
          if (!Array.isArray(renderer?.languages) || !renderer.languages.length) throw new TypeError('codeBlocks.register: "languages" must list at least one language.')
          const view = rawView(renderer.view, 'codeBlocks.register')
          const languages = renderer.languages.map(l => String(l).toLowerCase())
          return track(reg.codeBlocks, owned({ ...renderer, view, languages }, id, fullId(id, languages.join(','))), 'codeBlocks', false)
        },
      },
    },

    /* ---------------------------------------------------------------- UI */
    ui: {
      files: {
        filters: {
          register(filter) {
            checkId(filter?.id, 'files.filters.register')
            needFn(filter.hide, 'files.filters.register: hide')
            if (typeof filter.label !== 'string' || !filter.label.trim()) throw new TypeError('files.filters.register: "label" is needed.')
            return track(reg.fileFilters, owned(filter, id, fullId(id, filter.id)), 'fileFilters')
          },
          isShown: filterId => ws().filesView.shown.includes(fullId(id, filterId)),
          setShown(filterId, on) {
            ws().setFileFilterShown(fullId(id, checkId(filterId, 'files.filters.setShown')), !!on)
          },
        },
        companions: {
          register(companion) {
            checkId(companion?.id, 'files.companions.register')
            needFn(companion.when, 'files.companions.register: when')
            if (typeof companion.suffix !== 'string' || !SUFFIX.test(companion.suffix)) throw new TypeError('files.companions.register: "suffix" is a dot and the rest of a name, like ".meta".')
            return track(reg.fileCompanions, owned(companion, id, fullId(id, companion.id)), 'fileCompanions')
          },
        },
        icons: {
          register(provider) {
            checkId(provider?.id, 'files.icons.register')
            needFn(provider.icon, 'files.icons.register: icon')
            return track(reg.fileIcons, owned(provider, id, fullId(id, provider.id)), 'fileIcons')
          },
        },
        languages: {
          register(lang) {
            checkId(lang?.id, 'files.languages.register')
            const { extensions, language } = lang
            if (!Array.isArray(extensions) || !extensions.length || !extensions.every(e => typeof e === 'string' && /^\.[^\\/]+$/.test(e))) {
              throw new TypeError('files.languages.register: "extensions" lists extensions with their dot.')
            }
            if (typeof language !== 'string' || !language) throw new TypeError('files.languages.register: "language" is a Monaco language id.')
            const item = { id: lang.id, language, extensions: extensions.map(e => e.toLowerCase()) }
            return track(reg.fileLanguages, owned(item, id, fullId(id, lang.id)), 'fileLanguages')
          },
        },
        async reveal(path) {
          const { root, file } = locate(path, true)
          if (root !== threads().workdir && ws().openProjects.some(p => p.path === root)) ws().setActiveProject(root)
          if (root !== threads().workdir) throw new Error('That folder is not in view: show the chat that works in it first.')
          ws().openTool('files')
          if (file) await useFiles().reveal(root, file)
        },
      },
      toolWindows: {
        register(win) {
          checkId(win?.id, 'toolWindows.register')
          const view = rawView(win.view, 'toolWindows.register')
          const ref = pluginRef(id, win.id)
          const d = track(reg.toolWindows, owned({ ...win, view }, id, ref), 'toolWindows')
          // Gone while open: the panel closes (the pref keeps it for when the plugin is back).
          scope.add(() => { if (ws().toolPanel === ref) ws().toolPanel = null })
          return d
        },
        open(winId) {
          const ref = pluginRef(id, winId)
          if (!reg.toolWindows.some(w => w.fullId === ref)) throw new Error(`No tool window "${winId}".`)
          ws().openTool(ref)
        },
        close() {
          const open = ws().toolPanel
          if (open && reg.toolWindows.some(w => w.fullId === open && w.pluginId === id)) ws().closeTool()
        },
      },
      panelTabs: {
        register(tab) {
          checkId(tab?.id, 'panelTabs.register')
          const view = rawView(tab.view, 'panelTabs.register')
          const ref = fullId(id, tab.id)
          const d = track(reg.panelTabs, owned({ ...tab, view }, id, ref), 'panelTabs')
          // Gone while showing: the panel goes back to its terminals.
          const back = scope.add(() => { if (ws().panelPluginTab === ref) ws().panelPluginTab = null })
          return { dispose() { back.dispose(); d.dispose() } }
        },
        open(tabId) {
          const ref = fullId(id, tabId)
          if (!reg.panelTabs.some(t => t.fullId === ref)) throw new Error(`No panel tab "${tabId}".`)
          ws().openPanelTab(ref)
        },
      },
      tabs: {
        register(view) {
          checkId(view?.id, 'tabs.register')
          const v = rawView(view.view, 'tabs.register')
          if (view.header !== undefined && !['default', 'none'].includes(view.header)) throw new TypeError('tabs.register: header is "default" or "none".')
          const d = track(reg.tabViews, owned({ ...view, view: v }, id, fullId(id, view.id)), 'tabViews')
          // Open ones (restored, or from before a reload) follow what the view says now.
          for (const [tabId, tab] of Object.entries(pluginTabs)) {
            const ref = parsePluginTab(tabId)
            if (ref?.pluginId !== id || ref.viewId !== view.id) continue
            tab.restore = view.restore === true
            tab.icon = typeof view.icon === 'string' ? view.icon : undefined
          }
          return d
        },
        open(viewId, opts) {
          const view = reg.tabViews.find(v => v.pluginId === id && v.id === viewId)
          if (!view) throw new Error(`No tab view "${viewId}".`)
          const projectPath = ws().activeProjectPath
          if (!projectPath) throw new Error('No project is open.')
          const key = opts?.key ? String(opts.key) : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
          const tabId = pluginTabId({ projectPath, pluginId: id, viewId, key })
          const restore = view.restore === true
          // Focusing an open tab without saying a state leaves the one it has.
          const state = opts?.state === undefined && threads().tabs.includes(tabId) ? pluginTabs[tabId]?.state : opts?.state
          if (restore && state !== undefined && jsonState(state) === undefined) host.log('warn', [`tabs.open: the state of "${viewId}" is not JSON (or is over 256 KB), so it is not kept across restarts.`])
          pluginTabs[tabId] = {
            title: String(opts?.title ?? viewId),
            state: markRawIfObject(state),
            restore,
            ...(typeof view.icon === 'string' ? { icon: view.icon } : {}),
          }
          threads().show(tabId)
        },
        active() {
          const tabId = threads().activePane.threadId
          const ref = parsePluginTab(tabId)
          return ref && ref.pluginId === id ? { viewId: ref.viewId, key: ref.key, state: pluginTabs[tabId!]?.state } : null
        },
        close(viewId, key) {
          const projectPath = ws().activeProjectPath
          if (projectPath) threads().closeTab(pluginTabId({ projectPath, pluginId: id, viewId: String(viewId), key: String(key) }))
        },
      },
      navItems: {
        register(item) {
          checkId(item?.id, 'navItems.register')
          needFn(item.run, 'navItems.register: run')
          if (typeof item.title !== 'string' || !item.title.trim()) throw new TypeError('navItems.register: "title" is needed.')
          if (!item.icon) throw new TypeError('navItems.register: "icon" is needed.')
          if (item.shortcut !== undefined) checkId(item.shortcut, 'navItems.register: shortcut')
          return track(reg.navItems, owned(item, id, fullId(id, item.id)), 'navItems')
        },
      },
      components: pluginComponents(id),
      contextMenu(at, rows) {
        const place = at instanceof HTMLElement ? at : { x: Number(at?.x), y: Number(at?.y) }
        if (!(place instanceof HTMLElement) && !(Number.isFinite(place.x) && Number.isFinite(place.y))) throw new TypeError('ui.contextMenu: "at" is a point { x, y } or an element.')
        if (!Array.isArray(rows)) throw new TypeError('ui.contextMenu: "rows" is a list.')
        if (scope.disposed || !rows.length) return Promise.resolve()
        return openMenu({ pluginId: id, at: place, rows })
      },
      holdOverlay: () => scope.add(holdOverlay()),
      statusItems: {
        register(item) {
          checkId(item?.id, 'statusItems.register')
          if (!['project', 'titlebar', 'sidebar'].includes(item.location)) throw new TypeError('statusItems.register: location is "project", "titlebar" or "sidebar".')
          return track(reg.statusItems, owned(item, id, fullId(id, item.id)), 'statusItems')
        },
      },
      settingsPages: {
        register(page) {
          checkId(page?.id, 'settingsPages.register')
          const view = rawView(page.view, 'settingsPages.register')
          const full = fullId(id, page.id)
          const list = host.settingsPages
          if (list.some(p => p.fullId === full)) throw new Error(`settingsPages: "${full}" is registered already.`)
          list.push(raw({ ...page, view, pluginId: id, fullId: full }))
          host.count('settingsPages', 1)
          return scope.add(() => {
            const i = list.findIndex(p => p.fullId === full)
            if (i >= 0) list.splice(i, 1)
            host.count('settingsPages', -1)
            if ((ws().settings as string | null) === full) ws().settings = null
          })
        },
      },
      menus: {
        register<L extends MenuLocation>(location: L, item: PluginMenuItem<L>) {
          if (!['thread', 'file', 'project'].includes(location)) throw new TypeError('menus.register: location is "thread", "file" or "project".')
          checkId(item?.id, 'menus.register')
          needFn(item.run, 'menus.register: run')
          return track(reg.menus, owned(item as PluginMenuItem, id, `${location}:${fullId(id, item.id)}`, { location }), 'menus')
        },
      },

      toast: opts => { toast(opts, id) },
      notify(title, body) {
        const n = ws().notify
        if (!n.enabled) return
        call('notify', { title: String(title), body: String(body ?? ''), sound: n.sound }).catch(() => {})
      },
      confirm: opts => openDialog({ kind: 'confirm', pluginId: id, ...opts }) as Promise<boolean>,
      prompt: opts => openDialog({ kind: 'prompt', pluginId: id, ...opts }) as Promise<string | null>,
      dialog(opts) {
        const view = rawView(opts.view, 'ui.dialog')
        return openDialog({ kind: 'view', pluginId: id, title: opts.title, view, width: opts.width }) as Promise<void>
      },
      openSettings(section) {
        // A plugin page (`<pluginId>.<pageId>`, or one of this plugin's by its own id; Settings keys it `plugin:<fullId>`) or a built-in section.
        const page = host.settingsPages.find(p => p.fullId === section) ?? host.settingsPages.find(p => p.pluginId === id && p.id === section)
        ws().openSettings((page ? `plugin:${page.fullId}` : section ?? 'general') as Parameters<ReturnType<typeof useWorkspace>['openSettings']>[0])
      },
    },

    /* ---------------------------------------------------------------- theme */
    theme: {
      addStyles(css) {
        const d = styleEl(String(css ?? ''), 'styles')
        host.count('styles', 1)
        scope.add(() => host.count('styles', -1))
        return d
      },
      setTokens(tokens) {
        // Beats every theme and scheme rule in tokens.css (0,3,1 over 0,3,0); later calls come later in <head>.
        const d = styleEl(`html:root[data-theme][data-scheme] {\n${tokenDeclarations(tokens)}\n}`, 'tokens')
        host.count('tokens', 1)
        scope.add(() => host.count('tokens', -1))
        return d
      },
      registerScheme(scheme: PluginColorScheme) {
        checkId(scheme?.id, 'theme.registerScheme')
        const ref = pluginRef(id, scheme.id)
        const css = styleEl(schemeCss(ref, scheme.dark ?? {}, scheme.light ?? {}), 'scheme')
        const d = track(reg.schemes, owned(scheme, id, ref), 'schemes')
        // Chosen already (a saved pref waiting for its plugin): apply it now; on dispose, Mango's own takes over.
        if (ws().scheme === ref) ws().applyTheme()
        scope.add(() => { if (ws().scheme === ref) ws().applyTheme() })
        return { dispose() { d.dispose(); css.dispose() } }
      },
      current: () => ws().resolvedTheme(),
      onChange(handler) {
        needFn(handler, 'theme.onChange')
        let last = document.documentElement.dataset.theme
        const mo = new MutationObserver(() => {
          const now = document.documentElement.dataset.theme
          if (now === last) return
          last = now
          try { handler(now === 'light' ? 'light' : 'dark') } catch (e) { report(id, e, 'theme.onChange') }
        })
        mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
        return scope.add(() => mo.disconnect())
      },
    },

    /* ---------------------------------------------------------------- workspace, files, git */
    workspace: {
      activeProject: () => ws().activeProjectPath,
      openProjects: () => ws().openProjects.map(p => p.path),
      workdir: () => threads().workdir,
      onProjectChange: handler => watchScoped(() => ws().activeProjectPath, v => handler(v), 'workspace.onProjectChange'),
      openFile(path, opts) {
        const { root, file } = locate(path, true)
        if (!file) throw new Error('openFile needs a file, not a project folder.')
        const files = useFiles()
        if (opts?.line) files.revealLine(fileTabId(root, file), Number(opts.line))
        void files.openFile(root, file, true)
      },
      openBrowser(url) {
        const address = normalizeAddress(String(url ?? ''))
        if (!address || !/^https?:/i.test(address)) throw new Error(`Not a web address: ${url}`)
        const project = ws().activeProjectPath
        if (!project) throw new Error('No project is open.')
        useBrowser().open(project, address)
      },
      openTerminal(opts) {
        const tabId = ws().newTerminal(opts?.cwd ?? null)
        const command = opts?.command
        if (!command) return
        const tab = ws().terminalTabs.find(t => t.id === tabId)
        if (!tab) return
        // Typed into the shell once it is up, as if the user had.
        const stop = watch(() => tab.ptyId, (pty) => {
          if (!pty) return
          stop()
          setTimeout(() => { call('pty_write', { id: pty, data: `${command}\r` }).catch(e => report(id, e, 'openTerminal')) }, 150)
        }, { immediate: true })
        scope.add(stop)
      },
    },

    files: {
      async read(path) {
        const { root, file } = locate(path)
        const c = await call('fs_read_file', { root, file })
        if (c.text === null) throw new Error(c.tooLarge ? `${file} is too large to read.` : `${file} is not a text file.`)
        return c.text
      },
      async write(path, content) {
        const { root, file } = locate(path)
        const text = String(content ?? '')
        try {
          await call('fs_write_file', { root, file, text, bom: false, expectedModifiedMs: null })
        } catch (first) {
          // Not there yet: make it.
          try { await call('fs_create_file', { root, file, text }) } catch { throw first }
        }
        window.dispatchEvent(new CustomEvent('mango:files-changed', { detail: { path: root } }))
      },
      onChange(handler) {
        needFn(handler, 'files.onChange')
        const tell = (path: string) => {
          try { handler(path) } catch (e) { report(id, e, 'files.onChange') }
        }
        const onEvent = (e: Event) => {
          const path = (e as CustomEvent<{ path?: string }>).detail?.path
          if (path) tell(path)
        }
        window.addEventListener('mango:files-changed', onEvent)
        // A checkout, pull or commit changes files without that event.
        const stop = watch(() => {
          const path = threads().workdir
          const st = path ? useGit().repos[path]?.status : null
          return path && st?.isRepo ? `${path}\n${st.branch}\n${st.head}` : ''
        }, (now, before) => {
          const path = now.split('\n')[0]
          if (path && before && before.split('\n')[0] === path) tell(path)
        })
        return scope.add(() => {
          stop()
          window.removeEventListener('mango:files-changed', onEvent)
        })
      },
      async list(dir, opts) {
        const { root, file } = locate(dir)
        const listing = await call('fs_list_dir', { root, dir: file, ahead: !!opts?.children })
        const base = withTrailingSep(root)
        const windows = sepOf(root) === '\\'
        const entry = (e: FsEntry): PluginDirEntry => ({ name: e.name, path: base + (windows ? e.path.replace(/\//g, '\\') : e.path), isDir: e.isDir })
        const below = new Map((listing.ahead ?? []).map(a => [a.dir, a.entries]))
        return listing.entries.map((e) => {
          const children = e.isDir ? below.get(e.path) : undefined
          return children ? { ...entry(e), children: children.map(entry) } : entry(e)
        })
      },
    },

    git: {
      async status(path) {
        const git = useGit()
        await git.refresh(path)
        const st = git.repos[path]?.status
        return st && st.isRepo ? st : null
      },
      refresh: path => useGit().refresh(path),
    },

    /* ---------------------------------------------------------------- agents */
    agents: {
      registerMcpServer(server) {
        if (typeof server?.name !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(server.name)) throw new TypeError('registerMcpServer: name must be letters, digits, "_" or "-".')
        if (server.transport === 'stdio' ? typeof server.command !== 'string' || !server.command : server.transport === 'http' ? typeof server.url !== 'string' || !/^https?:\/\//i.test(server.url) : true) {
          throw new TypeError('registerMcpServer: a stdio server needs "command", an http server an http(s) "url".')
        }
        const taken = reg.mcpServers.find(s => s.name.toLowerCase() === server.name.toLowerCase())
        if (taken) throw new Error(`An MCP server "${server.name}" is registered already${taken.pluginId === id ? '' : ` by ${taken.pluginId}`}.`)
        return track(reg.mcpServers, owned(server, id, fullId(id, server.name)), 'mcpServers')
      },
      appendSystemPrompt(text) {
        if (typeof text !== 'string' && typeof text !== 'function') throw new TypeError('appendSystemPrompt takes a string or a getter.')
        return track(reg.systemPrompts, raw({ pluginId: id, fullId: fullId(id, `prompt-${reg.systemPrompts.length}`), text }), 'systemPrompts', false)
      },
    },

    /* ---------------------------------------------------------------- data */
    settings: {
      get: <T>(key: string) => usePlugins().setting(id, key) as T,
      set: (key, value) => usePlugins().setSetting(id, key, value),
      all() {
        const plugins = usePlugins()
        const out: Record<string, unknown> = {}
        for (const f of info.manifest.settings ?? []) out[f.key] = plugins.setting(id, f.key)
        for (const [k, v] of Object.entries(plugins.settingsValues[id] ?? {})) out[k] = v
        return out
      },
      onChange(handler) {
        needFn(handler, 'settings.onChange')
        return watchScoped(() => api.settings.all(), (now, before) => {
          for (const k of new Set([...Object.keys(now), ...Object.keys(before ?? {})])) {
            if (JSON.stringify(now[k]) !== JSON.stringify(before?.[k])) handler(k, now[k])
          }
        }, 'settings.onChange')
      },
    },

    storage: {
      get<T>(key: string) {
        try {
          const v = localStorage.getItem(`mango.plugin.${id}.${key}`)
          return v === null ? undefined : JSON.parse(v) as T
        } catch { return undefined }
      },
      set(key, value) {
        const k = `mango.plugin.${id}.${key}`
        if (value === undefined) localStorage.removeItem(k)
        else localStorage.setItem(k, JSON.stringify(value))
      },
      delete: key => localStorage.removeItem(`mango.plugin.${id}.${key}`),
      keys() {
        const prefix = `mango.plugin.${id}.`
        return Object.keys(localStorage).filter(k => k.startsWith(prefix)).map(k => k.slice(prefix.length))
      },
    },

    data: createPluginData({ pluginId: id, scope, call, on, report: (e, where) => report(id, e, where) }),

    events: {
      on(name, handler) {
        needFn(handler, 'events.on')
        const key = ++busSeq
        const map = bus.get(name) ?? new Map()
        bus.set(name, map)
        map.set(key, { pluginId: id, fn: handler })
        return scope.add(() => {
          map.delete(key)
          if (!map.size) bus.delete(name)
        })
      },
      emit(name, payload) {
        for (const h of [...(bus.get(name)?.values() ?? [])]) {
          try { h.fn(payload) } catch (e) { report(h.pluginId, e, `event "${name}"`) }
        }
      },
    },

    assets: {
      text: path => call('plugins_read', { id, path }),
      async url(path) {
        const a = await call('plugins_asset', { id, path })
        const bytes = Uint8Array.from(atob(a.data), c => c.charCodeAt(0))
        const url = URL.createObjectURL(new Blob([bytes], { type: a.mime || 'application/octet-stream' }))
        scope.add(() => URL.revokeObjectURL(url))
        return url
      },
    },

    log: {
      info: (...a) => host.log('info', a),
      warn: (...a) => host.log('warn', a),
      error: (...a) => host.log('error', a),
    },
    onBeforeClose: fn => hook(hooks.beforeClose, fn, 'onBeforeClose'),
    onDispose(fn) {
      needFn(fn, 'onDispose')
      scope.add(fn)
    },

    /* ---------------------------------------------------------------- escape hatches */
    backend: {
      call: (cmd, args) => call(cmd, args),
      async on(event, handler) {
        const unlisten = await on(event, (payload) => {
          try { handler(payload) } catch (e) { report(id, e, `backend event ${String(event)}`) }
        })
        return scope.add(unlisten)
      },
    },

    stores: {
      get workspace() { return useWorkspace() },
      get threads() { return useThreads() },
      get git() { return useGit() },
      get files() { return useFiles() },
      get browser() { return useBrowser() },
      byId: (storeId: string) => (host.pinia as unknown as { _s: Map<string, unknown> })._s.get(storeId),
    },
    app: host.app,
    pinia: host.pinia,
  }

  // Dialogs and tabs of a plugin that goes away close.
  scope.add(() => {
    for (const d of layers.dialogs.filter(d => d.pluginId === id)) closeDialog(d.id, d.kind === 'confirm' ? false : d.kind === 'prompt' ? null : undefined)
  })
  return api
}

function markRawIfObject<T>(v: T): T {
  return v && typeof v === 'object' ? markRaw(v as object) as T : v
}
