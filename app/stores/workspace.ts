import { defineStore } from 'pinia'
import type { AgentInfo, EnvRemote, ProjectInfo, TerminalProfile } from '~/types/ipc'
import type { PermissionMode } from '~/agents/types'
import { call } from '~/composables/useBackend'
import { baseName } from '~/utils/paths'
import { shortVersion } from '~/utils/agentCli'
import { envPath, isEnvPath, parseEnvPath, type EnvLocation } from '~/utils/envPath'
import { useEnvironments } from '~/stores/environments'
import { useThreads } from '~/stores/threads'

export type Theme = 'dark' | 'light' | 'system'
/** Colour scheme: the tint of the grounds and the accent family (see tokens.css). */
export const COLOR_SCHEMES = ['mango', 'blue', 'purple', 'pink', 'graphite'] as const
export type ColorScheme = typeof COLOR_SCHEMES[number]

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
}

/**
 * The tool windows that open on the right: where the project runs (this computer or an environment),
 * the project's files, source control, and the chat's pull requests and issues.
 */
export type ToolView = 'env' | 'files' | 'changes' | 'links'
export type CursorStyle = 'bar' | 'block' | 'underline'
export type AgentsTab = 'agents' | 'subscription' | 'usage'
export type SettingsSection = 'agents' | 'environments' | 'terminal' | 'voice' | 'appearance' | 'general'

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

/** The backend's recent folders and the remote projects, most recent first. */
const mergeRecent = (local: ProjectInfo[]) =>
  [...local.filter(p => !isEnvPath(p.path)), ...loadEnvProjects()].sort((a, b) => b.lastOpened - a.lastOpened)

/** Server names label remote projects: read the saved servers once one is around. */
function loadHostsFor(projects: ProjectInfo[]) {
  if (!projects.some(p => isEnvPath(p.path))) return
  const envs = useEnvironments()
  if (!envs.loaded) envs.load().catch(() => {})
}

const toolView = (v: unknown): ToolView | null => (v === 'env' || v === 'files' || v === 'changes' || v === 'links' ? v : null)

/** A remembered place for new projects: an environment, or null for this computer (and for anything unreadable). */
const whereOf = (v: unknown): EnvRemote | null => {
  const o = v as Partial<EnvRemote> | null
  return o && typeof o.hostId === 'string' && o.hostId && typeof o.instance === 'string' && o.instance
    ? { hostId: o.hostId, instance: o.instance }
    : null
}

let tabSeq = 0

export const useWorkspace = defineStore('workspace', {
  state: () => {
    const prefs = loadPrefs()
    const firstRun = isFirstRun()
    return {
      recent: [] as ProjectInfo[],
      /** Projects open in this window (sidebar groups). */
      openProjects: [] as ProjectInfo[],
      activeProjectPath: null as string | null,
      agents: [] as AgentInfo[],

      theme: (prefs.theme ?? 'dark') as Theme,
      scheme: (COLOR_SCHEMES.includes(prefs.scheme) ? prefs.scheme : 'mango') as ColorScheme,
      sidebarOpen: prefs.sidebarOpen ?? true,
      sidebarWidth: (prefs.sidebarWidth ?? 264) as number,

      terminalOpen: prefs.terminalOpen ?? false,
      /** fraction of the main column height */
      terminalHeight: (prefs.terminalHeight ?? 0.34) as number,
      terminalTabs: [] as TerminalTab[],
      activeTerminalId: null as string | null,
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
      /**
       * The tool window open on the right, or null. Older builds kept these views
       * in the left sidebar (`sidebarView`); one that was showing there opens here.
       */
      toolPanel: toolView(prefs.toolPanel !== undefined ? prefs.toolPanel : prefs.sidebarView),
      toolWidth: (prefs.toolWidth ?? 340) as number,

      /** Permission mode new chats start in. */
      defaultMode: (prefs.defaultMode ?? 'ask') as PermissionMode,

      /** Settings view; the value is the section to show. */
      settings: null as null | SettingsSection,
      /** which tab of Settings > Agents shows; not persisted */
      agentsTab: 'agents' as AgentsTab,

      paletteOpen: false,
      /**
       * which dialog is open: a project dialog ('open-env' picks a folder inside an environment),
       * "Get started" (setup) or the usage limits
       */
      dialog: null as null | 'new' | 'clone' | 'open-env' | 'setup' | 'usage' | 'worktree',
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
  },

  getters: {
    activeProject: s => s.openProjects.find(p => p.path === s.activeProjectPath) ?? null,
    hasProject: s => s.openProjects.length > 0,
    /** The shell a plain "new terminal" starts: the user's choice if it still exists, else the system default. */
    defaultTerminalProfile: s =>
      s.terminalProfiles.find(p => p.id === s.terminalProfileId)
      ?? s.terminalProfiles.find(p => p.isDefault)
      ?? s.terminalProfiles[0]
      ?? null,
  },

  actions: {
    persist() {
      try {
        localStorage.setItem(LS_KEY, JSON.stringify({
          theme: this.theme,
          scheme: this.scheme,
          sidebarOpen: this.sidebarOpen,
          sidebarWidth: this.sidebarWidth,
          terminalOpen: this.terminalOpen,
          terminalHeight: this.terminalHeight,
          toolPanel: this.toolPanel,
          toolWidth: this.toolWidth,
          diffView: this.diffView,
          terminalProfileId: this.terminalProfileId,
          terminalFontSize: this.terminalFontSize,
          terminalCursorStyle: this.terminalCursorStyle,
          terminalCursorBlink: this.terminalCursorBlink,
          defaultMode: this.defaultMode,
          setupSeen: this.setupSeen,
          where: this.where,
          openProjects: this.openProjects.map(p => p.path),
          activeProjectPath: this.activeProjectPath,
        }))
      } catch { /* storage unavailable: prefs just don't persist */ }
    },

    async init() {
      this.applyTheme()
      // "System" follows the OS while the app is open.
      window.matchMedia?.('(prefers-color-scheme: light)').addEventListener?.('change', () => this.applyTheme())
      const [recent, agents] = await Promise.all([
        call('recent_projects').catch(() => [] as ProjectInfo[]),
        call('detect_agents').catch(() => [] as AgentInfo[]),
      ])
      this.recent = mergeRecent(recent)
      this.loadTerminalProfiles()
      this.agents = agents.map(a => ({ ...a, version: shortVersion(a.version) }))
      // Reopen the projects that were open last time.
      const prefs = loadPrefs()
      const paths: string[] = prefs.openProjects ?? []
      // Built fresh so running init twice (hot reload) cannot list a project twice.
      const reopened: ProjectInfo[] = []
      for (const path of new Set(paths)) {
        const info = this.recent.find(r => r.path === path)
        if (info) reopened.push(info)
      }
      this.openProjects = reopened
      loadHostsFor(this.recent)
      this.activeProjectPath = this.openProjects.find(p => p.path === prefs.activeProjectPath)?.path
        ?? this.openProjects[0]?.path ?? null
      // First run: offer to install what is missing. Written now, so quitting
      // halfway brings the dialog back next time.
      if (!this.setupSeen) {
        this.persist()
        this.dialog = 'setup'
      }
    },

    async refreshRecent() {
      this.recent = mergeRecent(await call('recent_projects').catch(() => this.recent))
    },

    /** Add a project (already validated by the backend) to the window and focus it. */
    adopt(info: ProjectInfo) {
      const i = this.openProjects.findIndex(p => p.path === info.path)
      if (i === -1) this.openProjects.push(info)
      else this.openProjects[i] = info
      this.activeProjectPath = info.path
      this.recent = [info, ...this.recent.filter(r => r.path !== info.path)]
      if (isEnvPath(info.path)) saveEnvProjects([info, ...loadEnvProjects().filter(r => r.path !== info.path)])
      this.dialog = null
      this.persist()
    },

    /** Open a folder on this computer, or a remote project by its `env://` path. */
    async openProject(path: string) {
      const loc = parseEnvPath(path)
      if (loc) return this._openEnv(loc)
      const info = await call('open_project', { path })
      this.adopt(info)
      return info
    },

    /**
     * Open (or switch to) a folder inside a remote environment as a project. Nothing on this
     * computer's disk is involved: chats run their agent in the instance, terminals open a shell there.
     * `name` defaults to the folder's name (the instance's for `/`), or the name it was opened with before.
     */
    async openEnvProject(loc: EnvLocation, name?: string): Promise<void> {
      this._openEnv(loc, name)
      // Opened from Settings > Environments: show the project.
      this.settings = null
    },

    _openEnv(loc: EnvLocation, name?: string): ProjectInfo {
      const known = this.recent.find(r => r.path === envPath(loc))
      const info = envInfo(loc, name?.trim() || known?.name || envProjectName(loc), Date.now())
      this.adopt(info)
      loadHostsFor([info])
      return info
    },

    /** Remember where new projects go (null: this computer). */
    setWhere(where: EnvRemote | null) {
      this.where = where ? { hostId: where.hostId, instance: where.instance } : null
      this.persist()
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
    setScheme(scheme: ColorScheme) {
      this.scheme = scheme
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
      document.documentElement.dataset.theme = this.resolvedTheme()
      document.documentElement.dataset.scheme = this.scheme
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
      this.persist()
    },
    /** Show a tool window; again (or `force` false) to close it. */
    toggleTool(view: ToolView, force?: boolean) {
      const showing = this.toolPanel === view
      this.toolPanel = (force ?? !showing) ? view : null
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
    /** Show where the project runs (this computer or an environment) on the right; again to close it. */
    toggleEnv(force?: boolean) {
      this.toggleTool('env', force)
    },
    /** Show the project's files on the right; again to close it. */
    toggleFiles(force?: boolean) {
      this.toggleTool('files', force)
    },
    openSettings(section: SettingsSection = 'general', tab?: AgentsTab) {
      this.settings = section
      if (tab) this.agentsTab = tab
      this.paletteOpen = false
    },
    /** "New chat in a worktree" for the active project (a git repository on this computer or in an environment). */
    openWorktreeDialog() {
      if (!this.activeProject?.isGit || this.activeProject.vcs === 'plastic') return
      this.dialog = 'worktree'
      this.paletteOpen = false
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
    toggleTerminal(force?: boolean) {
      this.terminalOpen = force ?? !this.terminalOpen
      if (this.terminalOpen) {
        // A remote project's terminal is a shell in its environment: show one (open it when there is none yet).
        const path = this.activeProjectPath
        if (isEnvPath(path)) {
          const tab = this.terminalTabs.find(t => t.cwd === path && !t.exited)
          if (tab) this.activeTerminalId = tab.id
          else this.newTerminal()
        } else if (this.terminalTabs.length === 0) this.newTerminal()
      }
      this.persist()
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
    newTerminal(cwd?: string | null, profileId?: string | null) {
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
      this.activeTerminalId = id
      this.terminalOpen = true
      return id
    },
    closeTerminal(id: string) {
      const i = this.terminalTabs.findIndex(t => t.id === id)
      if (i === -1) return
      const [tab] = this.terminalTabs.splice(i, 1)
      if (tab?.ptyId && !tab.exited) call('pty_kill', { id: tab.ptyId }).catch(() => {})
      if (this.activeTerminalId === id) this.activeTerminalId = this.terminalTabs[Math.max(0, i - 1)]?.id ?? null
      if (this.terminalTabs.length === 0) this.terminalOpen = false
      this.persist()
    },
  },
})
