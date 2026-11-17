import type { AgentCommand, AgentModel, DiffLine, ToolKind } from '~/types/chat'
import type { AgentAdapter, AgentEvent, AgentQuestion, AgentRun, QuestionAnswers, AgentRunOptions, AgentTransport, AgentUsage, PermissionMode, SpawnFn, SteerInput, TaskKind, ToolImage, UsageWindow } from '~/agents/types'
import { elicitationForm, elicitationLink } from './questions.ts'

/**
 * Claude Code adapter.
 *
 * Protocol: `claude -p` with stream-json on both stdin and stdout, the same
 * wire format the Agent SDK uses. One process per turn; the conversation is
 * carried across turns with `--resume <session id>`.
 *
 *   stdin   {"type":"user","message":{…}}                        the prompt (image blocks, then text)
 *           {"type":"control_response",…}                        answers to permission requests
 *           {"type":"control_request","request":{"subtype":"interrupt"}}
 *   stdout  system/init, stream_event (partial deltas), assistant, user (tool results),
 *           control_request (can_use_tool), result
 *
 * Sub-agents (the Agent tool): their messages come with `parent_tool_use_id` set to the call
 * that started them (text and thinking too, since `initialize` asks for `forwardSubagentText`).
 * They are emitted with `agent` set, and the app gives each sub-agent a chat of its own.
 *
 * Background tasks (a command with `run_in_background`, a command that outlived its timeout, a
 * sub-agent nobody waits for) are reported as system/task_started, task_updated, task_progress
 * and task_notification. Claude Code answers each finished task by itself, with a turn of its
 * own, so the run stays open after `result` until no background task is left.
 *
 * Worktrees: the EnterWorktree tool moves the session into a git worktree (its result's
 * `tool_use_result` carries `worktreePath` and `worktreeBranch`), ExitWorktree moves it back.
 * Either is reported as a `workdir` event. Claude Code relocates the session's transcript to the
 * new folder's project, yet `--resume` still finds it from the old one and restores the
 * session's folder: the `cwd` of system/init then differs from the one we spawned in, which is
 * reported as `workdir` too.
 *
 * Permission modes: plan → plan, ask → default, edits → acceptEdits,
 * auto → bypassPermissions. With `--permission-prompt-tool stdio` the CLI asks
 * us before any tool call its mode does not already allow.
 */

const MODES: Record<PermissionMode, string> = {
  plan: 'plan',
  ask: 'default',
  edits: 'acceptEdits',
  auto: 'bypassPermissions',
}

const MAX_OUTPUT = 20_000

/** A path to compare: no trailing separator; a Windows path also in one case and with one kind of separator. */
const comparable = (p: string) => {
  const t = p.replace(/(?<=.)[\\/]+$/, '')
  return /^[a-z]:/i.test(t) ? t.replace(/\//g, '\\').toLowerCase() : t
}

/**
 * Whether Claude Code's `cwd` is another folder than `spawned`, not just another spelling of it
 * (a trailing separator, a Windows drive letter's case, or macOS's /private/tmp for /tmp).
 */
function movedFrom(spawned: string, cwd: string): boolean {
  const a = comparable(spawned)
  const b = comparable(cwd)
  return a !== b && b !== `/private${a}`
}

interface ToolShape { tool: ToolKind; label?: string; target: string; summary?: string; diff?: DiffLine[] }

const rel = (path: unknown, cwd: string): string => {
  const p = typeof path === 'string' ? path : ''
  const base = cwd.replace(/[\\/]+$/, '')
  if (p.startsWith(`${base}/`) || p.startsWith(`${base}\\`)) return p.slice(base.length + 1)
  return p
}

const lines = (s: unknown): string[] => (typeof s === 'string' && s.length ? s.replace(/\n$/, '').split('\n') : [])

function editDiff(oldText: unknown, newText: unknown): DiffLine[] {
  return [
    ...lines(oldText).map(text => ({ kind: 'del' as const, text })),
    ...lines(newText).map(text => ({ kind: 'add' as const, text })),
  ]
}

const counts = (diff: DiffLine[]) => {
  const add = diff.filter(l => l.kind === 'add').length
  const del = diff.filter(l => l.kind === 'del').length
  return `+${add} −${del}`
}

/** The name Mango registers its browser tools under (`browser_mcp`, src-tauri/src/browser_mcp.rs). */
const BROWSER_SERVER = 'mango-browser'

/** What one of Mango's browser tools does, for its row: `navigate http://localhost:3000`. */
function browserTarget(tool: string, input: any): string {
  let i = input ?? {}
  if (typeof i === 'string') { try { i = JSON.parse(i) ?? {} } catch { i = {} } }
  const s = (v: unknown) => (typeof v === 'string' ? v : '')
  const what = typeof i.ref === 'number' ? `[${i.ref}]` : s(i.selector)
  switch (tool) {
    case 'navigate': return `navigate ${s(i.url)}`.trim()
    case 'snapshot': return 'read the page'
    case 'click': return `click ${what}`.trim()
    case 'type': return `type ${JSON.stringify(s(i.text))}${what ? ` into ${what}` : ''}${i.submit ? ' and submit' : ''}`
    case 'press_key': return `press ${s(i.key)}`.trim()
    case 'scroll': return `scroll ${s(i.direction)}`.trim()
    case 'evaluate': { const x = s(i.script).replace(/\s+/g, ' '); return `evaluate ${x.length > 80 ? `${x.slice(0, 79)}…` : x}`.trim() }
    case 'console_logs': return 'read the console'
    case 'screenshot': return 'take a screenshot'
    case 'go': return s(i.action) || 'go'
    default: return tool.replace(/_/g, ' ')
  }
}

/** How a Claude Code tool call is shown: which row, which target, and a diff when the input implies one. */
function describeTool(name: string, input: any, cwd: string): ToolShape {
  const i = input ?? {}
  switch (name) {
    case 'Read':
      return { tool: 'read', target: rel(i.file_path, cwd) }
    case 'Write': {
      const diff = lines(i.content).slice(0, 400).map(text => ({ kind: 'add' as const, text }))
      return { tool: 'write', target: rel(i.file_path, cwd), summary: i.content != null ? `+${lines(i.content).length}` : undefined, diff }
    }
    case 'Edit': {
      const diff = editDiff(i.old_string, i.new_string)
      return { tool: 'edit', target: rel(i.file_path, cwd), summary: diff.length ? counts(diff) : undefined, diff }
    }
    case 'MultiEdit': {
      const diff: DiffLine[] = []
      for (const e of Array.isArray(i.edits) ? i.edits : []) {
        if (diff.length) diff.push({ kind: 'hunk', text: '' })
        diff.push(...editDiff(e.old_string, e.new_string))
      }
      return { tool: 'edit', target: rel(i.file_path, cwd), summary: diff.length ? counts(diff) : undefined, diff }
    }
    case 'NotebookEdit':
      return { tool: 'edit', target: rel(i.notebook_path, cwd) }
    case 'Bash':
      return { tool: 'bash', target: String(i.command ?? '') }
    case 'BashOutput':
      return { tool: 'bash', label: 'Checked', target: `output of ${i.bash_id ?? 'background command'}` }
    case 'KillShell':
      return { tool: 'bash', label: 'Stopped', target: String(i.shell_id ?? 'background command') }
    case 'Grep':
      return { tool: 'search', target: [i.pattern, i.path ? `in ${rel(i.path, cwd)}` : '', i.glob ?? ''].filter(Boolean).join(' ') }
    case 'Glob':
      return { tool: 'search', label: 'Listed', target: String(i.pattern ?? '') }
    case 'LS':
      return { tool: 'search', label: 'Listed', target: rel(i.path, cwd) }
    case 'WebFetch':
      return { tool: 'web', target: String(i.url ?? '') }
    case 'WebSearch':
      return { tool: 'web', label: 'Searched the web for', target: String(i.query ?? '') }
    case 'Task':
    case 'Agent':
      return { tool: 'other', label: 'Delegated', target: String(i.description ?? i.subagent_type ?? 'a sub-task') }
    case 'TodoWrite': {
      const todos: any[] = Array.isArray(i.todos) ? i.todos : []
      const current = todos.find(t => t.status === 'in_progress') ?? todos.find(t => t.status === 'pending')
      const done = todos.filter(t => t.status === 'completed').length
      return { tool: 'other', label: 'Updated plan', target: current?.content ?? `${todos.length} steps`, summary: todos.length ? `${done}/${todos.length}` : undefined }
    }
    case 'AskUserQuestion': {
      const qs = parseQuestions(i)
      return { tool: 'other', label: 'Asked', target: qs.map(q => q.header || q.question).join(', ') || 'a question' }
    }
    case 'ExitPlanMode':
      return { tool: 'other', label: 'Proposed', target: 'a plan' }
    case 'Skill':
      return { tool: 'other', label: 'Used skill', target: String(i.skill ?? i.command ?? '') }
    default: {
      // MCP tools are named mcp__server__tool.
      const mcp = /^mcp__(.+?)__(.+)$/.exec(name)
      if (mcp?.[1] === BROWSER_SERVER) return { tool: 'web', label: 'Browser', target: browserTarget(mcp[2]!, i) }
      const first = Object.values(i).find(v => typeof v === 'string') as string | undefined
      return { tool: 'other', label: 'Used', target: mcp ? `${mcp[1]} · ${mcp[2]}` : name, summary: first && first.length < 60 ? first : undefined }
    }
  }
}

/** AskUserQuestion's input as questions to show; anything malformed is left out. */
function parseQuestions(input: any): AgentQuestion[] {
  const list: any[] = Array.isArray(input?.questions) ? input.questions : []
  return list.flatMap((q) => {
    const question = typeof q?.question === 'string' ? q.question.trim() : ''
    const options = (Array.isArray(q?.options) ? q.options : [])
      .map((o: any) => ({ label: typeof o?.label === 'string' ? o.label : '', description: typeof o?.description === 'string' ? o.description : undefined }))
      .filter((o: { label: string }) => o.label)
    if (!question || !options.length) return []
    return [{ question, header: typeof q.header === 'string' && q.header ? q.header : undefined, options, multiSelect: q.multiSelect === true }]
  })
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map(c => (c?.type === 'text' ? c.text : c?.type === 'image' ? '[image]' : '')).filter(Boolean).join('\n')
  }
  return ''
}

/** Image blocks in a tool result: screenshots from MCP tools, image files Read, and the like. */
function resultImages(content: unknown): ToolImage[] {
  if (!Array.isArray(content)) return []
  return content
    .filter(c => c?.type === 'image' && c.source?.type === 'base64' && typeof c.source.data === 'string')
    .map(c => ({ mime: String(c.source.media_type ?? 'image/png'), data: c.source.data as string }))
}

const clip = (s: string) => (s.length > MAX_OUTPUT ? `${s.slice(0, MAX_OUTPUT)}\n… output truncated` : s)

const isAgentTool = (name: string | undefined) => name === 'Agent' || name === 'Task'

/**
 * A sub-agent's report, from the structured result: its own words, without the frame Claude Code
 * wraps around them for the model (the hand-back note, the tools-used tag, the usage block).
 */
function agentReport(extra: any): string | undefined {
  const content: any[] = Array.isArray(extra?.content) ? extra.content : []
  const text = content
    .map(c => (c?.type === 'text' && typeof c.text === 'string' ? c.text : ''))
    .join('\n')
    .replace(/<tools-used-before-summary>[\s\S]*?<\/tools-used-before-summary>\s*/g, '')
    .trim()
  return text || undefined
}

/** Claude Code's task types → what Mango shows. */
function taskKind(type: unknown): TaskKind {
  const t = String(type ?? '')
  if (/bash|shell/.test(t)) return 'command'
  if (/agent|teammate/.test(t)) return 'agent'
  return 'other'
}

/** A task's end state (`task_notification` status, or `task_updated` patch status), null while it runs. */
function taskEnd(status: unknown): 'done' | 'error' | 'stopped' | null {
  switch (status) {
    case 'completed': return 'done'
    case 'failed': return 'error'
    case 'killed':
    case 'stopped':
    case 'cancelled': return 'stopped'
    default: return null
  }
}

/** How long the run waits for Claude Code to answer a background task that finished after it answered. */
const RESUME_GRACE_MS = 5000

/** Claude Code's structured patch (Edit/Write results) → diff lines with real context. */
function patchDiff(patch: unknown): DiffLine[] | undefined {
  if (!Array.isArray(patch) || !patch.length) return undefined
  const out: DiffLine[] = []
  for (const hunk of patch) {
    out.push({ kind: 'hunk', text: `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@` })
    for (const l of Array.isArray(hunk.lines) ? hunk.lines : []) {
      const s = String(l)
      out.push({ kind: s[0] === '+' ? 'add' : s[0] === '-' ? 'del' : 'ctx', text: s.slice(1) })
    }
  }
  return out
}

function friendlyError(raw: string): string {
  const s = raw.trim()
  if (/\/login|not logged in|invalid api key|authentication_error|oauth token/i.test(s)) return 'Claude Code is not signed in. Open Settings > Agents and sign in.'
  if (/usage limit|rate limit|limit reached/i.test(s)) return `Claude Code hit a usage limit. ${s.split('\n')[0]}`
  if (/no conversation found/i.test(s)) return 'The earlier conversation could not be resumed. Send the message again to start a fresh one.'
  return s.split('\n').slice(0, 3).join(' ') || 'Claude Code stopped unexpectedly.'
}

function approvalFor(toolName: string, input: any, cwd: string): { title: string; command: string; reason: string } {
  const i = input ?? {}
  switch (toolName) {
    case 'Bash':
      return { title: 'Claude Code wants to run a command', command: String(i.command ?? ''), reason: String(i.description ?? '') }
    case 'Write':
      return { title: 'Claude Code wants to create a file', command: rel(i.file_path, cwd), reason: '' }
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return { title: 'Claude Code wants to edit a file', command: rel(i.file_path ?? i.notebook_path, cwd), reason: '' }
    case 'Read':
      return { title: 'Claude Code wants to read a file outside the project', command: rel(i.file_path, cwd), reason: '' }
    case 'Grep':
    case 'Glob':
    case 'LS':
      return { title: 'Claude Code wants to search outside the project', command: [i.pattern, rel(i.path, cwd)].filter(Boolean).join(' in '), reason: '' }
    case 'WebFetch':
      return { title: 'Claude Code wants to fetch a page', command: String(i.url ?? ''), reason: '' }
    case 'WebSearch':
      return { title: 'Claude Code wants to search the web', command: String(i.query ?? ''), reason: '' }
    case 'ExitPlanMode':
      return { title: 'Claude Code has a plan and wants to start', command: String(i.plan ?? ''), reason: 'Allow to let it carry out the plan.' }
    default: {
      const d = describeTool(toolName, i, cwd)
      if (d.label === 'Browser') return { title: 'Claude Code wants to use the browser', command: d.target || toolName, reason: '' }
      return { title: `Claude Code wants to use ${d.target || toolName}`, command: JSON.stringify(i, null, 2).slice(0, 1200), reason: '' }
    }
  }
}

/** A message that is a slash command (`/compact`, `/review 12`, a skill): the CLI runs it itself. */
const isSlash = (prompt: string) => /^\/[\w.:-]+(\s|$)/.test(prompt.trim())

/** The prompt as message content: attached images first, then the text (an empty text block is refused). */
function userContent(options: SteerInput): unknown[] {
  const content: unknown[] = (options.images ?? []).map(img => ({
    type: 'image',
    source: { type: 'base64', media_type: img.mime, data: img.data },
  }))
  if (options.prompt.trim() || !content.length) content.push({ type: 'text', text: options.prompt })
  return content
}

function run(options: AgentRunOptions): AgentRun {
  const { cwd, emit } = options
  /** The folder the session works in now: `cwd` until it enters (or leaves) a worktree. */
  let workdir = cwd
  const moveTo = (path: string, branch: string | null) => {
    if (!path || !movedFrom(workdir, path)) return
    workdir = path
    emit({ type: 'workdir', path, branch })
  }
  let transport: AgentTransport | null = null
  let ended = false
  let interrupted = false
  let lastStderr = ''
  let seq = 0
  let killTimer: ReturnType<typeof setTimeout> | undefined
  /**
   * User messages written to stdin, and how many the CLI has taken in (it echoes each one with
   * `isReplay` when it reads it). A message sent mid-turn ("steering") is read at the next step;
   * one that arrives as the turn finishes becomes a follow-up turn, so the run lasts until it is answered.
   */
  let sentMessages = 0
  let readMessages = 0

  /** Streaming state of the assistant message being received. */
  let messageId = ''
  const blocks = new Map<number, { kind: 'text' | 'thinking' | 'tool'; id: string; json: string; name: string; started: number }>()
  const streamedMessages = new Set<string>()
  /** Every tool call, the main conversation's and the sub-agents' (`scope`: the sub-agent it belongs to). */
  const tools = new Map<string, { name: string; shape: ToolShape; scope?: string }>()
  /**
   * Control requests waiting for the user (tool approvals, questions, MCP forms): what to answer
   * for a decision, and what to answer when the run is stopped first.
   */
  const pendingApprovals = new Map<string, { reply(value: boolean | QuestionAnswers | null): unknown; stopped: unknown }>()

  /** Sub-agents by the id of the Agent call that started them. */
  const subagents = new Map<string, { ended: boolean; background: boolean; taskId?: string }>()
  /** Claude Code's tasks by task id. `shown`: reported as a background task. */
  const tasks = new Map<string, { toolId?: string; kind: TaskKind; title: string; shown: boolean; ended: boolean; endedAt?: number }>()
  const runningTasks = () => [...tasks.values()].filter(t => t.shown && !t.ended).length

  /**
   * After `result` the run may stay open for background tasks: `idle` until Claude Code starts
   * another turn by itself (`resume`, with the finished tasks as the reason) or the user steers.
   */
  let idle = false
  let finishedWhileIdle: string[] = []
  /** When the newest model request started: a task that ends after it may still get an answer. */
  let requestStartedAt = 0
  let settleTimer: ReturnType<typeof setTimeout> | undefined

  /** Control requests this adapter sent and waits on (`get_task_output`). */
  const requests = new Map<string, (response: any) => void>()

  const end = (status: 'done' | 'error' | 'stopped', error?: string) => {
    if (ended) return
    ended = true
    clearTimeout(killTimer)
    clearTimeout(settleTimer)
    for (const id of pendingApprovals.keys()) emit({ type: 'approval-cancelled', id })
    pendingApprovals.clear()
    for (const resolve of requests.values()) resolve(null)
    requests.clear()
    emit({ type: 'turn-end', status, error })
    transport?.closeStdin().catch(() => {})
  }

  const send = (obj: unknown) => transport?.write(JSON.stringify(obj)).catch(() => {})

  /** The user decided on a pending control request: an approval (true/false) or answers (null: dismissed). */
  const decide = (id: string, value: boolean | QuestionAnswers | null) => {
    const pending = pendingApprovals.get(id)
    if (!pending) return
    pendingApprovals.delete(id)
    send({ type: 'control_response', response: { subtype: 'success', request_id: id, response: pending.reply(value) } })
  }

  const scoped = (scope: string | undefined) => (scope ? { agent: scope } : {})

  /** Nothing is left running: end now, or give Claude Code a moment to answer a task that just finished. */
  const settle = () => {
    clearTimeout(settleTimer)
    settleTimer = setTimeout(() => { if (idle && !runningTasks()) end('done') }, RESUME_GRACE_MS)
  }

  /** Claude Code started a turn: after `result`, that is it answering a finished background task. */
  const onTurnActivity = () => {
    requestStartedAt = Date.now()
    if (!idle) return
    idle = false
    clearTimeout(settleTimer)
    const reason = finishedWhileIdle.join('\n') || 'A background task finished.'
    finishedWhileIdle = []
    emit({ type: 'resume', reason })
  }

  const startTool = (id: string, name: string, input: any, scope?: string) => {
    if (isAgentTool(name) && input && !subagents.has(id)) {
      // Known before the tool row: the row's own events may come first, but the sub-agent's chat needs its prompt.
      const background = input.run_in_background === true
      subagents.set(id, { ended: false, background })
    }
    const shape = describeTool(name, input, cwd)
    const before = tools.get(id)
    const known = !!before
    // The full `assistant` message repeats what the stream already delivered.
    if (before && JSON.stringify(before.shape) === JSON.stringify(shape)) return
    tools.set(id, { name, shape, scope })
    if (!known) emit({ type: 'tool-start', id, tool: shape.tool, label: shape.label, target: shape.target, ...scoped(scope) })
    if (known || shape.summary || shape.diff?.length) {
      emit({ type: 'tool-update', id, target: shape.target, summary: shape.summary, diff: shape.diff?.length ? shape.diff : undefined, ...scoped(scope) })
    }
    if (isAgentTool(name) && input) startSubagent(id, input, scope)
  }

  const announced = new Set<string>()
  function startSubagent(id: string, input: any, scope?: string) {
    if (announced.has(id)) return
    announced.add(id)
    emit({
      type: 'subagent-start',
      id,
      ...(scope ? { parent: scope } : {}),
      title: String(input.description || input.subagent_type || 'Sub-agent'),
      agentType: typeof input.subagent_type === 'string' ? input.subagent_type : undefined,
      prompt: typeof input.prompt === 'string' ? input.prompt : undefined,
      background: subagents.get(id)?.background,
    })
  }

  function endSubagent(id: string, status: 'done' | 'error' | 'stopped') {
    const sub = subagents.get(id)
    if (!sub || sub.ended || !announced.has(id)) return
    sub.ended = true
    emit({ type: 'subagent-end', id, status })
  }

  function onStreamEvent(e: any) {
    switch (e.type) {
      case 'message_start':
        onTurnActivity()
        messageId = e.message?.id ?? `m${++seq}`
        streamedMessages.add(messageId)
        blocks.clear()
        break
      case 'content_block_start': {
        const b = e.content_block ?? {}
        if (b.type === 'text') {
          blocks.set(e.index, { kind: 'text', id: `${messageId}:${e.index}`, json: '', name: '', started: Date.now() })
          if (b.text) emit({ type: 'text-delta', id: `${messageId}:${e.index}`, text: b.text })
        } else if (b.type === 'thinking') {
          const id = `${messageId}:${e.index}`
          blocks.set(e.index, { kind: 'thinking', id, json: '', name: '', started: Date.now() })
          emit({ type: 'thinking-delta', id, text: b.thinking ?? '' })
        } else if (b.type === 'tool_use') {
          blocks.set(e.index, { kind: 'tool', id: b.id, json: '', name: b.name, started: Date.now() })
          startTool(b.id, b.name, undefined)
        }
        break
      }
      case 'content_block_delta': {
        const blk = blocks.get(e.index)
        const d = e.delta ?? {}
        if (!blk) break
        if (d.type === 'text_delta' && d.text) emit({ type: 'text-delta', id: blk.id, text: d.text })
        else if (d.type === 'thinking_delta' && d.thinking) emit({ type: 'thinking-delta', id: blk.id, text: d.thinking })
        else if (d.type === 'input_json_delta') blk.json += d.partial_json ?? ''
        break
      }
      case 'content_block_stop': {
        const blk = blocks.get(e.index)
        if (!blk) break
        if (blk.kind === 'thinking') emit({ type: 'thinking-end', id: blk.id, seconds: Math.round((Date.now() - blk.started) / 1000) })
        else if (blk.kind === 'tool') {
          let input: any
          try { input = blk.json ? JSON.parse(blk.json) : {} } catch { input = undefined }
          if (input !== undefined) startTool(blk.id, blk.name, input)
        }
        break
      }
    }
  }

  /** Full assistant message. With partial streaming on it mostly repeats what the deltas built. */
  function onAssistant(m: any) {
    const msg = m.message ?? {}
    const streamed = streamedMessages.has(msg.id)
    if (!streamed) onTurnActivity()
    const content: any[] = Array.isArray(msg.content) ? msg.content : []
    content.forEach((b, i) => {
      if (b.type === 'tool_use') startTool(b.id, b.name, b.input)
      else if (!streamed && b.type === 'text' && b.text) emit({ type: 'text', id: `${msg.id ?? `m${++seq}`}:a${i}`, text: b.text })
    })
    if (msg.error || m.error) lastStderr = String(msg.error ?? m.error)
  }

  /** A message of a sub-agent: what it says and thinks, and its tool calls and their results. Never partial. */
  function onSubagentMessage(m: any, scope: string) {
    if (m.type === 'user') return onToolResults(m)
    if (m.type !== 'assistant') return
    const msg = m.message ?? {}
    const content: any[] = Array.isArray(msg.content) ? msg.content : []
    content.forEach((b, i) => {
      // Each line carries its own uuid; the message id repeats across the blocks of one message.
      const id = `${scope}:${m.uuid ?? msg.id ?? ++seq}:${i}`
      if (b.type === 'tool_use') startTool(b.id, b.name, b.input, scope)
      else if (b.type === 'text' && b.text) emit({ type: 'text', id, text: b.text, agent: scope })
      else if (b.type === 'thinking' && b.thinking) {
        emit({ type: 'thinking-delta', id, text: b.thinking, agent: scope })
        emit({ type: 'thinking-end', id, agent: scope })
      }
    })
  }

  /** Tool results come back as a user message. */
  function onUser(m: any) {
    if (m.isReplay) { readMessages++; return }
    onToolResults(m)
  }

  function onToolResults(m: any) {
    const content: any[] = Array.isArray(m.message?.content) ? m.message.content : []
    for (const b of content) {
      if (b.type !== 'tool_result') continue
      const t = tools.get(b.tool_use_id)
      const text = resultText(b.content)
      const isError = b.is_error === true
      const extra = m.tool_use_result ?? m.toolUseResult
      const diff = patchDiff(extra?.structuredPatch) ?? (t?.shape.diff?.length ? t.shape.diff : undefined)
      let summary = t?.shape.summary
      let output: string | undefined
      if (t?.shape.tool === 'bash' || isError) output = clip(text)
      else if (isAgentTool(t?.name)) output = clip(agentReport(extra) ?? text) || undefined
      else if (t?.shape.tool === 'search' || t?.shape.tool === 'other' || t?.shape.tool === 'web') output = text ? clip(text) : undefined
      const images = resultImages(b.content)
      if (isError) summary = 'failed'
      else if (t?.shape.tool === 'bash' && /running in background with ID/i.test(text)) summary = 'in background'
      else if (t?.shape.tool === 'read' && images.length) summary = images.length === 1 ? 'image' : `${images.length} images`
      else if (t?.shape.tool === 'read') {
        const n = typeof extra?.file?.numLines === 'number' ? extra.file.numLines : (text ? text.split('\n').length : 0)
        summary = n ? `${n} lines` : undefined
      } else if (diff && t?.shape.tool === 'edit') summary = counts(diff)
      else if (diff && t?.shape.tool === 'write') summary = `+${diff.filter(l => l.kind === 'add').length}`
      const sub = subagents.get(b.tool_use_id)
      if (sub && !isError && (sub.background || extra?.status === 'async_launched')) summary = 'in background'
      emit({ type: 'tool-end', id: b.tool_use_id, status: isError ? 'error' : 'ok', summary, output, diff, ...(images.length ? { images } : {}), ...scoped(t?.scope) })
      // The main session changed folders. A sub-agent's switch moves only that sub-agent.
      if (!isError && !t?.scope && extra && typeof extra === 'object') worktreeMove(t?.name, extra)
      // A sub-agent that was waited for is done when its result is in; one in the background reports later.
      if (sub && (isError || !(sub.background || extra?.status === 'async_launched'))) {
        endSubagent(b.tool_use_id, isError ? (interrupted ? 'stopped' : 'error') : 'done')
      }
    }
  }

  /** EnterWorktree / ExitWorktree finished: their structured result says where the session is now. */
  function worktreeMove(name: string | undefined, extra: any) {
    const str = (v: unknown) => (typeof v === 'string' && v ? v : null)
    if (name === 'EnterWorktree') {
      const path = str(extra.worktreePath)
      if (path) moveTo(path, str(extra.worktreeBranch))
    } else if (name === 'ExitWorktree') {
      const path = str(extra.restoredCwd) ?? str(extra.originalCwd)
      if (path) moveTo(path, null)
    }
  }

  /* ---------- background tasks ---------- */

  function showTask(id: string) {
    const task = tasks.get(id)
    if (ended || !task || task.shown || task.ended) return
    task.shown = true
    emit({ type: 'task-start', id, kind: task.kind, title: task.title, ...(task.toolId ? { toolId: task.toolId } : {}) })
  }

  function finishTask(id: string, status: 'done' | 'error' | 'stopped', summary?: string) {
    const task = tasks.get(id)
    if (ended || !task || task.ended) return
    task.ended = true
    task.endedAt = Date.now()
    if (task.toolId) {
      const sub = subagents.get(task.toolId)
      if (sub?.background) endSubagent(task.toolId, status)
    }
    if (!task.shown) return
    emit({ type: 'task-end', id, status, ...(summary ? { summary } : {}) })
    if (!idle) return
    const what = task.kind === 'agent' ? 'Sub-agent' : task.kind === 'command' ? 'Background command' : 'Background task'
    const how = status === 'done' ? 'finished' : status === 'error' ? 'failed' : 'was stopped'
    finishedWhileIdle.push(`${what} ${how}: ${task.title}`)
    if (!runningTasks()) settle()
  }

  function onSystem(m: any) {
    switch (m.subtype) {
      case 'init':
        if (m.session_id) emit({ type: 'session', sessionId: m.session_id })
        // A resumed session that had moved into a worktree goes on there, wherever it was started.
        if (options.sessionId && typeof m.cwd === 'string') moveTo(m.cwd, null)
        onTurnActivity()
        break
      case 'task_started': {
        const id = typeof m.task_id === 'string' ? m.task_id : ''
        // Ambient tasks are Claude Code's own housekeeping, not something the agent started.
        if (!id || m.ambient || tasks.get(id)?.shown) break
        const toolId = typeof m.tool_use_id === 'string' ? m.tool_use_id : undefined
        tasks.set(id, { toolId, kind: taskKind(m.task_type), title: String(m.description || 'Background task'), shown: false, ended: false })
        const sub = toolId ? subagents.get(toolId) : undefined
        if (sub) { sub.taskId = id; if (m.is_backgrounded) sub.background = true }
        if (m.is_backgrounded) showTask(id)
        break
      }
      case 'task_updated': {
        const id = typeof m.task_id === 'string' ? m.task_id : ''
        const task = tasks.get(id)
        const patch = m.patch ?? {}
        if (!task) break
        if (typeof patch.description === 'string' && patch.description && patch.description !== task.title) {
          task.title = patch.description
          if (task.shown && !task.ended) emit({ type: 'task-update', id, title: task.title })
        }
        if (patch.is_backgrounded === true) {
          // A command that outlived its timeout, or a sub-agent sent to the background.
          const sub = task.toolId ? subagents.get(task.toolId) : undefined
          if (sub) sub.background = true
          showTask(id)
        }
        // The notification right behind this says how it ended; this covers a task that never sends one.
        const done = taskEnd(patch.status)
        if (done) setTimeout(() => finishTask(id, done, typeof patch.error === 'string' ? patch.error : undefined), 500)
        break
      }
      case 'task_progress': {
        const task = tasks.get(m.task_id)
        if (!task?.shown || task.ended) break
        const activity = typeof m.summary === 'string' && m.summary ? m.summary : typeof m.last_tool_name === 'string' ? `Using ${m.last_tool_name}` : undefined
        if (activity) emit({ type: 'task-update', id: m.task_id, activity })
        break
      }
      case 'task_notification': {
        const id = typeof m.task_id === 'string' ? m.task_id : ''
        const done = taskEnd(m.status) ?? 'done'
        if (tasks.has(id)) finishTask(id, done, typeof m.summary === 'string' ? m.summary : undefined)
        else if (typeof m.tool_use_id === 'string') endSubagent(m.tool_use_id, done)
        break
      }
      case 'background_tasks_changed': {
        // The full list of what runs in the background. It can come just before the task's own
        // task_started (which names the tool call), so a task known only from here shows a moment later.
        for (const t of Array.isArray(m.tasks) ? m.tasks : []) {
          const id = typeof t?.task_id === 'string' ? t.task_id : ''
          if (!id) continue
          if (tasks.has(id)) { showTask(id); continue }
          const kind = taskKind(t.task_type)
          const title = String(t.description || 'Background task')
          setTimeout(() => {
            if (!tasks.has(id)) tasks.set(id, { kind, title, shown: false, ended: false })
            showTask(id)
          }, 300)
        }
        break
      }
    }
  }

  function onControlRequest(m: any) {
    const req = m.request ?? {}
    const requestId: string = m.request_id
    if (req.subtype === 'can_use_tool') {
      if (req.tool_name === 'AskUserQuestion') {
        const questions = parseQuestions(req.input)
        if (!questions.length) {
          send({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response: { behavior: 'deny', message: 'The question had no options to show. Ask it in plain text instead.' } } })
          return
        }
        // Kept with the approvals: an interrupted or ended run settles both the same way.
        pendingApprovals.set(requestId, {
          // Claude Code reads the answers from the tool's input: question text to answer, several joined with ", ".
          reply: answers => (Array.isArray(answers)
            ? { behavior: 'allow', updatedInput: { ...req.input, answers: Object.fromEntries(questions.map((q, i) => [q.question, (answers[i] ?? []).join(', ')])) } }
            : { behavior: 'deny', message: 'The user dismissed the question without answering. Go on without it, or ask in plain text.' }),
          stopped: { behavior: 'deny', message: 'The user stopped the run.' },
        })
        emit({ type: 'question', id: requestId, questions, ...(req.tool_use_id ? { toolId: req.tool_use_id } : {}) })
        return
      }
      pendingApprovals.set(requestId, {
        reply: allow => (allow === true
          ? { behavior: 'allow', updatedInput: req.input }
          : { behavior: 'deny', message: 'The user denied this request.' }),
        stopped: { behavior: 'deny', message: 'The user stopped the run.' },
      })
      emit({ type: 'approval', id: requestId, toolId: req.tool_use_id, ...approvalFor(req.tool_name, req.input, cwd) })
      return
    }
    if (req.subtype === 'elicitation') {
      onElicitation(requestId, req)
      return
    }
    send({ type: 'control_response', response: { subtype: 'error', request_id: requestId, error: `Unsupported control request: ${req.subtype}` } })
  }

  /**
   * An MCP server asks the user something (MCP elicitation), through Claude Code: a form becomes
   * questions, a link one question to confirm, an empty form an approval.
   */
  function onElicitation(requestId: string, req: any) {
    const server = String(req.display_name || req.mcp_server_name || 'An MCP server')
    const message = typeof req.message === 'string' ? req.message : ''
    const decline = { action: 'decline' }
    const respond = (response: unknown) => send({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response } })
    const title = `${server} asks`
    if (req.mode === 'url' && typeof req.url === 'string' && /^https?:\/\//i.test(req.url)) {
      pendingApprovals.set(requestId, { reply: a => (Array.isArray(a) ? { action: 'accept' } : decline), stopped: { action: 'cancel' } })
      emit({ type: 'question', id: requestId, title, message, questions: [elicitationLink(req.url)] })
      return
    }
    const form = req.mode === 'url' ? null : elicitationForm(req.requested_schema, req.property_order)
    if (!form) { respond(decline); return }
    if (!form.questions.length) {
      pendingApprovals.set(requestId, { reply: allow => (allow === true ? { action: 'accept', content: {} } : decline), stopped: { action: 'cancel' } })
      emit({ type: 'approval', id: requestId, title, command: message || server, reason: '' })
      return
    }
    pendingApprovals.set(requestId, {
      reply: a => (Array.isArray(a) ? { action: 'accept', content: form.content(a) } : decline),
      stopped: { action: 'cancel' },
    })
    emit({ type: 'question', id: requestId, title, message, questions: form.questions })
  }

  /** Ask Claude Code something outside the conversation; resolves with its answer, or null. */
  function controlRequest(request: Record<string, unknown>, timeoutMs = 5000): Promise<any> {
    if (ended || !transport) return Promise.resolve(null)
    const id = `mango-${request.subtype}-${++seq}`
    return new Promise((resolve) => {
      const timer = setTimeout(() => { requests.delete(id); resolve(null) }, timeoutMs)
      requests.set(id, (response) => { clearTimeout(timer); resolve(response) })
      send({ type: 'control_request', request_id: id, request })
    })
  }

  const stopTaskById = (taskId: string) =>
    send({ type: 'control_request', request_id: `mango-stop-${++seq}`, request: { subtype: 'stop_task', task_id: taskId } })

  function onLine(line: string) {
    if (ended) return
    let m: any
    try { m = JSON.parse(line) } catch { return }
    if (m.type === 'control_response') {
      const id = m.response?.request_id
      const resolve = requests.get(id)
      if (resolve) { requests.delete(id); resolve(m.response?.subtype === 'success' ? (m.response.response ?? {}) : null) }
      return
    }
    // Sub-agent internals: whole messages whose parent is the Agent call that started the sub-agent.
    if (m.parent_tool_use_id) {
      if (announced.has(m.parent_tool_use_id)) onSubagentMessage(m, m.parent_tool_use_id)
      return
    }
    switch (m.type) {
      case 'system': onSystem(m); break
      case 'stream_event': onStreamEvent(m.event ?? {}); break
      case 'assistant': onAssistant(m); break
      case 'user': onUser(m); break
      case 'control_request': onControlRequest(m); break
      case 'control_cancel_request': {
        // Claude Code gave up waiting (the request timed out, or another client answered it).
        const id = typeof m.request_id === 'string' ? m.request_id : ''
        if (pendingApprovals.delete(id)) emit({ type: 'approval-cancelled', id })
        break
      }
      case 'result': {
        if (m.session_id) emit({ type: 'session', sessionId: m.session_id })
        if (interrupted) end('stopped')
        // A steering message came too late for this answer: the CLI answers it next, in the same process.
        else if (readMessages < sentMessages && !m.is_error && (!m.subtype || m.subtype === 'success')) break
        else if (m.is_error || (m.subtype && m.subtype !== 'success')) {
          const raw = typeof m.result === 'string' && m.result ? m.result : Array.isArray(m.errors) ? m.errors.join('\n') : String(m.subtype ?? '')
          end('error', friendlyError(raw))
        } else if (runningTasks()) {
          // Background work goes on, and Claude Code will answer it: stay open.
          idle = true
          emit({ type: 'answered' })
        } else if ([...tasks.values()].some(t => t.shown && (t.endedAt ?? 0) >= requestStartedAt)) {
          // A task finished while this answer was being written: Claude Code may take it up next.
          idle = true
          finishedWhileIdle = []
          settle()
        } else end('done')
        break
      }
    }
  }

  const args = [
    '-p',
    '--output-format', 'stream-json',
    '--input-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--replay-user-messages',
    '--permission-prompt-tool', 'stdio',
    '--permission-mode', MODES[options.mode] ?? 'default',
  ]
  if (options.model && options.model !== 'default') args.push('--model', options.model)
  if (options.effort) args.push('--effort', options.effort)
  if (options.sessionId) args.push('--resume', options.sessionId)
  // Attachments live outside the project: let Claude Code read them without asking.
  for (const dir of options.readDirs ?? []) args.push('--add-dir', dir)
  // Mango's browser for this chat. Tools that only read the page run without asking.
  const browser = options.browserMcp
  if (browser) {
    args.push('--mcp-config', JSON.stringify({ mcpServers: { [browser.name]: { type: 'http', url: browser.url } } }))
    if (browser.readOnlyTools.length) args.push('--allowedTools', browser.readOnlyTools.map(t => `mcp__${browser.name}__${t}`).join(','))
  }

  options.spawn(args, {
    onLine,
    onStderr: (l) => { if (l.trim()) lastStderr = l },
    onExit: (code) => {
      if (ended) return
      if (interrupted) end('stopped')
      else if (idle && code === 0) end('done')
      else end('error', friendlyError(lastStderr || `Claude Code exited with code ${code ?? 'unknown'} before finishing.`))
    },
  }).then((t) => {
    transport = t
    if (ended) { t.kill().catch(() => {}); return }
    // Ask for sub-agents' text and thinking, not only their tool calls. A CLI that does not know
    // the option ignores it (and the answer is not waited for).
    send({ type: 'control_request', request_id: 'mango-init', request: { subtype: 'initialize', forwardSubagentText: true } })
    // A slash command is not echoed back when the CLI reads it: counting it would wait forever.
    if (!isSlash(options.prompt)) sentMessages++
    send({ type: 'user', message: { role: 'user', content: userContent(options) } })
  }).catch((err) => {
    end('error', err instanceof Error ? err.message : String(err))
  })

  const grantedDirs = new Set(options.readDirs ?? [])

  return {
    async steer(input) {
      // --add-dir is fixed at launch: a message reading files from another folder waits for the next turn.
      if (ended || interrupted || !transport || (input.readDirs ?? []).some(d => !grantedDirs.has(d))) return false
      // A command runs as a turn of its own, not in the middle of this one.
      if (isSlash(input.prompt)) return false
      // Waiting on background tasks: the message starts the next turn, which the caller already shows as one.
      if (idle) { idle = false; finishedWhileIdle = []; clearTimeout(settleTimer) }
      sentMessages++
      await send({ type: 'user', message: { role: 'user', content: userContent(input) } })
      return true
    },
    respondApproval(id, allow) {
      decide(id, allow)
    },
    answerQuestion(id, answers) {
      decide(id, answers)
    },
    interrupt() {
      if (ended || interrupted) return
      interrupted = true
      for (const [id, pending] of pendingApprovals) {
        send({ type: 'control_response', response: { subtype: 'success', request_id: id, response: pending.stopped } })
      }
      // Stop means everything: the commands and sub-agents left running in the background too.
      for (const [id, task] of tasks) if (task.shown && !task.ended) stopTaskById(id)
      if (idle) {
        // No turn to interrupt: the run was only waiting on those tasks.
        end('stopped')
        const t = transport
        setTimeout(() => t?.kill().catch(() => {}), 5000)
        return
      }
      send({ type: 'control_request', request_id: `interrupt-${Date.now()}`, request: { subtype: 'interrupt' } })
      // If the CLI does not wind down by itself, stop it.
      killTimer = setTimeout(() => {
        transport?.kill().catch(() => {})
        end('stopped')
      }, 4000)
    },
    stopTask(id) {
      if (ended) return
      const taskId = tasks.has(id) ? id : subagents.get(id)?.taskId
      if (taskId) stopTaskById(taskId)
    },
    async taskOutput(id) {
      const r = await controlRequest({ subtype: 'get_task_output', task_id: id })
      if (!r) return null
      const text = [r.output, r.content, r.text, r.tail].find(v => typeof v === 'string')
      return typeof text === 'string' ? text : null
    },
  }
}

/**
 * The effort Claude Code runs a model at when none is chosen, from its `get_settings` answer:
 * the per-model setting (keyed by the resolved model id), else the global one, else what it
 * reports as applied for the model it would start with. Unknown for any other model.
 */
function defaultEffortFor(resolved: string | undefined, settings: any, efforts: string[]): string | undefined {
  if (!resolved || !efforts.length) return undefined
  const level = settings?.effective?.modelSettings?.[resolved]?.effortLevel
    ?? settings?.effective?.effortLevel
    ?? (settings?.applied?.model === resolved ? settings.applied.effort : undefined)
  return typeof level === 'string' && efforts.includes(level) ? level : undefined
}

/**
 * Claude Code's own model list: the `initialize` control request answers with every
 * model the account can use and the effort levels each accepts, and `get_settings`
 * with the effort each one runs at by default. No prompt is sent.
 */
function listModels(spawn: SpawnFn): Promise<AgentModel[]> {
  return new Promise((resolve, reject) => {
    let transport: AgentTransport | null = null
    let done = false
    let list: any[] | null = null
    let settings: any = undefined // undefined: not answered yet; null: no answer to be had
    const finish = (models: AgentModel[] | null, why?: string) => {
      if (done) return
      done = true
      clearTimeout(timer)
      transport?.kill().catch(() => {})
      if (models) resolve(models)
      else reject(new Error(why ?? 'Claude Code did not list its models.'))
    }
    const tryFinish = () => {
      if (!list || settings === undefined) return
      finish(list.filter((x: any) => typeof x?.value === 'string').map((x: any): AgentModel => {
        const efforts: string[] = x.supportsEffort && Array.isArray(x.supportedEffortLevels) ? x.supportedEffortLevels.map(String) : []
        const defaultEffort = defaultEffortFor(x.resolvedModel ?? x.value, settings, efforts)
        return x.value === 'default'
          ? { id: 'default', label: 'Default', hint: x.description ? `Claude Code's choice: ${x.description}` : undefined, efforts, defaultEffort }
          : { id: x.value, label: String(x.displayName ?? x.value), hint: x.description || undefined, efforts, defaultEffort }
      }))
    }
    const timer = setTimeout(() => {
      // The model list without defaults beats no list (an older CLI may not answer get_settings).
      if (list) { settings = null; tryFinish() } else finish(null, 'Claude Code took too long to list its models.')
    }, 30_000)
    spawn(['-p', '--output-format', 'stream-json', '--input-format', 'stream-json', '--verbose'], {
      onLine(line) {
        let m: any
        try { m = JSON.parse(line) } catch { return }
        if (m?.type !== 'control_response') return
        const id = m.response?.request_id
        if (id === 'mango-models') {
          const models = m.response?.response?.models
          if (!Array.isArray(models)) return finish(null)
          list = models
        } else if (id === 'mango-settings') {
          settings = m.response?.subtype === 'success' ? (m.response.response ?? null) : null
        } else return
        tryFinish()
      },
      onExit: () => {
        if (list) { settings ??= null; tryFinish() }
        finish(null, 'Claude Code exited before listing its models.')
      },
    }).then((t) => {
      transport = t
      if (done) { t.kill().catch(() => {}); return }
      t.write(JSON.stringify({ type: 'control_request', request_id: 'mango-models', request: { subtype: 'initialize' } }))
        .then(() => t.write(JSON.stringify({ type: 'control_request', request_id: 'mango-settings', request: { subtype: 'get_settings' } })))
        .catch(() => {})
    }).catch(err => finish(null, err instanceof Error ? err.message : String(err)))
  })
}

/**
 * Commands Mango does not offer: the composer's own chips set model and effort, `/clear` is
 * Mango's (a new conversation in the same chat), and the rest only change the terminal UI
 * or are internal plumbing.
 */
const HIDDEN_COMMANDS = new Set([
  'clear', 'model', 'effort', 'fast', 'color', 'focus', 'heapdump', 'config', 'rename', 'exit',
  'workflow-launch-exec',
])

/** A command's description, without the "(user)" source tag or "(plugin)" prefix Claude Code adds. */
const commandDescription = (raw: unknown) =>
  typeof raw === 'string'
    ? raw.replace(/\s*\((user|project|plugin|bundled|dynamic workflow)\)\s*$/i, '').replace(/^\([\w.:-]+\)\s*/, '').trim()
    : ''

/**
 * The slash commands Claude Code runs in this project: its built-ins that work without the
 * terminal UI, the user's and the project's commands, and skills. Read from the `initialize`
 * answer; no prompt is sent.
 */
function listCommands(spawn: SpawnFn): Promise<AgentCommand[]> {
  return new Promise((resolve, reject) => {
    let transport: AgentTransport | null = null
    let done = false
    const finish = (commands: AgentCommand[] | null, why?: string) => {
      if (done) return
      done = true
      clearTimeout(timer)
      transport?.kill().catch(() => {})
      if (commands) resolve(commands)
      else reject(new Error(why ?? 'Claude Code did not list its commands.'))
    }
    const timer = setTimeout(() => finish(null, 'Claude Code took too long to list its commands.'), 30_000)
    spawn(['-p', '--output-format', 'stream-json', '--input-format', 'stream-json', '--verbose'], {
      onLine(line) {
        let m: any
        try { m = JSON.parse(line) } catch { return }
        if (m?.type !== 'control_response' || m.response?.request_id !== 'mango-commands') return
        const list = m.response?.response?.commands
        if (!Array.isArray(list)) return finish(null)
        const out: AgentCommand[] = []
        for (const c of list) {
          const name = typeof c?.name === 'string' ? c.name : ''
          const description = commandDescription(c.description)
          if (!name || name.startsWith('_') || HIDDEN_COMMANDS.has(name) || /^\(removed\)|^renamed to/i.test(description)) continue
          if (out.some(o => o.name === name)) continue
          out.push({
            name,
            ...(description ? { description } : {}),
            ...(typeof c.argumentHint === 'string' && c.argumentHint ? { argumentHint: c.argumentHint } : {}),
            ...(Array.isArray(c.aliases) && c.aliases.length ? { aliases: c.aliases.map(String) } : {}),
          })
        }
        finish(out)
      },
      onExit: () => finish(null, 'Claude Code exited before listing its commands.'),
    }).then((t) => {
      transport = t
      if (done) { t.kill().catch(() => {}); return }
      t.write(JSON.stringify({ type: 'control_request', request_id: 'mango-commands', request: { subtype: 'initialize' } })).catch(() => {})
    }).catch(err => finish(null, err instanceof Error ? err.message : String(err)))
  })
}

/** "max" → "Max", "team_premium" → "Team premium". */
const planName = (raw: unknown): string | null =>
  typeof raw === 'string' && raw ? raw.charAt(0).toUpperCase() + raw.slice(1).replace(/_/g, ' ') : null

const resetTime = (raw: unknown): number | null => {
  const t = typeof raw === 'string' ? Date.parse(raw) : Number.NaN
  return Number.isFinite(t) ? t : null
}

const clampPercent = (n: unknown): number | null =>
  typeof n === 'number' && Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : null

/** The `rate_limits` of a `get_usage` answer → windows, 5-hour first. */
export function claudeUsageWindows(limits: any): UsageWindow[] {
  const out: UsageWindow[] = []
  const add = (id: string, label: string, percent: unknown, resets: unknown) => {
    const p = clampPercent(percent)
    if (p !== null && !out.some(w => w.id === id)) out.push({ id, label, percent: p, resetsAt: resetTime(resets) })
  }
  // Newer CLIs list every limit that applies to the plan, with per-model weekly limits named.
  if (Array.isArray(limits?.limits)) {
    for (const l of limits.limits) {
      const model = l?.scope?.model?.display_name
      if (l?.kind === 'session') add('five-hour', '5-hour', l.percent, l.resets_at)
      else if (l?.kind === 'weekly_all') add('weekly', 'Weekly', l.percent, l.resets_at)
      else if (l?.group === 'weekly' && typeof model === 'string' && model) add(`weekly:${model.toLowerCase()}`, `Weekly · ${model}`, l.percent, l.resets_at)
    }
  }
  // The fixed fields every version sends; they fill in whatever the list did not cover.
  const fixed: Array<[string, string, string]> = [
    ['five_hour', 'five-hour', '5-hour'],
    ['seven_day', 'weekly', 'Weekly'],
    ['seven_day_opus', 'weekly:opus', 'Weekly · Opus'],
    ['seven_day_sonnet', 'weekly:sonnet', 'Weekly · Sonnet'],
  ]
  for (const [key, id, label] of fixed) {
    const w = limits?.[key]
    if (w) add(id, label, w.utilization, w.resets_at)
  }
  const rank = (w: UsageWindow) => (w.id === 'five-hour' ? 0 : w.id === 'weekly' ? 1 : 2)
  return out.sort((a, b) => rank(a) - rank(b))
}

/**
 * The plan's usage limits: the `get_usage` control request answers with what `/usage`
 * shows (the 5-hour session, the week, per-model weekly limits). No prompt is sent.
 */
function readUsage(spawn: SpawnFn): Promise<AgentUsage> {
  return new Promise((resolve, reject) => {
    let transport: AgentTransport | null = null
    let done = false
    const finish = (usage: AgentUsage | null, why?: string) => {
      if (done) return
      done = true
      clearTimeout(timer)
      transport?.kill().catch(() => {})
      if (usage) resolve(usage)
      else reject(new Error(why ?? 'Claude Code did not report its usage.'))
    }
    const timer = setTimeout(() => finish(null, 'Claude Code took too long to report its usage.'), 30_000)
    spawn(['-p', '--output-format', 'stream-json', '--input-format', 'stream-json', '--verbose'], {
      onLine(line) {
        let m: any
        try { m = JSON.parse(line) } catch { return }
        if (m?.type !== 'control_response' || m.response?.request_id !== 'mango-usage') return
        if (m.response.subtype !== 'success') {
          const unsupported = m.response.error_code === 'unsupported_request' || /unsupported/i.test(String(m.response.error ?? ''))
          return finish(null, unsupported ? 'This version of Claude Code cannot report usage. Update it to see its limits.' : String(m.response.error || 'Claude Code did not report its usage.'))
        }
        const r = m.response.response ?? {}
        const plan = planName(r.subscription_type)
        const windows = r.rate_limits_available === false ? [] : claudeUsageWindows(r.rate_limits)
        finish({
          plan,
          windows,
          note: windows.length ? undefined : plan ? 'Claude Code reported no limits for this plan.' : 'No plan limits: Claude Code is not signed in with a Claude subscription (an API key is billed per token).',
        })
      },
      onExit: () => finish(null, 'Claude Code exited before reporting its usage.'),
    }).then((t) => {
      transport = t
      if (done) { t.kill().catch(() => {}); return }
      t.write(JSON.stringify({ type: 'control_request', request_id: 'mango-usage', request: { subtype: 'get_usage' } })).catch(() => {})
    }).catch(err => finish(null, err instanceof Error ? err.message : String(err)))
  })
}

export const claudeAdapter: AgentAdapter = { id: 'claude', run, listModels, readUsage, listCommands }
export default claudeAdapter
