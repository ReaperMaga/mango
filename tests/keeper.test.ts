/**
 * CLI processes kept between a chat's turns: the keeper itself, and the Claude Code adapter using one
 * against a fake CLI. Plain Node, no dependencies:
 *
 *   node --test tests/keeper.test.ts      (or: pnpm test)
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { AgentEvent, AgentRunOptions, KeptProcess } from '../app/agents/types.ts'
import { KeptProcesses } from '../app/agents/keeper.ts'
import { claudeAdapter } from '../app/agents/claude.ts'

const wait = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms))

/** A process that ends when its input closes (unless `stuck`), and what was done to it. */
function fakeProcess(stuck = false) {
  const did: string[] = []
  const p: KeptProcess & { did: string[] } = {
    did,
    handlers: { onLine: () => {} },
    readDirs: [],
    costUsd: 0,
    wakes: line => line === 'wake',
    transport: {
      async write() {},
      async closeStdin() { did.push('close'); if (!stuck) p.handlers.onExit?.(0) },
      async kill() { did.push('kill') },
    },
  }
  return p
}
const owner = (chat: string, folder = '/p') => ({ chat, agent: 'claude', folder })
const fits = () => true

test('a process is taken back once, under the key and stamp it was kept with', () => {
  const kept = new KeptProcesses()
  const p = fakeProcess()
  kept.keeperFor(owner('a'), 'm1', () => 'm2').keep('k', p)
  assert.equal(kept.keeperFor(owner('b'), 'm2', () => '').take('k', fits), null)
  assert.equal(kept.keeperFor(owner('a'), 'm2', () => '').take('k', fits), p)
  assert.equal(kept.keeperFor(owner('a'), 'm2', () => '').take('k', fits), null)
  assert.deepEqual(p.did, [])
})

test('another key, another stamp or a process that does not fit is closed', () => {
  for (const [stamp, key, fit] of [['m2', 'other', fits], ['m9', 'k', fits], ['m2', 'k', () => false]] as const) {
    const kept = new KeptProcesses()
    const p = fakeProcess()
    kept.keeperFor(owner('a'), '', () => 'm2').keep('k', p)
    assert.equal(kept.keeperFor(owner('a'), stamp, () => '').take(key, fit), null)
    assert.deepEqual(p.did, ['close'])
    assert.equal(kept.size, 0)
  }
})

test('a chat that is gone keeps nothing', () => {
  const kept = new KeptProcesses()
  const p = fakeProcess()
  kept.keeperFor(owner('a'), '', () => null).keep('k', p)
  assert.deepEqual(p.did, ['close'])
  assert.equal(kept.size, 0)
})

test('it goes after idling, and the one idle longest makes room', async () => {
  const kept = new KeptProcesses({ keepMs: 20, max: 2 })
  const [a, b, c] = [fakeProcess(), fakeProcess(), fakeProcess()]
  kept.keeperFor(owner('a'), '', () => '').keep('k', a)
  kept.keeperFor(owner('b'), '', () => '').keep('k', b)
  kept.keeperFor(owner('c'), '', () => '').keep('k', c)
  assert.deepEqual([a.did, b.did, c.did], [['close'], [], []])
  await wait(80)
  assert.deepEqual([b.did, c.did], [['close'], ['close']])
  assert.equal(kept.size, 0)
})

test('one that starts working by itself is killed at once; one that exits is forgotten', () => {
  const kept = new KeptProcesses()
  const p = fakeProcess()
  kept.keeperFor(owner('a'), '', () => '').keep('k', p)
  p.handlers.onLine('status')
  assert.deepEqual(p.did, [])
  p.handlers.onLine('wake')
  assert.deepEqual(p.did, ['kill'])
  const q = fakeProcess()
  kept.keeperFor(owner('a'), '', () => '').keep('k', q)
  q.handlers.onExit?.(0)
  assert.equal(kept.size, 0)
})

test('release waits until the picked ones are gone, and kills one that will not go', async () => {
  const kept = new KeptProcesses({ closeMs: 20 })
  const [a, b, stuck] = [fakeProcess(), fakeProcess(), fakeProcess(true)]
  kept.keeperFor(owner('a', '/tree'), '', () => '').keep('k', a)
  kept.keeperFor(owner('b', '/p'), '', () => '').keep('k', b)
  kept.keeperFor(owner('c', '/tree'), '', () => '').keep('k', stuck)
  await kept.release(p => p.folder === '/tree')
  assert.deepEqual([a.did, b.did, stuck.did], [['close'], [], ['close', 'kill']])
  kept.killAll()
  assert.deepEqual(b.did, ['kill'])
})

/* ---------- the Claude Code adapter ---------- */

interface FakeCli { args: string[]; got: any[]; closed: boolean; killed: boolean; refuseMode?: boolean }

/** Enough of Claude Code to answer: every process counts its own turns and what they cost so far. */
function fakeClaude() {
  const procs: FakeCli[] = []
  const spawn: AgentRunOptions['spawn'] = async (args, handlers) => {
    const p: FakeCli = { args, got: [], closed: false, killed: false }
    procs.push(p)
    let turns = 0
    const out = (o: unknown) => handlers.onLine(JSON.stringify(o))
    return {
      async write(line) {
        const m = JSON.parse(line)
        p.got.push(m)
        await wait()
        if (m.type === 'control_request') {
          const { subtype, mode } = m.request
          const ok = !(subtype === 'set_permission_mode' && p.refuseMode)
          out({ type: 'control_response', response: { subtype: ok ? 'success' : 'error', request_id: m.request_id, response: mode ? { mode } : {} } })
        } else if (m.type === 'user') {
          turns++
          out({ type: 'system', subtype: 'init', session_id: 's1' })
          out({ type: 'user', isReplay: true, message: m.message })
          out({ type: 'assistant', message: { id: `a${procs.length}-${turns}`, content: [{ type: 'text', text: 'ok' }] } })
          out({ type: 'result', subtype: 'success', session_id: 's1', total_cost_usd: turns, usage: { input_tokens: 1, output_tokens: 1 } })
        }
      },
      async closeStdin() { p.closed = true; handlers.onExit?.(0) },
      async kill() { p.killed = true },
    }
  }
  return { procs, spawn }
}

function chat(cli: ReturnType<typeof fakeClaude>) {
  const kept = new KeptProcesses()
  const turn = (over: Partial<AgentRunOptions> = {}) => new Promise<AgentEvent[]>((resolve) => {
    const events: AgentEvent[] = []
    claudeAdapter.run({
      cwd: '/p', prompt: 'hi', model: 'default', mode: 'ask', sessionId: 's1', spawn: cli.spawn,
      keeper: kept.keeperFor(owner('c'), '', () => ''),
      emit(e) { events.push(e); if (e.type === 'turn-end') setTimeout(() => resolve(events), 0) },
      ...over,
    })
  })
  return { kept, turn }
}
const prompts = (p: FakeCli) => p.got.filter(m => m.type === 'user').length
const cost = (events: AgentEvent[]) => events.flatMap(e => (e.type === 'usage' ? [e.usage.costUsd] : [])).at(-1)
const endings = (events: AgentEvent[]) => events.flatMap(e => (e.type === 'turn-end' ? [e.status] : []))

test('claude: the next turn goes to the kept process, in its mode, with only its own cost', async () => {
  const cli = fakeClaude()
  const { kept, turn } = chat(cli)
  assert.equal(cost(await turn({ sessionId: null })), 1)
  assert.equal(kept.size, 1)
  const second = await turn()
  assert.equal(cli.procs.length, 1)
  const [p] = cli.procs
  assert.equal(prompts(p!), 2)
  assert.ok(!p!.args.includes('--resume'))
  assert.equal(cost(second), 1)
  assert.deepEqual(endings(second), ['done'])
  const modeAt = p!.got.findIndex(m => m.request?.subtype === 'set_permission_mode')
  assert.equal(p!.got[modeAt].request.mode, 'default')
  assert.ok(modeAt < p!.got.findLastIndex(m => m.type === 'user'))
  assert.equal(p!.got.filter(m => m.request?.subtype === 'initialize').length, 1)
  kept.killAll()
})

test('claude: other settings, another session or a folder it cannot read start a new process', async () => {
  const others: Partial<AgentRunOptions>[] = [
    { mode: 'auto' }, { model: 'opus' }, { effort: 'low' }, { sessionId: 's2' }, { sessionId: null }, { cwd: '/q' },
    { appendSystemPrompt: 'x' }, { readDirs: ['/files'] },
    { mcpServers: [{ name: 'm', transport: 'http', url: 'https://example.com', headers: { A: 'b' } }] },
  ]
  for (const over of others) {
    const cli = fakeClaude()
    const { kept, turn } = chat(cli)
    await turn()
    await turn(over)
    assert.equal(cli.procs.length, 2, JSON.stringify(over))
    assert.ok(cli.procs[0]!.closed)
    assert.equal(cli.procs[1]!.args.includes('--resume'), over.sessionId !== null)
    kept.killAll()
  }
})

test('claude: a process that refuses the mode is replaced, and the turn still runs', async () => {
  const cli = fakeClaude()
  const { kept, turn } = chat(cli)
  await turn()
  cli.procs[0]!.refuseMode = true
  const events = await turn()
  assert.ok(cli.procs[0]!.killed)
  assert.equal(prompts(cli.procs[0]!), 1)
  assert.equal(prompts(cli.procs[1]!), 1)
  assert.deepEqual(endings(events), ['done'])
  kept.killAll()
})

test('claude: a turn stopped while the kept process wakes never sends its prompt', async () => {
  const cli = fakeClaude()
  const { kept, turn } = chat(cli)
  await turn()
  const events: AgentEvent[] = []
  const run = claudeAdapter.run({
    cwd: '/p', prompt: 'two', model: 'default', mode: 'ask', sessionId: 's1', spawn: cli.spawn,
    keeper: kept.keeperFor(owner('c'), '', () => ''), emit: e => events.push(e),
  })
  run.interrupt()
  await wait(50)
  assert.deepEqual(endings(events), ['stopped'])
  assert.equal(prompts(cli.procs[0]!), 1)
  assert.equal(cli.procs.length, 1)
  assert.ok(cli.procs[0]!.killed)
})

test('claude: not kept without a keeper, nor after a command that changes the session', async () => {
  const cli = fakeClaude()
  const { kept, turn } = chat(cli)
  await turn({ keeper: undefined })
  assert.ok(cli.procs[0]!.closed)
  await turn({ prompt: '/model opus' })
  assert.ok(cli.procs[1]!.closed)
  assert.equal(kept.size, 0)
  await turn({ prompt: 'hi' })
  assert.equal(kept.size, 1)
  kept.killAll()
})
