import type { AgentId, DiffLine, ToolKind } from '~/types/chat'

/**
 * How an agent CLI is driven. One `run()` is one turn: the adapter starts (or
 * talks to) the CLI, translates its protocol into `AgentEvent`s, and finishes
 * with exactly one `turn-end`. Adapters hold no UI state.
 */

/** Line-based stdio of one CLI process. */
export interface AgentTransport {
  /** Writes `line` plus a newline to stdin. */
  write(line: string): Promise<void>
  closeStdin(): Promise<void>
  kill(): Promise<void>
}

export interface SpawnHandlers {
  onLine(line: string): void
  onStderr?(line: string): void
  onExit?(code: number | null): void
}

/** Starts the agent's CLI with `args` in `cwd`. Handlers are attached before any output can arrive. */
export type SpawnFn = (args: string[], handlers: SpawnHandlers, env?: Record<string, string>) => Promise<AgentTransport>

export type PermissionMode =
  | 'plan'   // read-only: explore and propose, change nothing
  | 'ask'    // ask before edits and commands
  | 'edits'  // file edits are automatic, commands still ask
  | 'auto'   // nothing asks

export type AgentEvent =
  /** The CLI's own session/thread id. Persisted on the thread and passed back as `sessionId` to resume. */
  | { type: 'session'; sessionId: string }
  /** Append to (or create) the text block `id`. */
  | { type: 'text-delta'; id: string; text: string }
  /** Authoritative full text of block `id` (replaces what deltas built). */
  | { type: 'text'; id: string; text: string }
  | { type: 'thinking-delta'; id: string; text: string }
  | { type: 'thinking-end'; id: string; seconds?: number }
  /** `label` overrides the row's verb ("Delegated", "Listed"); needed for tool 'other'. */
  | { type: 'tool-start'; id: string; tool: ToolKind; target: string; label?: string }
  /** Any subset of fields; e.g. the target once the tool input finished streaming, or live output. */
  | { type: 'tool-update'; id: string; target?: string; summary?: string; output?: string; diff?: DiffLine[] }
  | { type: 'tool-end'; id: string; status: 'ok' | 'error'; summary?: string; output?: string; diff?: DiffLine[] }
  /** The agent needs a yes/no from the user. Answer with `AgentRun.respondApproval(id, allow)`. */
  /** `toolId` (optional) is the tool-start id this request is about, so the UI can show it next to that row. */
  | { type: 'approval'; id: string; title: string; command: string; reason: string; toolId?: string }
  /** The approval was settled without the user (e.g. the run was interrupted). */
  | { type: 'approval-cancelled'; id: string }
  /** Exactly one per run, always last. */
  | { type: 'turn-end'; status: 'done' | 'error' | 'stopped'; error?: string }

export interface AgentRunOptions {
  cwd: string
  prompt: string
  /** A model id from the adapter's `models`, or 'default' to let the CLI choose. */
  model: string
  mode: PermissionMode
  /** From an earlier `session` event of the same thread, null for a new conversation. */
  sessionId: string | null
  spawn: SpawnFn
  emit(event: AgentEvent): void
}

export interface AgentRun {
  respondApproval(id: string, allow: boolean): void
  /** Ask the agent to stop the turn. The adapter still emits `turn-end` (status 'stopped'). */
  interrupt(): void
}

/**
 * Adapters must stay runnable outside the app (see scripts/try-agent.ts):
 * import only types from '~/...', and touch no Vue, Pinia or Tauri API.
 * Display names and model lists live in AGENTS (types/chat.ts).
 */
export interface AgentAdapter {
  id: AgentId
  run(options: AgentRunOptions): AgentRun
}
