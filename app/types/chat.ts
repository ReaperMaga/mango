import type { PermissionMode } from '~/agents/types'

export type { PermissionMode }
export type AgentId = 'claude' | 'codex'

/** Ripeness: how far along a thread is. Drives the signature status dot. */
export type ThreadStatus =
  | 'idle'     // nothing asked yet
  | 'queued'   // message sent, agent not started
  | 'running'  // agent working
  | 'working'  // marked "in progress" by the user; no agent run is active right now
  | 'waiting'  // agent needs the user (approval / question)
  | 'done'     // finished, unread result
  | 'error'

/** 'other' covers anything without its own row style (sub-agents, plans, MCP tools); give it a `label`. */
export type ToolKind = 'read' | 'edit' | 'write' | 'bash' | 'search' | 'web' | 'other'

export interface DiffLine { kind: 'add' | 'del' | 'ctx' | 'hunk'; text: string }

/** Parts carry the agent's own block id (`id`) so streamed events can find them again. */
export type Part =
  | { type: 'text'; text: string; id?: string }
  | { type: 'thinking'; text: string; seconds: number; id?: string }
  | {
      type: 'tool'
      id?: string
      tool: ToolKind
      /** Overrides the verb shown for the row, e.g. "Delegated", "Listed". */
      label?: string
      /** e.g. file path or command */
      target: string
      status: 'running' | 'ok' | 'error'
      summary?: string
      output?: string
      diff?: DiffLine[]
    }
  | { type: 'approval'; id?: string; title?: string; command: string; reason: string; state: 'pending' | 'allowed' | 'denied' | 'cancelled' }
  /** A run-level problem shown inline (CLI missing, not signed in, crashed). */
  | { type: 'notice'; level: 'error' | 'info'; text: string }

export interface Message {
  id: string
  role: 'user' | 'agent'
  parts: Part[]
  createdAt: number
  /** Agent messages: how long the turn took, from the user's message to the end. */
  elapsedMs?: number
  /** Agent messages: how the turn ended. */
  outcome?: 'done' | 'stopped' | 'error'
}

export interface Thread {
  id: string
  projectPath: string
  title: string
  agent: AgentId
  model: string
  mode: PermissionMode
  status: ThreadStatus
  messages: Message[]
  createdAt: number
  updatedAt: number
  /** user has seen the latest agent output */
  seen: boolean
  /** true when the agent output in this thread came from the built-in mock, not a real CLI run */
  simulated?: boolean
  /** Position in the sidebar once the user has arranged a project's chats by hand; unset = newest activity first. */
  order?: number
  /** Put away by the user: hidden from the thread list, kept on disk. Its run status is remembered underneath. */
  archived?: boolean
  /** The CLI's own session id, used to resume the conversation on the next turn. */
  sessionId?: string | null
  /** git branch or worktree the agent works on */
  branch?: string | null
}

export interface AgentModel { id: string; label: string; hint?: string }

/**
 * Known agents. `models[0]` is the default. Model ids are what the adapter in
 * app/agents/ passes to the CLI; 'default' means "let the CLI decide".
 */
export const AGENTS: Record<AgentId, { name: string; models: AgentModel[] }> = {
  claude: {
    name: 'Claude Code',
    models: [
      { id: 'default', label: 'Default', hint: 'Whatever Claude Code is configured to use' },
      { id: 'opus', label: 'Opus', hint: 'Most capable' },
      { id: 'sonnet', label: 'Sonnet', hint: 'Balanced' },
      { id: 'haiku', label: 'Haiku', hint: 'Fastest' },
    ],
  },
  codex: {
    name: 'Codex',
    models: [
      { id: 'default', label: 'Default', hint: 'Whatever Codex is configured to use' },
      { id: 'gpt-6-luna', label: 'GPT-6-Luna', hint: 'Fast and affordable' },
      { id: 'gpt-5.6-terra', label: 'GPT-5.6-Terra', hint: 'Older, balanced' },
      { id: 'gpt-5.6-luna', label: 'GPT-5.6-Luna', hint: 'Older, fast' },
    ],
  },
}

export const modelLabel = (agent: AgentId, id: string) =>
  AGENTS[agent].models.find(m => m.id === id)?.label ?? id

/**
 * What a chat's status reads as. Four of them are the chat's life, and all four
 * can be picked by hand: Idle (not started, or parked), Working (in progress:
 * an agent is running, or you marked it so), Settled (the agent finished its
 * turn, or you called it finished) and Archived. Two more only come from a run
 * and need to be visible: "Needs you" (an approval is open) and "Failed".
 */
export type DisplayStatus = 'idle' | 'working' | 'waiting' | 'done' | 'error' | 'archived'

export function displayStatus(t: Pick<Thread, 'status' | 'archived'>): DisplayStatus {
  if (t.archived) return 'archived'
  if (t.status === 'running' || t.status === 'queued' || t.status === 'working') return 'working'
  return t.status
}

export const STATUS_LABELS: Record<DisplayStatus, string> = {
  idle: 'Idle',
  working: 'Working',
  waiting: 'Needs you',
  done: 'Settled',
  error: 'Failed',
  archived: 'Archived',
}

export const statusLabel = (t: Pick<Thread, 'status' | 'archived'>) => STATUS_LABELS[displayStatus(t)]
