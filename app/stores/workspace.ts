import { defineStore } from 'pinia'
import type { AgentInfo, ProjectInfo, TerminalProfile } from '~/types/ipc'
import type { PermissionMode } from '~/agents/types'
import { call } from '~/composables/useBackend'
import { baseName } from '~/utils/paths'
import { shortVersion } from '~/utils/agentCli'

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

/** The tool windows that open on the right: the project's files, source control, and the chat's pull requests and issues. */
export type ToolView = 'files' | 'changes' | 'links'
export type CursorStyle = 'bar' | 'block' | 'underline'
export type AgentsTab = 'agents' | 'subscription' | 'usage'
export type SettingsSection ='agents' | 'terminal' | 'voice' | 'appearance' | 'general'

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

const toolView = (v: unknown): ToolView | null => (v === 'files' || v === 'changes' || v === 'links' ? v : null)

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
      /** which dialog is open: a project dialog, "Get started" (setup) or the usage limits */
      dialog: null as null | 'new' | 'clone' | 'setup' | 'usage',
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
      this.recent = recent
      this.loadTerminalProfiles()
      this.agents = agents.map(a => ({ ...a, version: shortVersion(a.version) }))
      // Reopen the projects that were open last time.
      const prefs = loadPrefs()
      const paths: string[] = prefs.openProjects ?? []
      // Built fresh so running init twice (hot reload) cannot list a project twice.
      const reopened: ProjectInfo[] = []
      for (const path of new Set(paths)) {
        const info = recent.find(r => r.path === path)
        if (info) reopened.push(info)
      }
      this.openProjects = reopened
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
      this.recent = await call('recent_projects').catch(() => this.recent)
    },

    /** Add a project (already validated by the backend) to the window and focus it. */
    adopt(info: ProjectInfo) {
      const i = this.openProjects.findIndex(p => p.path === info.path)
      if (i === -1) this.openProjects.push(info)
      else this.openProjects[i] = info
      this.activeProjectPath = info.path
      this.recent = [info, ...this.recent.filter(r => r.path !== info.path)]
      this.dialog = null
      this.persist()
    },

    async openProject(path: string) {
      const info = await call('open_project', { path })
      this.adopt(info)
      return info
    },

    closeProject(path: string) {
      this.openProjects = this.openProjects.filter(p => p.path !== path)
      if (this.activeProjectPath === path) this.activeProjectPath = this.openProjects[0]?.path ?? null
      this.persist()
    },

    async forgetProject(path: string) {
      await call('forget_project', { path }).catch(() => {})
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
    /** Show the project's files on the right; again to close it. */
    toggleFiles(force?: boolean) {
      this.toggleTool('files', force)
    },
    openSettings(section: SettingsSection = 'general', tab?: AgentsTab) {
      this.settings = section
      if (tab) this.agentsTab = tab
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
      if (this.terminalOpen && this.terminalTabs.length === 0) this.newTerminal()
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
    newTerminal(cwd?: string | null, profileId?: string | null) {
      const id = `term-${++tabSeq}`
      const dir = cwd ?? this.activeProjectPath
      const profile = this.terminalProfiles.find(p => p.id === profileId) ?? this.defaultTerminalProfile
      this.terminalTabs.push({
        id,
        title: dir ? baseName(dir) : 'shell',
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
