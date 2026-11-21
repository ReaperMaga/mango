/**
 * The plugin API: what a plugin's entry module receives in `activate(mango)`.
 *
 * A plugin is a folder with `mango-plugin.json` (see `PluginManifest` in `~/types/ipc`) and one bundled
 * ES module (`main`, default `main.js`) that exports either `activate` / `deactivate` functions or a
 * default object with them:
 *
 *   export function activate(mango) {
 *     mango.commands.register({ id: 'hello', title: 'Say hello', run: () => mango.ui.toast({ title: 'Hello' }) })
 *   }
 *
 * Plugins run inside Mango's window with the same rights as Mango itself (trusted code, installed by the
 * user). Everything a plugin registers returns a `Disposable` and is also undone automatically when the
 * plugin is disabled, reloaded or removed, so `deactivate` is only needed for the plugin's own resources.
 *
 * The module cannot `import` anything (it is loaded from a blob URL): Vue, icons and Mango's stores come
 * in through this object. Bundle a plugin with esbuild/Vite into a single file; mark `vue` external and
 * read it from `mango.vue`.
 *
 * Keep this file free of runtime code: it is the contract, and `docs/plugins.md` mirrors it.
 */

import type { App, Component } from 'vue'
import type { Pinia } from 'pinia'
import type * as Vue from 'vue'
import type { Commands, Events, InstalledPlugin, PluginManifest } from '~/types/ipc'
import type { AgentId, Attachment, Thread, ThreadStatus } from '~/types/chat'
import type { AgentEvent } from '~/agents/types'

/* ---------------------------------------------------------------- basics */

export interface Disposable { dispose(): void }

/**
 * An icon: a Vue component (for example one built with `mango.vue.h`), a lucide icon name in kebab-case
 * (`'sparkles'`, `'git-branch'`), or raw `<svg …>` markup. Icons follow `currentColor`.
 */
export type PluginIcon = Component | string

/**
 * UI a plugin puts into Mango: either a Vue component (rendered with the app's Vue, so it can use
 * Mango's stores through `mango.stores`) or a framework-free `mount` that fills `el` and may return a
 * cleanup. `props` go to the component.
 */
export type PluginView<Ctx = Record<string, never>> =
  | { component: Component; props?: Record<string, unknown> }
  | { mount: (el: HTMLElement, ctx: Ctx) => void | (() => void) }

/** Something that may change: a plain value, or a getter re-read reactively (a getter may read stores). */
export type Reactive<T> = T | (() => T)

export type Awaitable<T> = T | Promise<T>

/* ---------------------------------------------------------------- commands and keys */

export interface PluginCommand {
  /** Unique within the plugin; the full id is `<pluginId>.<id>`. */
  id: string
  title: string
  /** Secondary text in the palette. */
  detail?: string
  icon?: PluginIcon
  /** Extra words the palette matches. */
  keywords?: string
  /** Hidden from the palette while false (still runnable through `commands.execute`). */
  when?: () => boolean
  run(...args: unknown[]): Awaitable<unknown>
}

export interface PluginShortcut {
  /** Unique within the plugin. Listed (and rebindable) in Settings > Shortcuts under the plugin's name. */
  id: string
  label: string
  /** Default binding, e.g. `Mod+Shift+L` (`Mod` = Cmd on macOS, Ctrl elsewhere). Must contain `Mod`. */
  key: string
  /** `always`, `app` (not in the terminal) or `workspace` (not under Settings). Default `workspace`. */
  scope?: 'always' | 'app' | 'workspace'
  run(): void
}

/** A Mango-handled composer slash command (`/name args`). */
export interface PluginSlashCommand {
  name: string
  description: string
  argumentHint?: string
  /** Which agents offer it; all when omitted. */
  agents?: AgentId[]
  /**
   * Runs instead of sending. Return a string to send that text to the agent instead (a prompt template),
   * or nothing when the command did all it does.
   */
  run(ctx: { threadId: string; args: string; projectPath: string | null }): Awaitable<string | void>
}

/* ---------------------------------------------------------------- chats */

export interface BeforeSendContext {
  threadId: string
  text: string
  attachments: Attachment[]
  agent: AgentId
  projectPath: string | null
}

/**
 * Return an object to change what is sent (`text`, `attachments`), `false` to cancel the send
 * (tell the user why yourself), or nothing to leave it alone. Hooks run in registration order,
 * each seeing the previous one's result.
 */
export type BeforeSendHook = (ctx: BeforeSendContext) => Awaitable<Partial<Pick<BeforeSendContext, 'text' | 'attachments'>> | false | void>

export interface MessageActionContext {
  threadId: string
  messageId: string
  role: 'user' | 'assistant'
  /** The message's plain text (its text parts joined). */
  text: string
}

export interface PluginMessageAction {
  id: string
  label: string
  icon: PluginIcon
  /** Only for these messages; all when omitted. */
  when?: (ctx: MessageActionContext) => boolean
  run(ctx: MessageActionContext): Awaitable<void>
}

/**
 * Renders fenced code blocks of a language in chat replies (```mermaid, ```csv …). `mount` fills `el`
 * with the rendered block; the code is untrusted agent output, so never put it into `innerHTML` raw.
 */
export interface PluginCodeBlockRenderer {
  /** Language tags it handles (lower case). */
  languages: string[]
  view: PluginView<{ code: string; language: string; threadId: string }>
}

export interface PluginChatApi {
  /** The chat in the active pane, or null. */
  active(): Thread | null
  get(id: string): Thread | null
  /** Chats of a project (all open projects when omitted), archived ones included. */
  list(projectPath?: string): Thread[]
  /** A new chat in a project (the active one when omitted); it is shown. */
  create(opts?: { projectPath?: string; agent?: AgentId; title?: string }): Thread
  /** Send a message as the user would (it goes through `onBeforeSend` hooks too). */
  send(threadId: string, text: string): Promise<void>
  /** Stop the running turn. */
  stop(threadId: string): void
  /** Show a chat (in the active pane). */
  show(threadId: string): void
  rename(threadId: string, title: string): void

  onBeforeSend(hook: BeforeSendHook): Disposable
  /** Every event an agent run produces, as it arrives (tool calls, text deltas, `turn-end`…). */
  onAgentEvent(handler: (threadId: string, event: AgentEvent) => void): Disposable
  /** A turn finished (after its `turn-end`). */
  onTurnEnd(handler: (threadId: string, ok: boolean) => void): Disposable
  onThreadCreated(handler: (thread: Thread) => void): Disposable
  onStatusChange(handler: (threadId: string, status: ThreadStatus) => void): Disposable

  slashCommands: { register(cmd: PluginSlashCommand): Disposable }
  messageActions: { register(action: PluginMessageAction): Disposable }
  codeBlocks: { register(renderer: PluginCodeBlockRenderer): Disposable }
}

/* ---------------------------------------------------------------- UI surfaces */

export interface ToolWindowContext {
  /** The project in view (the active chat's worktree when it has one). */
  projectPath: string | null
  close(): void
}

/** A tool window on the right (beside Files, Changes, Pull requests). */
export interface PluginToolWindow {
  id: string
  title: string
  icon: PluginIcon
  /** Small number on its button (e.g. unread count). */
  badge?: Reactive<number | null>
  /** Hidden from the stripe while false. */
  when?: () => boolean
  view: PluginView<ToolWindowContext>
}

export interface TabContext {
  /** What `tabs.open` was given. */
  state: unknown
  projectPath: string | null
  setTitle(title: string): void
  close(): void
}

/** A kind of tab in the main area (beside chats, diffs, files, browsers). */
export interface PluginTabView {
  id: string
  icon: PluginIcon
  view: PluginView<TabContext>
}

export interface PluginStatusItem {
  id: string
  /** `titlebar`: right side of the titlebar. `sidebar`: the sidebar foot, above account and settings. */
  location: 'titlebar' | 'sidebar'
  text?: Reactive<string>
  icon?: Reactive<PluginIcon | undefined>
  tooltip?: Reactive<string>
  onClick?: () => void
  /** Hidden while false. */
  when?: () => boolean
}

export interface PluginSettingsPage {
  id: string
  title: string
  icon?: PluginIcon
  view: PluginView<Record<string, never>>
}

export type MenuLocation = 'thread' | 'file' | 'project'

export interface MenuContext {
  thread: { threadId: string }
  file: { path: string; projectPath: string; isDir: boolean }
  project: { projectPath: string }
}

export interface PluginMenuItem<L extends MenuLocation = MenuLocation> {
  id: string
  label: string
  icon?: PluginIcon
  when?: (ctx: MenuContext[L]) => boolean
  run(ctx: MenuContext[L]): Awaitable<void>
}

export interface ToastOptions {
  title: string
  body?: string
  kind?: 'info' | 'success' | 'warning' | 'error'
  /** ms; 0 keeps it until dismissed. Default 5000. */
  timeout?: number
  action?: { label: string; run(): void }
}

export interface PluginUiApi {
  toolWindows: {
    register(win: PluginToolWindow): Disposable
    open(id: string): void
    close(): void
  }
  tabs: {
    register(view: PluginTabView): Disposable
    /** Open (or focus, for the same `key`) a tab of a registered view. */
    open(viewId: string, opts: { title: string; key?: string; state?: unknown }): void
  }
  statusItems: { register(item: PluginStatusItem): Disposable }
  settingsPages: { register(page: PluginSettingsPage): Disposable }
  menus: { register<L extends MenuLocation>(location: L, item: PluginMenuItem<L>): Disposable }

  /** A small message in the corner of the window. */
  toast(opts: ToastOptions): void
  /** A system notification (respects Settings > Notifications). */
  notify(title: string, body?: string): void
  confirm(opts: { title: string; body?: string; confirmLabel?: string; danger?: boolean }): Promise<boolean>
  prompt(opts: { title: string; body?: string; placeholder?: string; value?: string }): Promise<string | null>
  /** A dialog showing a plugin view; resolves when it is closed. */
  dialog(opts: { title: string; view: PluginView<{ close(): void }>; width?: number }): Promise<void>
  /** Open Settings at a plugin page (`<pluginId>.<pageId>`) or a built-in section. */
  openSettings(section?: string): void
}

/* ---------------------------------------------------------------- theme */

/**
 * A colour scheme offered in Settings > Appearance beside the built-in ones. Values set CSS custom
 * properties from `app/assets/css/tokens.css` (`--accent`, `--bg-app`, …) in dark and light theme.
 */
export interface PluginColorScheme {
  id: string
  label: string
  /** Swatch colour in the picker. */
  swatch: string
  dark: Record<string, string>
  light: Record<string, string>
}

export interface PluginThemeApi {
  /** Add CSS to the app (removed on dispose). The manifest's `styles` file is added for you. */
  addStyles(css: string): Disposable
  /** Override design tokens (`{ '--accent': '#f60' }`) in the current theme; later calls win. */
  setTokens(tokens: Record<string, string>): Disposable
  registerScheme(scheme: PluginColorScheme): Disposable
  /** The theme in effect. */
  current(): 'dark' | 'light'
  onChange(handler: (theme: 'dark' | 'light') => void): Disposable
}

/* ---------------------------------------------------------------- workspace, files, git, terminal */

export interface PluginWorkspaceApi {
  activeProject(): string | null
  openProjects(): string[]
  /** The folder in view: the active chat's worktree, or the project. */
  workdir(): string | null
  onProjectChange(handler: (projectPath: string | null) => void): Disposable
  /** Open a file of a project in an editor tab (optionally at a line). */
  openFile(path: string, opts?: { line?: number }): void
  /** Open a web page in a browser tab (http/https). */
  openBrowser(url: string): void
  /** Open a terminal tab in the workdir, optionally running a command in it. */
  openTerminal(opts?: { cwd?: string; command?: string }): void
}

export interface PluginFilesApi {
  /** Paths are absolute, inside an open project (remote `env://` projects work too). */
  read(path: string): Promise<string>
  write(path: string, content: string): Promise<void>
  list(dir: string): Promise<Array<{ name: string; path: string; isDir: boolean }>>
}

export interface PluginGitApi {
  /** Refreshed status of a working copy (null when it is not under version control). */
  status(path: string): Promise<unknown>
  refresh(path: string): Promise<void>
}

/* ---------------------------------------------------------------- agents */

/** An MCP server added to agent runs while the plugin is active (same shape as Settings > MCP servers). */
export interface PluginMcpServer {
  name: string
  agents?: AgentId[]
  transport: 'stdio' | 'http'
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
}

export interface PluginAgentsApi {
  registerMcpServer(server: PluginMcpServer): Disposable
  /** Text appended to the system prompt of every run (Claude `--append-system-prompt`, Codex instructions). */
  appendSystemPrompt(text: Reactive<string>): Disposable
}

/* ---------------------------------------------------------------- data */

/** The plugin's declarative settings (manifest `settings`), as the user set them in Settings > Plugins. */
export interface PluginSettingsApi {
  get<T = unknown>(key: string): T
  set(key: string, value: unknown): void
  all(): Record<string, unknown>
  onChange(handler: (key: string, value: unknown) => void): Disposable
}

/** Private key-value storage (JSON values), kept across restarts, removed with the plugin. */
export interface PluginStorageApi {
  get<T = unknown>(key: string): T | undefined
  set(key: string, value: unknown): void
  delete(key: string): void
  keys(): string[]
}

/* ---------------------------------------------------------------- escape hatches */

/** Raw access to Mango's backend: every command in `~/types/ipc` `Commands`. */
export interface PluginBackendApi {
  call<K extends keyof Commands>(cmd: K, args: Commands[K][0]): Promise<Commands[K][1]>
  on<K extends keyof Events>(event: K, handler: (payload: Events[K]) => void): Promise<Disposable>
}

/** Mango's Pinia stores: read and change anything the app itself can. No stability promise. */
export interface PluginStores {
  workspace: ReturnType<typeof import('~/stores/workspace')['useWorkspace']>
  threads: ReturnType<typeof import('~/stores/threads')['useThreads']>
  git: ReturnType<typeof import('~/stores/git')['useGit']>
  files: ReturnType<typeof import('~/stores/files')['useFiles']>
  browser: ReturnType<typeof import('~/stores/browser')['useBrowser']>
  /** Any store by its Pinia id. */
  byId(id: string): unknown
}

/* ---------------------------------------------------------------- the API object */

export interface MangoPluginApi {
  /** The plugin's own record and manifest. */
  plugin: { id: string; manifest: PluginManifest; dir: string; info: InstalledPlugin }
  /** Mango's version (`package.json`). */
  version: string
  platform: 'windows' | 'macos' | 'linux' | 'browser'

  /** The app's Vue (h, ref, computed, defineComponent, watch…): use it, never bundle another copy. */
  vue: typeof Vue

  commands: {
    register(cmd: PluginCommand): Disposable
    /** Run a command by full id (`<pluginId>.<id>`, or a built-in palette action id). */
    execute(id: string, ...args: unknown[]): Promise<unknown>
    list(): Array<{ id: string; title: string; pluginId: string | null }>
  }
  shortcuts: { register(shortcut: PluginShortcut): Disposable }
  chat: PluginChatApi
  ui: PluginUiApi
  theme: PluginThemeApi
  workspace: PluginWorkspaceApi
  files: PluginFilesApi
  git: PluginGitApi
  agents: PluginAgentsApi
  settings: PluginSettingsApi
  storage: PluginStorageApi
  /** Messages between plugins (and to themselves): names are free, use a `<pluginId>:` prefix. */
  events: {
    on(name: string, handler: (payload: unknown) => void): Disposable
    emit(name: string, payload?: unknown): void
  }
  /** A file of the plugin as text, or as a `blob:` URL usable in `<img src>` / CSS. */
  assets: { text(path: string): Promise<string>; url(path: string): Promise<string> }
  /** Lines shown in the plugin's log in Settings > Plugins (also mirrored to the console). */
  log: { info(...args: unknown[]): void; warn(...args: unknown[]): void; error(...args: unknown[]): void }
  /** Undo `fn` when the plugin goes away. */
  onDispose(fn: () => void): void

  backend: PluginBackendApi
  stores: PluginStores
  app: App
  pinia: Pinia
}

/** What a plugin's entry module exports (named or as `default`). */
export interface MangoPluginModule {
  activate(mango: MangoPluginApi): Awaitable<void | (() => void)>
  deactivate?(): Awaitable<void>
}

/* ---------------------------------------------------------------- runtime state (Settings > Plugins reads it) */

export type PluginRunStatus = 'disabled' | 'loading' | 'active' | 'error' | 'incompatible' | 'paused'

export interface PluginLogLine {
  at: number
  level: 'info' | 'warn' | 'error'
  text: string
}

export interface PluginRunState {
  status: PluginRunStatus
  /** Why it failed to load or activate, or why it is incompatible. */
  error: string | null
  activatedAt: number | null
  /** What it registered right now, by kind (`commands: 3`, `toolWindows: 1`…). */
  contributions: Record<string, number>
}
