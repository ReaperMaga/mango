import type { AgentModel, DiffLine, ToolKind } from '~/types/chat'
import type { AgentAdapter, AgentEvent, AgentRun, AgentRunOptions, AgentTransport, PermissionMode, SpawnFn, ToolImage } from '~/agents/types'

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
    case 'ExitPlanMode':
      return { tool: 'other', label: 'Proposed', target: 'a plan' }
    case 'Skill':
      return { tool: 'other', label: 'Used skill', target: String(i.skill ?? i.command ?? '') }
    default: {
      // MCP tools are named mcp__server__tool.
      const mcp = /^mcp__(.+?)__(.+)$/.exec(name)
      const first = Object.values(i).find(v => typeof v === 'string') as string | undefined
      return { tool: 'other', label: 'Used', target: mcp ? `${mcp[1]} · ${mcp[2]}` : name, summary: first && first.length < 60 ? first : undefined }
    }
  }
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
      return { title: `Claude Code wants to use ${d.target || toolName}`, command: JSON.stringify(i, null, 2).slice(0, 1200), reason: '' }
    }
  }
}

/** The prompt as message content: attached images first, then the text (an empty text block is refused). */
function userContent(options: AgentRunOptions): unknown[] {
  const content: unknown[] = (options.images ?? []).map(img => ({
    type: 'image',
    source: { type: 'base64', media_type: img.mime, data: img.data },
  }))
  if (options.prompt.trim() || !content.length) content.push({ type: 'text', text: options.prompt })
  return content
}

function run(options: AgentRunOptions): AgentRun {
  const { cwd, emit } = options
  let transport: AgentTransport | null = null
  let ended = false
  let interrupted = false
  let lastStderr = ''
  let seq = 0
  let killTimer: ReturnType<typeof setTimeout> | undefined

  /** Streaming state of the assistant message being received. */
  let messageId = ''
  const blocks = new Map<number, { kind: 'text' | 'thinking' | 'tool'; id: string; json: string; name: string; started: number }>()
  const streamedMessages = new Set<string>()
  const tools = new Map<string, { name: string; shape: ToolShape }>()
  const pendingApprovals = new Map<string, { input: any }>()

  const end = (status: 'done' | 'error' | 'stopped', error?: string) => {
    if (ended) return
    ended = true
    clearTimeout(killTimer)
    for (const id of pendingApprovals.keys()) emit({ type: 'approval-cancelled', id })
    pendingApprovals.clear()
    emit({ type: 'turn-end', status, error })
    transport?.closeStdin().catch(() => {})
  }

  const send = (obj: unknown) => transport?.write(JSON.stringify(obj)).catch(() => {})

  const startTool = (id: string, name: string, input: any) => {
    const shape = describeTool(name, input, cwd)
    const before = tools.get(id)
    const known = !!before
    // The full `assistant` message repeats what the stream already delivered.
    if (before && JSON.stringify(before.shape) === JSON.stringify(shape)) return
    tools.set(id, { name, shape })
    if (!known) emit({ type: 'tool-start', id, tool: shape.tool, label: shape.label, target: shape.target })
    if (known || shape.summary || shape.diff?.length) {
      emit({ type: 'tool-update', id, target: shape.target, summary: shape.summary, diff: shape.diff?.length ? shape.diff : undefined })
    }
  }

  function onStreamEvent(e: any) {
    switch (e.type) {
      case 'message_start':
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
    const content: any[] = Array.isArray(msg.content) ? msg.content : []
    content.forEach((b, i) => {
      if (b.type === 'tool_use') startTool(b.id, b.name, b.input)
      else if (!streamed && b.type === 'text' && b.text) emit({ type: 'text', id: `${msg.id ?? `m${++seq}`}:a${i}`, text: b.text })
    })
    if (msg.error || m.error) lastStderr = String(msg.error ?? m.error)
  }

  /** Tool results come back as a user message. */
  function onUser(m: any) {
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
      else if (t?.shape.tool === 'search' || t?.shape.tool === 'other' || t?.shape.tool === 'web') output = text ? clip(text) : undefined
      const images = resultImages(b.content)
      if (isError) summary = 'failed'
      else if (t?.shape.tool === 'read' && images.length) summary = images.length === 1 ? 'image' : `${images.length} images`
      else if (t?.shape.tool === 'read') {
        const n = typeof extra?.file?.numLines === 'number' ? extra.file.numLines : (text ? text.split('\n').length : 0)
        summary = n ? `${n} lines` : undefined
      } else if (diff && t?.shape.tool === 'edit') summary = counts(diff)
      else if (diff && t?.shape.tool === 'write') summary = `+${diff.filter(l => l.kind === 'add').length}`
      emit({ type: 'tool-end', id: b.tool_use_id, status: isError ? 'error' : 'ok', summary, output, diff, ...(images.length ? { images } : {}) })
    }
  }

  function onControlRequest(m: any) {
    const req = m.request ?? {}
    const requestId: string = m.request_id
    if (req.subtype === 'can_use_tool') {
      if (req.tool_name === 'AskUserQuestion') {
        // Multiple-choice questions need their own UI; until then, steer the agent to plain text.
        send({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response: { behavior: 'deny', message: 'This client cannot show multiple-choice questions. Ask the question in plain text instead.' } } })
        return
      }
      pendingApprovals.set(requestId, { input: req.input })
      emit({ type: 'approval', id: requestId, toolId: req.tool_use_id, ...approvalFor(req.tool_name, req.input, cwd) })
      return
    }
    send({ type: 'control_response', response: { subtype: 'error', request_id: requestId, error: `Unsupported control request: ${req.subtype}` } })
  }

  function onLine(line: string) {
    if (ended) return
    let m: any
    try { m = JSON.parse(line) } catch { return }
    // Sub-agent internals (messages whose parent is a Task tool call) stay folded into that tool's row.
    if (m.parent_tool_use_id) return
    switch (m.type) {
      case 'system':
        if (m.subtype === 'init' && m.session_id) emit({ type: 'session', sessionId: m.session_id })
        break
      case 'stream_event': onStreamEvent(m.event ?? {}); break
      case 'assistant': onAssistant(m); break
      case 'user': onUser(m); break
      case 'control_request': onControlRequest(m); break
      case 'result': {
        if (m.session_id) emit({ type: 'session', sessionId: m.session_id })
        if (interrupted) end('stopped')
        else if (m.is_error || (m.subtype && m.subtype !== 'success')) {
          const raw = typeof m.result === 'string' && m.result ? m.result : Array.isArray(m.errors) ? m.errors.join('\n') : String(m.subtype ?? '')
          end('error', friendlyError(raw))
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
    '--permission-prompt-tool', 'stdio',
    '--permission-mode', MODES[options.mode] ?? 'default',
  ]
  if (options.model && options.model !== 'default') args.push('--model', options.model)
  if (options.effort) args.push('--effort', options.effort)
  if (options.sessionId) args.push('--resume', options.sessionId)
  // Attachments live outside the project: let Claude Code read them without asking.
  for (const dir of options.readDirs ?? []) args.push('--add-dir', dir)

  options.spawn(args, {
    onLine,
    onStderr: (l) => { if (l.trim()) lastStderr = l },
    onExit: (code) => {
      if (ended) return
      if (interrupted) end('stopped')
      else end('error', friendlyError(lastStderr || `Claude Code exited with code ${code ?? 'unknown'} before finishing.`))
    },
  }).then((t) => {
    transport = t
    if (ended) { t.kill().catch(() => {}); return }
    send({ type: 'user', message: { role: 'user', content: userContent(options) } })
  }).catch((err) => {
    end('error', err instanceof Error ? err.message : String(err))
  })

  return {
    respondApproval(id, allow) {
      const pending = pendingApprovals.get(id)
      if (!pending) return
      pendingApprovals.delete(id)
      send({
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: id,
          response: allow
            ? { behavior: 'allow', updatedInput: pending.input }
            : { behavior: 'deny', message: 'The user denied this request.' },
        },
      })
    },
    interrupt() {
      if (ended || interrupted) return
      interrupted = true
      for (const [id] of pendingApprovals) {
        send({ type: 'control_response', response: { subtype: 'success', request_id: id, response: { behavior: 'deny', message: 'The user stopped the run.' } } })
      }
      send({ type: 'control_request', request_id: `interrupt-${Date.now()}`, request: { subtype: 'interrupt' } })
      // If the CLI does not wind down by itself, stop it.
      killTimer = setTimeout(() => {
        transport?.kill().catch(() => {})
        end('stopped')
      }, 4000)
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

export const claudeAdapter: AgentAdapter = { id: 'claude', run, listModels }
export default claudeAdapter
