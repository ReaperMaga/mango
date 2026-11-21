import { markRaw, reactive, shallowReactive } from 'vue'
import type { AgentId, Attachment, Thread, ThreadStatus } from '~/types/chat'
import type { AgentCommand } from '~/types/chat'
import type { AgentEvent, AgentMcpServer } from '~/agents/types'
import type { ShortcutDef } from '~/utils/shortcuts'
import type {
  BeforeSendContext, BeforeSendHook, MenuLocation, PluginColorScheme, PluginCodeBlockRenderer, PluginCommand,
  PluginMcpServer, PluginMenuItem, PluginMessageAction, PluginShortcut, PluginSlashCommand, PluginStatusItem,
  PluginTabView, PluginToolWindow, Reactive,
} from './types'
import { emitAll, parseSlash, runBeforeSend, type HookEntry } from './hooks'

/**
 * Everything the active plugins registered, in one place the app reads: the palette, the shortcuts,
 * the composer, the tool stripe, the tab strip, the menus, the run path. Lists are shallow-reactive
 * (a plugin's objects and components are never made deep-reactive); each entry carries its plugin.
 *
 * The runtime (`runtime.ts`) and the API (`api.ts`) fill it; the app only reads it and calls the
 * helpers below, which isolate each plugin: a hook that throws is reported and skipped.
 */

export type Owned<T> = T & { pluginId: string; fullId: string }

export const reg = {
  commands: shallowReactive<Owned<PluginCommand>[]>([]),
  /** `fullId` is `plugin:<pluginId>.<id>`: the id `ws.shortcuts` keeps a rebinding under. */
  shortcuts: shallowReactive<Owned<PluginShortcut>[]>([]),
  slashCommands: shallowReactive<Owned<PluginSlashCommand>[]>([]),
  messageActions: shallowReactive<Owned<PluginMessageAction>[]>([]),
  codeBlocks: shallowReactive<Owned<PluginCodeBlockRenderer>[]>([]),
  /** `fullId` is `plugin:<pluginId>.<id>`, the `ToolView` value. */
  toolWindows: shallowReactive<Owned<PluginToolWindow>[]>([]),
  /** `fullId` is `<pluginId>.<id>`. */
  tabViews: shallowReactive<Owned<PluginTabView>[]>([]),
  statusItems: shallowReactive<Owned<PluginStatusItem>[]>([]),
  menus: shallowReactive<Array<Owned<PluginMenuItem> & { location: MenuLocation }>>([]),
  /** `fullId` is `plugin:<pluginId>.<id>`, the `scheme` value. */
  schemes: shallowReactive<Owned<PluginColorScheme>[]>([]),
  mcpServers: shallowReactive<Owned<PluginMcpServer>[]>([]),
  systemPrompts: shallowReactive<Array<{ pluginId: string; fullId: string; text: Reactive<string> }>>([]),
}

/** Open plugin tabs: title and the state `tabs.open` was given, by tab id (see `ids.ts`). Not saved. */
export const pluginTabs = reactive<Record<string, { title: string; state: unknown }>>({})

/** Plugin names by id (for "Plugins" groups and details). */
export const pluginNames = reactive<Record<string, string>>({})

export const hooks = {
  beforeSend: [] as HookEntry<BeforeSendHook>[],
  agentEvent: [] as HookEntry<(threadId: string, e: AgentEvent) => void>[],
  turnEnd: [] as HookEntry<(threadId: string, ok: boolean) => void>[],
  threadCreated: [] as HookEntry<(t: Thread) => void>[],
  statusChange: [] as HookEntry<(threadId: string, s: ThreadStatus) => void>[],
}

/* ---------- reporting a plugin's failures (the runtime puts them into its log) */

let reporter: (pluginId: string, e: unknown, where: string) => void = (id, e, where) => console.error(`[plugin ${id}] ${where}:`, e)
export function setReporter(fn: typeof reporter) { reporter = fn }
export function report(pluginId: string, e: unknown, where: string) {
  try { reporter(pluginId, e, where) } catch { /* the log itself failed */ }
}

/** A `Reactive<T>` read safely: a getter that throws gives `fallback`. */
export function read<T>(v: Reactive<T> | undefined, pluginId: string, fallback: T, where = 'getter'): T {
  if (typeof v !== 'function') return v === undefined ? fallback : v
  try { return (v as () => T)() } catch (e) { report(pluginId, e, where); return fallback }
}

/** `when()` read safely: a throw hides the thing. */
export function shown(item: { when?: (...a: never[]) => boolean; pluginId: string }, ...args: unknown[]): boolean {
  if (!item.when) return true
  try { return (item.when as (...a: unknown[]) => boolean)(...args) !== false } catch (e) { report(item.pluginId, e, 'when()'); return false }
}

/** Run a plugin's callback, reporting (not throwing) what goes wrong. */
export async function guarded<T>(pluginId: string, where: string, fn: () => T | Promise<T>): Promise<T | undefined> {
  try { return await fn() } catch (e) { report(pluginId, e, where); return undefined }
}

export const raw = <T extends object>(v: T): T => (v && typeof v === 'object' ? markRaw(v) : v)

/* ---------- shortcuts */

export function pluginShortcutDefs(): ShortcutDef[] {
  return reg.shortcuts.map(s => ({
    id: s.fullId,
    label: s.label,
    group: pluginNames[s.pluginId] ?? s.pluginId,
    scope: s.scope ?? 'workspace',
    key: s.key,
  }))
}

/* ---------- chat hooks (called from stores/threads.ts and agents/index.ts) */

const onHookError = (where: string) => (pluginId: string, e: unknown) => report(pluginId, e, where)

/** `onBeforeSend`: null when a plugin cancelled the send. */
export function pluginBeforeSend(ctx: BeforeSendContext): Promise<{ text: string; attachments: Attachment[] } | null> {
  if (!hooks.beforeSend.length) return Promise.resolve({ text: ctx.text, attachments: ctx.attachments })
  return runBeforeSend<Attachment, BeforeSendContext>(hooks.beforeSend as HookEntry<(c: BeforeSendContext) => unknown>[], ctx, onHookError('onBeforeSend'))
}

export function emitAgentEvent(threadId: string, e: AgentEvent) {
  if (hooks.agentEvent.length) emitAll(hooks.agentEvent, [threadId, e], onHookError('onAgentEvent'))
}
export function emitTurnEnd(threadId: string, ok: boolean) {
  if (hooks.turnEnd.length) emitAll(hooks.turnEnd, [threadId, ok], onHookError('onTurnEnd'))
}
export function emitThreadCreated(t: Thread) {
  if (hooks.threadCreated.length) emitAll(hooks.threadCreated, [t], onHookError('onThreadCreated'))
}
export function emitStatusChange(threadId: string, s: ThreadStatus) {
  if (hooks.statusChange.length) emitAll(hooks.statusChange, [threadId, s], onHookError('onStatusChange'))
}

/* ---------- slash commands */

const offered = (c: Owned<PluginSlashCommand>, agent: AgentId) => !c.agents?.length || c.agents.includes(agent)

/** Plugins' composer commands for an agent, in the composer's shape (`mango: true`: Mango handles them). */
export function pluginSlashList(agent: AgentId): AgentCommand[] {
  return reg.slashCommands.filter(c => offered(c, agent)).map(c => ({
    name: c.name,
    description: c.description || pluginNames[c.pluginId] || c.pluginId,
    ...(c.argumentHint ? { argumentHint: c.argumentHint } : {}),
    mango: true,
    plugin: pluginNames[c.pluginId] ?? c.pluginId,
  }))
}

/**
 * A plugin's `/name args` typed in a chat: runs it. `null`: not a plugin command (send as usual).
 * `{ send: text }`: send that instead. `{ send: null }`: the command did all it does.
 */
export async function runPluginSlash(text: string, ctx: { threadId: string; agent: AgentId; projectPath: string | null }): Promise<{ send: string | null } | null> {
  const parsed = parseSlash(text)
  if (!parsed) return null
  const cmd = reg.slashCommands.find(c => c.name === parsed.name && offered(c, ctx.agent))
  if (!cmd) return null
  let out: string | void | undefined
  try {
    out = await cmd.run({ threadId: ctx.threadId, args: parsed.args, projectPath: ctx.projectPath })
  } catch (e) {
    report(cmd.pluginId, e, `/${cmd.name}`)
    return { send: null }
  }
  return { send: typeof out === 'string' && out.trim() ? out : null }
}

/* ---------- agent runs */

/** The plugins' MCP servers a run of `agent` gets, as an adapter takes them. Names a user server has already are left out. */
export function pluginMcpFor(agent: AgentId, taken: string[] = []): AgentMcpServer[] {
  const names = new Set(taken.map(n => n.toLowerCase()))
  const out: AgentMcpServer[] = []
  for (const s of reg.mcpServers) {
    if (s.agents?.length && !s.agents.includes(agent)) continue
    if (names.has(s.name.toLowerCase())) continue
    names.add(s.name.toLowerCase())
    if (s.transport === 'stdio' && s.command) out.push({ name: s.name, transport: 'stdio', command: s.command, args: [...(s.args ?? [])], env: { ...(s.env ?? {}) } })
    else if (s.transport === 'http' && s.url) out.push({ name: s.name, transport: 'http', url: s.url, headers: { ...(s.headers ?? {}) } })
  }
  return out
}

/** What plugins append to the system prompt of a run, joined; '' when nothing. */
export function pluginSystemPrompt(): string {
  return reg.systemPrompts
    .map(p => read(p.text, p.pluginId, '', 'appendSystemPrompt'))
    .filter(t => typeof t === 'string' && t.trim())
    .map(t => t.trim())
    .join('\n\n')
}

/* ---------- lookups */

export const isPluginSchemeRegistered = (id: string) => reg.schemes.some(s => s.fullId === id)
export const pluginToolWindow = (ref: string | null | undefined) => (ref ? reg.toolWindows.find(w => w.fullId === ref) ?? null : null)
export const pluginTabView = (pluginId: string, viewId: string) => reg.tabViews.find(v => v.pluginId === pluginId && v.id === viewId) ?? null
export const pluginMenus = <L extends MenuLocation>(location: L) =>
  reg.menus.filter(m => m.location === location) as unknown as Array<Owned<PluginMenuItem<L>>>

/* ---------- Mango's own commands, for `commands.execute` / `commands.list` */

export interface BuiltinCommand { id: string; title: string; run(): unknown }
let builtins: () => BuiltinCommand[] = () => []
/** The command palette hands over its actions (it computes them; ids as in the palette). */
export function setBuiltinCommands(fn: () => BuiltinCommand[]) { builtins = fn }
export function builtinCommands(): BuiltinCommand[] {
  try { return builtins() } catch { return [] }
}
