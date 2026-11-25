/**
 * The Mango plugin API, for plugin authors: copy this file next to your sources and type your entry point
 *
 *   import type { MangoPluginApi } from './mango-plugin'
 *   export function activate(mango: MangoPluginApi) { … }
 *
 * It mirrors app/plugin-host/types.ts (the source of truth, documented in docs/plugins.md) without Mango's
 * internal imports: Vue types come from the `vue` package (a type-only dependency; never bundle Vue, use
 * `mango.vue`), and the stores, the backend and chat shapes are typed loosely.
 */

import type * as Vue from 'vue'
import type { App, Component } from 'vue'

/* ---------------------------------------------------------------- basics */

export interface Disposable { dispose(): void }

/** A lucide icon name in kebab-case that Mango draws (`'timer'`), raw `<svg …>` markup, or a Vue component. */
export type PluginIcon = Component | string

/** A Vue component (props go to it; it gets `ctx` as a prop when it declares one) or a framework-free mount. */
export type PluginView<Ctx = Record<string, never>> =
  | { component: Component; props?: Record<string, unknown> }
  | { mount: (el: HTMLElement, ctx: Ctx) => void | (() => void) }

/** A plain value, or a getter re-read reactively. */
export type Reactive<T> = T | (() => T)
export type Awaitable<T> = T | Promise<T>

export type AgentId = 'claude' | 'codex'
export type ThreadStatus = 'queued' | 'running' | 'working' | 'waiting' | 'done' | 'error'

/* ---------------------------------------------------------------- manifest */

export interface PluginSettingField {
  key: string
  type: 'boolean' | 'string' | 'text' | 'number' | 'select'
  label: string
  description?: string
  default?: string | number | boolean
  options?: { value: string; label: string }[]
  placeholder?: string
  min?: number
  max?: number
}

/** `mango-plugin.json`. */
export interface PluginManifest {
  id: string
  name: string
  version: string
  description?: string
  author?: string
  homepage?: string
  main?: string
  styles?: string
  minAppVersion?: string
  settings?: PluginSettingField[]
}

/* ---------------------------------------------------------------- chats (loosely: see app/types/chat.ts) */

export interface Attachment {
  id: string
  name: string
  path: string
  mime: string
  size: number
  kind: 'image' | 'file'
  thumb?: string
}

export type Part =
  | { type: 'text'; text: string; id?: string }
  | { type: 'thinking'; text: string; seconds: number; id?: string }
  | { type: 'tool'; id?: string; tool: 'read' | 'edit' | 'write' | 'bash' | 'search' | 'web' | 'other'; label?: string; target: string; status: 'running' | 'ok' | 'error'; summary?: string; output?: string; childId?: string; [k: string]: unknown }
  | { type: 'approval'; id?: string; title?: string; command: string; reason: string; state: 'pending' | 'allowed' | 'denied' | 'cancelled' }
  | { type: 'question'; id?: string; questions: Array<{ question: string; header?: string; [k: string]: unknown }>; title?: string; message?: string; state: 'pending' | 'answered' | 'dismissed' | 'cancelled'; [k: string]: unknown }
  | { type: 'notice'; level: 'error' | 'info'; text: string }

export interface Message {
  id: string
  role: 'user' | 'agent'
  parts: Part[]
  attachments?: Attachment[]
  createdAt: number
  elapsedMs?: number
  outcome?: 'done' | 'stopped' | 'error'
  fromAgent?: boolean
  [k: string]: unknown
}

export interface Thread {
  id: string
  projectPath: string
  title: string
  agent: AgentId
  model: string
  status: ThreadStatus
  messages: Message[]
  createdAt: number
  updatedAt: number
  archived?: boolean
  branch?: string | null
  worktree?: string | null
  parentId?: string | null
  [k: string]: unknown
}

/** An agent run's event (app/agents/types.ts `AgentEvent`). */
export type AgentEvent = { type: string; [k: string]: unknown }

/* ---------------------------------------------------------------- commands and keys */

export interface PluginCommand {
  id: string
  title: string
  detail?: string
  icon?: PluginIcon
  keywords?: string
  when?: () => boolean
  run(...args: unknown[]): Awaitable<unknown>
}

export interface PluginShortcut {
  id: string
  label: string
  /** e.g. `Mod+Shift+L`; must contain `Mod`. */
  key: string
  scope?: 'always' | 'app' | 'workspace'
  run(): void
}

export interface PluginSlashCommand {
  name: string
  description: string
  argumentHint?: string
  agents?: AgentId[]
  /** Return a string to send it instead; nothing when the command did all it does. */
  run(ctx: { threadId: string; args: string; projectPath: string | null }): Awaitable<string | void>
}

/* ---------------------------------------------------------------- chat API */

export interface BeforeSendContext {
  threadId: string
  text: string
  attachments: Attachment[]
  agent: AgentId
  projectPath: string | null
}

/** Return changes, `false` to cancel (tell the user why), or nothing. */
export type BeforeSendHook = (ctx: BeforeSendContext) => Awaitable<Partial<Pick<BeforeSendContext, 'text' | 'attachments'>> | false | void>

export interface MessageActionContext {
  threadId: string
  messageId: string
  role: 'user' | 'assistant'
  text: string
}

export interface PluginMessageAction {
  id: string
  label: string
  icon: PluginIcon
  when?: (ctx: MessageActionContext) => boolean
  run(ctx: MessageActionContext): Awaitable<void>
}

/** The code is untrusted agent output: never put it into innerHTML. */
export interface PluginCodeBlockRenderer {
  languages: string[]
  view: PluginView<{ code: string; language: string; threadId: string }>
}

export interface PluginChatApi {
  active(): Thread | null
  get(id: string): Thread | null
  list(projectPath?: string): Thread[]
  create(opts?: { projectPath?: string; agent?: AgentId; title?: string }): Thread
  send(threadId: string, text: string): Promise<void>
  stop(threadId: string): void
  show(threadId: string): void
  rename(threadId: string, title: string): void
  /** Since 0.4.2. What is written in a chat's composer and not sent yet. */
  draft(threadId: string): string
  /** Since 0.4.2. Put text into a chat's composer, replacing what is there; nothing is sent. */
  setDraft(threadId: string, text: string): void

  onBeforeSend(hook: BeforeSendHook): Disposable
  onAgentEvent(handler: (threadId: string, event: AgentEvent) => void): Disposable
  onTurnEnd(handler: (threadId: string, ok: boolean) => void): Disposable
  onThreadCreated(handler: (thread: Thread) => void): Disposable
  onStatusChange(handler: (threadId: string, status: ThreadStatus) => void): Disposable

  slashCommands: { register(cmd: PluginSlashCommand): Disposable }
  messageActions: { register(action: PluginMessageAction): Disposable }
  codeBlocks: { register(renderer: PluginCodeBlockRenderer): Disposable }
}

/* ---------------------------------------------------------------- UI */

export interface ToolWindowContext { projectPath: string | null; close(): void }

export interface PluginToolWindow {
  id: string
  title: string
  icon: PluginIcon
  badge?: Reactive<number | null>
  when?: () => boolean
  view: PluginView<ToolWindowContext>
}

/** `visible`: the tab is in view (in the open panel, or in its pane). `close()`: hide the panel, or close its tab in the main area. */
export interface PanelTabContext { projectPath: string | null; visible: boolean; close(): void }

/** A tab in the bottom panel among the terminals: one of each, moved and closed by the user like a terminal's tab; `when` hides it. */
export interface PluginPanelTab {
  id: string
  title: string
  icon: PluginIcon
  badge?: Reactive<number | null>
  when?: () => boolean
  view: PluginView<PanelTabContext>
}

export interface TabContext {
  state: unknown
  projectPath: string | null
  setTitle(title: string): void
  /** Since 0.4.2. Replace `state` (kept across restarts for a view with `restore`). */
  setState(state: unknown): void
  close(): void
}

export interface PluginTabView {
  id: string
  icon: PluginIcon
  view: PluginView<TabContext>
  /** Since 0.4.2. `none`: no header row above the view; it draws its own. */
  header?: 'default' | 'none'
  /** Since 0.4.2. Open tabs come back after a restart, with their title and `state` (JSON). */
  restore?: boolean
}

/** Since 0.4.2. A row in the sidebar under New chat; an icon in the titlebar while the sidebar is hidden. */
export interface PluginNavItem {
  id: string
  title: string
  icon: PluginIcon
  /** The `shortcuts.register` id of its shortcut, shown on the row. */
  shortcut?: string
  badge?: Reactive<number | null>
  /** Marked as the place in view. */
  active?: Reactive<boolean>
  when?: () => boolean
  run(): void
}

/** Since 0.4.2. A row of `ui.contextMenu` and the Menu component. */
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

/** Since 0.4.2. Mango's own controls; docs/plugins.md lists their props. */
export interface PluginUiComponents {
  Button: Component
  IconButton: Component
  Menu: Component
  Field: Component
  Icon: Component
  ThreadDot: Component
  ProjectBadge: Component
  Markdown: Component
}

export interface PluginStatusItem {
  id: string
  /** `project` (since 0.1.41): after the project and its branch. */
  location: 'project' | 'titlebar' | 'sidebar'
  text?: Reactive<string>
  icon?: Reactive<PluginIcon | undefined>
  tooltip?: Reactive<string>
  onClick?: () => void
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

/* since 0.1.41: project files (the Files view, file tabs, the editor) */

export interface FileEntryContext {
  projectPath: string
  /** Relative to `projectPath`, forward slashes. */
  path: string
  name: string
  isDir: boolean
}
export interface FileFilterContext extends FileEntryContext {
  hasSibling(name: string, ignoreCase?: boolean): boolean
}
/** Hidden until the user ticks it under View options > Show. */
export interface PluginFileFilter {
  id: string
  label: string
  hint?: string
  when?: (ctx: { projectPath: string }) => boolean
  hide(ctx: FileFilterContext): boolean
}
/** A file named like the entry plus `suffix`: renamed and deleted with it, not duplicated. */
export interface PluginFileCompanion {
  id: string
  suffix: string
  /** Null (or a throw) refuses rename and delete until it can be told. */
  when(ctx: FileEntryContext): boolean | null
}
export type FileTint = 'blue' | 'yellow' | 'orange' | 'green' | 'purple' | 'red' | 'neutral'
export interface FileIconContext extends FileEntryContext {
  open: boolean
  /** Only in the Files view, where the whole folder was read. */
  hasSibling?: (name: string, ignoreCase?: boolean) => boolean
}
export interface PluginFileIconProvider {
  id: string
  icon(ctx: FileIconContext): { icon: PluginIcon; tint?: FileTint; note?: string } | null | undefined
}
export interface PluginFileLanguage {
  id: string
  extensions: string[]
  language: string
}
export interface PluginFilesUiApi {
  filters: { register(filter: PluginFileFilter): Disposable; isShown(id: string): boolean; setShown(id: string, shown: boolean): void }
  companions: { register(companion: PluginFileCompanion): Disposable }
  icons: { register(provider: PluginFileIconProvider): Disposable }
  languages: { register(language: PluginFileLanguage): Disposable }
  reveal(path: string): Promise<void>
}

export interface PluginUiApi {
  files: PluginFilesUiApi
  toolWindows: { register(win: PluginToolWindow): Disposable; open(id: string): void; close(): void }
  panelTabs: { register(tab: PluginPanelTab): Disposable; open(id: string): void }
  tabs: {
    register(view: PluginTabView): Disposable
    open(viewId: string, opts: { title: string; key?: string; state?: unknown }): void
    /** Since 0.4.2. This plugin's tab in the active pane, or null. Reactive. */
    active(): { viewId: string; key: string; state: unknown } | null
    /** Since 0.4.2. Close a tab of the active project. */
    close(viewId: string, key: string): void
  }
  /** Since 0.4.2. */
  navItems: { register(item: PluginNavItem): Disposable }
  /** Since 0.4.2. */
  components: PluginUiComponents
  /** Since 0.4.2. A menu at a point or hanging from an element. Resolves when it closes. */
  contextMenu(at: { x: number; y: number } | HTMLElement, rows: PluginMenuRow[]): Promise<void>
  /** Since 0.4.2. Call while a layer of your own floats over the workspace; dispose it after. */
  holdOverlay(): Disposable
  statusItems: { register(item: PluginStatusItem): Disposable }
  settingsPages: { register(page: PluginSettingsPage): Disposable }
  menus: { register<L extends MenuLocation>(location: L, item: PluginMenuItem<L>): Disposable }
  toast(opts: ToastOptions): void
  notify(title: string, body?: string): void
  confirm(opts: { title: string; body?: string; confirmLabel?: string; danger?: boolean }): Promise<boolean>
  prompt(opts: { title: string; body?: string; placeholder?: string; value?: string }): Promise<string | null>
  dialog(opts: { title: string; view: PluginView<{ close(): void }>; width?: number }): Promise<void>
  openSettings(section?: string): void
}

/* ---------------------------------------------------------------- theme */

export interface PluginColorScheme {
  id: string
  label: string
  swatch: string
  /** Applies in both themes; `light` overrides it in light theme. */
  dark: Record<string, string>
  light: Record<string, string>
}

export interface PluginThemeApi {
  addStyles(css: string): Disposable
  setTokens(tokens: Record<string, string>): Disposable
  registerScheme(scheme: PluginColorScheme): Disposable
  current(): 'dark' | 'light'
  onChange(handler: (theme: 'dark' | 'light') => void): Disposable
}

/* ---------------------------------------------------------------- workspace, files, git, agents */

export interface PluginWorkspaceApi {
  activeProject(): string | null
  openProjects(): string[]
  workdir(): string | null
  onProjectChange(handler: (projectPath: string | null) => void): Disposable
  openFile(path: string, opts?: { line?: number }): void
  openBrowser(url: string): void
  openTerminal(opts?: { cwd?: string; command?: string }): void
}

export interface PluginFilesApi {
  read(path: string): Promise<string>
  write(path: string, content: string): Promise<void>
  /** Since 0.1.41: a folder's files may have changed (Files view, agent turn, branch or commit). */
  onChange(handler: (projectPath: string) => void): Disposable
  /** `children` (since 0.1.41): some subfolders come along in the same call. */
  list(dir: string, opts?: { children?: boolean }): Promise<PluginDirEntry[]>
}

export interface PluginDirEntry {
  name: string
  path: string
  isDir: boolean
  children?: PluginDirEntry[]
}

export interface PluginGitApi {
  status(path: string): Promise<unknown>
  refresh(path: string): Promise<void>
}

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
  /** One line. A function gets the run (since 0.1.41); '' adds nothing to it. */
  appendSystemPrompt(text: string | ((run: AgentRunContext) => string)): Disposable
}

export interface AgentRunContext {
  threadId: string
  agent: AgentId
  projectPath: string
  workdir: string
}

/* ---------------------------------------------------------------- data */

export interface PluginSettingsApi {
  get<T = unknown>(key: string): T
  set(key: string, value: unknown): void
  all(): Record<string, unknown>
  onChange(handler: (key: string, value: unknown) => void): Disposable
}

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
   * All of these, or none. Rejects with an error whose `conflicts` (`PluginDoc[]`, as they are now) is set when
   * an `expectedRev` no longer holds; nothing is written then.
   */
  write(ops: PluginDataOp[]): Promise<PluginDoc[]>
  /** Everything written after `since` (0: everything), tombstones included, oldest first. */
  changes(since: number): Promise<{ seq: number; docs: PluginDoc[] }>
  /** After every write, from this window or another. */
  onChange(handler: (change: PluginDataChange) => void): Disposable
}

/* ---------------------------------------------------------------- the API object */

export interface MangoPluginApi {
  plugin: { id: string; manifest: PluginManifest; dir: string; info: unknown }
  version: string
  platform: 'windows' | 'macos' | 'linux' | 'browser'
  /** The app's Vue: use it, never bundle another copy. */
  vue: typeof Vue

  commands: {
    register(cmd: PluginCommand): Disposable
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
  events: {
    on(name: string, handler: (payload: unknown) => void): Disposable
    emit(name: string, payload?: unknown): void
  }
  assets: { text(path: string): Promise<string>; url(path: string): Promise<string> }
  log: { info(...args: unknown[]): void; warn(...args: unknown[]): void; error(...args: unknown[]): void }
  onDispose(fn: () => void): void

  /** No stability promise: every command and event in Mango's app/types/ipc.ts. */
  backend: {
    call(cmd: string, args: Record<string, unknown>): Promise<any>
    on(event: string, handler: (payload: any) => void): Promise<Disposable>
  }
  /** No stability promise: Mango's Pinia stores. */
  stores: { workspace: any; threads: any; git: any; files: any; browser: any; byId(id: string): unknown }
  app: App
  pinia: unknown
}

export interface MangoPluginModule {
  activate(mango: MangoPluginApi): Awaitable<void | (() => void)>
  deactivate?(): Awaitable<void>
}
