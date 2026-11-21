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

export interface TabContext {
  state: unknown
  projectPath: string | null
  setTitle(title: string): void
  close(): void
}

export interface PluginTabView {
  id: string
  icon: PluginIcon
  view: PluginView<TabContext>
}

export interface PluginStatusItem {
  id: string
  location: 'titlebar' | 'sidebar'
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

export interface PluginUiApi {
  toolWindows: { register(win: PluginToolWindow): Disposable; open(id: string): void; close(): void }
  tabs: {
    register(view: PluginTabView): Disposable
    open(viewId: string, opts: { title: string; key?: string; state?: unknown }): void
  }
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
  list(dir: string): Promise<Array<{ name: string; path: string; isDir: boolean }>>
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
  appendSystemPrompt(text: Reactive<string>): Disposable
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
