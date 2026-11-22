import { defineStore } from 'pinia'
import { toRaw } from 'vue'
import type { AgentInfo, EnvRemote, ProjectInfo, TerminalProfile } from '~/types/ipc'
import type { PermissionMode } from '~/agents/types'
import type { AgentId } from '~/types/chat'
import { call } from '~/composables/useBackend'
import { baseName, withTrailingSep } from '~/utils/paths'
import { shortVersion } from '~/utils/agentCli'
import { envPath, isEnvPath, movedEnvPath, parseEnvPath, type EnvLocation } from '~/utils/envPath'
import { useEnvironments } from '~/stores/environments'
import { useThreads } from '~/stores/threads'
import { useWindows } from '~/stores/windows'
import { editorTabOf, parseTerminalTab, placeBefore, terminalTabId } from '~/utils/terminalTabs'
import { notifyPrefsOf, type NotifyPrefs } from '~/utils/notifications'
import { cleanOverrides, comboLabel, comboParts, resolveBindings } from '~/utils/shortcuts'
import { openProjectInOf, whereToOpen, type OpenProjectIn } from '~/utils/openWhere'
import { filesViewOf, type FilesView } from '~/utils/fileTree'
import {
  effectiveScheme, isPanelTabRef, isPluginRef, normalizePanelOrder, normalizePanelPlaces, panelEditorTabId, panelStrip,
  parsePanelEditorTab, type PanelTabPlace, type PluginRef,
} from '~/plugin-host/ids'
import { isPluginSchemeRegistered, pluginShortcutDefs, reg as pluginReg, shown as pluginShown, shownPanelTab } from '~/plugin-host/registry'

export type Theme = 'dark' | 'light' | 'system'
/** Colour scheme: the tint of the grounds and the accent family (see tokens.css). */
export const COLOR_SCHEMES = ['mango', 'blue', 'teal', 'green', 'purple', 'pink', 'red', 'slate', 'uchiha', 'graphite', 'ink', 'cocoa', 'neon', 'solar'] as const
export type ColorScheme = typeof COLOR_SCHEMES[number]
/** A built-in scheme, or one a plugin registered (`plugin:<pluginId>.<id>`; Mango's own applies while it is not there). */
export type SchemeId = ColorScheme | PluginRef
/** Interface text size, corner roundness and animation (scales in tokens.css). */
export const TEXT_SIZES = ['small', 'default', 'large', 'xlarge'] as const
export type TextSize = typeof TEXT_SIZES[number]
export const CORNERS = ['sharp', 'default', 'round'] as const
export type Corners = typeof CORNERS[number]
export const MOTIONS = ['system', 'full', 'reduced'] as const
export type Motion = typeof MOTIONS[number]

export interface TerminalTab {
  id: string
  title: string
  cwd: string | null
  /** set once the PTY is spawned */
  ptyId: string | null
  exited: boolean
  /** The shell this tab runs (a TerminalProfile id); null means the system default. */
  profileId: string | null
  /** Display name of that shell, e.g. "Zsh". */
  shell: string | null
  /** Shown as a tab in the main area (see utils/terminalTabs.ts) instead of in the docked panel. */
  inEditor?: boolean
}

/** Where a terminal moved into the main area shows: before a tab of the strip, in a pane, or in a new right pane. */
export interface TerminalPlacement {
  /** Put its tab before this one in the strip (null: at the end); left out, it goes after the tab in view. */
  before?: string | null
  /** The pane to show it in; left out, the active one. */
  paneId?: string
  /** Open a second pane on the right for it. */
  split?: boolean
}

/**
 * The tool windows that open on the right: where the project runs (this computer or an environment),
 * the project's files, source control, and the chat's pull requests and issues.
 */
export type ToolView = 'env' | 'files' | 'changes' | 'links' | 'releases' | PluginRef
/** Enter sends (Shift+Enter breaks the line), or Ctrl/Cmd+Enter sends (Enter breaks the line). */
/** Interface and code fonts (see tokens.css). */
export const UI_FONTS = ['inter', 'geist', 'dm-sans', 'manrope', 'system'] as const
export type UiFont = typeof UI_FONTS[number]
export const MONO_FONTS = ['jetbrains-mono', 'fira-code', 'source-code-pro', 'geist-mono', 'system'] as const
export type MonoFont = typeof MONO_FONTS[number]
export type SendKey = 'enter' | 'mod-enter'
/** A message written while the agent works: wait for the turn to end, or hand it to the running turn. */
export type FollowUp = 'queue' | 'steer'
/** Tool calls in a chat: all, only the failed ones, none, or only the final answers (Zen). */
export type ToolCalls = 'all' | 'hide-ok' | 'hide' | 'zen'
export type CursorStyle = 'bar' | 'block' | 'underline'
/** What Mango tells you about while you are elsewhere (Settings > Notifications). */
/** Notification preferences: the type and the loader live in `utils/notifications.ts` (the phone shares them). */
export type { NotifyPrefs }
const notifyOf = notifyPrefsOf
/** What one project overrides (Settings > Projects). Anything missing follows the global default. */
export interface ProjectPrefs {
  /** Shown instead of the folder name. */
  name?: string
  /** Sorts first in the project lists. */
  pinned?: boolean
  /** Agent and permission mode new chats of this project start with. */
  agent?: AgentId
  mode?: PermissionMode
  /** The model new chats start with (for the agent they start with). */
  model?: string
  /** A hue (0 to 360) for the project's badge; automatic when missing. */
  color?: number
  /** Hidden from the Recent list; its chats are kept. Opening the project again brings it back. */
  archived?: boolean
  /** Files and folders excluded in the Files view, relative to the project (forward slashes); its worktrees share them. */
  excluded?: string[]
}
const projectPrefsOf = (): Record<string, ProjectPrefs> => loadPrefs().projectPrefs ?? {}

/** A yes/no question before something is archived or deleted. */
export interface ConfirmAsk { title: string; body: string; label: string; danger?: boolean; run: () => void
  /** Only something to read: one button, no Cancel. */
  info?: boolean }
/** "Open project: this window or a new one?" waiting for its answer (null: cancelled). */
export interface OpenWhereAsk { name: string; answer: (choice: 'this' | 'new' | null) => void }
export type AgentsTab = 'agents' | 'subscription' | 'usage'
/** Built-in sections, plus `plugin:<pluginId>.<pageId>` for a settings page a plugin registered (Settings > Plugins when it is gone). */
export type SettingsSection = 'agents' | 'environments' | 'terminal' | 'mcp' | 'voice' | 'appearance' | 'general' | 'projects' | 'behavior' | 'notifications' | 'shortcuts' | 'maintenance' | 'archive' | 'changelog' | 'plugins' | `plugin:${string}`
/** How Settings > Projects > Environment variables edits a file: as key/value rows or as plain text. */
export type EnvEditMode = 'fields' | 'raw'

const LS_KEY = 'mango.workspace.v1'

/** No prefs stored at all: Mango has never run on this computer (or its data was cleared). */
function isFirstRun() {
  try {
    return localStorage.getItem(LS_KEY) === null
  } catch {
    return false
  }
}

function loadPrefs() {
  try {
    return JSON.parse(localStorage.getItem(LS_KEY) || '{}')
  } catch {
    return {}
  }
}

/**
 * Remote projects (folders inside an environment, `env://…`). The backend's recent list only
 * holds folders on this computer, so these are kept here, most recent first.
 */
const ENV_KEY = 'mango.envProjects.v1'
const MAX_ENV_PROJECTS = 30

/** A remote project's name when none is given: its folder, or the instance for `/`. */
export const envProjectName = (loc: EnvLocation) => (loc.dir === '/' ? loc.instance : baseName(loc.dir))
/** A project's own name before it has one: its folder's (or its instance's). */
const folderName = (path: string) => { const loc = parseEnvPath(path); return loc ? envProjectName(loc) : baseName(path) }

const envInfo = (loc: EnvLocation, name: string, lastOpened: number): ProjectInfo =>
  ({ path: envPath(loc), name, isGit: false, vcs: null, branch: null, lastOpened })

/** Tolerates anything an older or newer build wrote: entries that don't parse are dropped. */
function loadEnvProjects(): ProjectInfo[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(ENV_KEY) || '[]')
    if (!Array.isArray(raw)) return []
    const out: ProjectInfo[] = []
    for (const p of raw) {
      const loc = parseEnvPath(typeof p?.path === 'string' ? p.path : null)
      if (!loc || out.some(o => o.path === envPath(loc))) continue
      const name = typeof p.name === 'string' && p.name.trim() ? p.name.trim() : envProjectName(loc)
      out.push(envInfo(loc, name, Number.isFinite(p.lastOpened) ? p.lastOpened : 0))
    }
    return out
  } catch {
    return []
  }
}

function saveEnvProjects(list: ProjectInfo[]) {
  try {
    localStorage.setItem(ENV_KEY, JSON.stringify(list.slice(0, MAX_ENV_PROJECTS)))
  } catch { /* storage unavailable: remote projects just aren't remembered */ }
}

/** A project under the name the user gave it in Settings > Projects. */
const named = (p: ProjectInfo, prefs: Record<string, ProjectPrefs>): ProjectInfo =>
  prefs[p.path]?.name ? { ...p, name: prefs[p.path]!.name! } : p

/** Pinned projects first, then the most recently opened. */
const byPinned = (prefs: Record<string, ProjectPrefs>) => (a: ProjectInfo, b: ProjectInfo) =>
  Number(!!prefs[b.path]?.pinned) - Number(!!prefs[a.path]?.pinned) || b.lastOpened - a.lastOpened

/** The backend's recent folders and the remote projects, pinned first, then most recent first. */
const mergeRecent = (local: ProjectInfo[]) => {
  const prefs = projectPrefsOf()
  return [...local.filter(p => !isEnvPath(p.path)), ...loadEnvProjects()].map(p => named(p, prefs)).sort(byPinned(prefs))
}

/** Server names label remote projects: read the saved servers once one is around. */
function loadHostsFor(projects: ProjectInfo[]) {
  if (!projects.some(p => isEnvPath(p.path))) return
  const envs = useEnvironments()
  if (!envs.loaded) envs.load().catch(() => {})
}

/**
 * Env file names the user created that `env_files` would not find on its own (not `.env`,
 * `.env.*` or `*.env`), per project path. Anything unreadable from an older or newer build is dropped.
 */
function envExtraOf(v: unknown): Record<string, string[]> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {}
  const out: Record<string, string[]> = {}
  for (const [root, names] of Object.entries(v as Record<string, unknown>)) {
    if (!Array.isArray(names)) continue
    const list = [...new Set(names.filter((n): n is string => typeof n === 'string' && n.length > 0))]
    if (list.length) out[root] = list
  }
  return out
}

/** A plugin's tool window (`plugin:<pluginId>.<id>`) is kept while it is not loaded: the panel shows it once the plugin is back. */
const toolView = (v: unknown): ToolView | null => (v === 'env' || v === 'files' || v === 'changes' || v === 'links' || v === 'releases' || isPluginRef(v) ? v : null)

/** A remembered place for new projects: an environment, or null for this computer (and for anything unreadable). */
const whereOf = (v: unknown): EnvRemote | null => {
  const o = v as Partial<EnvRemote> | null
  return o && typeof o.hostId === 'string' && o.hostId && typeof o.instance === 'string' && o.instance
    ? { hostId: o.hostId, instance: o.instance }
    : null
}

let tabSeq = 0

/**
 * Prefs that belong to one window: its layout and its projects. The main window keeps them in
 * storage; another window (`stores/windows.ts`) keeps its own in memory and leaves the stored ones
 * alone. Every other pref is shared: a change in one window reaches the others (`syncShared`).
 */
const WINDOW_KEYS = ['openProjects', 'activeProjectPath', 'sidebarOpen', 'sidebarWidth', 'terminalOpen', 'terminalHeight', 'panelPluginTab', 'panelOrder', 'panelTabPlaces', 'toolPanel', 'toolWidth', 'lastToolPanel'] as const
const SHARED_KEYS = ['theme', 'scheme', 'textSize', 'corners', 'motion', 'fontUi', 'fontMono', 'diffView', 'filesView', 'terminalProfileId', 'terminalFontSize', 'terminalCursorStyle',
  'terminalCursorBlink', 'defaultMode', 'envEditMode', 'envExtraFiles', 'projectPrefs', 'sendKey', 'followUp', 'toolCalls', 'confirmArchive', 'confirmDelete', 'setupSeen', 'where',
  'openProjectIn'] as const

const initialState = () => {
    const prefs = loadPrefs()
    const firstRun = isFirstRun()
    return {
      recent: [] as ProjectInfo[],
      /** Projects open in this window (sidebar groups). */
      openProjects: [] as ProjectInfo[],
      /**
       * The main window's projects that are open in another window for now: they come back when that
       * window closes, and are remembered with the open ones.
       */
      lent: [] as ProjectInfo[],
      activeProjectPath: null as string | null,
      agents: [] as AgentInfo[],

      theme: (prefs.theme ?? 'dark') as Theme,
      scheme: (COLOR_SCHEMES.includes(prefs.scheme) || isPluginRef(prefs.scheme) ? prefs.scheme : 'mango') as SchemeId,
      textSize: (TEXT_SIZES.includes(prefs.textSize) ? prefs.textSize : 'default') as TextSize,
      corners: (CORNERS.includes(prefs.corners) ? prefs.corners : 'default') as Corners,
      fontUi: (UI_FONTS.includes(prefs.fontUi) ? prefs.fontUi : 'inter') as UiFont,
      fontMono: (MONO_FONTS.includes(prefs.fontMono) ? prefs.fontMono : 'jetbrains-mono') as MonoFont,
      motion: (MOTIONS.includes(prefs.motion) ? prefs.motion : 'system') as Motion,
      sidebarOpen: prefs.sidebarOpen ?? true,
      sidebarWidth: (prefs.sidebarWidth ?? 264) as number,

      terminalOpen: prefs.terminalOpen ?? false,
      /** fraction of the main column height */
      terminalHeight: (prefs.terminalHeight ?? 0.34) as number,
      terminalTabs: [] as TerminalTab[],
      activeTerminalId: null as string | null,
      /**
       * The plugin panel tab (`<pluginId>.<id>`) chosen in the bottom panel instead of a terminal, or null.
       * Kept while its plugin is not loaded yet or its `when()` is false: the panel shows the terminals then
       * (`activePanelTab`), and the tab again once it is back. A plugin that stops clears it (`plugin-host/api.ts`).
       */
      panelPluginTab: (isPanelTabRef(prefs.panelPluginTab) ? prefs.panelPluginTab : null) as string | null,
      /**
       * The panel strip's hand-made order: terminal ids and panel tab refs (see `panelStrip` in plugin-host/ids).
       * Empty until something is moved: then the terminals keep their own order. Only the refs are saved.
       */
      panelOrder: normalizePanelOrder(prefs.panelOrder) as string[],
      /** Where each plugin panel tab is when not in the panel (the main area, or closed), by ref; kept while its plugin is away. */
      panelTabPlaces: normalizePanelPlaces(prefs.panelTabPlaces) as Record<string, PanelTabPlace>,
      /** Shells found on this machine. */
      terminalProfiles: [] as TerminalProfile[],
      terminalProfilesLoading: false,
      /** The user's choice of shell for new terminals; null follows the system default. */
      terminalProfileId: (prefs.terminalProfileId ?? null) as string | null,
      terminalFontSize: (prefs.terminalFontSize ?? 12.5) as number,
      terminalCursorStyle: (prefs.terminalCursorStyle ?? 'bar') as CursorStyle,
      terminalCursorBlink: (prefs.terminalCursorBlink ?? true) as boolean,

      /** How diffs in the main pane are laid out. */
      diffView: (prefs.diffView === 'unified' ? 'unified' : 'split') as 'unified' | 'split',
      /** What the Files tree shows and how (its View options menu). */
      filesView: filesViewOf(prefs.filesView),
      /**
       * The tool window open on the right, or null. Older builds kept these views
       * in the left sidebar (`sidebarView`); one that was showing there opens here.
       */
      toolPanel: toolView(prefs.toolPanel !== undefined ? prefs.toolPanel : prefs.sidebarView),
      toolWidth: (prefs.toolWidth ?? 340) as number,
      /** The tool window shown last: what the titlebar's panel toggle brings back. */
      lastToolPanel: (toolView(prefs.lastToolPanel) ?? toolView(prefs.toolPanel) ?? 'changes') as ToolView,

      /** Settings > Projects > Environment variables: rows or plain text. */
      envEditMode: (prefs.envEditMode === 'raw' ? 'raw' : 'fields') as EnvEditMode,
      /** Extra env file names per project (see `envExtraOf`). Names only, never contents. */
      envExtraFiles: envExtraOf(prefs.envExtraFiles),

      /** Permission mode new chats start in. */
      defaultMode: (prefs.defaultMode ?? 'ask') as PermissionMode,
      sendKey: (prefs.sendKey === 'mod-enter' ? 'mod-enter' : 'enter') as SendKey,
      followUp: (prefs.followUp === 'steer' ? 'steer' : 'queue') as FollowUp,
      toolCalls: (['all', 'hide-ok', 'hide', 'zen'].includes(prefs.toolCalls) ? prefs.toolCalls : 'all') as ToolCalls,
      notify: notifyOf(prefs.notify),
      /** Keys the user changed, by action id (Settings > Shortcuts); `''` is a cleared key. Defaults live in utils/shortcuts. */
      shortcuts: cleanOverrides(prefs.shortcuts),
      /** A key is being recorded in Settings > Shortcuts: the shortcuts stand still. Not persisted. */
      recordingShortcut: false,
      /** Per-project overrides, by project path (Settings > Projects). */
      projectPrefs: projectPrefsOf(),
      /** Ask before archiving / deleting a chat (Settings > Preferences). */
      confirmArchive: (prefs.confirmArchive ?? false) as boolean,
      confirmDelete: (prefs.confirmDelete ?? true) as boolean,
      /** The question on screen (ConfirmDialog); null when none. Not persisted. */
      confirm: null as null | ConfirmAsk,
      /** Opening a project in a window that holds others: this window or a new one (Settings > Preferences). */
      openProjectIn: openProjectInOf(prefs.openProjectIn),
      /** The "This window or New window" question on screen (OpenWhereDialog); null when none. Not persisted. */
      openWhere: null as null | OpenWhereAsk,

      /** Settings view; the value is the section to show. */
      settings: null as null | SettingsSection,
      /** A block of the section to scroll to once it shows (Projects > Environment variables). Not persisted. */
      settingsAnchor: null as null | 'project-env' | 'project-mcp',
      /** which tab of Settings > Agents shows; not persisted */
      agentsTab: 'agents' as AgentsTab,

      paletteOpen: false,
      /**
       * which dialog is open: a project dialog ('open-env' picks a folder inside an environment),
       * "Get started" (setup) or the usage limits
       */
      dialog: null as null | 'new' | 'clone' | 'open-env' | 'setup' | 'usage',
      /**
       * Where Open folder, New project and Clone put a project: an environment, or null for this
       * computer. The last choice, remembered.
       */
      where: whereOf(prefs.where),
      /**
       * The "Get started" dialog was shown and closed. Unset in prefs from older
       * builds, which already ran: only a first run starts out false.
       */
      setupSeen: (prefs.setupSeen ?? !firstRun) as boolean,
    }
}

export const useWorkspace = defineStore('workspace', {
  state: initialState,

  getters: {
    /** The recent projects the lists show: archived ones are left out. */
    listedRecent: s => s.recent.filter(p => !s.projectPrefs[p.path]?.archived),
    activeProject: s => s.openProjects.find(p => p.path === s.activeProjectPath) ?? null,
    hasProject: s => s.openProjects.length > 0,
    /** Every action's key in force. */
    bindings: s => resolveBindings(s.shortcuts, pluginShortcutDefs()),
    /** The shell a plain "new terminal" starts: the user's choice if it still exists, else the system default. */
    defaultTerminalProfile: s =>
      s.terminalProfiles.find(p => p.id === s.terminalProfileId)
      ?? s.terminalProfiles.find(p => p.isDefault)
      ?? s.terminalProfiles[0]
      ?? null,
    /** The terminals in the docked panel, in order (the rest are tabs in the main area). */
    panelTerminals: s => s.terminalTabs.filter(t => !t.inEditor),
    /** The plugin tab the bottom panel shows (registered, `when()` holding), or null: it shows a terminal. */
    activePanelTab: (s): ReturnType<typeof shownPanelTab> => {
      const t = shownPanelTab(s.panelPluginTab)
      return t && !s.panelTabPlaces[t.fullId] ? t : null
    },
    /** The plugin panel tabs in the panel's strip now (registered, `when()` holding, not moved out or closed). */
    panelPluginTabs: (s): string[] => pluginReg.panelTabs.filter(t => !s.panelTabPlaces[t.fullId] && pluginShown(t)).map(t => t.fullId),
    /** The panel's strip, in order: terminal ids and panel tab refs. */
    panelStrip(): string[] {
      return panelStrip(this.panelOrder, this.panelTerminals.map(t => t.id), this.panelPluginTabs)
    },
  },

  actions: {
    /** An action's key written for a tooltip (`Ctrl+Shift+G`), or '' when it has none. Follows Settings > Shortcuts. */
    keyLabel(id: string): string {
      const k = this.bindings[id]
      return k ? comboLabel(k) : ''
    },
    /** The same, one string per key, for the palette's key caps. */
    keyParts(id: string): string[] {
      const k = this.bindings[id]
      return k ? comboParts(k) : []
    },
    /** `Label (Ctrl+N)`, or just the label when the action has no key. */
    withKey(label: string, id: string): string {
      const k = this.keyLabel(id)
      return k ? `${label} (${k})` : label
    },

    persist() {
      try {
        const all: Record<string, unknown> = {
          theme: this.theme,
          scheme: this.scheme,
          textSize: this.textSize,
          corners: this.corners,
          motion: this.motion,
          fontUi: this.fontUi,
          fontMono: this.fontMono,
          sidebarOpen: this.sidebarOpen,
          sidebarWidth: this.sidebarWidth,
          terminalOpen: this.terminalOpen,
          terminalHeight: this.terminalHeight,
          panelPluginTab: this.panelPluginTab,
          panelOrder: normalizePanelOrder(this.panelOrder),
          panelTabPlaces: this.panelTabPlaces,
          toolPanel: this.toolPanel,
          toolWidth: this.toolWidth,
          lastToolPanel: this.lastToolPanel,
          diffView: this.diffView,
          filesView: this.filesView,
          terminalProfileId: this.terminalProfileId,
          terminalFontSize: this.terminalFontSize,
          terminalCursorStyle: this.terminalCursorStyle,
          terminalCursorBlink: this.terminalCursorBlink,
          defaultMode: this.defaultMode,
          envEditMode: this.envEditMode,
          envExtraFiles: this.envExtraFiles,
          projectPrefs: this.projectPrefs,
          sendKey: this.sendKey,
          followUp: this.followUp,
          toolCalls: this.toolCalls,
          notify: this.notify,
          shortcuts: this.shortcuts,
          confirmArchive: this.confirmArchive,
          confirmDelete: this.confirmDelete,
          setupSeen: this.setupSeen,
          where: this.where,
          openProjectIn: this.openProjectIn,
          openProjects: [...this.openProjects, ...this.lent].map(p => p.path),
          activeProjectPath: this.activeProjectPath,
        }
        // Another window writes the shared prefs only; the main window's layout and projects stay.
        if (!useWindows().isMain) {
          const stored = loadPrefs()
          for (const k of WINDOW_KEYS) {
            if (k in stored) all[k] = stored[k]
            else delete all[k]
          }
        }
        localStorage.setItem(LS_KEY, JSON.stringify(all))
      } catch { /* storage unavailable: prefs just don't persist */ }
    },

    /** Another window changed the shared prefs: take them over (the theme with them). */
    syncShared() {
      const fresh = initialState() as Record<string, unknown>
      const self = this as unknown as Record<string, unknown>
      for (const k of SHARED_KEYS) {
        if (JSON.stringify(self[k]) !== JSON.stringify(fresh[k])) self[k] = fresh[k]
      }
      this.applyTheme()
    },

    async init() {
      this.applyTheme()
      // "System" follows the OS while the app is open.
      window.matchMedia?.('(prefers-color-scheme: light)').addEventListener?.('change', () => this.applyTheme())
      window.matchMedia?.('(prefers-reduced-motion: reduce)').addEventListener?.('change', () => this.applyTheme())
      // Prefs changed in another window.
      window.addEventListener('storage', (e) => { if (e.key === LS_KEY) this.syncShared() })
      const win = useWindows()
      const [recent, agents] = await Promise.all([
        call('recent_projects').catch(() => [] as ProjectInfo[]),
        call('detect_agents').catch(() => [] as AgentInfo[]),
      ])
      this.recent = mergeRecent(recent)
      this.loadTerminalProfiles()
      this.agents = agents.map(a => ({ ...a, version: shortVersion(a.version) }))
      if (!win.isMain) return this._initWindow()
      // Reopen the projects that were open last time.
      const prefs = loadPrefs()
      const paths: string[] = prefs.openProjects ?? []
      // Built fresh so running init twice (hot reload) cannot list a project twice.
      const reopened: ProjectInfo[] = []
      for (const path of new Set(paths)) {
        const info = this.recent.find(r => r.path === path)
        if (info) reopened.push(info)
      }
      // Ones open in another window wait for it to close.
      this.openProjects = reopened.filter(p => !win.projectElsewhere(p.path))
      this.lent = reopened.filter(p => win.projectElsewhere(p.path))
      loadHostsFor(this.recent)
      this.activeProjectPath = this.openProjects.find(p => p.path === prefs.activeProjectPath)?.path
        ?? this.openProjects[0]?.path ?? null
      // First run (the main window only): offer to install what is missing. Written now, so
      // quitting halfway brings the dialog back next time.
      if (!this.setupSeen) {
        this.persist()
        this.dialog = 'setup'
      }
    },

    /**
     * A window other than the main one: open what it was opened on. A chat window shows its chat's
     * project (the project itself may stay open in another window: the chat is what it holds).
     */
    async _initWindow() {
      const win = useWindows()
      this.openProjects = []
      this.activeProjectPath = null
      const path = win.spec.kind === 'main' ? null : win.spec.path
      if (!path) return
      try {
        await this._openHere(path)
      } catch (e) {
        win.refused = e instanceof Error ? e.message : String(e)
      }
    },

    /** The main window's project went to another window: it comes back when that window closes. */
    lend(path: string) {
      const p = this.openProjects.find(o => o.path === path)
      if (!p) return
      this.openProjects = this.openProjects.filter(o => o.path !== path)
      if (useWindows().isMain && !this.lent.some(l => l.path === path)) this.lent.push(p)
      if (this.activeProjectPath === path) this.activeProjectPath = this.openProjects[0]?.path ?? null
      this.persist()
    },

    /** Projects lent to another window that no window holds any more: open here again. */
    takeBackLent() {
      const win = useWindows()
      const back = this.lent.filter(p => !win.projectElsewhere(p.path))
      if (!back.length) return
      this.lent = this.lent.filter(p => !back.includes(p))
      for (const p of back) if (!this.openProjects.some(o => o.path === p.path)) this.openProjects.push(p)
      this.activeProjectPath ??= this.openProjects[0]?.path ?? null
      this.persist()
    },

    /**
     * The main window was closed while others are open (it is hidden, see `stores/windows.ts`):
     * it lets go of its projects, so the other windows may open them, and of the ones it lent.
     */
    park() {
      this.openProjects = []
      this.lent = []
      this.activeProjectPath = null
      this.settings = null
      this.persist()
    },

    /**
     * The last window on screen is closing while the main window is parked: its projects become
     * the ones the main window reopens next time Mango starts.
     */
    handOverSession() {
      try {
        const stored = loadPrefs()
        stored.openProjects = this.openProjects.map(p => p.path)
        stored.activeProjectPath = this.activeProjectPath
        localStorage.setItem(LS_KEY, JSON.stringify(stored))
      } catch { /* storage unavailable: nothing to reopen */ }
    },

    async refreshRecent() {
      this.recent = mergeRecent(await call('recent_projects').catch(() => this.recent))
    },

    /** Add a project (already validated by the backend) to the window and focus it. */
    adopt(info: ProjectInfo) {
      if (this.projectPrefs[info.path]?.archived) this.setProjectPref(info.path, { archived: null })
      info = named(info, this.projectPrefs)
      const i = this.openProjects.findIndex(p => p.path === info.path)
      if (i === -1) this.openProjects.push(info)
      else this.openProjects[i] = info
      this.activeProjectPath = info.path
      this.recent = [info, ...this.recent.filter(r => r.path !== info.path)]
      if (isEnvPath(info.path)) saveEnvProjects([info, ...loadEnvProjects().filter(r => r.path !== info.path)])
      this.dialog = null
      this.persist()
    },

    /**
     * Open a folder on this computer, or a remote project by its `env://` path. Open in another
     * window already: that window comes to the front instead.
     */
    async openProject(path: string) {
      const win = useWindows()
      const elsewhere = win.projectElsewhere(path)
      if (elsewhere) {
        await win.focus(elsewhere)
        return this.recent.find(r => r.path === path) ?? null
      }
      return this._openHere(path)
    },

    async _openHere(path: string) {
      const loc = parseEnvPath(path)
      if (loc) return this._openEnv(loc)
      const info = await call('open_project', { path })
      this.adopt(info)
      return info
    },

    /**
     * `openProject` for the user's own Open (recent list, palette, Open folder): in a window that
     * already holds other projects, it goes where the user says (`chooseWhere`).
     */
    async openProjectAsking(path: string) {
      const where = await this.chooseWhere(path, this.recent.find(r => r.path === path)?.name ?? folderName(path))
      if (where === 'this') return this.openProject(path)
      if (where === 'new') await this.openInWindow(path)
      return null
    },

    /**
     * Where the project the user is opening goes: this window, a new one, or nowhere (null: the
     * question was cancelled). Asks only when there is a choice (`whereToOpen`) and none was remembered.
     */
    async chooseWhere(path: string, name: string): Promise<'this' | 'new' | null> {
      const win = useWindows()
      const decided = whereToOpen({
        pref: this.openProjectIn,
        windowKind: win.spec.kind,
        openHere: this.openProjects.map(p => p.path),
        path,
        elsewhere: !!win.projectElsewhere(path),
      })
      if (decided !== 'ask') return decided
      this.openWhere?.answer(null)
      return new Promise((resolve) => {
        const ask: OpenWhereAsk = {
          name,
          answer: (choice) => {
            // The store holds it behind a reactive proxy: compare the object itself.
            if (this.openWhere && toRaw(this.openWhere) === ask) this.openWhere = null
            resolve(choice)
          },
        }
        this.openWhere = ask
        this.paletteOpen = false
      })
    },

    /** The question's answer; `remember` keeps it for next time (Settings > Preferences sets it back). */
    answerWhere(choice: 'this' | 'new' | null, remember = false) {
      if (choice && remember) {
        this.openProjectIn = choice
        this.persist()
      }
      this.openWhere?.answer(choice)
    },

    /** A project the user chose to open in a new window; when it cannot move now, they are told why. */
    async openInWindow(path: string) {
      this.dialog = null
      try {
        await useWindows().openProjectWindow(path)
      } catch (e) {
        this.notify('Not opened in a new window', e instanceof Error ? e.message : String(e))
      }
    },

    /** A project just created or cloned (`info` from the backend): open it where the user says. */
    async placeProject(info: ProjectInfo): Promise<'this' | 'new' | null> {
      this.dialog = null
      const where = await this.chooseWhere(info.path, info.name)
      if (where === 'this') this.adopt(info)
      else if (where === 'new') await this.openInWindow(info.path)
      else await this.refreshRecent()
      return where
    },

    /**
     * Open (or switch to) a folder inside a remote environment as a project. Nothing on this
     * computer's disk is involved: chats run their agent in the instance, terminals open a shell there.
     * `name` defaults to the folder's name (the instance's for `/`), or the name it was opened with before.
     * In a window that holds other projects it goes where the user says (`chooseWhere`); the result
     * says where it went (null: nowhere, the question was cancelled).
     */
    async openEnvProject(loc: EnvLocation, name?: string): Promise<'this' | 'new' | null> {
      const path = envPath(loc)
      const elsewhere = useWindows().projectElsewhere(path)
      if (elsewhere) {
        this.settings = null
        await useWindows().focus(elsewhere)
        return 'new'
      }
      const known = this.recent.find(r => r.path === path)
      const where = await this.chooseWhere(path, name?.trim() || known?.name || envProjectName(loc))
      if (!where) return null
      if (where === 'new') {
        // The new window opens it by its path alone: the name it was given travels in the saved list.
        const info = envInfo(loc, name?.trim() || known?.name || envProjectName(loc), Date.now())
        saveEnvProjects([info, ...loadEnvProjects().filter(r => r.path !== path)])
        await this.openInWindow(path)
        return 'new'
      }
      this._openEnv(loc, name)
      // Opened from Settings > Environments: show the project.
      this.settings = null
      return 'this'
    },

    _openEnv(loc: EnvLocation, name?: string): ProjectInfo {
      const known = this.recent.find(r => r.path === envPath(loc))
      const info = envInfo(loc, name?.trim() || known?.name || envProjectName(loc), Date.now())
      this.adopt(info)
      loadHostsFor([info])
      return info
    },

    setEnvEditMode(mode: EnvEditMode) {
      this.envEditMode = mode
      this.persist()
    },
    /** Remember (or forget) an env file name `env_files` would not find by its pattern. */
    setEnvExtraFile(root: string, name: string, on: boolean) {
      const now = this.envExtraFiles[root] ?? []
      const next = on ? [...new Set([...now, name])] : now.filter(n => n !== name)
      const all = { ...this.envExtraFiles }
      if (next.length) all[root] = next
      else delete all[root]
      this.envExtraFiles = all
      this.persist()
    },

    /** A removed project's remembered env file names go with it. */
    forgetEnvExtraFiles(root: string) {
      if (!(root in this.envExtraFiles)) return
      const all = { ...this.envExtraFiles }
      delete all[root]
      this.envExtraFiles = all
      this.persist()
    },

    /**
     * An environment's instance was renamed: its projects, their prefs, remembered env files, the
     * place for new projects and its terminals follow it to `env://<hostId>/<to>/…`.
     */
    moveEnvInstance(hostId: string, from: string, to: string) {
      const move = (p: string) => movedEnvPath(p, hostId, from, to) ?? p
      const moveInfo = (p: ProjectInfo): ProjectInfo => {
        const path = movedEnvPath(p.path, hostId, from, to)
        if (!path) return p
        // A project at the instance's root is named after it unless the user named it.
        const root = parseEnvPath(path)!.dir === '/'
        return { ...p, path, name: root && p.name === from ? to : p.name }
      }
      const moveKeys = <T>(o: Record<string, T>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [move(k), v]))
      saveEnvProjects(loadEnvProjects().map(moveInfo))
      this.recent = this.recent.map(moveInfo)
      this.openProjects = this.openProjects.map(moveInfo)
      if (this.activeProjectPath) this.activeProjectPath = move(this.activeProjectPath)
      this.projectPrefs = moveKeys(this.projectPrefs)
      this.envExtraFiles = moveKeys(this.envExtraFiles)
      if (this.where?.hostId === hostId && this.where.instance === from) this.where = { hostId, instance: to }
      for (const t of this.terminalTabs) {
        const cwd = movedEnvPath(t.cwd, hostId, from, to)
        if (!cwd) continue
        t.cwd = cwd
        if (t.title === from) t.title = to
      }
      this.persist()
    },

    /** Remember where new projects go (null: this computer). */
    setWhere(where: EnvRemote | null) {
      this.where = where ? { hostId: where.hostId, instance: where.instance } : null
      this.persist()
    },

    /**
     * The live terminals of a project in this window: opened in its folder (or a chat's worktree of it,
     * or inside it), or shown as one of its tabs. A shell runs in the window that started it, so these
     * keep the project in this window (`stores/windows.ts`).
     */
    terminalsOf(path: string): TerminalTab[] {
      const threads = useThreads()
      const inside = (dir: string | null) => !!dir && (dir === path || threads.ownerOf(dir) === path || dir.startsWith(withTrailingSep(path)))
      return this.terminalTabs.filter(t => !t.exited && (inside(t.cwd) || threads.tabs.some(id => parseTerminalTab(id)?.terminalId === t.id && parseTerminalTab(id)?.projectPath === path)))
    },

    closeProject(path: string) {
      this.openProjects = this.openProjects.filter(p => p.path !== path)
      if (this.activeProjectPath === path) this.activeProjectPath = this.openProjects[0]?.path ?? null
      this.persist()
    },

    async forgetProject(path: string) {
      if (isEnvPath(path)) saveEnvProjects(loadEnvProjects().filter(r => r.path !== path))
      else await call('forget_project', { path }).catch(() => {})
      this.recent = this.recent.filter(r => r.path !== path)
    },

    setActiveProject(path: string) {
      this.activeProjectPath = path
      this.persist()
    },

    /* ---------- theme ---------- */
    setTheme(theme: Theme) {
      this.theme = theme
      this.applyTheme()
      this.persist()
    },
    setScheme(scheme: SchemeId) {
      this.scheme = scheme
      this.applyTheme()
      this.persist()
    },
    setTextSize(textSize: TextSize) {
      this.textSize = textSize
      this.applyTheme()
      this.persist()
    },
    setCorners(corners: Corners) {
      this.corners = corners
      this.applyTheme()
      this.persist()
    },
    setFonts(patch: { ui?: UiFont; mono?: MonoFont }) {
      if (patch.ui) this.fontUi = patch.ui
      if (patch.mono) this.fontMono = patch.mono
      this.applyTheme()
      this.persist()
    },
    setMotion(motion: Motion) {
      this.motion = motion
      this.applyTheme()
      this.persist()
    },
    cycleTheme() {
      this.setTheme(this.resolvedTheme() === 'dark' ? 'light' : 'dark')
    },
    resolvedTheme(): 'dark' | 'light' {
      if (this.theme !== 'system') return this.theme
      return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
    },
    applyTheme() {
      const root = document.documentElement.dataset
      root.theme = this.resolvedTheme()
      root.scheme = effectiveScheme(this.scheme, isPluginSchemeRegistered)
      root.textSize = this.textSize
      root.corners = this.corners
      root.fontUi = this.fontUi === 'inter' ? '' : this.fontUi
      root.fontMono = this.fontMono === 'jetbrains-mono' ? '' : this.fontMono
      root.motion = this.motion === 'system'
        ? (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'reduced' : 'full')
        : this.motion
    },

    /* ---------- layout ---------- */
    toggleSidebar() {
      this.sidebarOpen = !this.sidebarOpen
      this.persist()
    },
    setSidebarWidth(w: number) {
      this.sidebarWidth = Math.round(Math.min(560, Math.max(200, w)))
    },

    /** Open a tool window on the right. */
    openTool(view: ToolView) {
      this.toolPanel = view
      this.lastToolPanel = view
      this.persist()
    },
    /** Show a tool window; again (or `force` false) to close it. */
    toggleTool(view: ToolView, force?: boolean) {
      const showing = this.toolPanel === view
      this.toolPanel = (force ?? !showing) ? view : null
      if (this.toolPanel) this.lastToolPanel = this.toolPanel
      this.persist()
    },
    /** Show the tool window used last, or put the open one away. */
    toggleToolPanel(force?: boolean) {
      const show = force ?? !this.toolPanel
      this.toolPanel = show ? (this.toolPanel ?? this.lastToolPanel) : null
      if (this.toolPanel) this.lastToolPanel = this.toolPanel
      this.persist()
    },
    closeTool() {
      this.toolPanel = null
      this.persist()
    },
    setToolWidth(w: number) {
      this.toolWidth = Math.round(Math.min(640, Math.max(260, w)))
    },
    /** Show source control on the right; again to close it. */
    toggleGit(force?: boolean) {
      this.toggleTool('changes', force)
    },
    /** Show the chat's pull requests and issues on the right; again to close it. */
    toggleLinks(force?: boolean) {
      this.toggleTool('links', force)
    },
    /** Show the project's GitHub releases and the runs that build them on the right; again to close it. */
    toggleReleases(force?: boolean) {
      this.toggleTool('releases', force)
    },
    /** Show where the project runs (this computer or an environment) on the right; again to close it. */
    toggleEnv(force?: boolean) {
      this.toggleTool('env', force)
    },
    setFilesView(patch: Partial<FilesView>) {
      this.filesView = { ...this.filesView, ...patch }
      this.persist()
    },
    /** Show the project's files on the right; again to close it. */
    toggleFiles(force?: boolean) {
      this.toggleTool('files', force)
    },
    /**
     * Change what one project overrides. An empty or missing value goes back to the default; a name
     * that equals the folder's is no override.
     */
    setProjectPref(path: string, patch: Partial<Record<keyof ProjectPrefs, ProjectPrefs[keyof ProjectPrefs] | null>>) {
      const next: Record<string, unknown> = { ...this.projectPrefs[path], ...patch }
      for (const k of Object.keys(next)) if (next[k] === null || next[k] === undefined || next[k] === '' || next[k] === false) delete next[k]
      if (Object.keys(next).length) this.projectPrefs[path] = next as ProjectPrefs
      else delete this.projectPrefs[path]
      this.persist()
      // Names are baked into the project lists: refresh them (the folder's own name comes from the recent list's source).
      const folder = (p: ProjectInfo) => (isEnvPath(p.path) ? envProjectName(parseEnvPath(p.path)!) : baseName(p.path))
      const rename = (p: ProjectInfo) => (p.path === path ? { ...p, name: this.projectPrefs[path]?.name ?? folder(p) } : p)
      this.openProjects = this.openProjects.map(rename)
      this.recent = this.recent.map(rename).sort(byPinned(this.projectPrefs))
    },
    /** Run `run` now, or after the user agrees when that kind of action is set to ask first. */
    confirmThen(kind: 'archive' | 'delete', ask: Omit<ConfirmAsk, 'run'>, run: () => void) {
      if (!(kind === 'archive' ? this.confirmArchive : this.confirmDelete)) return run()
      this.confirm = { ...ask, run }
    },
    /** Tell the user something that did not happen and why (one OK button). */
    notify(title: string, body: string) {
      this.confirm = { title, body, label: 'OK', info: true, run: () => {} }
    },
    openSettings(section: SettingsSection = 'general', tab?: AgentsTab) {
      this.settings = section
      if (tab) this.agentsTab = tab
      this.paletteOpen = false
    },
    /** Settings > Projects for the active project, scrolled to its environment variables. */
    openProjectEnv() {
      this.settingsAnchor = 'project-env'
      this.openSettings('projects')
    },
    /** Settings > Projects for the active project, scrolled to its MCP servers. */
    openProjectMcp() {
      this.settingsAnchor = 'project-mcp'
      this.openSettings('projects')
    },
    openUsage() {
      this.dialog = 'usage'
      this.paletteOpen = false
    },
    openSetup() {
      this.dialog = 'setup'
      this.paletteOpen = false
    },
    closeSetup() {
      if (this.dialog === 'setup') this.dialog = null
      this.setupSeen = true
      this.persist()
      // Something may have been installed: let the rest of the app see it.
      this.refreshAgents()
    },
    async refreshAgents() {
      const agents = await call('detect_agents').catch(() => this.agents)
      this.agents = agents.map(a => ({ ...a, version: shortVersion(a.version) }))
    },

    /* ---------- terminal ---------- */
    /**
     * Show or hide the bottom panel. Without `force` it is about the terminals (the Terminal button, its
     * shortcut): it hides the panel while they show, and otherwise shows them, also over a plugin tab.
     */
    toggleTerminal(force?: boolean) {
      if (force === undefined && this.activePanelTab) {
        this.panelPluginTab = null
        this.terminalOpen = false
        force = true
      }
      this.terminalOpen = force ?? !this.terminalOpen
      if (this.terminalOpen && !this.activePanelTab) {
        // A remote project's terminal is a shell in its environment: show one (open it when there is none yet).
        const path = this.activeProjectPath
        if (isEnvPath(path)) {
          const tab = this.panelTerminals.find(t => t.cwd === path && !t.exited)
          if (tab) this.activeTerminalId = tab.id
          else this.newTerminal()
        } else if (this.panelTerminals.length === 0) this.newTerminal()
      }
      this.persist()
    },
    /**
     * Bring a plugin's panel tab (`<pluginId>.<id>`) into view: its tab in the main area when it is there,
     * else the panel at it (a closed one comes back into the panel). No shell is started for it.
     */
    openPanelTab(ref: string) {
      const place = this.panelTabPlaces[ref]
      if (place?.at === 'editor') {
        this._addPanelEditorTab(ref)
        const tabId = this.panelEditorTab(ref)
        if (tabId) useThreads().show(tabId)
        return
      }
      if (place) delete this.panelTabPlaces[ref]
      this.panelPluginTab = ref
      this.terminalOpen = true
      this.persist()
    },
    /** A panel tab's tab in the main area, if it has one. */
    panelEditorTab(ref: string): string | null {
      return useThreads().tabs.find(id => parsePanelEditorTab(id)?.ref === ref) ?? null
    },
    /** Put a panel tab placed in the main area back into its pane's strip (its plugin is back, or a reload), without showing it. */
    _addPanelEditorTab(ref: string) {
      const place = this.panelTabPlaces[ref]
      if (place?.at !== 'editor' || this.panelEditorTab(ref)) return
      const threads = useThreads()
      const tabId = panelEditorTabId(place.projectPath, ref)
      threads.addTab(tabId)
      if (threads.panes.some(p => p.id === place.paneId)) threads._setGroup(tabId, place.paneId)
    },
    /**
     * Keep the main area in step with the panel tabs: a tab for each registered one placed there, and none
     * for one whose plugin is away (its place is remembered, with the pane it was in) or that moved elsewhere.
     */
    syncPanelEditorTabs() {
      const threads = useThreads()
      const live = new Set(pluginReg.panelTabs.map(t => t.fullId))
      for (const id of [...threads.tabs]) {
        const p = parsePanelEditorTab(id)
        if (!p) continue
        const place = this.panelTabPlaces[p.ref]
        if (live.has(p.ref) && place?.at === 'editor') continue
        if (place?.at === 'editor') place.paneId = threads.groupOf(id)
        threads.removeTab(id)
      }
      for (const ref of live) this._addPanelEditorTab(ref)
    },
    /** A panel tab leaves the panel's view: the strip's neighbour shows instead (a terminal or another tab); with none, the panel hides. */
    _panelTabLeaving(ref: string) {
      if (this.panelPluginTab !== ref) return
      const strip = this.panelStrip
      const i = strip.indexOf(ref)
      const next = (i > 0 ? strip[i - 1] : strip[i + 1]) ?? null
      this.panelPluginTab = null
      if (next && isPanelTabRef(next)) this.panelPluginTab = next
      else if (next) this.activeTerminalId = next
      else this.terminalOpen = false
    },
    /** Close a panel tab wherever it is. Nothing is lost: its button, `panelTabs.open` or a command brings it back into the panel. */
    closePanelTab(ref: string) {
      if (this.panelTabPlaces[ref]?.at !== 'editor') this._panelTabLeaving(ref)
      const tabId = this.panelEditorTab(ref)
      this.panelTabPlaces[ref] = { at: 'closed' }
      if (tabId) useThreads().removeTab(tabId)
      this.persist()
    },
    /** Show a panel tab as a tab in the main area (like `moveTerminalToEditor`); it belongs to the project in view. */
    movePanelTabToEditor(ref: string, at: TerminalPlacement = {}) {
      const project = this.activeProjectPath
      if (!project) return
      const threads = useThreads()
      if (this.panelTabPlaces[ref]?.at !== 'editor') this._panelTabLeaving(ref)
      const tabId = this.panelEditorTab(ref) ?? panelEditorTabId(project, ref)
      const projectPath = parsePanelEditorTab(tabId)!.projectPath
      // Placed first: the main area keeps this tab only while its place says so (`syncPanelEditorTabs`).
      this.panelTabPlaces[ref] = { at: 'editor', projectPath, paneId: threads.activePaneId }
      if (at.before !== undefined) threads.placeTab(tabId, at.before)
      else threads.addTab(tabId, threads.activePane.threadId)
      threads.showOnly(tabId, at.split ? 'split' : at.paneId ?? threads.activePaneId)
      this.panelTabPlaces[ref] = { at: 'editor', projectPath, paneId: threads.groupOf(tabId) }
      this.persist()
    },
    /** Dock a panel tab in the panel before `before` (a strip key; null: at the end; left out: where it was) and show it there. */
    movePanelTabToPanel(ref: string, before?: string | null) {
      const tabId = this.panelEditorTab(ref)
      delete this.panelTabPlaces[ref]
      if (tabId) useThreads().removeTab(tabId)
      if (before !== undefined) this.panelOrder = placeBefore(this.panelStrip, ref, before)
      this.panelPluginTab = ref
      this.terminalOpen = true
      this.persist()
    },
    /** Show a terminal of the panel (the active one when left out) instead of a plugin tab; starts a shell when there is none. */
    showTerminals(id?: string) {
      const changed = this.panelPluginTab !== null || !this.terminalOpen
      this.panelPluginTab = null
      if (id && this.panelTerminals.some(t => t.id === id)) this.activeTerminalId = id
      if (this.panelTerminals.length === 0) this.newTerminal()
      this.terminalOpen = true
      if (changed) this.persist()
    },
    setTerminalHeight(fraction: number) {
      this.terminalHeight = Math.min(0.8, Math.max(0.14, fraction))
    },
    /** Look for shells on this machine (again). */
    async loadTerminalProfiles() {
      this.terminalProfilesLoading = true
      try {
        this.terminalProfiles = await call('terminal_profiles')
      } catch { /* keep what we had; terminals fall back to the system default */ }
      this.terminalProfilesLoading = false
    },
    setTerminalProfile(id: string | null) {
      this.terminalProfileId = id
      this.persist()
    },
    setTerminalFontSize(size: number) {
      this.terminalFontSize = Math.min(22, Math.max(9, Math.round(size * 2) / 2))
      this.persist()
    },
    /** `profileId` picks a shell for this one terminal; omitted, the default shell is used. */
    /**
     * Open a terminal tab. `cwd` defaults to the working copy in view (the active chat's worktree, else the
     * active project): for a remote project that is a shell in its
     * environment. Picking a local shell (`profileId`) always runs on this computer, in the home folder when the
     * project is remote.
     */
    newTerminal(cwd?: string | null, profileId?: string | null, inEditor = false) {
      const id = `term-${++tabSeq}`
      let dir = cwd ?? useThreads().workdir ?? this.activeProjectPath
      if (profileId && isEnvPath(dir)) dir = null
      // In a remote project the terminal is a shell inside the instance (TerminalView starts it with `env_shell`).
      const remote = parseEnvPath(dir)
      const profile = remote ? null : this.terminalProfiles.find(p => p.id === profileId) ?? this.defaultTerminalProfile
      this.terminalTabs.push({
        id,
        title: remote ? remote.instance : dir ? baseName(dir) : 'shell',
        cwd: dir,
        ptyId: null,
        exited: false,
        profileId: profile?.id ?? null,
        shell: profile?.name ?? null,
      })
      if (inEditor && this.activeProjectPath) {
        this.moveTerminalToEditor(id)
        return id
      }
      this.activeTerminalId = id
      this.panelPluginTab = null
      this.terminalOpen = true
      return id
    },
    /** Close a terminal wherever it is (the panel or a main-area tab) and end its shell. */
    closeTerminal(id: string) {
      const i = this.terminalTabs.findIndex(t => t.id === id)
      if (i === -1) return
      const [tab] = this.terminalTabs.splice(i, 1)
      if (tab?.ptyId && !tab.exited) call('pty_kill', { id: tab.ptyId }).catch(() => {})
      if (tab?.inEditor) {
        const threads = useThreads()
        const editorTab = editorTabOf(threads.tabs, id)
        if (editorTab) threads.removeTab(editorTab)
      }
      this._afterPanelLeft(id, i)
      this.persist()
    },
    /** A terminal left the panel (closed or moved to the main area): pick the next one, or hide the panel when it is empty. */
    _afterPanelLeft(id: string, index: number) {
      const panel = this.panelTerminals
      if (this.activeTerminalId === id || !panel.some(t => t.id === this.activeTerminalId)) {
        const before = this.terminalTabs.slice(0, index).filter(t => !t.inEditor)
        this.activeTerminalId = before[before.length - 1]?.id ?? panel[0]?.id ?? null
      }
      // A plugin tab showing keeps the panel up without terminals.
      if (panel.length === 0 && !this.activePanelTab) {
        const tab = this.panelPluginTabs[0]
        if (tab && this.terminalOpen) this.panelPluginTab = tab
        else this.terminalOpen = false
      }
    },
    /**
     * Show a terminal as a tab in the main area, with the same shell and scrollback (TerminalPanel
     * keeps the xterm and moves it into the pane). Its tab belongs to the project in view.
     */
    moveTerminalToEditor(id: string, at: TerminalPlacement = {}) {
      const tab = this.terminalTabs.find(t => t.id === id)
      const project = this.activeProjectPath
      if (!tab || !project) return
      const threads = useThreads()
      const tabId = editorTabOf(threads.tabs, id) ?? terminalTabId(project, id)
      const wasInPanel = !tab.inEditor
      tab.inEditor = true
      if (at.before !== undefined) threads.placeTab(tabId, at.before)
      else threads.addTab(tabId, threads.activePane.threadId)
      threads.showOnly(tabId, at.split ? 'split' : at.paneId ?? threads.activePaneId)
      if (wasInPanel) this._afterPanelLeft(id, this.terminalTabs.indexOf(tab))
    },
    /** Dock a main-area terminal in the panel again, before `before` (a terminal id; null or left out: at the end). */
    moveTerminalToPanel(id: string, before: string | null = null) {
      const tab = this.terminalTabs.find(t => t.id === id)
      if (!tab) return
      if (tab.inEditor) {
        const threads = useThreads()
        const editorTab = editorTabOf(threads.tabs, id)
        if (editorTab) threads.removeTab(editorTab)
        tab.inEditor = false
      }
      const target = before ? this.terminalTabs.find(t => t.id === before) ?? null : null
      this.terminalTabs = placeBefore(this.terminalTabs, tab, target)
      // With panel tabs in the strip, its order says where the terminal goes among them.
      if (this.panelOrder.length || (before && isPanelTabRef(before))) this.panelOrder = placeBefore(this.panelStrip, id, before)
      this.activeTerminalId = id
      this.panelPluginTab = null
      this.terminalOpen = true
      this.persist()
    },
  },
})
