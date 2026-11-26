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
  /** Since 0.4.2. What is written in a chat's composer and not sent yet. */
  draft(threadId: string): string
  /** Since 0.4.2. Put text into a chat's composer, replacing what is there; nothing is sent. */
  setDraft(threadId: string, text: string): void

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

export interface PanelTabContext {
  /** The project in view (the active chat's worktree when it has one). */
  projectPath: string | null
  /** True while the tab is in view: showing in the open bottom panel, or shown in its pane in the main area. */
  visible: boolean
  /** In the panel: hide the panel. In the main area: close the tab. */
  close(): void
}

/**
 * A tab in the bottom panel among the terminals (like a JetBrains tool window docked at the bottom), with a
 * button at the foot of the tool strip. There is one of each: the user moves it like a terminal's tab (along
 * the strip, into the main area and back) and may close it; its button or `panelTabs.open` brings it back.
 * Where it is persists. `when` hides it from the panel's strip and the tool strip.
 */
export interface PluginPanelTab {
  id: string
  title: string
  icon: PluginIcon
  /** Small number on the tab (e.g. unread count). */
  badge?: Reactive<number | null>
  /** Hidden from the strip while false. */
  when?: () => boolean
  view: PluginView<PanelTabContext>
}

export interface TabContext {
  /** What `tabs.open` was given. */
  state: unknown
  projectPath: string | null
  setTitle(title: string): void
  /** Since 0.4.2. Replace `state` (kept across restarts for a view with `restore`). */
  setState(state: unknown): void
  close(): void
}

/** A kind of tab in the main area (beside chats, diffs, files, browsers). */
export interface PluginTabView {
  id: string
  icon: PluginIcon
  view: PluginView<TabContext>
  /**
   * Since 0.4.2. `none`: no header row above the view (icon, title, plugin name); the view draws its own.
   * Default `default`.
   */
  header?: 'default' | 'none'
  /**
   * Since 0.4.2. Open tabs of this view come back after a restart, with their title and `state` (which must
   * be JSON). Off by default: the tab closes with the app.
   */
  restore?: boolean
}

/**
 * Since 0.4.2. A place of the plugin's own in Mango's navigation: an icon on the tool strip at the right edge,
 * set apart under the tool windows, for a plugin whose main thing is a tab in the main area.
 */
export interface PluginNavItem {
  id: string
  title: string
  icon: PluginIcon
  /** The `shortcuts.register` id of its shortcut: shown in the tooltip (as the user rebound it). */
  shortcut?: string
  /** Small number on the icon. */
  badge?: Reactive<number | null>
  /** Marked as the place in view, e.g. while its tab shows (`tabs.active`). */
  active?: Reactive<boolean>
  /** Hidden while false. */
  when?: () => boolean
  run(): void
}

/** Since 0.4.2. A row of `ui.contextMenu`. Icons as everywhere in the API. */
export interface PluginMenuRow {
  label: string
  icon?: PluginIcon
  /** A second line, muted. */
  hint?: string
  /** Muted, right-aligned on the label's line. */
  aside?: string
  kbd?: string
  checked?: boolean
  disabled?: boolean
  danger?: boolean
  /** A divider before this row. */
  divider?: boolean
  /** A small heading before this row, starting a group. */
  group?: string
  onSelect?: () => void
}

/**
 * Since 0.4.2. Mango's own controls, so a plugin's view looks and behaves like the app around it. Props are
 * those of the components in `app/components/ui` (listed in docs/plugins.md).
 */
export interface PluginUiComponents {
  /** UiButton's props; default slot. */
  Button: Component
  /** IconButton's props (`label` is its tooltip and name); the icon as default slot. */
  IconButton: Component
  /** UiMenu's props, with `items` as `PluginMenuRow` (icons of any kind); slot `{ open, toggle }`. */
  Menu: Component
  /** UiField's props: label, hint and error around a control. */
  Field: Component
  /** `icon`: any `PluginIcon`. */
  Icon: Component
  /** `threadId`: the status dot of a chat, as the sidebar draws it. Renders nothing for a chat that is gone. */
  ThreadDot: Component
  /** `name`, `path`, `size`: a project's badge. */
  ProjectBadge: Component
  /** `text`: Markdown as a chat reply shows it, raw HTML escaped. */
  Markdown: Component
}

export interface PluginStatusItem {
  id: string
  /**
   * `project` (since 0.1.41): in the titlebar after the project and its branch, for what kind of project it is.
   * `titlebar`: right side of the titlebar. `sidebar`: the sidebar foot, above account and settings.
   */
  location: 'project' | 'titlebar' | 'sidebar'
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

/* ---------- project files: the Files view, file tabs, the editor */

export interface FileEntryContext {
  /** The folder in view (a project, or a chat's worktree). */
  projectPath: string
  /** Relative to `projectPath`, with forward slashes on every system. */
  path: string
  name: string
  isDir: boolean
}

export interface FileFilterContext extends FileEntryContext {
  /** Whether the same folder has an entry of this name (false where the folder was not read whole). */
  hasSibling(name: string, ignoreCase?: boolean): boolean
}

/**
 * Entries the Files view hides until the user asks for them: each filter is a checkbox under
 * View options > Show, off at first and remembered. A file asked for by name ("Show in Files") shows anyway.
 */
export interface PluginFileFilter {
  id: string
  /** What the checkbox shows, e.g. `Unity .meta files`. */
  label: string
  hint?: string
  /** The projects that have it; all when omitted. */
  when?: (ctx: { projectPath: string }) => boolean
  /** Called for every row, often: keep it quick. A throw shows the entry. */
  hide(ctx: FileFilterContext): boolean
}

/**
 * A file that goes with another: the entry's name plus `suffix`, beside it (Unity's `Player.cs.meta`).
 * Renaming or deleting the entry in the Files view takes it along; duplicating leaves it behind. While
 * it is hidden its git change shows on the entry.
 */
export interface PluginFileCompanion {
  id: string
  /** `.meta`: starts with a dot, up to 32 characters. */
  suffix: string
  /**
   * The entries that have one. Null: not known yet, so renaming or deleting the entry waits (it is
   * refused with "try again"); a throw refuses them too.
   */
  when(ctx: FileEntryContext): boolean | null
}

/** Mango's file-type colours; `neutral` is the plain ink. */
export type FileTint = 'blue' | 'yellow' | 'orange' | 'green' | 'purple' | 'red' | 'neutral'

export interface FileIconContext extends FileEntryContext {
  /** An open folder. */
  open: boolean
  /** Only in the Files view, and only where the whole folder was read. */
  hasSibling?: (name: string, ignoreCase?: boolean) => boolean
}

/** Icons in the Files view and on file tabs. The first provider with an answer wins, then Mango's own. */
export interface PluginFileIconProvider {
  id: string
  /**
   * Called for every row, often: keep it quick. `note` joins the row's tooltip. Return the same icon value
   * each time (SVG markup draws at once; a lucide name is looked up first).
   */
  icon(ctx: FileIconContext): { icon: PluginIcon; tint?: FileTint; note?: string } | null | undefined
}

/** An editor language for extensions Monaco does not know (`.prefab` is YAML). */
export interface PluginFileLanguage {
  id: string
  /** With the dot: `['.prefab', '.unity']`. */
  extensions: string[]
  /** A Monaco language id: `yaml`, `xml`, `hlsl`… */
  language: string
}

export interface PluginFilesUiApi {
  filters: {
    register(filter: PluginFileFilter): Disposable
    /** Whether the user shows what this plugin's filter hides. */
    isShown(id: string): boolean
    setShown(id: string, shown: boolean): void
  }
  companions: { register(companion: PluginFileCompanion): Disposable }
  icons: { register(provider: PluginFileIconProvider): Disposable }
  languages: { register(language: PluginFileLanguage): Disposable }
  /** Open the Files tool window at a path of an open project. */
  reveal(path: string): Promise<void>
}

export interface PluginUiApi {
  /** Since 0.1.41. */
  files: PluginFilesUiApi
  toolWindows: {
    register(win: PluginToolWindow): Disposable
    open(id: string): void
    close(): void
  }
  panelTabs: {
    register(tab: PluginPanelTab): Disposable
    /** Bring this tab into view: the panel at it, or its tab in the main area when it was moved there. A closed one reopens in the panel. */
    open(id: string): void
  }
  tabs: {
    register(view: PluginTabView): Disposable
    /** Open (or focus, for the same `key`) a tab of a registered view. */
    open(viewId: string, opts: { title: string; key?: string; state?: unknown }): void
    /** Since 0.4.2. This plugin's tab in the active pane, or null. Reactive in a computed or a getter. */
    active(): { viewId: string; key: string; state: unknown } | null
    /** Since 0.4.2. Close a tab of the active project (nothing when it is not open). */
    close(viewId: string, key: string): void
  }
  /** Since 0.4.2. */
  navItems: { register(item: PluginNavItem): Disposable }
  /** Since 0.4.2. Mango's own controls. */
  components: PluginUiComponents
  /** Since 0.4.2. A menu at a point (a right click), or hanging from an element. Resolves when it closes. */
  contextMenu(at: { x: number; y: number } | HTMLElement, rows: PluginMenuRow[]): Promise<void>
  /**
   * Since 0.4.2. Call while a layer of the plugin's own floats over the workspace (a popover, a drag): a browser
   * tab's page is a native view drawn over all HTML, and hides until this is disposed. `ui.contextMenu`,
   * `ui.dialog` and the Menu component do it themselves.
   */
  holdOverlay(): Disposable
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
  /**
   * Since 0.1.41. A folder's files may have changed: the Files view or a plugin changed them, an agent's
   * turn ended, or the working copy in view moved to another branch or commit.
   */
  onChange(handler: (projectPath: string) => void): Disposable
  list(dir: string, opts?: {
    /**
     * Since 0.1.41. Read subfolders in the same call (one round trip for a remote project): those that
     * came along have `children`. Only some do (24 folders, 2000 entries, none that git ignores).
     */
    children?: boolean
  }): Promise<PluginDirEntry[]>
}

export interface PluginDirEntry {
  name: string
  path: string
  isDir: boolean
  children?: PluginDirEntry[]
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
  /**
   * Text appended to the system prompt of every run (Claude `--append-system-prompt`, Codex instructions).
   * A function gets the run (since 0.1.41) and returns '' to add nothing to it. Keep it to one line: a
   * CLI installed as a Windows batch file refuses arguments with line breaks.
   */
  appendSystemPrompt(text: string | ((run: AgentRunContext) => string)): Disposable
}

export interface AgentRunContext {
  threadId: string
  agent: AgentId
  projectPath: string
  /** Where the agent works: the chat's worktree, else the project. */
  workdir: string
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

/**
 * Since 0.4.2. A saved document. `data` is JSON, null once it is deleted: a deleted document stays behind as a
 * tombstone, so a copy kept elsewhere can learn of it.
 */
export interface PluginDoc<T = unknown> {
  collection: string
  id: string
  /** 1 when first written, one more on every write. */
  rev: number
  /** Where this write stands among all of the plugin's writes: unique, always growing. */
  seq: number
  createdAt: number
  updatedAt: number
  deleted: boolean
  data: T | null
}

/**
 * `expectedRev`: write only if the document is still at this revision (`0`: only if it does not exist, or is
 * deleted). Left out: write whatever is there.
 */
export type PluginDataOp =
  | { op: 'put'; collection: string; id: string; data: unknown; expectedRev?: number }
  | { op: 'delete'; collection: string; id: string; expectedRev?: number }

export interface PluginDataChange {
  /** The last `seq` in this change. */
  seq: number
  docs: PluginDoc[]
  /** Written by this window (its own `write` already returned these). */
  local: boolean
}

/**
 * Since 0.4.2. Documents kept in a database in Mango's data folder, for what a person makes in the plugin:
 * more than `storage` holds, safe with several windows open, and kept when the plugin is removed unless the
 * user asks for it to go. Collections are just names (letters, digits, `_`, `-`, up to 64); ids are up to 128
 * characters; a document is at most 1 MB of JSON.
 */
export interface PluginDataApi {
  /** A collection's documents, deleted ones left out. */
  list<T = unknown>(collection: string): Promise<PluginDoc<T>[]>
  get<T = unknown>(collection: string, id: string): Promise<PluginDoc<T> | null>
  /**
   * All of these (up to 20 000, 64 MB of JSON), or none. Rejects with an error whose `conflicts` (`PluginDoc[]`, as they are now) is set when
   * an `expectedRev` no longer holds; nothing is written then.
   */
  write(ops: PluginDataOp[]): Promise<PluginDoc[]>
  /** Everything written after `since` (0: everything), tombstones included, oldest first. */
  changes(since: number): Promise<{ seq: number; docs: PluginDoc[] }>
  /** After every write, from this window or another. */
  onChange(handler: (change: PluginDataChange) => void): Disposable
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
  /** Since 0.4.2. */
  data: PluginDataApi
  /** Messages between plugins (and to themselves): names are free, use a `<pluginId>:` prefix. */
  events: {
    on(name: string, handler: (payload: unknown) => void): Disposable
    emit(name: string, payload?: unknown): void
  }
  /** A file of the plugin as text, or as a `blob:` URL usable in `<img src>` / CSS. */
  assets: { text(path: string): Promise<string>; url(path: string): Promise<string> }
  /** Lines shown in the plugin's log in Settings > Plugins (also mirrored to the console). */
  log: { info(...args: unknown[]): void; warn(...args: unknown[]): void; error(...args: unknown[]): void }
  /**
   * Since 0.4.2. Awaited before the window closes or hides, Mango quits, or restarts for an update: save what is not
   * saved yet. About 2 s, for all plugins together. The window may stay after all, and ask again.
   */
  onBeforeClose(fn: () => Awaitable<void>): Disposable
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

/** `builtIn`: what the plugin did is part of Mango now, so it does not run. */
export type PluginRunStatus = 'disabled' | 'loading' | 'active' | 'error' | 'incompatible' | 'paused' | 'builtIn'

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
