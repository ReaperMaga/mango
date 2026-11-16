import type { AgentAdapter, AgentEvent, AgentRun, AgentRunOptions, AgentTransport, PermissionMode, SpawnFn, SteerInput, ToolImage } from '~/agents/types'
import type { AgentModel, DiffLine, ToolKind } from '~/types/chat'

/**
 * Codex adapter: drives `codex app-server` (JSON-RPC 2.0 over stdio, one JSON
 * object per line, no "jsonrpc" field on the wire).
 *
 * One process per turn: spawn, `initialize`, `thread/start` (or `thread/resume`
 * with the thread id we emitted as the session id), `turn/start`, translate the
 * `item/*` notifications until `turn/completed`, then close stdin so the server
 * exits. Startup costs ~0.3 s before the prompt is on its way, and no server is
 * left running between turns.
 *
 * Codex keeps a command running when its turn ends or is interrupted (a
 * "background terminal" the model can come back to). With a server per turn
 * nothing could come back to it, so before the turn is reported as ended the
 * adapter asks Codex to stop those commands (`thread/backgroundTerminals/clean`,
 * which is why `experimentalApi` is switched on in `initialize`). Seen with
 * codex-cli 0.167 on Linux: that stop ends the sandbox wrapper, but the command
 * inside it can run on until it finishes by itself; only the process owner
 * (the spawn bridge) could reap it.
 *
 * Permission modes → Codex approval policy + sandbox (set on the thread for
 * every turn, so changing the mode between turns takes effect):
 *
 *   plan   approvalPolicy 'never'       sandbox 'read-only'
 *          Nothing can be written and nothing asks; a write attempt simply
 *          fails inside the sandbox and Codex reports it.
 *   ask    approvalPolicy 'untrusted'   sandbox 'workspace-write'
 *          Every file change and every command asks first (with codex-cli
 *          0.167 that includes plain reads such as `cat`). What is approved
 *          still runs inside the sandbox.
 *   edits  approvalPolicy 'on-request'  sandbox 'workspace-write'
 *          Edits inside the project apply automatically and commands run
 *          inside the sandbox without asking; a command that has to leave it
 *          (network, writing outside the project) asks first. Codex has no
 *          "edits free, every command asks" combination; this is the closest.
 *   auto   approvalPolicy 'never'       sandbox 'workspace-write'
 *          Nothing asks. Still sandboxed to the project: a command that needs
 *          more fails instead of escalating. Never danger-full-access.
 *
 * 'workspace-write' takes its details (network access, extra writable roots)
 * from the user's ~/.codex/config.toml; by default the network is off.
 *
 * Runs in plain Node with type stripping: type-only imports, erasable syntax.
 */

type Json = any

interface Policy { approvalPolicy: 'untrusted' | 'on-request' | 'never'; sandbox: 'read-only' | 'workspace-write' }

const POLICIES: Record<PermissionMode, Policy> = {
  plan: { approvalPolicy: 'never', sandbox: 'read-only' },
  ask: { approvalPolicy: 'untrusted', sandbox: 'workspace-write' },
  edits: { approvalPolicy: 'on-request', sandbox: 'workspace-write' },
  auto: { approvalPolicy: 'never', sandbox: 'workspace-write' },
}

/** Notifications this adapter has no use for; the server skips sending them. */
const UNUSED_NOTIFICATIONS = [
  'thread/tokenUsage/updated',
  'account/rateLimits/updated',
  'mcpServer/startupStatus/updated',
  'remoteControl/status/changed',
  'turn/diff/updated',
  'skills/changed',
  'app/list/updated',
]

const OUTPUT_CAP = 20_000
const DIFF_LINE_CAP = 1500
const SIGN_IN_HINT = 'Codex is not signed in. Open Settings > Agents and sign in.'

/* ---------- small pure helpers ---------- */

function capTail(text: string): string {
  return text.length > OUTPUT_CAP ? `… earlier output cut\n${text.slice(-OUTPUT_CAP)}` : text
}

function relPath(path: string, cwd: string): string {
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '')
  let p = norm(path)
  let c = norm(cwd)
  if (/^[a-z]:\//i.test(c)) { p = p.toLowerCase(); c = c.toLowerCase() }
  if (!c) return path
  if (p === c) return '.'
  return p.startsWith(`${c}/`) ? norm(path).slice(c.length + 1) : path
}

/** One shell word → its literal text, or null when `text` is not exactly one quoted/bare word. */
function unquoteWord(text: string): string | null {
  const t = text.trim()
  if (t.length >= 2 && t.startsWith('\'') && t.endsWith('\'')) {
    const inner = t.slice(1, -1).replace(/'\\''|'"'"'/g, '\u0000')
    return inner.includes('\'') ? null : inner.replace(/\u0000/g, '\'')
  }
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) {
    const inner = t.slice(1, -1)
    if (/(^|[^\\])(\\\\)*"/.test(inner)) return null
    return inner.replace(/\\(["\\$`!])/g, '$1')
  }
  return /[\s'"]/.test(t) ? null : t
}

/** `/bin/bash -lc 'npm test'` → `npm test`. Anything that is not a plain shell wrapper is returned unchanged. */
function unwrapCommand(command: string): string {
  const m = /^(?:\S*[\\/])?(?:bash|zsh|sh|dash)(?:\.exe)?\s+-l?c\s+([\s\S]+)$/.exec(command)
    ?? /^"?(?:[^"]*[\\/])?(?:pwsh|powershell)(?:\.exe)?"?\s+(?:-NoProfile\s+)?-Command\s+([\s\S]+)$/i.exec(command)
  if (!m) return command
  return unquoteWord(m[1]!) ?? command
}

/** Codex's per-file `diff` (unified diff for updates, bare content for added/deleted files) → DiffLine[]. */
function toDiffLines(diff: string, kind: string): DiffLine[] {
  const lines = diff.replace(/\r\n/g, '\n').split('\n')
  if (lines.length && lines[lines.length - 1] === '') lines.pop()
  const unified = lines.some(l => l.startsWith('@@'))
  const out: DiffLine[] = []
  if (!unified && (kind === 'add' || kind === 'delete')) {
    for (const text of lines) out.push({ kind: kind === 'add' ? 'add' : 'del', text })
  }
  else {
    let inHunk = false
    for (const l of lines) {
      if (l.startsWith('@@')) { inHunk = true; out.push({ kind: 'hunk', text: l }); continue }
      if (!inHunk && /^(diff |index |--- |\+\+\+ |new file|deleted file|similarity|rename )/.test(l)) continue
      if (l.startsWith('\\ ')) continue
      if (l.startsWith('+')) out.push({ kind: 'add', text: l.slice(1) })
      else if (l.startsWith('-')) out.push({ kind: 'del', text: l.slice(1) })
      else out.push({ kind: 'ctx', text: l.startsWith(' ') ? l.slice(1) : l })
    }
  }
  if (out.length > DIFF_LINE_CAP) {
    const more = out.length - DIFF_LINE_CAP
    out.length = DIFF_LINE_CAP
    out.push({ kind: 'hunk', text: `… ${more} more lines` })
  }
  return out
}

function diffSummary(diff: string, kind: string): string {
  let adds = 0
  let dels = 0
  // Counted on the full diff, not the capped DiffLine list.
  const lines = diff.replace(/\r\n/g, '\n').split('\n')
  if (lines.length && lines[lines.length - 1] === '') lines.pop()
  const unified = lines.some(l => l.startsWith('@@'))
  if (!unified && kind === 'add') adds = lines.length
  else if (!unified && kind === 'delete') dels = lines.length
  else {
    let inHunk = false
    for (const l of lines) {
      if (l.startsWith('@@')) { inHunk = true; continue }
      if (!inHunk && /^(--- |\+\+\+ )/.test(l)) continue
      if (l.startsWith('+')) adds++
      else if (l.startsWith('-')) dels++
    }
  }
  const parts: string[] = []
  if (adds || !dels) parts.push(`+${adds}`)
  if (dels) parts.push(`−${dels}`)
  return parts.join(' ')
}

/**
 * A stderr line worth quoting if the process dies: no colour codes, no tracing prefix.
 * Returns '' for continuation lines and for the config warnings Codex prints on every start.
 */
function cleanStderr(line: string): string {
  const plain = line.replace(/\u001B\[[0-9;]*[A-Za-z]/g, '')
  if (/^\s/.test(plain) || /^note:/i.test(plain)) return ''
  const text = plain.replace(/^\S+Z\s+(ERROR|WARN|INFO|DEBUG|TRACE)\s+[\w:]+:\s*/, '').trim()
  return /unrecognized configuration setting|until the project is trusted|^WARNING: proceeding/i.test(text) ? '' : text
}

function errorInfoKey(info: Json): string {
  if (typeof info === 'string') return info
  if (info && typeof info === 'object') return Object.keys(info)[0] ?? ''
  return ''
}

/** A Codex error (turn error, `error` notification or JSON-RPC error) → one short sentence naming the problem and the fix. */
function describeError(error: Json, model: string): string {
  const message = String((typeof error === 'string' ? error : error?.message) ?? '').trim()
  const short = message.length > 300 ? `${message.slice(0, 300)}…` : message
  const key = errorInfoKey(error?.codexErrorInfo)
  const has = (re: RegExp) => re.test(message)
  const modelName = model === 'default' ? 'The configured model' : `The model "${model}"`

  if (key === 'unauthorized' || has(/not (logged|signed) in|401 unauthorized|sign in again|login required|missing (bearer|api key)|authentication (required|token)/i)) return SIGN_IN_HINT
  if (key === 'usageLimitExceeded' || has(/usage limit/i)) return `Codex usage limit reached. ${short || 'Wait for it to reset, or upgrade the plan.'}`
  if (key === 'rateLimitExceeded' || has(/rate limit|429/i)) return 'Codex is rate limited. Wait a moment, then send the message again.'
  if (key === 'modelNotFound' || has(/model.{0,60}(not (found|supported|available)|does not exist)|unknown model|unsupported model/i)) return `${modelName} is not available for this Codex account. Pick another model. (${short})`
  if (key === 'contextWindowExceeded') return 'The conversation no longer fits the model\'s context window. Start a new thread.'
  if (key === 'serverOverloaded') return 'Codex servers are overloaded. Try again in a moment.'
  if (key === 'httpConnectionFailed' || key === 'responseStreamConnectionFailed' || key === 'responseStreamDisconnected' || key === 'responseTooManyFailedAttempts') {
    return `Could not reach Codex. Check the network connection and try again.${short ? ` (${short})` : ''}`
  }
  if (key === 'sandboxError') return `Codex could not set up its sandbox: ${short}`
  if (has(/config\.toml|failed to load configuration/i)) return `Codex could not load its configuration: ${short.replace(/^failed to load configuration:\s*/i, '')}. Fix that file and try again.`
  return short ? `Codex error: ${short}` : 'Codex failed without saying why. Try again.'
}

/* ---------- the adapter ---------- */

interface FileTool { id: string; diff: string; kind: string }
interface OpenApproval { rpcId: string | number; respond(allow: boolean): Json }


/**
 * The prompt as turn input: the text, then each attached image by path (`localImage`; Codex
 * reads the file itself). The sandbox can read the whole disk, so `readDirs` needs no grant.
 */
function turnInput(options: SteerInput): Json[] {
  const input: Json[] = []
  if (options.prompt.trim() || !options.images?.length) input.push({ type: 'text', text: options.prompt, text_elements: [] })
  for (const img of options.images ?? []) input.push({ type: 'localImage', path: img.path })
  return input
}
function run(options: AgentRunOptions): AgentRun {
  const { cwd, model } = options
  const policy = POLICIES[options.mode] ?? POLICIES.ask

  let transport: AgentTransport | null = null
  let ended = false
  let exited = false
  let stopRequested = false
  let interruptSent = false
  let turnRequested = false
  /** Set once Codex reported the turn over and we are only waiting for its cleanup. */
  let closing: { status: 'done' | 'error' | 'stopped'; error?: string } | null = null
  let threadId: string | null = null
  let turnId: string | null = null
  let lastStderr = ''
  let lastError: Json = null
  let stopTimer: ReturnType<typeof setTimeout> | null = null

  let nextRpcId = 1
  const waiting = new Map<number, { resolve(result: Json): void; reject(error: Json): void; timer: ReturnType<typeof setTimeout> }>()

  /** Tool rows: every id ever started, and the ones still running. Then text/thinking blocks and live command output. */
  const knownTools = new Set<string>()
  const openTools = new Set<string>()
  const textStreamed = new Set<string>()
  const thinking = new Map<string, { startedAt: number | null; streamed: boolean }>()
  const commandOutput = new Map<string, string>()
  const fileTools = new Map<string, Map<string, FileTool>>()
  const approvals = new Map<string, OpenApproval>()

  const emit = (event: AgentEvent) => { if (!ended) options.emit(event) }

  /* ----- wire ----- */

  const send = (message: Json) => {
    if (!transport || exited) return
    transport.write(JSON.stringify(message)).catch(() => {})
  }

  const request = (method: string, params: Json, timeoutMs: number): Promise<Json> =>
    new Promise((resolve, reject) => {
      const id = nextRpcId++
      const timer = setTimeout(() => {
        waiting.delete(id)
        reject({ message: `Codex did not answer ${method} within ${Math.round(timeoutMs / 1000)} s.` })
      }, timeoutMs)
      waiting.set(id, { resolve, reject, timer })
      send({ id, method, params })
    })

  const shutdown = () => {
    // Nothing will answer now: settle what is still asked (a steer in flight falls back to the next turn).
    for (const w of waiting.values()) { clearTimeout(w.timer); w.reject({ message: 'Codex closed.' }) }
    waiting.clear()
    if (stopTimer) clearTimeout(stopTimer)
    const t = transport
    if (!t || exited) return
    // Closing stdin lets the server flush the session file and exit by itself.
    t.closeStdin().catch(() => {})
    setTimeout(() => { if (!exited) t.kill().catch(() => {}) }, 2000)
  }

  const finish = (status: 'done' | 'error' | 'stopped', error?: string) => {
    if (ended) return
    for (const id of approvals.keys()) emit({ type: 'approval-cancelled', id })
    approvals.clear()
    for (const id of thinking.keys()) endThinking(id, null)
    for (const id of openTools) emit({ type: 'tool-end', id, status: 'error', summary: status === 'error' ? 'did not finish' : 'stopped' })
    openTools.clear()
    emit(status === 'error' ? { type: 'turn-end', status, error: error ?? 'Codex failed.' } : { type: 'turn-end', status })
    ended = true
    shutdown()
  }

  const fail = (error: Json) => finish(stopRequested ? 'stopped' : 'error', describeError(error, model))

  /**
   * The turn is over on Codex's side. Commands it left running would be orphaned when this server exits,
   * so Codex stops them first; their final `item/completed` still lands before `turn-end`.
   */
  const closeTurn = (status: 'done' | 'error' | 'stopped', error?: string) => {
    if (ended || closing) return
    closing = { status, error }
    if (stopTimer) clearTimeout(stopTimer)
    const done = () => finish(status, error)
    request('thread/backgroundTerminals/clean', { threadId }, 2000)
      .then(() => { if (openTools.size) setTimeout(done, 150); else done() }, done)
  }

  /* ----- tools ----- */

  const startTool = (id: string, tool: ToolKind, target: string, label?: string) => {
    if (knownTools.has(id)) return
    knownTools.add(id)
    openTools.add(id)
    emit({ type: 'tool-start', id, tool, target, ...(label ? { label } : {}) })
  }

  const endTool = (id: string, status: 'ok' | 'error', rest: { summary?: string; output?: string; diff?: DiffLine[]; images?: ToolImage[] } = {}) => {
    if (!openTools.delete(id)) return
    emit({ type: 'tool-end', id, status, ...rest })
  }

  const endThinking = (id: string, completedAt: number | null) => {
    const block = thinking.get(id)
    if (!block) return
    thinking.delete(id)
    if (!block.streamed) return
    const seconds = block.startedAt && completedAt ? Math.max(1, Math.round((completedAt - block.startedAt) / 1000)) : undefined
    emit(seconds === undefined ? { type: 'thinking-end', id } : { type: 'thinking-end', id, seconds })
  }

  const thinkingDelta = (id: string, text: string) => {
    if (!text) return
    let block = thinking.get(id)
    if (!block) { block = { startedAt: null, streamed: false }; thinking.set(id, block) }
    block.streamed = true
    emit({ type: 'thinking-delta', id, text })
  }

  /** How a command shows up: Codex tells us when a shell command is really just a file read or a search. */
  const classifyCommand = (item: Json): { tool: ToolKind; target: string } => {
    const actions: Json[] = Array.isArray(item.commandActions) ? item.commandActions : []
    if (actions.length && actions.every(a => a.type === 'read')) {
      return { tool: 'read', target: actions.map(a => relPath(String(a.path ?? a.name ?? ''), cwd)).join(', ') }
    }
    if (actions.length === 1 && actions[0].type === 'search') {
      const a = actions[0]
      const where = a.path ? ` in ${relPath(String(a.path), cwd)}` : ''
      return { tool: 'search', target: a.query ? `${a.query}${where}` : unwrapCommand(String(a.command ?? item.command ?? '')) }
    }
    if (actions.length === 1 && actions[0].type === 'listFiles') {
      const a = actions[0]
      return { tool: 'search', target: a.path ? relPath(String(a.path), cwd) : unwrapCommand(String(a.command ?? item.command ?? '')) }
    }
    return { tool: 'bash', target: unwrapCommand(String(item.command ?? '')) }
  }

  /** One tool row per file of a patch, keyed by path so streamed patch updates find their row again. */
  const syncFileChanges = (itemId: string, changes: Json[]) => {
    let tools = fileTools.get(itemId)
    if (!tools) { tools = new Map(); fileTools.set(itemId, tools) }
    for (const change of changes ?? []) {
      const path = String(change.path ?? '')
      const kind = String(change.kind?.type ?? 'update')
      const diff = String(change.diff ?? '')
      let tool = tools.get(path)
      if (!tool) {
        tool = { id: tools.size === 0 ? itemId : `${itemId}#${tools.size}`, diff: '', kind }
        tools.set(path, tool)
        const movedTo = kind === 'update' && change.kind?.move_path ? ` → ${relPath(String(change.kind.move_path), cwd)}` : ''
        startTool(tool.id, kind === 'add' ? 'write' : 'edit', `${relPath(path, cwd)}${movedTo}`)
      }
      if (diff !== tool.diff && openTools.has(tool.id)) {
        tool.diff = diff
        tool.kind = kind
        emit({ type: 'tool-update', id: tool.id, summary: diffSummary(diff, kind), diff: toDiffLines(diff, kind) })
      }
    }
    return tools
  }

  const mcpOutput = (item: Json): string => {
    if (item.error?.message) return String(item.error.message)
    const content: Json[] = item.result?.content ?? item.contentItems ?? []
    return content.map(c => (typeof c?.text === 'string' ? c.text : c?.type ? `[${c.type}]` : '')).filter(Boolean).join('\n')
  }

  /** Images in an MCP result (`{type:'image', data, mimeType}`) or a dynamic tool's output (`inputImage` data URLs). */
  const toolImages = (item: Json): ToolImage[] => {
    const content: Json[] = item.result?.content ?? item.contentItems ?? []
    const out: ToolImage[] = []
    for (const c of content) {
      if (c?.type === 'image' && typeof c.data === 'string') out.push({ mime: String(c.mimeType ?? 'image/png'), data: c.data })
      const url = c?.type === 'inputImage' ? String(c.imageUrl ?? '') : ''
      const m = /^data:([^;,]+);base64,(.+)$/s.exec(url)
      if (m) out.push({ mime: m[1]!, data: m[2]! })
    }
    return out
  }

  const webTarget = (item: Json): string => {
    const a = item.action
    if (a?.type === 'openPage' && a.url) return String(a.url)
    if (a?.type === 'findInPage' && a.url) return a.pattern ? `${a.pattern} in ${a.url}` : String(a.url)
    return String(item.query || a?.query || a?.queries?.[0] || 'web search')
  }

  const onItemStarted = (item: Json, startedAt: number | null) => {
    switch (item.type) {
      case 'reasoning':
        thinking.set(item.id, { startedAt, streamed: false })
        break
      case 'commandExecution': {
        const { tool, target } = classifyCommand(item)
        startTool(item.id, tool, target)
        break
      }
      case 'fileChange':
        syncFileChanges(item.id, item.changes)
        break
      case 'webSearch':
        startTool(item.id, 'web', webTarget(item))
        break
      case 'mcpToolCall':
        startTool(item.id, 'search', `${item.server}.${item.tool}`)
        break
      case 'dynamicToolCall':
        startTool(item.id, 'search', item.namespace ? `${item.namespace}.${item.tool}` : String(item.tool))
        break
      case 'imageView':
        startTool(item.id, 'read', relPath(String(item.path ?? ''), cwd))
        break
      case 'imageGeneration':
        startTool(item.id, 'other', 'an image', 'Generated')
        break
    }
  }

  const onItemCompleted = (item: Json, completedAt: number | null) => {
    switch (item.type) {
      case 'agentMessage':
      case 'plan':
        if (item.text || textStreamed.has(item.id)) emit({ type: 'text', id: item.id, text: String(item.text ?? '') })
        break
      case 'reasoning': {
        const block = thinking.get(item.id)
        if (!block?.streamed) {
          const summary: string[] = item.summary?.length ? item.summary : item.content ?? []
          thinkingDelta(item.id, summary.join('\n\n'))
        }
        endThinking(item.id, completedAt)
        break
      }
      case 'commandExecution': {
        onItemStarted(item, null)
        const { tool } = classifyCommand(item)
        const output = capTail(String(item.aggregatedOutput ?? commandOutput.get(item.id) ?? ''))
        commandOutput.delete(item.id)
        const ok = item.status === 'completed' && (item.exitCode === 0 || item.exitCode == null)
        let summary: string | undefined
        if (item.status === 'declined') summary = 'declined'
        else if (!ok && (closing || stopRequested)) summary = 'stopped'
        else if (!ok) summary = item.exitCode == null ? 'failed' : `exit ${item.exitCode}`
        else if (tool === 'read' && output) summary = `${output.replace(/\n$/, '').split('\n').length} lines`
        else if (typeof item.durationMs === 'number' && item.durationMs >= 1000) summary = `finished in ${(item.durationMs / 1000).toFixed(1)}s`
        endTool(item.id, ok ? 'ok' : 'error', { ...(summary ? { summary } : {}), ...(output ? { output } : {}) })
        break
      }
      case 'fileChange': {
        const tools = syncFileChanges(item.id, item.changes)
        const ok = item.status === 'completed'
        for (const tool of tools.values()) {
          endTool(tool.id, ok ? 'ok' : 'error', {
            summary: ok ? diffSummary(tool.diff, tool.kind) : item.status === 'declined' ? 'declined' : 'failed',
            diff: toDiffLines(tool.diff, tool.kind),
          })
        }
        fileTools.delete(item.id)
        break
      }
      case 'webSearch':
        onItemStarted(item, null)
        if (openTools.has(item.id)) emit({ type: 'tool-update', id: item.id, target: webTarget(item) })
        endTool(item.id, 'ok')
        break
      case 'mcpToolCall':
      case 'dynamicToolCall': {
        onItemStarted(item, null)
        const ok = item.status === 'completed' && !item.error && item.success !== false
        const output = capTail(mcpOutput(item))
        const images = toolImages(item)
        endTool(item.id, ok ? 'ok' : 'error', { ...(ok ? {} : { summary: 'failed' }), ...(output ? { output } : {}), ...(images.length ? { images } : {}) })
        break
      }
      case 'imageView':
        onItemStarted(item, null)
        endTool(item.id, 'ok', item.path ? { images: [{ mime: '', path: String(item.path) }] } : {})
        break
      case 'imageGeneration': {
        onItemStarted(item, null)
        const ok = item.status !== 'failed'
        const image: ToolImage | null = item.savedPath
          ? { mime: '', path: String(item.savedPath) }
          : typeof item.result === 'string' && item.result ? { mime: 'image/png', data: item.result } : null
        endTool(item.id, ok ? 'ok' : 'error', {
          ...(item.revisedPrompt ? { output: String(item.revisedPrompt) } : {}),
          ...(image ? { images: [image] } : {}),
          ...(ok ? {} : { summary: 'failed' }),
        })
        break
      }
    }
  }

  /* ----- server → client ----- */

  const onNotification = (method: string, p: Json) => {
    // Sub-agent threads report on the same connection; only our thread drives this turn.
    if (p?.threadId && threadId && p.threadId !== threadId) return
    // After turn/completed only the commands being stopped still report.
    if (closing && method !== 'item/completed') return

    switch (method) {
      case 'turn/started':
        if (p.turn?.id && !turnId) { turnId = p.turn.id; if (stopRequested) sendInterrupt() }
        break
      case 'item/started':
        onItemStarted(p.item, p.startedAtMs ?? null)
        break
      case 'item/completed':
        onItemCompleted(p.item, p.completedAtMs ?? null)
        break
      case 'item/agentMessage/delta':
      case 'item/plan/delta':
        if (p.delta) { textStreamed.add(p.itemId); emit({ type: 'text-delta', id: p.itemId, text: p.delta }) }
        break
      case 'item/reasoning/summaryPartAdded':
        if (thinking.get(p.itemId)?.streamed) thinkingDelta(p.itemId, '\n\n')
        break
      case 'item/reasoning/summaryTextDelta':
      case 'item/reasoning/textDelta':
        thinkingDelta(p.itemId, p.delta)
        break
      case 'item/commandExecution/outputDelta': {
        if (!openTools.has(p.itemId) || !p.delta) break
        let output = (commandOutput.get(p.itemId) ?? '') + p.delta
        if (output.length > OUTPUT_CAP * 2) output = output.slice(-OUTPUT_CAP)
        commandOutput.set(p.itemId, output)
        emit({ type: 'tool-update', id: p.itemId, output: capTail(output) })
        break
      }
      case 'item/fileChange/patchUpdated':
        syncFileChanges(p.itemId, p.changes)
        break
      case 'serverRequest/resolved': {
        // Settled without us (turn interrupted, or answered by another client).
        for (const [id, a] of approvals) {
          if (a.rpcId === p.requestId) { approvals.delete(id); emit({ type: 'approval-cancelled', id }) }
        }
        break
      }
      case 'error':
        if (!p.willRetry) lastError = p.error
        break
      case 'turn/completed': {
        const turn = p.turn ?? {}
        if (turnId && turn.id && turn.id !== turnId) break
        if (turn.status === 'failed' && !stopRequested) closeTurn('error', describeError(turn.error ?? lastError ?? 'The turn failed.', model))
        else if (turn.status === 'completed' && !interruptSent) closeTurn('done')
        else closeTurn('stopped')
        break
      }
    }
  }

  const askUser = (rpcId: string | number, title: string, command: string, reason: string, respond: (allow: boolean) => Json) => {
    const id = `approval-${rpcId}`
    approvals.set(id, { rpcId, respond })
    emit({ type: 'approval', id, title, command, reason })
  }

  const onServerRequest = (rpcId: string | number, method: string, p: Json) => {
    switch (method) {
      case 'item/commandExecution/requestApproval': {
        const net = p.networkApprovalContext
        const command = p.command ? unwrapCommand(String(p.command)) : net ? `${net.protocol ?? 'network'}://${net.host}` : ''
        const title = net && !p.command
          ? 'Codex wants network access'
          : p.kind === 'writeStdin' ? 'Codex wants to send input to a running command' : 'Codex wants to run a command'
        askUser(rpcId, title, command, String(p.reason ?? ''), allow => ({ decision: allow ? 'accept' : 'decline' }))
        break
      }
      case 'item/fileChange/requestApproval': {
        const tools = fileTools.get(p.itemId)
        const files = tools ? [...tools.keys()].map(path => relPath(path, cwd)).join('\n') : ''
        const outside = p.grantRoot ? `Needs write access to ${p.grantRoot}. ` : ''
        askUser(rpcId, 'Codex wants to edit files', files || 'files in this project', `${outside}${p.reason ?? ''}`.trim(), allow => ({ decision: allow ? 'accept' : 'decline' }))
        break
      }
      case 'item/permissions/requestApproval': {
        const fs = p.permissions?.fileSystem
        const wanted = [
          p.permissions?.network?.enabled ? 'network access' : '',
          ...(fs?.write ?? []).map((path: string) => `write ${path}`),
          ...(fs?.read ?? []).map((path: string) => `read ${path}`),
        ].filter(Boolean).join('\n')
        askUser(rpcId, 'Codex wants more permissions', wanted || 'additional permissions', String(p.reason ?? ''), (allow) => {
          const granted: Json = {}
          if (allow && p.permissions?.network) granted.network = p.permissions.network
          if (allow && fs) granted.fileSystem = fs
          return { permissions: granted, scope: 'turn' }
        })
        break
      }
      case 'mcpServer/elicitation/request': {
        // Codex asks for MCP tool approval through an empty form. Forms with real fields cannot be shown here.
        const fields = p.mode === 'form' ? Object.keys(p.requestedSchema?.properties ?? {}) : null
        if (fields && fields.length === 0) {
          askUser(rpcId, `Codex wants to use the ${p.serverName} tools`, String(p.message ?? p.serverName), '', allow => ({ action: allow ? 'accept' : 'decline', content: allow ? {} : null, _meta: null }))
        }
        else {
          send({ id: rpcId, result: { action: 'decline', content: null, _meta: null } })
        }
        break
      }
      case 'item/tool/requestUserInput':
        send({ id: rpcId, result: { answers: {} } })
        break
      default:
        send({ id: rpcId, error: { code: -32601, message: `Mango does not handle ${method}` } })
    }
  }

  const onLine = (line: string) => {
    if (ended) return
    let msg: Json
    try { msg = JSON.parse(line) }
    catch { return }
    if (!msg || typeof msg !== 'object') return

    if (typeof msg.method === 'string') {
      if (msg.id !== undefined && msg.id !== null) onServerRequest(msg.id, msg.method, msg.params ?? {})
      else onNotification(msg.method, msg.params ?? {})
      return
    }
    const w = waiting.get(msg.id)
    if (!w) return
    waiting.delete(msg.id)
    clearTimeout(w.timer)
    if (msg.error) w.reject(msg.error)
    else w.resolve(msg.result)
  }

  const onExit = (code: number | null) => {
    exited = true
    if (ended) return
    if (closing) return finish(closing.status, closing.error)
    if (stopRequested) return finish('stopped')
    const detail = lastStderr || (lastError ? describeError(lastError, model) : '')
    const how = code === null ? 'was killed' : `exited with code ${code}`
    finish('error', !threadId && /config/i.test(detail)
      ? `Codex could not start: ${detail} Fix ~/.codex/config.toml and try again.`
      : `Codex stopped unexpectedly (${how}).${detail ? ` Last message: ${detail}` : ''}`)
  }

  /* ----- the turn ----- */

  function sendInterrupt() {
    if (interruptSent || ended || !threadId || !turnId) return
    interruptSent = true
    request('turn/interrupt', { threadId, turnId }, 10_000).catch(() => {})
    // The server answers with turn/completed (interrupted). If it does not, stop anyway.
    stopTimer = setTimeout(() => finish('stopped'), 5000)
  }

  const start = async () => {
    try {
      transport = await options.spawn(['app-server'], {
        onLine,
        onStderr: (line) => { const text = cleanStderr(line); if (text) lastStderr = text },
        onExit,
      })
    }
    catch (e: Json) {
      const why = String(e?.message ?? e ?? '').trim()
      return finish('error', `Could not start the Codex CLI${why ? ` (${why})` : ''}. Install it from Settings > Agents, or make sure "codex" is on your PATH.`)
    }
    if (ended) return shutdown()
    if (exited) return

    try {
      await request('initialize', {
        clientInfo: { name: 'mango', title: 'Mango', version: '0.1.0' },
        capabilities: { experimentalApi: true, requestAttestation: false, optOutNotificationMethods: UNUSED_NOTIFICATIONS },
      }, 30_000)
      send({ method: 'initialized' })
      if (stopRequested) return finish('stopped')

      // Asked alongside the thread so a missing sign-in is named as such instead of surfacing as a 401 mid-turn.
      request('account/read', { refreshToken: false }, 30_000)
        .then((r) => { if (r && r.account == null && r.requiresOpenaiAuth) finish('error', SIGN_IN_HINT) })
        .catch(() => {})

      const settings = {
        cwd,
        approvalPolicy: policy.approvalPolicy,
        approvalsReviewer: 'user',
        sandbox: policy.sandbox,
        ...(model && model !== 'default' ? { model } : {}),
      }
      let opened: Json
      let turnModel = model && model !== 'default' ? model : null
      let turnEffort = options.effort || null
      if (options.sessionId) {
        // A resumed thread keeps the model and effort of its last turn. 'default' has to mean Codex's
        // configured model and effort again, so look those up (the answers are local) while the thread loads.
        const configured = turnModel && turnEffort
          ? null
          : Promise.all([
              request('config/read', { includeLayers: false, cwd }, 10_000).catch(() => null),
              request('model/list', {}, 10_000).catch(() => null),
            ]).then(([config, models]) => {
              const list: Json[] = models?.data ?? []
              const model = config?.config?.model ?? list.find(m => m.isDefault)?.model ?? null
              const effort = config?.config?.model_reasoning_effort
                ?? list.find(m => m.model === (turnModel ?? model))?.defaultReasoningEffort ?? null
              return { model, effort }
            })
        try {
          opened = await request('thread/resume', { threadId: options.sessionId, excludeTurns: true, ...settings }, 90_000)
          const defaults = await configured
          if (!turnModel && defaults?.model && defaults.model !== opened.model) turnModel = defaults.model
          if (!turnEffort && defaults?.effort) turnEffort = defaults.effort
        }
        catch (e: Json) {
          if (ended) return
          const why = String(e?.message ?? '').trim()
          if (/no rollout|not found|no such|does not exist|invalid thread/i.test(why)) {
            return finish(stopRequested ? 'stopped' : 'error', `Codex no longer has this conversation on disk (session ${options.sessionId}). Start a new thread to continue.`)
          }
          throw e
        }
      }
      else {
        opened = await request('thread/start', settings, 90_000)
      }
      if (ended) return
      threadId = String(opened.thread.id)
      emit({ type: 'session', sessionId: threadId })
      if (stopRequested) return finish('stopped')

      turnRequested = true
      const started = await request('turn/start', {
        threadId,
        input: turnInput(options),
        approvalPolicy: policy.approvalPolicy,
        approvalsReviewer: 'user',
        // Reasoning summaries are what the thinking block shows; without this Codex sends none.
        summary: 'auto',
        ...(turnModel ? { model: turnModel } : {}),
        ...(turnEffort ? { effort: turnEffort } : {}),
      }, 60_000)
      if (ended) return
      if (!turnId && started?.turn?.id) turnId = started.turn.id
      if (stopRequested) sendInterrupt()
    }
    catch (e: Json) {
      fail(e)
    }
  }

  start().catch(e => fail(e))

  return {
    async steer(input) {
      // Before Codex named the turn, or once it is over, there is nothing to add to.
      if (ended || closing || stopRequested || !threadId || !turnId) return false
      try {
        await request('turn/steer', { threadId, input: turnInput(input), expectedTurnId: turnId }, 15_000)
        return !stopRequested
      }
      catch {
        return false
      }
    },
    respondApproval(id, allow) {
      const approval = approvals.get(id)
      if (!approval || ended) return
      approvals.delete(id)
      send({ id: approval.rpcId, result: approval.respond(allow) })
    },
    interrupt() {
      if (ended || stopRequested || closing) return
      stopRequested = true
      if (turnId) sendInterrupt()
      // Nothing is running on Codex's side yet: just stop. (With turn/start on its way, the interrupt follows its answer.)
      else if (!turnRequested) finish('stopped')
    },
  }
}

/**
 * Codex's own model list (`model/list` on a short-lived app-server): the models the
 * signed-in account can use and the reasoning efforts each accepts. No turn is started.
 */
function listModels(spawn: SpawnFn): Promise<AgentModel[]> {
  return new Promise((resolve, reject) => {
    let transport: AgentTransport | null = null
    let done = false
    let nextId = 1
    const pending = new Map<number, (result: Json, error?: Json) => void>()
    const finish = (models: AgentModel[] | null, why?: string) => {
      if (done) return
      done = true
      clearTimeout(timer)
      transport?.kill().catch(() => {})
      if (models) resolve(models)
      else reject(new Error(why ?? 'Codex did not list its models.'))
    }
    const timer = setTimeout(() => finish(null, 'Codex took too long to list its models.'), 30_000)
    const request = (method: string, params: Json) => new Promise<Json>((ok, fail) => {
      const id = nextId++
      pending.set(id, (result, error) => (error ? fail(new Error(String(error?.message ?? error))) : ok(result)))
      transport?.write(JSON.stringify({ id, method, params })).catch(fail)
    })

    async function list() {
      await request('initialize', { clientInfo: { name: 'mango', title: 'Mango', version: '0.1.0' }, capabilities: { experimentalApi: true } })
      await transport?.write(JSON.stringify({ method: 'initialized' }))
      const all: Json[] = []
      let cursor: string | null = null
      for (let page = 0; page < 10; page++) {
        const res: Json = await request('model/list', cursor ? { cursor } : {})
        all.push(...(res?.data ?? []))
        cursor = res?.nextCursor ?? null
        if (!cursor) break
      }
      const efforts = (m: Json): string[] => (m?.supportedReasoningEfforts ?? []).map((e: Json) => String(e?.reasoningEffort ?? e)).filter(Boolean)
      const fallback = all.find(m => m.isDefault)
      const models: AgentModel[] = [{
        id: 'default',
        label: 'Default',
        hint: fallback ? `Codex's choice: ${fallback.displayName ?? fallback.model}` : 'Whatever Codex is configured to use',
        efforts: fallback ? efforts(fallback) : [],
        defaultEffort: fallback?.defaultReasoningEffort ?? undefined,
      }]
      for (const m of all) {
        if (m.hidden || typeof m.model !== 'string') continue
        models.push({
          id: m.model,
          label: String(m.displayName ?? m.model),
          hint: m.description || undefined,
          efforts: efforts(m),
          defaultEffort: m.defaultReasoningEffort ?? undefined,
        })
      }
      finish(models)
    }

    spawn(['app-server'], {
      onLine(line) {
        let m: Json
        try { m = JSON.parse(line) } catch { return }
        if (typeof m?.id !== 'number' || !pending.has(m.id) || m.method) return
        const settle = pending.get(m.id)!
        pending.delete(m.id)
        settle(m.result, m.error)
      },
      onExit: () => finish(null, 'Codex exited before listing its models.'),
    }).then((t) => {
      transport = t
      if (done) { t.kill().catch(() => {}); return }
      list().catch(e => finish(null, e instanceof Error ? e.message : String(e)))
    }).catch(err => finish(null, err instanceof Error ? err.message : String(err)))
  })
}

export const codexAdapter: AgentAdapter = { id: 'codex', run, listModels }

export default codexAdapter
