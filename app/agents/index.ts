import type { AgentCommand, AgentId, AgentModel, Attachment, Message, Part, QuestionAnswers, Thread } from '~/types/chat'
import { awaitsUser } from '~/types/chat'
import type { AgentAdapter, AgentEvent, AgentRun, AgentUsage, ContextUsage, SpawnFn, SpawnHandlers, ToolImage, TurnUsage } from '~/agents/types'
import type { useThreads } from '~/stores/threads'
import type { EnvRemote } from '~/types/ipc'
import { call, isTauri, on } from '~/composables/useBackend'
import { runMockAgent } from '~/utils/mockAgent'
import { mergeContext } from '~/agents/context'
import { forAgent, forRemoteAgent, makeThumb, type DroppedAttachment } from '~/utils/attachments'
import { envPath, parseEnvPath } from '~/utils/envPath'
import { mcpServersForRun } from '~/utils/mcpServers'
import { emitAgentEvent, pluginMcpFor, pluginSystemPrompt } from '~/plugin-host/registry'

/**
 * Runs agent turns for threads: picks the adapter, bridges its CLI process to
 * the Rust backend, and turns AgentEvents into message parts on the thread.
 */
type Store = ReturnType<typeof useThreads>

const adapters: Record<AgentId, () => Promise<AgentAdapter>> = {
  claude: () => import('~/agents/claude').then(m => m.claudeAdapter),
  codex: () => import('~/agents/codex').then(m => m.codexAdapter),
}

/** A live run, and how to hand it a message mid-turn. */
interface LiveRun { run: AgentRun; steer(text: string, attachments: Attachment[]): Promise<boolean> }

/** Live runs by thread id (not persisted: a run dies with the app). */
const runs = new Map<string, LiveRun>()
/** Turns still getting ready to start their CLI, by thread id: stopping one, or a newer one, takes it out. */
const starting = new Map<string, symbol>()

export const isRunning = (threadId: string) => runs.has(threadId)

export function respondApproval(threadId: string, approvalId: string, allow: boolean) {
  runs.get(threadId)?.run.respondApproval(approvalId, allow)
}

export function answerQuestion(threadId: string, questionId: string, answers: QuestionAnswers | null) {
  runs.get(threadId)?.run.answerQuestion?.(questionId, answers)
}

export function interruptRun(threadId: string): boolean {
  const live = runs.get(threadId)
  if (!live) starting.delete(threadId)
  live?.run.interrupt()
  return !!live
}

/**
 * Give the thread's running turn a message the user just sent (already in the chat).
 * False when there is no run to take it, or the run cannot: the caller sends it as the next turn.
 */
export function steerRun(threadId: string, text: string, attachments: Attachment[] = []): Promise<boolean> {
  return runs.get(threadId)?.steer(text, attachments) ?? Promise.resolve(false)
}

/** How the simulated agent (browser preview) answers for its own background tasks. */
export const simulatedTasks = new Map<string, { stop(id: string): void; output(id: string): Promise<string | null> }>()

/** Stop one background task or sub-agent of the chat's run (the id of its task or of the call that started it). */
export function stopTask(threadId: string, id: string) {
  const run = runs.get(threadId)?.run
  if (run) run.stopTask?.(id)
  else simulatedTasks.get(threadId)?.stop(id)
}

/** The end of a background command's output, or null when there is none to read. */
export function readTaskOutput(threadId: string, id: string): Promise<string | null> {
  const run = runs.get(threadId)?.run
  if (run) return run.taskOutput?.(id) ?? Promise.resolve(null)
  return simulatedTasks.get(threadId)?.output(id) ?? Promise.resolve(null)
}

/* ------------------------------------------------------------------ */
/* Process bridge: one set of global listeners, dispatched by process id */
/* ------------------------------------------------------------------ */

const handlers = new Map<string, SpawnHandlers>()
/** Output that arrived before `agent_spawn` returned the id to register under. */
const backlog = new Map<string, Array<(h: SpawnHandlers) => void>>()
let listening: Promise<void> | null = null

function dispatch(id: string, deliver: (h: SpawnHandlers) => void) {
  const h = handlers.get(id)
  if (h) deliver(h)
  else {
    if (!backlog.has(id)) backlog.set(id, [])
    backlog.get(id)!.push(deliver)
  }
}

function ensureListening() {
  listening ??= Promise.all([
    on('agent://stdout', e => dispatch(e.id, h => h.onLine(e.line))),
    on('agent://stderr', e => dispatch(e.id, h => h.onStderr?.(e.line))),
    on('agent://exit', e => dispatch(e.id, (h) => { h.onExit?.(e.code); handlers.delete(e.id) })),
    on('agent://connection', e => dispatch(e.id, h => h.onConnection?.(e.state))),
  ]).then(() => {})
  return listening
}

/**
 * Where the agent's CLI runs for a project: `cwd` is the folder the adapter sees. A remote
 * project (`env://…`) runs inside its instance, in the folder there.
 */
function placeOf(projectPath: string) {
  const loc = parseEnvPath(projectPath)
  return loc
    ? { cwd: loc.dir, remote: { hostId: loc.hostId, instance: loc.instance } }
    : { cwd: projectPath, remote: null }
}

/**
 * `onConnection`: a remote run lost its connection or has it back (the run goes on meanwhile);
 * the runner shows it, whether or not the adapter cares.
 */
function spawnFor(agent: AgentId, projectPath: string, onConnection?: (state: 'lost' | 'back') => void): SpawnFn {
  const { cwd, remote } = placeOf(projectPath)
  return async (args, given, env) => {
    await ensureListening()
    const id = await call('agent_spawn', { agent, args, cwd, env: env ?? null, ...(remote ? { remote } : {}) })
    const h: SpawnHandlers = onConnection
      ? {
          onLine: line => given.onLine(line),
          onStderr: line => given.onStderr?.(line),
          onExit: code => given.onExit?.(code),
          onConnection: (state) => { given.onConnection?.(state); onConnection(state) },
        }
      : given
    handlers.set(id, h)
    for (const deliver of backlog.get(id) ?? []) deliver(h)
    backlog.delete(id)
    return {
      write: line => call('agent_write', { id, data: `${line}\n` }),
      closeStdin: () => call('agent_close_stdin', { id }),
      kill: () => call('agent_kill', { id }),
    }
  }
}

/**
 * The models the agent's CLI offers (no turn is run). Null in the browser preview,
 * which has no CLI, and when the adapter cannot list them.
 */
export async function listAgentModels(agent: AgentId, cwd: string): Promise<AgentModel[] | null> {
  if (!isTauri()) return null
  const adapter = await adapters[agent]()
  // The list is kept per agent, not per project: ask the CLI on this computer, also for a remote project.
  return adapter.listModels ? adapter.listModels(spawnFor(agent, parseEnvPath(cwd) ? '' : cwd)) : null
}

/**
 * The slash commands the agent's CLI offers in the project at `cwd` (no turn is run).
 * Null in the browser preview, which has no CLI, and when the adapter has no list.
 */
export async function listAgentCommands(agent: AgentId, cwd: string): Promise<AgentCommand[] | null> {
  if (!isTauri()) return null
  const adapter = await adapters[agent]()
  return adapter.listCommands ? adapter.listCommands(spawnFor(agent, cwd), placeOf(cwd).cwd) : null
}

/**
 * The plan's usage limits as the agent's CLI reports them (no turn is run; the CLI starts
 * in the home folder). Rejects with a readable message when the CLI cannot answer.
 */
export async function readAgentUsage(agent: AgentId): Promise<AgentUsage> {
  const adapter = await adapters[agent]()
  if (!adapter.readUsage) throw new Error(`${agent} cannot report its usage.`)
  return adapter.readUsage(spawnFor(agent, ''))
}

/**
 * How full the conversation `sessionId` is, read in `workdir` (where its runs happen) without a
 * turn. Null in the browser preview and for agents that cannot say without one (Codex).
 */
export async function readAgentContext(agent: AgentId, workdir: string, sessionId: string, model: string): Promise<ContextUsage | null> {
  if (!isTauri()) return null
  const adapter = await adapters[agent]()
  return adapter.readContext ? adapter.readContext(spawnFor(agent, workdir), sessionId, model) : null
}

/* ------------------------------------------------------------------ */
/* Images tools produce                                                */
/* ------------------------------------------------------------------ */

const IMAGE_EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }
/** More than this per tool call is noise in the chat. */
const MAX_TOOL_IMAGES = 8

/**
 * Keeps the images a tool produced: the bytes go to the attachment store (so the chat
 * history holds only a path and a small preview), then they appear on the tool's row.
 */
async function keepToolImages(store: Store, part: Extract<Part, { type: 'tool' }>, images: ToolImage[], remote = false) {
  for (const img of images) {
    // A file the CLI saved in a remote environment is not on this computer's disk.
    if (remote && !img.data) continue
    if ((part.images?.length ?? 0) >= MAX_TOOL_IMAGES) return
    try {
      let info, data: string
      if (img.data) {
        const name = `image-${Date.now().toString(36)}.${IMAGE_EXT[img.mime] ?? 'png'}`
        info = await call('attachment_save', { name, data: img.data })
        data = img.data
      } else if (img.path) {
        info = await call('attachment_import', { path: img.path })
        data = await call('attachment_read', { path: info.path })
      } else continue
      const thumb = await makeThumb(info.mime, data)
      ;(part.images ??= []).push({ ...info, thumb })
      store.persist()
    } catch { /* an image that can't be kept is left out; the row still says what happened */ }
  }
}

/* ------------------------------------------------------------------ */
/* One turn                                                            */
/* ------------------------------------------------------------------ */

/**
 * Where a run writes: the chat's own agent messages, or a sub-agent's chat. A message the user
 * steers in mid-turn sits after the current one, and what the agent does from then on goes into
 * a new one below it; rows started earlier (a command still running) keep updating where they are.
 */
interface Target { threadId: string; msgs: Message[]; msg: Message; ended?: boolean }

function findIn<T extends Part['type']>(target: Target, type: T, id: string) {
  for (let i = target.msgs.length - 1; i >= 0; i--) {
    const part = target.msgs[i]!.parts.find(p => p.type === type && 'id' in p && p.id === id)
    if (part) return part as Extract<Part, { type: T }>
  }
  return undefined
}

/** A tool row by id, in the chat or any of its sub-agents' chats. */
function findTool(targets: Iterable<Target>, id: string) {
  for (const t of targets) {
    const part = findIn(t, 'tool', id)
    if (part) return part
  }
  return undefined
}

/** Close what a run left open in a chat: running rows fail, open approvals are cancelled. */
function settleParts(msgs: Message[], status: 'done' | 'error' | 'stopped') {
  for (const p of msgs.flatMap(m => m.parts)) {
    if (p.type === 'tool' && p.status === 'running') { p.status = 'error'; p.summary = status === 'stopped' ? 'stopped' : 'did not finish' }
    if ((p.type === 'approval' || p.type === 'question') && p.state === 'pending') p.state = 'cancelled'
    if (p.type === 'thinking' && p.seconds === 0) p.seconds = 1
  }
}

const TASK_END_SUMMARY = { done: 'finished', error: 'failed', stopped: 'stopped' } as const

/**
 * What a run gets for a message and its attachments. A `remote` run (the CLI is in a remote
 * environment) cannot read this computer's disk: pictures go inline, and every other file (or a
 * picture too large to send inline) is put into the environment first and named by its path
 * there. One that could not be put there stays behind and is listed in `dropped`.
 */
async function agentInput(text: string, files: Attachment[], remote: EnvRemote | null) {
  const read = (path: string) => call('attachment_read', { path })
  if (!files.length) return { prompt: text, images: [], readDirs: [] as string[], dropped: [] as DroppedAttachment[] }
  if (!remote) return { ...(await forAgent(text, files, read)), dropped: [] as DroppedAttachment[] }
  const put = (path: string) => call('attachment_put_remote', { ...remote, path })
  return { ...(await forRemoteAgent(text, files, read, put)), readDirs: [] as string[] }
}

/**
 * Mango's browser tools for a run in `threadId` (they belong to its top-level chat, whose
 * browser tab the agent drives). Undefined when they cannot be had: the run goes on without.
 */
async function browserToolsFor(store: Store, threadId: string) {
  const root = store.rootOf(threadId) ?? store.byId(threadId)
  if (!root) return undefined
  try {
    // A remote project's URL works inside its environment (the backend forwards it there).
    const mcp = await call('browser_mcp', { threadId: root.id, projectPath: root.projectPath })
    return mcp?.url && mcp.name ? { url: mcp.url, name: mcp.name, readOnlyTools: mcp.readOnlyTools ?? [] } : undefined
  } catch {
    return undefined
  }
}

/**
 * The MCP servers the user added that apply to a run of `agent` in `projectPath` (a worktree's
 * chat counts as its project's). Read fresh each turn, so a change in Settings reaches the next
 * message. A list that can't be read leaves them out: the run goes on without.
 */
async function userMcpFor(agent: AgentId, projectPath: string) {
  try {
    return mcpServersForRun(await call('mcp_servers'), agent, projectPath)
  } catch {
    return []
  }
}

/**
 * Run one turn to its end. `attachments`: files sent with `text`, already in the attachment store.
 * False when it was stopped before its agent started: that one never saw the prompt.
 */
export async function runAgentTurn(store: Store, threadId: string, text: string, attachments: Attachment[] = []): Promise<boolean> {
  const thread = store.byId(threadId)
  if (!thread) return false
  /** Where the agent works: the chat's own worktree, or the project folder. */
  const workdir = store.workdirFor(threadId) ?? thread.projectPath

  // The browser preview has no backend to run CLIs: simulate, and say so.
  if (!isTauri()) {
    thread.simulated = true
    await runMockAgent(store, threadId, text.trim() || attachments.map(a => a.name).join(', '))
    return true
  }
  thread.simulated = false

  const first = store._pushAgentMessage(threadId)
  if (!first) return false
  store._setStatus(threadId, 'running')
  const turn = Symbol(threadId)
  starting.set(threadId, turn)
  /** Stopped (and maybe sent again) while this got ready: the chat is not this turn's any more. */
  const standDown = () => {
    const t = store.byId(threadId)
    const at = t?.messages.findIndex(m => m.id === first.id && !m.parts.length) ?? -1
    if (at >= 0) t!.messages.splice(at, 1)
    store.persist(threadId)
    return false
  }

  const main: Target = { threadId, msgs: [first], msg: first }
  let runUsage: TurnUsage | null = null
  const place = placeOf(workdir)
  /** Sub-agents' chats, by the id of the tool call that started each. */
  const subs = new Map<string, Target>()
  const targetFor = (agent: string | undefined) => (agent ? subs.get(agent) : main)
  const push = <P extends Part>(target: Target, part: P) => store._pushPart(target.threadId, target.msg, part) as P
  const pendingApprovals = () => main.msgs.some(m => m.parts.some(awaitsUser))

  /** End a sub-agent's chat: how it went shows as its status and on its last message. */
  const endSub = (target: Target, status: 'done' | 'error' | 'stopped') => {
    if (target.ended) return
    target.ended = true
    settleParts(target.msgs, status)
    if (status === 'stopped') push(target, { type: 'notice', level: 'info', text: 'Stopped.' })
    for (const m of target.msgs) {
      const t = store.byId(target.threadId)
      if (!m.parts.length && t?.messages.includes(m)) t.messages.splice(t.messages.indexOf(m), 1)
    }
    // A finished sub-agent has nothing pending: it is settled, unlike a chat, which only the user settles.
    store._setStatus(target.threadId, status === 'error' ? 'error' : 'done', status)
  }

  /** Folders the agent moved into during this turn: their files changed too. */
  const moved = new Set<string>()
  let finish!: () => void
  let over = false
  const finished = new Promise<void>(resolve => (finish = () => { over = true; resolve() }))

  const emit = (e: AgentEvent) => {
    // Plugins see every event as it arrives (`chat.onAgentEvent`); one that throws is skipped.
    emitAgentEvent(threadId, e)
    const t = store.byId(threadId)
    if (!t) return
    switch (e.type) {
      case 'session':
        t.sessionId = e.sessionId
        break
      case 'context':
        t.context = mergeContext(t.context, e.usage)
        // Live readings come with every request; the full one at the end of a turn is worth saving.
        if (e.usage.max > 0) store.persist(threadId)
        break
      case 'workdir': {
        // The agent moved its session (Claude Code's EnterWorktree / ExitWorktree): later turns,
        // Changes, Files and the sidebar follow it. A remote run reports the folder inside its instance.
        const folder = place.remote ? envPath({ ...place.remote, dir: e.path }) : e.path
        moved.add(folder)
        void store.moveToWorktree(threadId, folder, e.branch ?? null)
        break
      }
      case 'text-delta': {
        const to = targetFor(e.agent)
        if (!to) break
        const part = findIn(to, 'text', e.id) ?? push(to, { type: 'text', id: e.id, text: '' })
        part.text += e.text
        break
      }
      case 'text': {
        const to = targetFor(e.agent)
        if (!to) break
        const part = findIn(to, 'text', e.id) ?? push(to, { type: 'text', id: e.id, text: '' })
        part.text = e.text
        break
      }
      case 'thinking-delta': {
        const to = targetFor(e.agent)
        if (!to) break
        const part = findIn(to, 'thinking', e.id) ?? push(to, { type: 'thinking', id: e.id, text: '', seconds: 0 })
        part.text += e.text
        break
      }
      case 'thinking-end': {
        const to = targetFor(e.agent)
        const part = to && findIn(to, 'thinking', e.id)
        if (!to || !part) break
        part.seconds = Math.max(e.seconds ?? 0, part.text ? 1 : 0)
        // A thinking block with no visible text and no measurable time is noise.
        if (!part.text && part.seconds < 1) {
          const owner = to.msgs.find(m => m.parts.includes(part))
          owner?.parts.splice(owner.parts.indexOf(part), 1)
        }
        break
      }
      case 'tool-start': {
        const to = targetFor(e.agent)
        if (to && !findIn(to, 'tool', e.id)) push(to, { type: 'tool', id: e.id, tool: e.tool, label: e.label, target: e.target, status: 'running' })
        break
      }
      case 'tool-update': {
        const to = targetFor(e.agent)
        const part = to && findIn(to, 'tool', e.id)
        if (!part) break
        if (e.target !== undefined) part.target = e.target
        if (e.summary !== undefined) part.summary = e.summary
        if (e.output !== undefined) part.output = e.output
        if (e.diff !== undefined) part.diff = e.diff
        if (e.images?.length) void keepToolImages(store, part, e.images, !!place.remote)
        break
      }
      case 'tool-end': {
        const to = targetFor(e.agent)
        const part = to && findIn(to, 'tool', e.id)
        if (!part) break
        part.status = e.status
        if (e.summary !== undefined) part.summary = e.summary
        if (e.output !== undefined) part.output = e.output
        if (e.diff !== undefined) part.diff = e.diff
        if (e.images?.length) void keepToolImages(store, part, e.images, !!place.remote)
        // `gh pr create` and the like: the new pull request or issue belongs to this chat.
        store._linkCreated(to.threadId, part)
        store.persist(to.threadId)
        break
      }
      case 'subagent-start': {
        if (subs.has(e.id)) break
        const parent = targetFor(e.parent) ?? main
        const child = store._createSubagent(parent.threadId, { toolId: e.id, title: e.title, agentType: e.agentType, prompt: e.prompt })
        const first = child && store._pushAgentMessage(child.id)
        if (!child || !first) break
        subs.set(e.id, { threadId: child.id, msgs: [first], msg: first })
        // The parent's "Delegated" row opens the sub-agent's chat.
        const row = findIn(parent, 'tool', e.id)
        if (row) row.childId = child.id
        break
      }
      case 'subagent-end': {
        const sub = subs.get(e.id)
        if (sub) endSub(sub, e.status)
        break
      }
      case 'task-start':
        store._taskStart(threadId, { id: e.id, kind: e.kind, title: e.title, ...(e.toolId ? { toolId: e.toolId } : {}) })
        break
      case 'task-update':
        store._taskUpdate(threadId, e.id, { ...(e.title ? { title: e.title } : {}), ...(e.activity ? { activity: e.activity } : {}) })
        break
      case 'task-end': {
        store._taskEnd(threadId, e.id, e.status, e.summary)
        // The row that started it said "in background"; now it says how that went.
        const toolId = store.live[threadId]?.tasks.find(x => x.id === e.id)?.toolId
        const row = toolId ? findTool([main, ...subs.values()], toolId) : undefined
        if (row && row.status === 'ok') row.summary = TASK_END_SUMMARY[e.status]
        if (row && e.status === 'error') row.status = 'error'
        break
      }
      case 'answered':
        store._setIdle(threadId, true)
        break
      case 'resume': {
        // The agent picks up again by itself: a reply of its own, saying what it reacts to.
        store._setIdle(threadId, false)
        const next = store._pushAgentMessage(threadId)
        if (!next) break
        main.msgs.push(next)
        main.msg = next
        push(main, { type: 'notice', level: 'info', text: e.reason })
        break
      }
      case 'approval': {
        const part: Part = { type: 'approval', id: e.id, title: e.title, command: e.command, reason: e.reason, state: 'pending' }
        // Sit right under the tool row the request is about, not after later rows.
        const owner = (e.toolId && main.msgs.find(m => m.parts.some(p => p.type === 'tool' && p.id === e.toolId))) || main.msg
        const at = e.toolId ? owner.parts.findIndex(p => p.type === 'tool' && p.id === e.toolId) : -1
        if (at >= 0) owner.parts.splice(at + 1, 0, part)
        else push(main, part)
        store._setStatus(threadId, 'waiting')
        break
      }
      case 'question': {
        const part: Part = { type: 'question', id: e.id, questions: e.questions, ...(e.title ? { title: e.title } : {}), ...(e.message ? { message: e.message } : {}), state: 'pending' }
        push(main, part)
        store._setStatus(threadId, 'waiting')
        break
      }
      case 'approval-cancelled': {
        const part = findIn(main, 'approval', e.id) ?? findIn(main, 'question', e.id)
        if (part?.state === 'pending') part.state = 'cancelled'
        if (!pendingApprovals() && t.status === 'waiting') store._setStatus(threadId, 'running')
        break
      }
      case 'usage':
        runUsage = e.usage
        break
      case 'turn-end': {
        settleParts(main.msgs, e.status)
        // Sub-agents end with the run that started them.
        for (const sub of subs.values()) endSub(sub, e.status === 'error' ? 'error' : 'stopped')
        if (e.status === 'error') {
          push(main, { type: 'notice', level: 'error', text: e.error || 'The agent stopped unexpectedly.' })
          // A conversation the CLI can no longer resume would fail forever: start fresh next time.
          if (/no longer has this conversation|could not be resumed/i.test(e.error ?? '')) t.sessionId = null
        }
        if (e.status === 'stopped') push(main, { type: 'notice', level: 'info', text: 'Stopped.' })
        // An agent message with nothing in it (stopped before any output) would render as a gap.
        for (const m of main.msgs) if (!m.parts.length && t.messages.includes(m)) t.messages.splice(t.messages.indexOf(m), 1)
        // What the turn spent goes on its last reply, beside how long it took.
        const lastReply = t.messages[t.messages.length - 1]
        if (runUsage && lastReply?.role === 'agent') lastReply.usage = { ...runUsage }
        runs.delete(threadId)
        store._clearLive(threadId)
        // Answering never settles a chat: it stays Working until the user marks it settled.
        store._setStatus(threadId, e.status === 'error' ? 'error' : 'working', e.status)
        finish()
        break
      }
    }
    // New output from the main conversation means it is no longer only waiting on background work.
    if ((e.type === 'text-delta' || e.type === 'tool-start') && !e.agent && store.live[threadId]?.idle) store._setIdle(threadId, false)
    const to = 'agent' in e && e.agent ? subs.get(e.agent) : undefined
    if (to) store._touch(to.threadId)
    store._touch(threadId)
  }

  /** Tell the user which files stayed behind (they could not be put into the remote environment). */
  const noteDropped = (dropped: DroppedAttachment[]) => {
    if (!dropped.length) return
    const names = dropped.map(d => d.attachment.name).join(', ')
    push(main, {
      type: 'notice',
      level: 'error',
      text: `Not sent: ${names}. ${dropped[0]!.error}`,
    })
  }

  try {
    const adapter = await adapters[thread.agent]()
    const { dropped, ...input } = await agentInput(text, attachments, place.remote)
    noteDropped(dropped)
    if (place.remote && !input.prompt.trim() && !input.images.length) {
      throw new Error(`Nothing to send: the attached files could not be put into the remote environment. ${dropped[0]?.error ?? ''}`.trim())
    }
    const [browserMcp, userMcp] = await Promise.all([
      browserToolsFor(store, threadId),
      userMcpFor(thread.agent, (store.rootOf(threadId) ?? thread).projectPath),
    ])
    // Plugins' servers come after the user's (a name the user has, or the browser's, stays theirs). Their
    // env values and headers are secrets like the user's: the adapters put them in the CLI's environment.
    // A remote project gets none: like the user's global servers, they would start in the wrong place.
    const pluginMcp = place.remote ? [] : pluginMcpFor(thread.agent, [...userMcp.map(s => s.name), ...(browserMcp ? [browserMcp.name] : [])])
    const mcpServers = [...userMcp, ...pluginMcp]
    const appendSystemPrompt = pluginSystemPrompt({
      threadId, agent: thread.agent, projectPath: (store.rootOf(threadId) ?? thread).projectPath, workdir,
    })
    if (starting.get(threadId) !== turn) return standDown()
    const run = adapter.run({
      cwd: place.cwd,
      remote: !!place.remote,
      ...input,
      model: thread.model,
      mode: thread.mode,
      effort: thread.effort ?? null,
      sessionId: thread.sessionId ?? null,
      ...(browserMcp ? { browserMcp } : {}),
      ...(mcpServers.length ? { mcpServers } : {}),
      ...(appendSystemPrompt ? { appendSystemPrompt } : {}),
      // Through a drop the run goes on in its environment: the chat says it is reconnecting, and stays Working.
      spawn: spawnFor(thread.agent, workdir, (state) => { if (!over) store._setReconnecting(threadId, state === 'lost') }),
      emit,
    })
    runs.set(threadId, {
      run,
      async steer(text, files) {
        if (!run.steer) return false
        const { dropped, ...input } = await agentInput(text, files, place.remote)
        // A message with nothing that can go along waits for the next turn, which says why.
        if (place.remote && !input.prompt.trim() && !input.images.length) return false
        if (runs.get(threadId)?.run !== run || !(await run.steer(input))) return false
        // The steered message is the last one in the chat: what the agent does next goes below it.
        if (runs.get(threadId)?.run === run) {
          store._setIdle(threadId, false)
          const next = store._pushAgentMessage(threadId)
          if (next) { main.msgs.push(next); main.msg = next }
          noteDropped(dropped)
        }
        return true
      },
    })
  } catch (err) {
    if (starting.get(threadId) !== turn) return standDown()
    emit({ type: 'turn-end', status: 'error', error: err instanceof Error ? err.message : String(err) })
  }

  starting.delete(threadId)
  await finished
  // The agent probably changed files: let whoever shows them (the changes panel) catch up.
  for (const path of new Set([workdir, ...moved])) window.dispatchEvent(new CustomEvent('mango:files-changed', { detail: { path } }))
  return true
}

export type { Thread }
