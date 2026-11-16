import type { AgentId, AgentModel, Attachment, Message, Part, Thread } from '~/types/chat'
import type { AgentAdapter, AgentEvent, AgentRun, AgentUsage, SpawnFn, SpawnHandlers, ToolImage } from '~/agents/types'
import type { useThreads } from '~/stores/threads'
import { call, isTauri, on } from '~/composables/useBackend'
import { runMockAgent } from '~/utils/mockAgent'
import { forAgent, makeThumb } from '~/utils/attachments'

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

function spawnFor(agent: AgentId, cwd: string): SpawnFn {
  return async (args, h, env) => {
    await ensureListening()
    const id = await call('agent_spawn', { agent, args, cwd, env: env ?? null })
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
  return adapter.listModels ? adapter.listModels(spawnFor(agent, cwd)) : null
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
async function keepToolImages(store: Store, part: Extract<Part, { type: 'tool' }>, images: ToolImage[]) {
  for (const img of images) {
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

  /**
   * The turn's agent messages. A message the user steers in mid-turn sits after the current one,
   * and what the agent does from then on goes into a new one below it; rows started earlier
   * (a command still running) keep updating where they are.
   */
  const msgs: Message[] = [first]
  let msg = first
  const find = <T extends Part['type']>(type: T, id: string) => {
    for (let i = msgs.length - 1; i >= 0; i--) {
      const part = msgs[i]!.parts.find(p => p.type === type && 'id' in p && p.id === id)
      if (part) return part as Extract<Part, { type: T }>
    }
    return undefined
  }
  const push = <P extends Part>(part: P) => store._pushPart(threadId, msg, part) as P
  const pendingApprovals = () => msgs.some(m => m.parts.some(p => p.type === 'approval' && p.state === 'pending'))

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
        const part = find('text', e.id) ?? push({ type: 'text', id: e.id, text: '' })
        part.text += e.text
        break
      }
      case 'text': {
        const part = find('text', e.id) ?? push({ type: 'text', id: e.id, text: '' })
        part.text = e.text
        break
      }
      case 'thinking-delta': {
        const part = find('thinking', e.id) ?? push({ type: 'thinking', id: e.id, text: '', seconds: 0 })
        part.text += e.text
        break
      }
      case 'thinking-end': {
        const part = find('thinking', e.id)
        if (!part) break
        part.seconds = Math.max(e.seconds ?? 0, part.text ? 1 : 0)
        // A thinking block with no visible text and no measurable time is noise.
        if (!part.text && part.seconds < 1) {
          const owner = msgs.find(m => m.parts.includes(part))
          owner?.parts.splice(owner.parts.indexOf(part), 1)
        }
        break
      }
      case 'tool-start':
        if (!find('tool', e.id)) push({ type: 'tool', id: e.id, tool: e.tool, label: e.label, target: e.target, status: 'running' })
        break
      case 'tool-update': {
        const part = find('tool', e.id)
        if (!part) break
        if (e.target !== undefined) part.target = e.target
        if (e.summary !== undefined) part.summary = e.summary
        if (e.output !== undefined) part.output = e.output
        if (e.diff !== undefined) part.diff = e.diff
        if (e.images?.length) void keepToolImages(store, part, e.images)
        break
      }
      case 'tool-end': {
        const part = find('tool', e.id)
        if (!part) break
        part.status = e.status
        if (e.summary !== undefined) part.summary = e.summary
        if (e.output !== undefined) part.output = e.output
        if (e.diff !== undefined) part.diff = e.diff
        if (e.images?.length) void keepToolImages(store, part, e.images)
        store.persist()
        break
      }
      case 'approval': {
        const part: Part = { type: 'approval', id: e.id, title: e.title, command: e.command, reason: e.reason, state: 'pending' }
        // Sit right under the tool row the request is about, not after later rows.
        const owner = (e.toolId && msgs.find(m => m.parts.some(p => p.type === 'tool' && p.id === e.toolId))) || msg
        const at = e.toolId ? owner.parts.findIndex(p => p.type === 'tool' && p.id === e.toolId) : -1
        if (at >= 0) owner.parts.splice(at + 1, 0, part)
        else push(part)
        store._setStatus(threadId, 'waiting')
        break
      }
      case 'approval-cancelled': {
        const part = find('approval', e.id)
        if (part?.state === 'pending') part.state = 'cancelled'
        if (!pendingApprovals() && t.status === 'waiting') store._setStatus(threadId, 'running')
        break
      }
      case 'turn-end': {
        for (const p of msgs.flatMap(m => m.parts)) {
          if (p.type === 'tool' && p.status === 'running') { p.status = 'error'; p.summary = e.status === 'stopped' ? 'stopped' : 'did not finish' }
          if (p.type === 'approval' && p.state === 'pending') p.state = 'cancelled'
          if (p.type === 'thinking' && p.seconds === 0) p.seconds = 1
        }
        if (e.status === 'error') {
          push({ type: 'notice', level: 'error', text: e.error || 'The agent stopped unexpectedly.' })
          // A conversation the CLI can no longer resume would fail forever: start fresh next time.
          if (/no longer has this conversation|could not be resumed/i.test(e.error ?? '')) t.sessionId = null
        }
        if (e.status === 'stopped') push({ type: 'notice', level: 'info', text: 'Stopped.' })
        // An agent message with nothing in it (stopped before any output) would render as a gap.
        for (const m of msgs) if (!m.parts.length && t.messages.includes(m)) t.messages.splice(t.messages.indexOf(m), 1)
        runs.delete(threadId)
        // Answering never settles a chat: it stays Working until the user marks it settled.
        store._setStatus(threadId, e.status === 'error' ? 'error' : 'working', e.status)
        finish()
        break
      }
    }
    store._touch(threadId)
  }

  try {
    const adapter = await adapters[thread.agent]()
    const input = attachments.length
      ? await forAgent(text, attachments, path => call('attachment_read', { path }))
      : { prompt: text, images: [], readDirs: [] }
    const run = adapter.run({
      cwd: thread.projectPath,
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
        const input = files.length
          ? await forAgent(text, files, path => call('attachment_read', { path }))
          : { prompt: text, images: [], readDirs: [] }
        if (runs.get(threadId)?.run !== run || !(await run.steer(input))) return false
        // The steered message is the last one in the chat: what the agent does next goes below it.
        if (runs.get(threadId)?.run === run) {
          const next = store._pushAgentMessage(threadId)
          if (next) { msgs.push(next); msg = next }
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
