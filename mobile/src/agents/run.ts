import type { AgentId, Attachment, QuestionAnswers } from '~/types/chat'
import type { AgentAdapter, AgentRun } from '~/agents/types'
import { claudeAdapter } from '~/agents/claude'
import { codexAdapter } from '~/agents/codex'
import { backend } from '@/remote'
import { useThreads } from '@/state/threads'
import { createTurn } from '@/agents/turn'
import { agentInput, inlineFor } from '@/attachments/input'

/**
 * Runs agent turns for chats on the phone: a port of the desktop's `app/agents/index.ts`. The
 * adapters are the desktop's own (`~/agents/claude`, `~/agents/codex`), unchanged; their CLI runs
 * in the chat's environment through `backend.spawnFor` (SSH, or the simulation in the web
 * preview). What a turn does to its chat is in `turn.ts`.
 *
 * Left out against the desktop, because a phone has none of it: the browser tools (MCP), pictures
 * tools produce (no attachment store), and making worktrees (a chat waiting for one runs in the
 * project folder). Attachments go further than on the desktop: they are put into the environment
 * when picked (`@/attachments`), so every file reaches the agent, not only pictures.
 */

const adapters: Record<AgentId, AgentAdapter> = {
  claude: claudeAdapter,
  codex: codexAdapter,
}

/** A live run, and how to hand it a message mid-turn. */
interface LiveRun { run: AgentRun; steer(text: string, attachments: Attachment[]): Promise<boolean> }

/** Live runs by thread id (not persisted: a run dies with the app). */
const runs = new Map<string, LiveRun>()

export const isRunning = (threadId: string) => runs.has(threadId)

export function respondApproval(threadId: string, approvalId: string, allow: boolean) {
  runs.get(threadId)?.run.respondApproval(approvalId, allow)
}

export function answerQuestion(threadId: string, questionId: string, answers: QuestionAnswers | null) {
  runs.get(threadId)?.run.answerQuestion?.(questionId, answers)
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

/** Stop one background task or sub-agent of the chat's run (the id of its task or of the call that started it). */
export function stopTask(threadId: string, id: string) {
  runs.get(threadId)?.run.stopTask?.(id)
}

/** The end of a background command's output, or null when there is none to read. */
export function readTaskOutput(threadId: string, id: string): Promise<string | null> {
  return runs.get(threadId)?.run.taskOutput?.(id) ?? Promise.resolve(null)
}

/* ------------------------------------------------------------------ */
/* Files changed                                                       */
/* ------------------------------------------------------------------ */

const filesListeners = new Set<(path: string) => void>()

/**
 * Called with each folder (an `env://` path) a finished turn probably changed files in: the
 * desktop's `mango:files-changed` event. Returns how to stop listening.
 */
export function onFilesChanged(listener: (path: string) => void): () => void {
  filesListeners.add(listener)
  return () => { filesListeners.delete(listener) }
}

/* ------------------------------------------------------------------ */
/* One turn                                                            */
/* ------------------------------------------------------------------ */

/**
 * Run one turn of chat `threadId` for a user message already in it. Resolves when the turn has
 * ended (and its end is in the chat). `attachments`: files sent with `text`, already inside the
 * environment.
 */
export async function runAgentTurn(threadId: string, text: string, attachments: Attachment[] = []): Promise<void> {
  const store = useThreads.getState()
  const thread = store.byId(threadId)
  if (!thread) return
  /** Where the agent works: the chat's own worktree, or the project folder. */
  const workdir = store.workdirFor(threadId) ?? thread.projectPath

  // The web preview's replies come from a simulated CLI: say so on the chat.
  store.edit(threadId, (d) => { d.simulated = !backend.real })

  const first = store._pushAgentMessage(threadId)
  if (!first) return
  store._setStatus(threadId, 'running')

  let current: AgentRun | null = null
  const turn = createTurn(store, threadId, first, workdir, () => {
    if (current && runs.get(threadId)?.run === current) runs.delete(threadId)
  })

  try {
    const adapter = adapters[thread.agent]
    const { prompt, images } = agentInput(text, attachments, inlineFor)
    if (!prompt && !images.length) throw new Error('Nothing to send.')
    const run = adapter.run({
      cwd: turn.place.cwd,
      remote: !!turn.place.remote,
      prompt,
      images,
      // The attachments are in the agent user's home inside the environment: readable without a grant.
      readDirs: [],
      model: thread.model,
      mode: thread.mode,
      effort: thread.effort ?? null,
      sessionId: thread.sessionId ?? null,
      spawn: backend.spawnFor(thread.agent, workdir),
      emit: turn.emit,
    })
    current = run
    // A run that failed while it started has already ended: there is nothing to keep.
    if (!turn.ended) {
      runs.set(threadId, {
        run,
        async steer(text, files) {
          if (!run.steer) return false
          const input = agentInput(text, files, inlineFor)
          if (!input.prompt && !input.images.length) return false
          if (runs.get(threadId)?.run !== run || !(await run.steer({ ...input, readDirs: [] }))) return false
          // The steered message is the last one in the chat: what the agent does next goes below it.
          if (runs.get(threadId)?.run === run) {
            useThreads.getState()._setIdle(threadId, false)
            turn.nextMessage()
          }
          return true
        },
      })
    }
  } catch (err) {
    turn.emit({ type: 'turn-end', status: 'error', error: err instanceof Error ? err.message : String(err) })
  }

  await turn.finished
  // The agent probably changed files: let whoever shows them (the changes screen) catch up.
  for (const path of new Set([workdir, ...turn.moved])) {
    for (const listener of filesListeners) {
      try { listener(path) } catch { /* one listener's failure is not the run's */ }
    }
  }
}
