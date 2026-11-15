import type { AgentId, Part, Thread } from '~/types/chat'
import type { AgentAdapter, AgentEvent, AgentRun, SpawnFn, SpawnHandlers } from '~/agents/types'
import type { useThreads } from '~/stores/threads'
import { call, isTauri, on } from '~/composables/useBackend'
import { runMockAgent } from '~/utils/mockAgent'

/**
 * Runs agent turns for threads: picks the adapter, bridges its CLI process to
 * the Rust backend, and turns AgentEvents into message parts on the thread.
 */
type Store = ReturnType<typeof useThreads>

const adapters: Record<AgentId, () => Promise<AgentAdapter>> = {
  claude: () => import('~/agents/claude').then(m => m.claudeAdapter),
  codex: () => import('~/agents/codex').then(m => m.codexAdapter),
}

/** Live runs by thread id (not persisted: a run dies with the app). */
const runs = new Map<string, AgentRun>()

export const isRunning = (threadId: string) => runs.has(threadId)

export function respondApproval(threadId: string, approvalId: string, allow: boolean) {
  runs.get(threadId)?.respondApproval(approvalId, allow)
}

export function interruptRun(threadId: string): boolean {
  const run = runs.get(threadId)
  run?.interrupt()
  return !!run
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

/* ------------------------------------------------------------------ */
/* One turn                                                            */
/* ------------------------------------------------------------------ */

export async function runAgentTurn(store: Store, threadId: string, prompt: string): Promise<void> {
  const thread = store.byId(threadId)
  if (!thread) return

  // The browser preview has no backend to run CLIs: simulate, and say so.
  if (!isTauri()) {
    thread.simulated = true
    return runMockAgent(store, threadId, prompt)
  }
  thread.simulated = false

  const msg = store._pushAgentMessage(threadId)
  if (!msg) return
  store._setStatus(threadId, 'running')

  const find = <T extends Part['type']>(type: T, id: string) =>
    msg.parts.find(p => p.type === type && 'id' in p && p.id === id) as Extract<Part, { type: T }> | undefined
  const push = <P extends Part>(part: P) => store._pushPart(threadId, msg, part) as P
  const pendingApprovals = () => msg.parts.some(p => p.type === 'approval' && p.state === 'pending')

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
        if (!part.text && part.seconds < 1) msg.parts.splice(msg.parts.indexOf(part), 1)
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
        break
      }
      case 'tool-end': {
        const part = find('tool', e.id)
        if (!part) break
        part.status = e.status
        if (e.summary !== undefined) part.summary = e.summary
        if (e.output !== undefined) part.output = e.output
        if (e.diff !== undefined) part.diff = e.diff
        store.persist()
        break
      }
      case 'approval': {
        const part: Part = { type: 'approval', id: e.id, title: e.title, command: e.command, reason: e.reason, state: 'pending' }
        // Sit right under the tool row the request is about, not after later rows.
        const at = e.toolId ? msg.parts.findIndex(p => p.type === 'tool' && p.id === e.toolId) : -1
        if (at >= 0) msg.parts.splice(at + 1, 0, part)
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
        for (const p of msg.parts) {
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
        if (!msg.parts.length) t.messages.splice(t.messages.indexOf(msg), 1)
        runs.delete(threadId)
        store._setStatus(threadId, e.status === 'done' ? 'done' : e.status === 'error' ? 'error' : 'idle')
        finish()
        break
      }
    }
    store._touch(threadId)
  }

  try {
    const adapter = await adapters[thread.agent]()
    const run = adapter.run({
      cwd: thread.projectPath,
      prompt,
      model: thread.model,
      mode: thread.mode,
      sessionId: thread.sessionId ?? null,
      spawn: spawnFor(thread.agent, thread.projectPath),
      emit,
    })
    runs.set(threadId, run)
  } catch (err) {
    emit({ type: 'turn-end', status: 'error', error: err instanceof Error ? err.message : String(err) })
  }

  await finished
  // The agent probably changed files: let whoever shows them (the changes panel) catch up.
  window.dispatchEvent(new CustomEvent('mango:files-changed', { detail: { path: thread.projectPath } }))
}

export type { Thread }
