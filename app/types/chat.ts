import type { AgentQuestion, ContextUsage, PermissionMode, QuestionAnswers } from '~/agents/types'

export type { AgentQuestion, ContextUsage, PermissionMode, QuestionAnswers }
export type AgentId = 'claude' | 'codex'

/** Ripeness: how far along a thread is. Drives the signature status dot. */
export type ThreadStatus =
  | 'queued'   // message sent, agent not started
  | 'running'  // agent working
  | 'working'  // in progress, no agent run active: new chats and every finished turn land here
  | 'waiting'  // agent needs the user (approval / question)
  | 'done'     // settled: only ever set by the user, with the mark in the sidebar
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
      /** Images the tool produced (screenshots, images it read), kept in the attachment store. */
      images?: Attachment[]
      /** The sub-agent this call started: its own chat (a child thread). */
      childId?: string
    }
  | { type: 'approval'; id?: string; title?: string; command: string; reason: string; state: 'pending' | 'allowed' | 'denied' | 'cancelled' }
  /**
   * Questions from the agent or an MCP server, answered in the chat. `title` names who asks when
   * it is not the agent itself; `message` is what they say first. `answers` holds one entry per
   * question (secret ones are not kept).
   */
  | {
      type: 'question'
      id?: string
      questions: AgentQuestion[]
      title?: string
      message?: string
      state: 'pending' | 'answered' | 'dismissed' | 'cancelled'
      answers?: QuestionAnswers
    }
  /** A run-level problem shown inline (CLI missing, not signed in, crashed). */
  | { type: 'notice'; level: 'error' | 'info'; text: string }

/** An approval or a question still waiting for the user: while one is open, the chat needs them. */
export const awaitsUser = (p: Part) => (p.type === 'approval' || p.type === 'question') && p.state === 'pending'

/** What a waiting chat waits for: an answer to a question, or an approval. */
export const waitingFor = (t: Pick<Thread, 'messages'>): 'answer' | 'approval' => {
  const last = t.messages[t.messages.length - 1]
  return last?.parts.some(p => p.type === 'question' && p.state === 'pending') ? 'answer' : 'approval'
}

/**
 * A file sent with a user message. The bytes live in Mango's attachment store on disk
 * (`attachment_save` / `attachment_import`); the message keeps only this and a small preview.
 */
export interface Attachment {
  id: string
  name: string
  /** Absolute path of the stored copy, which the agent reads. */
  path: string
  mime: string
  size: number
  /** 'image': PNG, JPEG, GIF or WebP, sent to the agent as a picture. 'file': handed over by path. */
  kind: 'image' | 'file'
  /** Small preview of an image as a data URL. */
  thumb?: string
}

export interface Message {
  id: string
  role: 'user' | 'agent'
  parts: Part[]
  /** User messages: files sent along. */
  attachments?: Attachment[]
  createdAt: number
  /** Agent messages: how long the turn took, from the user's message to the end. */
  elapsedMs?: number
  /** Agent messages: how the turn ended. */
  outcome?: 'done' | 'stopped' | 'error'
  /** User messages in a sub-agent's chat: the task the parent agent wrote, not the person. */
  fromAgent?: boolean
  /** Kept by the user: listed under "Pinned" in the message list. */
  pinned?: true
  /** Agent messages: what the turn used (tokens in, with cached ones, and out; the cost when the CLI says). */
  usage?: { input: number; output: number; costUsd?: number }
  /** User messages that waited in the queue: when the person wrote it (`createdAt` is when it went out). */
  writtenAt?: number
}

/**
 * Something an agent run keeps going in the background (a command, a sub-agent nobody waits
 * for). Lives only as long as the run: not saved.
 */
export interface BackgroundTask {
  id: string
  kind: 'command' | 'agent' | 'other'
  title: string
  /** The tool row that started it. */
  toolId?: string
  /** What it is doing now. */
  activity?: string
  status: 'running' | 'done' | 'error' | 'stopped'
  summary?: string
  startedAt: number
  endedAt?: number
}

/**
 * A pull request or issue linked to a chat: one the agent created during it (`gh pr create`,
 * a GitHub MCP tool), or one the user linked by hand. The details are read from GitHub when
 * shown; `title` and `state` keep the last ones seen so the list reads well offline.
 */
export interface LinkedItem {
  /** `host/owner/repo#number`, lower case: the same item however it was written. */
  key: string
  kind: 'pr' | 'issue'
  url: string
  host: string
  owner: string
  repo: string
  number: number
  title?: string
  state?: 'open' | 'draft' | 'merged' | 'closed'
  source: 'agent' | 'user'
  linkedAt: number
}

export interface Thread {
  id: string
  projectPath: string
  title: string
  agent: AgentId
  model: string
  mode: PermissionMode
  /** Reasoning effort for the agent ("low" … "max"); null or missing leaves it to the CLI. */
  effort?: string | null
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
  /** The git branch the chat started on (for a worktree chat: its worktree's branch). */
  branch?: string | null
  /**
   * The linked git worktree (its folder) the chat works in, so it can run beside other chats of the
   * project without touching their files. Null or missing: the project folder itself.
   * Sub-agent chats leave it unset and work where their top-level chat does.
   */
  worktree?: string | null
  /**
   * A chat started as "New chat in a worktree" whose worktree is not made yet: it runs nowhere until
   * its first message, which names the branch and adds the worktree before the agent starts.
   */
  awaitingWorktree?: true
  /**
   * Set on a sub-agent's chat: the chat (or sub-agent) that started it. Such a chat is read-only,
   * filled by the parent's run, and listed under its parent instead of on its own.
   */
  parentId?: string | null
  /** Sub-agent chats: the tool call in the parent that started it. */
  toolId?: string
  /** Sub-agent chats: the kind of agent ("Explore", "general-purpose"). */
  agentType?: string
  /** Pull requests and issues linked to this chat, oldest first. Sub-agent chats link to their top-level chat. */
  links?: LinkedItem[]
  /**
   * The earlier messages as text, for the agent's next turn: set when the conversation was cut back
   * (edit, regenerate) or branched, since the CLI's own session cannot be rewound. Sent once, ahead of the next message.
   */
  history?: string
  /** How full the conversation's context window was at its last reading; unset before the first reply or after `/clear`. */
  context?: ContextUsage
}

export interface AgentModel {
  id: string
  label: string
  hint?: string
  /** Effort levels the model accepts, lowest first; empty or missing when it has none to pick. */
  efforts?: string[]
  /** The level the CLI uses when none is chosen. */
  defaultEffort?: string
}

/**
 * A slash command the composer offers. Most come from the agent's CLI (built-ins, the user's
 * own commands and skills) and are sent as the message text, `/name args`; the adapter or the
 * CLI acts on them. `mango` ones are handled by the app itself (`/clear`, `/create-pr`).
 */
export interface AgentCommand {
  /** Without the slash: "compact", "gsap-skills:gsap-core" */
  name: string
  description?: string
  /** What goes after the name, e.g. "[instructions]"; empty when it takes nothing. */
  argumentHint?: string
  /** Other names that run the same command. */
  aliases?: string[]
  mango?: boolean
  /** Added by a plugin (its name): Mango runs it, the composer tags it with the name. */
  plugin?: string
}

/** Names for the effort levels the CLIs use. Unknown ones show as they are. */
export const EFFORT_LABELS: Record<string, string> = {
  none: 'None',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
}
export const effortLabel = (level: string) => EFFORT_LABELS[level] ?? level

const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
const CODEX_EFFORTS = ['low', 'medium', 'high', 'xhigh']

/**
 * Known agents. `models[0]` is the default. Model ids are what the adapter in
 * app/agents/ passes to the CLI; 'default' means "let the CLI decide".
 * These lists are the fallback: the models store asks each installed CLI for
 * its own list (stores/models.ts) and prefers that.
 */
export const AGENTS: Record<AgentId, { name: string; models: AgentModel[] }> = {
  claude: {
    name: 'Claude Code',
    models: [
      { id: 'default', label: 'Default', hint: 'Whatever Claude Code is configured to use', efforts: CLAUDE_EFFORTS },
      { id: 'fable', label: 'Fable', hint: 'Most capable, for the hardest and longest tasks', efforts: CLAUDE_EFFORTS },
      { id: 'opus', label: 'Opus', hint: 'Best for everyday, complex tasks', efforts: CLAUDE_EFFORTS },
      { id: 'sonnet', label: 'Sonnet', hint: 'Efficient for routine tasks', efforts: CLAUDE_EFFORTS },
      { id: 'haiku', label: 'Haiku', hint: 'Fastest', efforts: CLAUDE_EFFORTS },
    ],
  },
  codex: {
    name: 'Codex',
    models: [
      { id: 'default', label: 'Default', hint: 'Whatever Codex is configured to use', efforts: CODEX_EFFORTS },
      { id: 'gpt-5.5', label: 'GPT-5.5', hint: 'Frontier model for complex coding', efforts: CODEX_EFFORTS, defaultEffort: 'medium' },
      { id: 'gpt-5.4', label: 'GPT-5.4', hint: 'Strong model for everyday coding', efforts: CODEX_EFFORTS, defaultEffort: 'medium' },
      { id: 'gpt-5.4-mini', label: 'GPT-5.4-Mini', hint: 'Small, fast and cost-efficient', efforts: CODEX_EFFORTS, defaultEffort: 'medium' },
    ],
  },
}

export const modelLabel = (agent: AgentId, id: string) =>
  AGENTS[agent].models.find(m => m.id === id)?.label ?? id

/**
 * What a chat's status reads as. Three of them are the chat's life: Working (a
 * new chat, an agent running, or a turn that finished and waits for more),
 * Settled (only when you press the mark: finished, nothing pending) and
 * Archived. Two more only come from a run and need to be visible: "Needs you"
 * (an approval is open) and "Failed".
 */
export type DisplayStatus = 'working' | 'waiting' | 'done' | 'error' | 'archived'

export function displayStatus(t: Pick<Thread, 'status' | 'archived'>): DisplayStatus {
  if (t.archived) return 'archived'
  if (t.status === 'running' || t.status === 'queued' || t.status === 'working') return 'working'
  return t.status
}

/** A finished turn nobody has looked at yet. */
export const hasUnreadResult = (t: Pick<Thread, 'status' | 'archived' | 'seen'>) =>
  !t.archived && !t.seen && (t.status === 'working' || t.status === 'done')

export const STATUS_LABELS: Record<DisplayStatus, string> = {
  working: 'Working',
  waiting: 'Needs you',
  done: 'Settled',
  error: 'Failed',
  archived: 'Archived',
}

export const statusLabel = (t: Pick<Thread, 'status' | 'archived'>) => STATUS_LABELS[displayStatus(t)]
