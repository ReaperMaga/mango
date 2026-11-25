/**
 * Drive an agent adapter against the real CLI, outside the app.
 *
 *   node scripts/try-agent.ts <claude|codex> <cwd> "<prompt>" [--mode ask|plan|edits|auto]
 *        [--model id] [--effort level] [--session id] [--image file.png] [--deny] [--dismiss] [--interrupt-after ms]
 *        [--steer "<text>" [--steer-after ms]] [--then "<text>" [--then-after ms] [--no-keep] [--between "<text>"] [--then-model id] [--then-effort level] [--then-file path]] [--task-output-after ms] [--stop-task-after ms] [--mcp servers.json] [--raw]
 *   node scripts/try-agent.ts <claude|codex> <cwd> --models [--raw]
 *   node scripts/try-agent.ts <claude|codex> <cwd> --usage [--raw]
 *   node scripts/try-agent.ts <claude|codex> <cwd> --commands [--raw]
 *   node scripts/try-agent.ts claude <cwd> --context <session id> [--model id] [--raw]
 *
 * Prints every AgentEvent as one JSON line (text deltas are coalesced).
 * Approvals are allowed automatically unless --deny is given; questions get their first option unless --dismiss is.
 * --models prints the CLI's model list (no turn, no quota) instead of running a prompt.
 * --usage prints the plan's usage limits (5-hour, weekly, …), also without a turn.
 * --commands prints the slash commands the composer offers for <cwd>, also without a turn.
 * --context prints how full a conversation's context window is, also without a turn (run it in the
 * conversation's own folder; Claude Code only).
 * --image attaches a PNG, JPEG, GIF or WebP the way the app does (inline for Claude, by path for Codex).
 * --steer sends another message while the turn runs (after --steer-after ms, default 3000), as typing during a run does.
 * --then sends a second turn --then-after ms (default 1000) after the first, in the process kept from it, as the app
 *  does for a chat's next message; with --no-keep a new process resumes the session instead. --between first sends
 *  a message to the same session from a `claude -p --resume` of its own, as someone in a terminal would (Claude Code only).
 *  --then-model and --then-effort give the second turn another model or effort; --then-file attaches a file to it by path.
 * --task-output-after reads each background task's output that long after it starts (no quota);
 * --stop-task-after stops each background task that long after it starts.
 * --mcp hands the run MCP servers as Settings > MCP servers would: a JSON array of AgentMcpServer
 * (app/agents/types.ts), e.g. [{"name":"x","transport":"stdio","command":"node","args":["s.js"],"env":{}}].
 * --raw also prints the CLI's own stdout lines (prefixed "<<") and stdin writes (">>").
 */
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { KeptProcesses } from '../app/agents/keeper.ts'
import { attachmentNote } from '../app/utils/attachments.ts'

const [agentId, cwd, prompt, ...rest] = process.argv.slice(2)
if (!agentId || !cwd || (!prompt && !['--models', '--usage', '--commands', '--context'].some(f => process.argv.includes(f)))) {
  console.error('usage: node scripts/try-agent.ts <claude|codex> <cwd> "<prompt>" [flags]')
  process.exit(2)
}
const flag = (name: string) => { const i = rest.indexOf(`--${name}`); return i >= 0 ? rest[i + 1] : undefined }
const has = (name: string) => rest.includes(`--${name}`)
const raw = has('raw')

const mod = await import(`../app/agents/${agentId}.ts`)
const adapter = mod.default ?? mod[`${agentId}Adapter`]
if (!adapter?.run) throw new Error(`app/agents/${agentId}.ts must export the adapter as default or ${agentId}Adapter`)

let pendingText = ''
const flush = () => { if (pendingText) { console.log(JSON.stringify({ type: 'text-delta(coalesced)', text: pendingText })); pendingText = '' } }

const spawnCli = async (args: string[], handlers: any, env?: Record<string, string>) => {
    if (raw) console.log('$$', agentId, args.join(' '))
    const p = spawn(agentId, args, { cwd, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] })
    const lines = (stream: NodeJS.ReadableStream, cb?: (l: string) => void, tag = '<<') => {
      let buf = ''
      stream.on('data', (d) => {
        buf += d
        let i
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).replace(/\r$/, ''); buf = buf.slice(i + 1)
          if (!line) continue
          if (raw) console.log(tag, line.length > 2000 ? `${line.slice(0, 2000)}…` : line)
          cb?.(line)
        }
      })
    }
    lines(p.stdout!, handlers.onLine)
    lines(p.stderr!, handlers.onStderr, '!!')
    p.on('exit', code => handlers.onExit?.(code))
    return {
      write: async (line: string) => { if (raw) console.log('>>', line); p.stdin!.write(`${line}\n`) },
      closeStdin: async () => { p.stdin!.end() },
      kill: async () => { p.kill('SIGTERM') },
    }
}

if (prompt === '--models' || has('models')) {
  const models = await adapter.listModels(spawnCli)
  for (const m of models) console.log(JSON.stringify(m))
  process.exit(0)
}

if (prompt === '--commands' || has('commands')) {
  for (const c of await adapter.listCommands(spawnCli, resolve(cwd))) console.log(JSON.stringify(c))
  process.exit(0)
}

if (prompt === '--usage' || has('usage')) {
  console.log(JSON.stringify(await adapter.readUsage(spawnCli), null, 2))
  process.exit(0)
}

const contextOf = prompt === '--context' ? rest[0] : flag('context')
if (contextOf) {
  if (!adapter.readContext) throw new Error(`${agentId} cannot report the context window without a turn.`)
  console.log(JSON.stringify(await adapter.readContext(spawnCli, contextOf, flag('model') ?? 'default'), null, 2))
  process.exit(0)
}

const imagePath = flag('image') ? resolve(flag('image')!) : null
const imageMime: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' }
const images = imagePath
  ? [{ name: basename(imagePath), path: imagePath, mime: imageMime[extname(imagePath).toLowerCase()] ?? 'image/png', data: readFileSync(imagePath).toString('base64') }]
  : []

const thenFile = flag('then-file') ? resolve(flag('then-file')!) : null

// One chat's process, kept from the first turn to the --then turn.
const kept = has('no-keep') ? null : new KeptProcesses()
let session: string | null = flag('session') ?? null
let then = flag('then')

/** The app's `agent_transcript`, without its cuts. */
const readTranscript = async (id: string) => {
  const projects = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects')
  const file = readdirSync(projects).map(d => join(projects, d, `${id}.jsonl`)).find(f => existsSync(f))
  return file ? { lines: readFileSync(file, 'utf8').split('\n').slice(0, -1), whole: true } : null
}

const turn = (prompt: string, second = false) => adapter.run({
  cwd,
  prompt: second && thenFile ? `${prompt}\n\n${attachmentNote([{ name: basename(thenFile), path: thenFile }])}` : prompt,
  images,
  readDirs: second && thenFile ? [dirname(thenFile)] : [],
  model: (second && flag('then-model')) || flag('model') || 'default',
  mode: flag('mode') ?? 'ask',
  effort: (second && flag('then-effort')) || flag('effort') || null,
  sessionId: session,
  ...(kept ? { keeper: kept.keeperFor({ chat: 'try', agent: agentId, folder: cwd }, '', () => ''), readTranscript } : {}),
  ...(flag('mcp') ? { mcpServers: JSON.parse(readFileSync(resolve(flag('mcp')!), 'utf8')) } : {}),
  spawn: spawnCli,
  emit(event: any) {
    if (event.type === 'text-delta') { pendingText += event.text; return }
    flush()
    console.log(JSON.stringify(event))
    if (event.type === 'session') session = event.sessionId
    if (event.type === 'approval') setTimeout(() => run.respondApproval(event.id, !has('deny')), 300)
    // Questions get each one's first option (or "42" where there are none), unless --dismiss.
    if (event.type === 'question') {
      setTimeout(() => run.answerQuestion?.(event.id, has('dismiss') ? null : event.questions.map(q => [q.options[0]?.label ?? '42'])), 300)
    }
    if (event.type === 'turn-end') {
      const next = then
      then = undefined
      if (next) {
        setTimeout(() => {
          const between = flag('between')
          if (between && session) {
            const answer = execFileSync('claude', ['-p', '--resume', session, '--model', flag('model') ?? 'default', between], { cwd, encoding: 'utf8' })
            console.log('-- between:', answer.trim())
          }
          console.log('-- then', kept?.size ? '(a process is kept)' : '(no process is kept)')
          run = turn(next, true)
        }, Number(flag('then-after')) || 1000)
      }
      else setTimeout(async () => { await kept?.release(() => true); process.exit(0) }, 1500)
    }
    if (event.type === 'task-start') {
      const id = event.id
      const readAfter = Number(flag('task-output-after'))
      if (readAfter) setTimeout(async () => console.log('-- task output', id, JSON.stringify(await run.taskOutput?.(id))), readAfter)
      const stopAfter = Number(flag('stop-task-after'))
      if (stopAfter) setTimeout(() => { console.log('-- stop task', id); run.stopTask?.(id) }, stopAfter)
    }
  },
})
let run = turn(prompt)

const steer = flag('steer')
if (steer) {
  setTimeout(async () => {
    if (!run.steer) return console.log('-- steer: this adapter cannot steer')
    console.log(`-- steer: ${await run.steer({ prompt: steer, images: [], readDirs: [] }) ? 'taken' : 'refused (would be the next turn)'}`)
  }, Number(flag('steer-after')) || 3000)
}

const after = Number(flag('interrupt-after'))
if (after) setTimeout(() => { console.log('-- interrupt'); run.interrupt() }, after)
setTimeout(() => { console.error('-- harness timeout'); process.exit(1) }, 180_000)
