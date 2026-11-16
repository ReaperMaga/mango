import type { AgentCommand, AgentId, AgentModel, Attachment, Message, Part, Thread } from '~/types/chat'
import type { AgentAdapter, AgentEvent, AgentRun, AgentUsage, SpawnFn, SpawnHandlers, ToolImage } from '~/agents/types'
import type { useThreads } from '~/stores/threads'
import { call, isTauri, on } from '~/composables/useBackend'
import { runMockAgent } from '~/utils/mockAgent'
import { forAgent, makeThumb } from '~/utils/attachments'
import { parseEnvPath } from '~/utils/envPath'

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

export const isRunning = (threadId: string) => runs.has(threadId)

export function respondApproval(threadId: string, approvalId: string, allow: boolean) {
  runs.get(threadId)?.run.respondApproval(approvalId, allow)
}

export function interruptRun(threadId: string): boolean {
  const live = runs.get(threadId)
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

function spawnFor(agent: AgentId, projectPath: string): SpawnFn {
  const { cwd, remote } = placeOf(projectPath)
  return async (args, h, env) => {
    await ensureListening()
    const id = await call('agent_spawn', { agent, args, cwd, env: env ?? null, ...(remote ? { remote } : {}) })
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
    if (p.type === 'approval' && p.state === 'pending') p.state = 'cancelled'
    if (p.type === 'thinking' && p.seconds === 0) p.seconds = 1
  }
}

const TASK_END_SUMMARY = { done: 'finished', error: 'failed', stopped: 'stopped' } as const

/**
 * What a run gets for a message and its attachments. A `remote` run (the CLI is in a remote
 * environment) cannot read this computer's disk: pictures go inline, every other file (and a
 * picture too large to send inline) stays behind and is listed in `dropped`.
 */
async function agentInput(text: string, files: Attachment[], remote: boolean) {
  const read = (path: string) => call('attachment_read', { path })
  if (!files.length) return { prompt: text, images: [], readDirs: [] as string[], dropped: [] as Attachment[] }
  if (!remote) return { ...(await forAgent(text, files, read)), dropped: [] as Attachment[] }
  const { images } = await forAgent(text, files.filter(a => a.kind === 'image'), read)
  const sent = new Set(images.map(i => i.path))
  return { prompt: text.trim(), images, readDirs: [] as string[], dropped: files.filter(a => !sent.has(a.path)) }
}

/** `attachments`: files sent with `text`, already in the attachment store. */
export async function runAgentTurn(store: Store, threadId: string, text: string, attachments: Attachment[] = []): Promise<void> {
  const thread = store.byId(threadId)
  if (!thread) return

  // The browser preview has no backend to run CLIs: simulate, and say so.
  if (!isTauri()) {
    thread.simulated = true
    return runMockAgent(store, threadId, text.trim() || attachments.map(a => a.name).join(', '))
  }
  thread.simulated = false

  const first = store._pushAgentMessage(threadId)
  if (!first) return
  store._setStatus(threadId, 'running')

  const main: Target = { threadId, msgs: [first], msg: first }
  const place = placeOf(thread.projectPath)
  /** Sub-agents' chats, by the id of the tool call that started each. */
  const subs = new Map<string, Target>()
  const targetFor = (agent: string | undefined) => (agent ? subs.get(agent) : main)
  const push = <P extends Part>(target: Target, part: P) => store._pushPart(target.threadId, target.msg, part) as P
  const pendingApprovals = () => main.msgs.some(m => m.parts.some(p => p.type === 'approval' && p.state === 'pending'))

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

  let finish!: () => void
  const finished = new Promise<void>(resolve => (finish = resolve))

  const emit = (e: AgentEvent) => {
    const t = store.byId(threadId)
    if (!t) return
    switch (e.type) {
      case 'session':
        t.sessionId = e.sessionId
        break
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
        store.persist()
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
      case 'approval-cancelled': {
        const part = findIn(main, 'approval', e.id)
        if (part?.state === 'pending') part.state = 'cancelled'
        if (!pendingApprovals() && t.status === 'waiting') store._setStatus(threadId, 'running')
        break
      }
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

  /** Tell the user which files stayed behind (a remote run cannot read this computer's disk). */
  const noteDropped = (dropped: Attachment[]) => {
    if (!dropped.length) return
    const names = dropped.map(a => a.name).join(', ')
    push(main, {
      type: 'notice',
      level: 'info',
      text: `Not sent: ${names}. The agent runs in a remote environment and can't read files on this computer; only pictures go along. Copy files into the instance from a terminal.`,
    })
  }

  try {
    const adapter = await adapters[thread.agent]()
    const { dropped, ...input } = await agentInput(text, attachments, !!place.remote)
    noteDropped(dropped)
    if (place.remote && !input.prompt.trim() && !input.images.length) {
      throw new Error('Nothing to send: the attached files are on this computer, and the remote environment can\'t read them. Paste pictures instead, or copy the files into the instance from a terminal.')
    }
    const run = adapter.run({
      cwd: place.cwd,
      remote: !!place.remote,
      ...input,
      model: thread.model,
      mode: thread.mode,
      effort: thread.effort ?? null,
      sessionId: thread.sessionId ?? null,
      spawn: spawnFor(thread.agent, thread.projectPath),
      emit,
    })
    runs.set(threadId, {
      run,
      async steer(text, files) {
        if (!run.steer) return false
        const { dropped, ...input } = await agentInput(text, files, !!place.remote)
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
    emit({ type: 'turn-end', status: 'error', error: err instanceof Error ? err.message : String(err) })
  }

  await finished
  // The agent probably changed files: let whoever shows them (the changes panel) catch up.
  window.dispatchEvent(new CustomEvent('mango:files-changed', { detail: { path: thread.projectPath } }))
}

export type { Thread }
