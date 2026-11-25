import type { AgentCommand, AgentId, AgentModel, DiffLine, ToolKind } from '~/types/chat'

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
  /**
   * A run in a remote environment lost its connection (`'lost'`) and is reattaching, or got it
   * back (`'back'`). The run keeps going in the environment meanwhile: no output is lost, and
   * `onExit` comes only when it really ends. Adapters need not handle this; the runner shows it.
   */
  onConnection?(state: 'lost' | 'back'): void
}

/** Starts the agent's CLI with `args` in `cwd`. Handlers are attached before any output can arrive. */
export type SpawnFn = (args: string[], handlers: SpawnHandlers, env?: Record<string, string>) => Promise<AgentTransport>

/** A CLI process between two turns of a chat. */
export interface KeptProcess {
  transport: AgentTransport
  /** Where its output goes: whoever holds the process sets this. */
  handlers: SpawnHandlers
  /** Folders outside the project it was started with access to. */
  readDirs: string[]
  /** What it has spent so far, over all its turns. */
  costUsd: number
  /** Whether an output line means it started working by itself. */
  wakes(line: string): boolean
}

/** Holds a chat's CLI process from one turn to the next. */
export interface ProcessKeeper {
  /** The chat's kept process, when it was kept under `key` and `fits`; any other one is closed. */
  take(key: string, fits: (p: KeptProcess) => boolean): KeptProcess | null
  keep(key: string, process: KeptProcess): void
}

export type PermissionMode =
  | 'plan'   // read-only: explore and propose, change nothing
  | 'ask'    // ask before edits and commands
  | 'edits'  // file edits are automatic, commands still ask
  | 'auto'   // nothing asks

/** An image a tool produced (a screenshot, an image file it read, a generated picture): its bytes, or where it is on disk. */
export interface ToolImage {
  mime: string
  /** base64 */
  data?: string
  /** Absolute path, when the CLI saved it to disk instead. */
  path?: string
}

/**
 * One question an agent (or an MCP server through it) asks the user: Claude Code's
 * AskUserQuestion, Codex's request_user_input, a field of an MCP elicitation form.
 */
export interface AgentQuestion {
  question: string
  /** A short tag for it ("Auth method"). */
  header?: string
  /** More about what is asked, under the question. */
  detail?: string
  /** Choices; empty when the answer can only be typed. */
  options: { label: string; description?: string }[]
  /** Several options may be picked. */
  multiSelect?: boolean
  /** An answer may be typed: an "Other" field beside the options, or the only field without them. */
  freeText?: boolean
  /** A typed answer is hidden as it is typed, and never saved with the chat. */
  secret?: boolean
  /** May be left unanswered. */
  optional?: boolean
  /** A typed answer must be a number (or a whole number). */
  format?: 'number' | 'integer'
  /** What a typed answer looks like ("name@example.com"). */
  placeholder?: string
  /** Picked (option labels) or typed when the card opens. */
  preset?: string[]
}

/** What the user gave for each question, in order: the picked option labels and any typed text. */
export type QuestionAnswers = string[][]

/** What a background task is: a shell command, a sub-agent, or something else the CLI runs on its own (a monitor). */
export type TaskKind = 'command' | 'agent' | 'other'

/**
 * Content events carry `agent` when they belong to a sub-agent rather than the main
 * conversation: the id of its `subagent-start` (the tool call that started it).
 */
interface Scoped { agent?: string }

export type AgentEvent =
  /** The CLI's own session/thread id. Persisted on the thread and passed back as `sessionId` to resume. */
  | { type: 'session'; sessionId: string }
  /**
   * The agent moved its session to another folder (it entered a git worktree, or left one for
   * the folder it came from); later turns must run there. `path` is absolute, as the CLI
   * reports it; `branch` is the worktree's branch when the CLI names it, null when it does not
   * (or when going back to the original folder). Only ever taken from the CLI's own tool
   * results and session messages, never from what the model writes.
   */
  | { type: 'workdir'; path: string; branch?: string | null }
  /** Append to (or create) the text block `id`. */
  | ({ type: 'text-delta'; id: string; text: string } & Scoped)
  /** Authoritative full text of block `id` (replaces what deltas built). */
  | ({ type: 'text'; id: string; text: string } & Scoped)
  | ({ type: 'thinking-delta'; id: string; text: string } & Scoped)
  | ({ type: 'thinking-end'; id: string; seconds?: number } & Scoped)
  /** `label` overrides the row's verb ("Delegated", "Listed"); needed for tool 'other'. */
  | ({ type: 'tool-start'; id: string; tool: ToolKind; target: string; label?: string } & Scoped)
  /** Any subset of fields; e.g. the target once the tool input finished streaming, or live output. */
  /** `images` are added to the row's images (never replace them). */
  | ({ type: 'tool-update'; id: string; target?: string; summary?: string; output?: string; diff?: DiffLine[]; images?: ToolImage[] } & Scoped)
  | ({ type: 'tool-end'; id: string; status: 'ok' | 'error'; summary?: string; output?: string; diff?: DiffLine[]; images?: ToolImage[] } & Scoped)
  /**
   * A sub-agent started: the tool call `id` (already a tool row) handed `prompt` to another agent.
   * Its own work arrives as content events with `agent: id`. `parent` is the sub-agent that
   * started it, when sub-agents nest. `background`: the caller does not wait for it.
   */
  | { type: 'subagent-start'; id: string; parent?: string; title: string; agentType?: string; prompt?: string; background?: boolean }
  | { type: 'subagent-end'; id: string; status: 'done' | 'error' | 'stopped' }
  /**
   * Work that runs on while the agent does other things: a command started in the background,
   * a sub-agent nobody waits for. `toolId` is the tool row that started it. Stop one with
   * `AgentRun.stopTask(id)`. A run with background tasks still running does not end.
   */
  | { type: 'task-start'; id: string; kind: TaskKind; title: string; toolId?: string }
  /** `activity`: what it is doing now (the tool it last used, a progress line). */
  | { type: 'task-update'; id: string; title?: string; activity?: string }
  | { type: 'task-end'; id: string; status: 'done' | 'error' | 'stopped'; summary?: string }
  /** The agent has answered, but background tasks still run: the run stays open for them. */
  | { type: 'answered' }
  /**
   * The agent takes the conversation up again without a new user message (a background task
   * finished and it reacts to that). What follows belongs in a new reply; `reason` says why.
   */
  | { type: 'resume'; reason: string }
  /** The agent needs a yes/no from the user. Answer with `AgentRun.respondApproval(id, allow)`. */
  /** `toolId` (optional) is the tool-start id this request is about, so the UI can show it next to that row. */
  | { type: 'approval'; id: string; title: string; command: string; reason: string; toolId?: string }
  /**
   * The agent asks the user to pick from options (one card, several questions). Answer with
   * `AgentRun.answerQuestion(id, answers)`. `toolId` is the tool call it belongs to.
   */
  | { type: 'question'; id: string; questions: AgentQuestion[]; toolId?: string; title?: string; message?: string }
  /** The approval or question was settled without the user (e.g. the run was interrupted). */
  | { type: 'approval-cancelled'; id: string }
  /**
   * How full the conversation's context window is now. A reading with `max` 0 is a live one
   * taken mid-turn: it only updates the total (see `mergeContext`).
   */
  | { type: 'context'; usage: ContextUsage }
  /** What the run has used so far, in total (each event replaces the one before). */
  | { type: 'usage'; usage: TurnUsage }
  /** Exactly one per run, always last. */
  | { type: 'turn-end'; status: 'done' | 'error' | 'stopped'; error?: string }

/** A picture sent with the prompt: PNG, JPEG, GIF or WebP. */
export interface AgentImage {
  name: string
  /** Absolute path of the file on disk (outside the project). */
  path: string
  mime: string
  /** The bytes as base64, within the model's size limits, for CLIs that take images inline. */
  data: string
}

export interface AgentRunOptions {
  /** The project folder; inside the instance when `remote`. */
  cwd: string
  /**
   * The CLI runs in a remote environment (an Incus instance reached over SSH), not on this
   * computer: nothing on this computer's disk (attachment paths, `readDirs`) can be read
   * from there, so images go inline and no folder outside `cwd` is granted.
   */
  remote?: boolean
  /**
   * The user's message. Other attached files are already named in it by path (they live in
   * `readDirs`); it may be empty when only images were sent.
   */
  prompt: string
  images?: AgentImage[]
  /** Folders outside `cwd` the agent needs to read this turn (where attachments are stored). */
  readDirs?: string[]
  /** A model id from the adapter's `models`, or 'default' to let the CLI choose. */
  model: string
  mode: PermissionMode
  /** One of the model's `efforts`, or null to leave it to the CLI. */
  effort?: string | null
  /** From an earlier `session` event of the same thread, null for a new conversation. */
  sessionId: string | null
  /**
   * Mango's browser tools for this chat (an MCP server over HTTP on 127.0.0.1, see `browser_mcp`):
   * register it with the CLI for this turn. `readOnlyTools` only read the page and may run
   * without asking. Absent in remote environments and the browser preview.
   */
  browserMcp?: BrowserMcpServer
  /**
   * MCP servers the user added (Settings > MCP servers) that apply to this run, already filtered
   * by agent and project; names never clash with each other or with `browserMcp`. Register them
   * with the CLI for this turn (see `agents/mcp.ts`). Values in `env` and `headers` are secrets:
   * keep them out of the command line where the CLI can read them from its environment instead.
   */
  mcpServers?: AgentMcpServer[]
  /**
   * Text added to the agent's system prompt for this run (what plugins append, see `plugin-host/`):
   * Claude Code `--append-system-prompt`, Codex `developerInstructions`. Absent when there is none.
   */
  appendSystemPrompt?: string
  /**
   * Keeps the CLI process running for the chat's next turn (see `agents/keeper.ts`). Absent: every turn
   * starts its own. Only for runs on this computer: in an environment another device may go on with the chat.
   */
  keeper?: ProcessKeeper
  spawn: SpawnFn
  emit(event: AgentEvent): void
}

/** Mango's browser tools, as an agent run gets them. */
export interface BrowserMcpServer {
  url: string
  /** The server's name: Claude Code calls its tools `mcp__<name>__<tool>`. */
  name: string
  readOnlyTools: string[]
}

/** An MCP server the user added, as an agent run gets it. */
export type AgentMcpServer =
  | { name: string; transport: 'stdio'; command: string; args: string[]; env: Record<string, string> }
  | { name: string; transport: 'http'; url: string; headers: Record<string, string> }

/** A message sent while a turn runs. Same shape as the turn's own prompt. */
export type SteerInput = Pick<AgentRunOptions, 'prompt' | 'images' | 'readDirs'>

export interface AgentRun {
  respondApproval(id: string, allow: boolean): void
  /** Answer a `question` event, one entry per question. Null: the user dismissed it without answering. */
  answerQuestion?(id: string, answers: QuestionAnswers | null): void
  /**
   * Hand the running turn another user message ("steering"): the agent reads it at its next
   * step and answers within the same turn. Resolves false when this run cannot take it
   * (not started yet, ending, or it needs something the run was not started with); the
   * caller then sends it as the next turn instead. Optional: without it, every such message waits.
   */
  steer?(input: SteerInput): Promise<boolean>
  /** Ask the agent to stop the turn. The adapter still emits `turn-end` (status 'stopped'). Background tasks stop too. */
  interrupt(): void
  /** Stop one background task or sub-agent: the id of its `task-start` or `subagent-start`. */
  stopTask?(id: string): void
  /**
   * The end of a background command's output (plain text, a few KB at most), or null when the
   * CLI cannot say. Read-only: no turn is run, no quota is spent.
   */
  taskOutput?(id: string): Promise<string | null>
}

/** What one run (a turn, with its steering messages) spent: tokens in (cached ones too) and out, and the cost when the CLI says. */
export interface TurnUsage {
  input: number
  output: number
  costUsd?: number
}

/** One thing that takes room in the context window ("System prompt", "Messages", "Free space"). */
export interface ContextPart {
  id: string
  label: string
  tokens: number
  /** 'buffer': kept free for compacting; 'free': still unused. */
  kind: 'used' | 'buffer' | 'free'
}

/** A conversation's context window, as its CLI last reported it. */
export interface ContextUsage {
  /** Tokens the conversation takes up. */
  used: number
  /** The model's window in tokens; 0 when unknown. */
  max: number
  /** Where the CLI compacts the conversation by itself, when it says. */
  compactAt?: number
  /** What fills the window, when the CLI breaks it down (Claude Code). */
  parts?: ContextPart[]
  /** The model the numbers are for, as the CLI names it. */
  model?: string
  /** Unix ms of the reading. */
  at: number
}

/** One rolling usage limit of the signed-in plan, e.g. the 5-hour or the weekly window. */
export interface UsageWindow {
  /** Stable per agent: 'five-hour', 'weekly', 'weekly:<model>', or 'window:<minutes>'. */
  id: string
  /** "5-hour", "Weekly", "Weekly · Opus" */
  label: string
  /** 0 to 100, how much of the window's allowance is used. */
  percent: number
  /** Unix ms when the window starts over; null when the CLI does not say. */
  resetsAt: number | null
}

/** The plan limits an agent CLI reports for the signed-in account. */
export interface AgentUsage {
  /** e.g. "Max", "Plus"; null when unknown. */
  plan: string | null
  /** Shortest window first. Empty when the account has no plan limits (an API key, for one). */
  windows: UsageWindow[]
  /** Something to say instead of, or under, the windows ("Billed per token: no plan limits"). */
  note?: string
}

/**
 * Adapters must stay runnable outside the app (see scripts/try-agent.ts):
 * import only types from '~/...', and touch no Vue, Pinia or Tauri API.
 * Display names and model lists live in AGENTS (types/chat.ts).
 */
export interface AgentAdapter {
  id: AgentId
  run(options: AgentRunOptions): AgentRun
  /**
   * The models this CLI offers the signed-in account, 'default' first, read from the CLI
   * without running a turn (no quota is spent). Rejects when the CLI can't answer.
   */
  listModels?(spawn: SpawnFn): Promise<AgentModel[]>
  /**
   * The plan's usage limits (5-hour, weekly, …) as the CLI reports them, without running a
   * turn (no quota is spent). Rejects when the CLI can't answer (missing, signed out, too old).
   */
  readUsage?(spawn: SpawnFn): Promise<AgentUsage>
  /**
   * How full the conversation `sessionId` is, read without running a turn (no quota is spent);
   * `spawn` runs where the conversation's runs do. Rejects when the CLI can't answer.
   */
  readContext?(spawn: SpawnFn, sessionId: string, model: string): Promise<ContextUsage>
  /**
   * The slash commands a message can start with in this project (`spawn` runs in it), without
   * running a turn. A message `/name args` goes to `run()` as its prompt, unchanged.
   */
  listCommands?(spawn: SpawnFn, cwd: string): Promise<AgentCommand[]>
}
