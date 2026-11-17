import type { AgentId } from '~/types/chat'
import type { AgentTransport, SpawnFn, SpawnHandlers } from '~/agents/types'
import { parseEnvPath } from '~/utils/envPath'

/**
 * A fake agent CLI for the web preview (and tests): it speaks just enough of Claude Code's
 * `stream-json` and of `codex app-server`'s JSON-RPC that the real adapters (`~/agents/claude`,
 * `~/agents/codex`) turn it into a believable reply, labelled "Simulated": some thinking, streamed
 * text, a file read, an edit with a diff (asked for first in "ask" mode, skipped in "plan" mode),
 * and a closing message. Messages steered in mid-turn are acknowledged; interrupting stops it.
 * A Claude prompt that mentions "background" also starts two background commands, which outlive
 * the reply (the run waits for them, their output can be read and each can be stopped) and are
 * answered with a short follow-up once both are over.
 *
 * The line formats are the ones the adapters parse (see the protocol notes at the top of
 * `app/agents/claude.ts` and `app/agents/codex.ts`); nothing here runs anything.
 */

export interface SimulatedOptions {
  /** Milliseconds between streamed chunks. 0 in tests. */
  pace?: number
}

type Json = any

/** The made-up project the reply talks about. */
const FILE_READ = 'README.md'
const FILE_EDIT = 'src/index.ts'
const OLD_LINE = 'const greeting = \'Hello\''
const NEW_LINE = 'const greeting = \'Hello from Mango\''
const README = '# Example project\n\nA small app used by the simulated agent.\n'

const chunks = (text: string) => text.match(/\S+\s*|\s+/g) ?? [text]
const brief = (text: string) => {
  const line = text.trim().split('\n')[0] ?? ''
  return line.length > 80 ? `${line.slice(0, 79)}…` : line
}

function promptText(content: unknown): string {
  if (typeof content === 'string') return content
  return Array.isArray(content) ? content.map(c => (c?.type === 'text' ? String(c.text ?? '') : '')).join('') : ''
}

/** What the simulated agent says. */
function script(prompt: string) {
  return {
    thinking: `Simulated thinking: the request is “${brief(prompt) || 'the attached files'}”. There is no real agent here, so I'll show what a turn looks like.`,
    intro: '**Simulated reply.** This preview has no connection to an environment, so no agent ran and nothing below happened. ',
    done: (steered: string[], edited: 'yes' | 'denied' | 'plan') => [
      edited === 'yes' ? `Done (simulated): the greeting in \`${FILE_EDIT}\` now says hello from Mango.`
        : edited === 'denied' ? 'You declined the edit (simulated), so nothing changed.'
        : `Plan mode (simulated): I would change the greeting in \`${FILE_EDIT}\`; nothing was edited.`,
      ...(steered.length ? [`You also said: “${steered.map(brief).join('”, “')}”.`] : []),
    ].join(' '),
  }
}

/** The background commands a "background" prompt starts: how long each runs (in paces) and what it prints. */
const BACKGROUND = [
  {
    tool: 'toolu_sim_bg_test',
    task: 'sim_task_test',
    command: 'pnpm test',
    description: 'Run the test suite',
    paces: 260,
    summary: '42 tests passed',
    lines: [' RUN  v3.2.4 /home/agent/project', ' ✓ src/index.test.ts (6 tests) 38ms', ' ✓ src/routes.test.ts (21 tests) 412ms', ' ✓ src/cart.test.ts (15 tests) 96ms', '', ' Test Files  3 passed (3)', '      Tests  42 passed (42)'],
  },
  {
    tool: 'toolu_sim_bg_build',
    task: 'sim_task_build',
    command: 'pnpm build',
    description: 'Build for production',
    paces: 700,
    summary: 'built in 24s',
    lines: ['> project@0.1.0 build', '> vite build', '', 'vite v7.1.3 building for production...', 'transforming...', '✓ 214 modules transformed.', 'rendering chunks...', 'dist/index.html   0.46 kB', 'dist/assets/index.js  148.20 kB │ gzip: 47.61 kB', '✓ built in 24.08s'],
  },
] as const

/** A process that is only a script: lines out, lines in, an exit. */
function processOf(handlers: SpawnHandlers, pace: number) {
  let exited = false
  const proc = {
    alive: () => !exited,
    out(obj: Json) { if (!exited) handlers.onLine(JSON.stringify(obj)) },
    exit(code: number | null) {
      if (exited) return
      exited = true
      handlers.onExit?.(code)
    },
    wait: (ms = pace) => new Promise<void>(r => setTimeout(r, ms)),
  }
  return proc
}

export function simulatedSpawn(agent: AgentId, projectPath: string, options: SimulatedOptions = {}): SpawnFn {
  const dir = (parseEnvPath(projectPath)?.dir ?? projectPath).replace(/\/+$/, '') || '/'
  const pace = options.pace ?? 35
  return async (args, handlers) => (agent === 'codex' || args.includes('app-server')
    ? codexProcess(dir, handlers, pace)
    : claudeProcess(dir, args, handlers, pace))
}

/* ------------------------------------------------------------------ */
/* Claude Code: stream-json                                            */
/* ------------------------------------------------------------------ */

function claudeProcess(dir: string, args: string[], handlers: SpawnHandlers, pace: number): AgentTransport {
  const p = processOf(handlers, pace)
  const flag = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined }
  const mode = flag('--permission-mode') ?? 'default'
  const sessionId = flag('--resume') ?? `sim-${Math.random().toString(36).slice(2, 10)}`
  let started = false
  let interrupted = false
  const steered: string[] = []
  const decisions = new Map<string, (allow: boolean) => void>()
  let seq = 0
  /** Background commands still running, by task id. */
  const background = new Map<string, { spec: typeof BACKGROUND[number]; startedAt: number; timer?: ReturnType<typeof setTimeout> }>()
  const outcomes: string[] = []
  let answered = false
  let followedUp = false

  /** Stream one content block of an assistant message, as `--include-partial-messages` does. */
  async function block(index: number, b: Json, deltas: Json[]) {
    p.out({ type: 'stream_event', event: { type: 'content_block_start', index, content_block: b } })
    for (const delta of deltas) {
      if (interrupted) break
      await p.wait()
      p.out({ type: 'stream_event', event: { type: 'content_block_delta', index, delta } })
    }
    p.out({ type: 'stream_event', event: { type: 'content_block_stop', index } })
  }

  async function message(content: Json[]) {
    const id = `sim_msg_${++seq}`
    p.out({ type: 'stream_event', event: { type: 'message_start', message: { id, role: 'assistant' } } })
    let i = 0
    for (const b of content) {
      if (interrupted) break
      if (b.type === 'thinking') await block(i, { type: 'thinking', thinking: '' }, chunks(b.thinking).map(t => ({ type: 'thinking_delta', thinking: t })))
      else if (b.type === 'text') await block(i, { type: 'text', text: '' }, chunks(b.text).map(t => ({ type: 'text_delta', text: t })))
      else if (b.type === 'tool_use') await block(i, { type: 'tool_use', id: b.id, name: b.name, input: {} }, [{ type: 'input_json_delta', partial_json: JSON.stringify(b.input) }])
      i++
    }
    p.out({ type: 'assistant', message: { id, role: 'assistant', content } })
  }

  const toolResult = (id: string, content: string, extra: Json = {}, isError = false) =>
    p.out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, ...(isError ? { is_error: true } : {}) }] }, ...extra })

  const finish = (text: string) => {
    if (interrupted) p.out({ type: 'result', subtype: 'error_during_execution', is_error: true, session_id: sessionId })
    else p.out({ type: 'result', subtype: 'success', is_error: false, session_id: sessionId, result: text })
    if (interrupted || answered) return
    answered = true
    // The background commands run on after the reply, as real ones do.
    for (const [id, t] of background) t.timer = setTimeout(() => endTask(id, 'completed'), t.spec.paces * pace)
  }

  /** A background command ended: its notification, and once none is left, Claude Code's own answer to them. */
  function endTask(id: string, status: 'completed' | 'killed') {
    const t = background.get(id)
    if (!t || !p.alive()) return
    clearTimeout(t.timer)
    background.delete(id)
    const summary = status === 'completed' ? t.spec.summary : undefined
    outcomes.push(`\`${t.spec.command}\` ${status === 'completed' ? `finished (${t.spec.summary})` : 'was stopped'}`)
    p.out({ type: 'system', subtype: 'task_notification', task_id: id, status, ...(summary ? { summary } : {}) })
    if (!background.size && answered && !interrupted && !followedUp) {
      followedUp = true
      void followUp()
    }
  }

  async function followUp() {
    await p.wait()
    if (!p.alive() || interrupted) return
    p.out({ type: 'system', subtype: 'init', session_id: sessionId, model: 'simulated', permissionMode: mode })
    const text = `The background work is over (simulated): ${outcomes.join(', ')}.`
    await message([{ type: 'text', text }])
    finish(text)
  }

  /** What a background command has printed so far. */
  function taskOutput(id: string): string | null {
    const t = background.get(id)
    if (!t) return null
    const share = pace ? Math.min(1, (Date.now() - t.startedAt) / (t.spec.paces * pace)) : 1
    return t.spec.lines.slice(0, Math.max(1, Math.ceil(t.spec.lines.length * share))).join('\n')
  }

  /** Two commands sent to the background, as `Bash` with `run_in_background` does. */
  async function startBackground() {
    await message(BACKGROUND.map(b => ({ type: 'tool_use', id: b.tool, name: 'Bash', input: { command: b.command, description: b.description, run_in_background: true } })))
    if (interrupted) return
    for (const b of BACKGROUND) {
      toolResult(b.tool, `Command running in background with ID: ${b.task}`)
      background.set(b.task, { spec: b, startedAt: Date.now() })
      p.out({ type: 'system', subtype: 'task_started', task_id: b.task, tool_use_id: b.tool, task_type: 'local_bash', description: b.description, is_backgrounded: true })
    }
    await p.wait()
  }

  async function turn(prompt: string) {
    const say = script(prompt)
    p.out({ type: 'system', subtype: 'init', session_id: sessionId, model: 'simulated', permissionMode: mode })
    await p.wait()
    const read = { type: 'tool_use', id: 'toolu_sim_read', name: 'Read', input: { file_path: `${dir}/${FILE_READ}` } }
    await message([{ type: 'thinking', thinking: say.thinking }, { type: 'text', text: say.intro }, read])
    if (interrupted) return finish('')
    toolResult(read.id, README, { tool_use_result: { file: { filePath: read.input.file_path, numLines: README.split('\n').length } } })
    await p.wait()
    if (/background/i.test(prompt)) {
      await startBackground()
      if (interrupted) return finish('')
    }

    let edited: 'yes' | 'denied' | 'plan' = 'plan'
    if (mode !== 'plan') {
      const edit = { type: 'tool_use', id: 'toolu_sim_edit', name: 'Edit', input: { file_path: `${dir}/${FILE_EDIT}`, old_string: OLD_LINE, new_string: NEW_LINE } }
      await message([edit])
      if (interrupted) return finish('')
      let allow = true
      if (mode === 'default') {
        // `--permission-prompt-tool stdio`: Claude Code asks before an edit in the default mode.
        const requestId = 'sim-perm-edit'
        allow = await new Promise<boolean>((resolve) => {
          decisions.set(requestId, resolve)
          p.out({ type: 'control_request', request_id: requestId, request: { subtype: 'can_use_tool', tool_name: 'Edit', input: edit.input, tool_use_id: edit.id } })
        })
        if (interrupted) return finish('')
      }
      if (allow) toolResult(edit.id, `The file ${edit.input.file_path} has been updated.`)
      else toolResult(edit.id, 'The user denied this request.', {}, true)
      edited = allow ? 'yes' : 'denied'
      await p.wait()
    }
    const text = say.done(steered, edited) + (background.size ? ' The tests and the build go on in the background; I\'ll look at them when they finish.' : '')
    await message([{ type: 'text', text }])
    finish(text)
  }

  function onMessage(m: Json) {
    if (m.type === 'control_request') {
      const sub = m.request?.subtype
      if (sub === 'interrupt') {
        interrupted = true
        // A permission request still open is settled by the stop.
        for (const resolve of decisions.values()) resolve(false)
        decisions.clear()
      }
      if (sub === 'stop_task') setTimeout(() => endTask(String(m.request?.task_id ?? ''), 'killed'), 0)
      const output = sub === 'get_task_output' ? taskOutput(String(m.request?.task_id ?? '')) : null
      const response = sub === 'initialize'
        ? { commands: [], models: [{ value: 'default', displayName: 'Default', description: 'Simulated' }] }
        : output !== null ? { output } : {}
      p.out({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response } })
      return
    }
    if (m.type === 'control_response') {
      const id = m.response?.request_id
      const decide = decisions.get(id)
      if (decide) { decisions.delete(id); decide(m.response?.response?.behavior === 'allow') }
      return
    }
    if (m.type === 'user') {
      // `--replay-user-messages`: every message is echoed when the CLI reads it.
      p.out({ ...m, isReplay: true })
      const text = promptText(m.message?.content)
      if (!started) { started = true; void turn(text) }
      else steered.push(text)
    }
  }

  return {
    async write(line) {
      let m: Json
      try { m = JSON.parse(line) } catch { return }
      setTimeout(() => { if (p.alive()) onMessage(m) }, 0)
    },
    async closeStdin() { setTimeout(() => p.exit(0), 0) },
    async kill() { p.exit(null) },
  }
}

/* ------------------------------------------------------------------ */
/* Codex: app-server JSON-RPC                                          */
/* ------------------------------------------------------------------ */

function codexProcess(dir: string, handlers: SpawnHandlers, pace: number): AgentTransport {
  const p = processOf(handlers, pace)
  let threadId = `sim-thread-${Math.random().toString(36).slice(2, 10)}`
  let approvalPolicy = 'untrusted'
  let sandbox = 'workspace-write'
  let turnSeq = 0
  let turnId = ''
  let interrupted = false
  const steered: string[] = []
  /** Our requests to the client (approvals), by id. */
  const asked = new Map<string, (result: Json) => void>()
  let reqSeq = 0

  const notify = (method: string, params: Json) => p.out({ method, params: { threadId, ...params } })
  const now = () => Date.now()

  async function item(started: Json, deltas: Array<[string, Json]>, completed: Json) {
    notify('item/started', { turnId, item: started, startedAtMs: now() })
    for (const [method, params] of deltas) {
      if (interrupted) break
      await p.wait()
      notify(method, { turnId, itemId: started.id, ...params })
    }
    notify('item/completed', { turnId, item: completed, completedAtMs: now() })
  }

  const textItem = (id: string, text: string) =>
    item({ type: 'agentMessage', id, text: '' }, chunks(text).map(delta => ['item/agentMessage/delta', { delta }]), { type: 'agentMessage', id, text })

  async function turn(prompt: string) {
    const say = script(prompt)
    notify('turn/started', { turn: { id: turnId, status: 'inProgress' } })
    await p.wait()
    await item({ type: 'reasoning', id: 'rs_sim_1', summary: [], content: [] },
      chunks(say.thinking).map(delta => ['item/reasoning/summaryTextDelta', { delta, summaryIndex: 0 }]),
      { type: 'reasoning', id: 'rs_sim_1', summary: [say.thinking], content: [] })
    if (!interrupted) await textItem('msg_sim_1', say.intro)
    if (!interrupted) {
      const path = `${dir}/${FILE_READ}`
      const cmd = { type: 'commandExecution', id: 'cmd_sim_read', command: `/bin/bash -lc 'cat ${FILE_READ}'`, cwd: dir, commandActions: [{ type: 'read', command: `cat ${FILE_READ}`, name: FILE_READ, path }] }
      await item({ ...cmd, status: 'inProgress' }, [['item/commandExecution/outputDelta', { delta: README }]],
        { ...cmd, status: 'completed', exitCode: 0, aggregatedOutput: README, durationMs: 12 })
    }
    let edited: 'yes' | 'denied' | 'plan' = 'plan'
    if (!interrupted && sandbox !== 'read-only') {
      const changes = [{ path: `${dir}/${FILE_EDIT}`, kind: { type: 'update', move_path: null }, diff: `@@ -1,3 +1,3 @@\n import { start } from './app'\n-${OLD_LINE}\n+${NEW_LINE}\n start(greeting)\n` }]
      notify('item/started', { turnId, item: { type: 'fileChange', id: 'fc_sim_1', changes, status: 'inProgress' }, startedAtMs: now() })
      let allow = true
      if (approvalPolicy === 'untrusted') {
        const id = `sim-req-${++reqSeq}`
        const result = await new Promise<Json>((resolve) => {
          asked.set(id, resolve)
          p.out({ id, method: 'item/fileChange/requestApproval', params: { threadId, turnId, itemId: 'fc_sim_1', reason: 'Simulated edit' } })
        })
        allow = result?.decision === 'accept'
      }
      edited = allow ? 'yes' : 'denied'
      notify('item/completed', { turnId, item: { type: 'fileChange', id: 'fc_sim_1', changes, status: interrupted ? 'failed' : allow ? 'completed' : 'declined' }, completedAtMs: now() })
    }
    // A message steered in by now is read before the last reply.
    await p.wait()
    if (!interrupted) await textItem('msg_sim_2', say.done(steered, edited))
    notify('turn/completed', { turn: { id: turnId, status: interrupted ? 'interrupted' : 'completed' } })
  }

  function answer(id: Json, method: string, params: Json) {
    const ok = (result: Json) => p.out({ id, result })
    switch (method) {
      case 'initialize': return ok({ userAgent: 'mango-simulated/0' })
      case 'account/read': return ok({ account: { type: 'chatgpt', email: null, planType: null }, requiresOpenaiAuth: false })
      case 'config/read': return ok({ config: {} })
      case 'model/list': return ok({ data: [{ id: 'simulated', model: 'simulated', displayName: 'Simulated', isDefault: true, supportedReasoningEfforts: [] }] })
      case 'skills/list': return ok({ data: [] })
      case 'thread/start':
      case 'thread/resume':
        if (method === 'thread/resume' && typeof params.threadId === 'string') threadId = params.threadId
        if (params.approvalPolicy) approvalPolicy = params.approvalPolicy
        if (params.sandbox) sandbox = params.sandbox
        return ok({ thread: { id: threadId }, model: 'simulated' })
      case 'turn/start': {
        if (params.approvalPolicy) approvalPolicy = params.approvalPolicy
        turnId = `sim-turn-${++turnSeq}`
        ok({ turn: { id: turnId, status: 'inProgress', items: [] } })
        const text = (Array.isArray(params.input) ? params.input : []).map((x: Json) => (x?.type === 'text' ? String(x.text ?? '') : '')).join('')
        void turn(text)
        return
      }
      case 'turn/steer': {
        steered.push((Array.isArray(params.input) ? params.input : []).map((x: Json) => (x?.type === 'text' ? String(x.text ?? '') : '')).join(''))
        return ok({ turnId })
      }
      case 'turn/interrupt':
        interrupted = true
        ok({})
        // An approval still open is settled by the stop.
        for (const [reqId, resolve] of asked) { notify('serverRequest/resolved', { requestId: reqId }); resolve(null) }
        asked.clear()
        return
      case 'thread/backgroundTerminals/clean': return ok({})
      default:
        p.out({ id, error: { code: -32601, message: `The simulated Codex does not do ${method}.` } })
    }
  }

  function onMessage(m: Json) {
    if (typeof m.method === 'string') {
      if (m.id !== undefined && m.id !== null) answer(m.id, m.method, m.params ?? {})
      return // notifications (`initialized`) need no answer
    }
    const resolve = asked.get(m.id)
    if (resolve) { asked.delete(m.id); resolve(m.result) }
  }

  return {
    async write(line) {
      let m: Json
      try { m = JSON.parse(line) } catch { return }
      setTimeout(() => { if (p.alive()) onMessage(m) }, 0)
    },
    async closeStdin() { setTimeout(() => p.exit(0), 0) },
    async kill() { p.exit(null) },
  }
}
