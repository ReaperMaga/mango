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
    model: 'default',
    effort: null,
    seen: new Set(),
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

interface FakeCli {
  args: string[]
  got: any[]
  closed: boolean
  killed: boolean
  refuseMode?: boolean
  /** Control requests it does not know. */
  unknown?: string[]
  /** Says yes to a model or effort and does not change it. */
  ignores?: boolean
  model?: string
  effort?: string
}
/** How a fake process tells what its session had spent: before the answer, too late, or not at all. */
type Spent = 'early' | 'late' | 'never'

/** Enough of Claude Code to answer: a turn costs 1, and a process that resumes counts on from what its session had spent. */
function fakeClaude(tells: Spent = 'early') {
  const procs: FakeCli[] = []
  let spent = 0
  const spawn: AgentRunOptions['spawn'] = async (args, handlers) => {
    const arg = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined)
    const p: FakeCli = { args, got: [], closed: false, killed: false, model: `claude-${arg('--model') ?? 'default'}`, effort: arg('--effort') ?? 'high' }
    procs.push(p)
    let turns = 0
    let total = args.includes('--resume') ? spent : 0
    let spentAsked: string | undefined
    const out = (o: unknown) => handlers.onLine(JSON.stringify(o))
    return {
      async write(line) {
        const m = JSON.parse(line)
        p.got.push(m)
        await wait()
        if (m.type === 'control_request') {
          const { subtype, mode } = m.request
          if (subtype === 'get_usage') {
            spentAsked = m.request_id
            if (tells === 'early') out({ type: 'control_response', response: { subtype: 'success', request_id: spentAsked, response: { session: { total_cost_usd: total } } } })
            return
          }
          const { model, settings } = m.request
          const ok = !(subtype === 'set_permission_mode' && p.refuseMode) && !p.unknown?.includes(subtype) && model !== 'none-such'
          // Any effort is accepted; one it does not know leaves it where it was.
          if (ok && subtype === 'set_model' && !p.ignores) p.model = `claude-${model}`
          if (ok && subtype === 'apply_flag_settings' && !p.ignores && ['low', 'medium', 'high'].includes(settings.effortLevel)) p.effort = settings.effortLevel
          if (ok && subtype === 'set_model') out({ type: 'user', isReplay: true, uuid: `note-${model}`, message: { role: 'user', content: `<local-command-stdout>Set model to ${model}</local-command-stdout>` } })
          const response = mode ? { mode } : subtype === 'set_model' ? { model: `claude-${model}` } : subtype === 'get_settings' ? { applied: { model: p.model, effort: p.effort } } : {}
          out({ type: 'control_response', response: { subtype: ok ? 'success' : 'error', request_id: m.request_id, ...(ok ? { response } : { error: 'no' }) } })
        } else if (m.type === 'user') {
          turns++
          spent = ++total
          out({ type: 'system', subtype: 'init', session_id: 's1' })
          out({ type: 'user', isReplay: true, uuid: `u${procs.length}-${turns}`, message: m.message })
          out({ type: 'assistant', uuid: `r${procs.length}-${turns}`, message: { id: `a${procs.length}-${turns}`, content: [{ type: 'text', text: 'ok' }] } })
          if (spentAsked && tells === 'late') out({ type: 'control_response', response: { subtype: 'success', request_id: spentAsked, response: { session: { total_cost_usd: total } } } })
          out({ type: 'result', subtype: 'success', session_id: 's1', total_cost_usd: total, usage: { input_tokens: 1, output_tokens: 1 } })
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

test('claude: a new process that resumes shows only its own cost, or none when it cannot tell', async () => {
  for (const [tells, costs] of [['early', [1, 1, 1]], ['late', [1, undefined, 1]], ['never', [1, undefined, 1]]] as const) {
    const cli = fakeClaude(tells)
    const { kept, turn } = chat(cli)
    const first = await turn({ sessionId: null })
    await kept.release(() => true)
    const resumed = await turn()
    // The process kept from there knows its total, however it began.
    const third = await turn()
    assert.deepEqual([first, resumed, third].map(cost), costs, tells)
    assert.equal(cli.procs.length, 2, tells)
    assert.ok(!cli.procs[0]!.got.some(m => m.request?.subtype === 'get_usage'))
    const asked = cli.procs[1]!.got.map(m => m.request?.subtype ?? m.type)
    assert.ok(asked.indexOf('get_usage') < asked.indexOf('user'))
    // Tokens show either way.
    assert.ok(resumed.some(e => e.type === 'usage' && e.usage.output === 1), tells)
    kept.killAll()
  }
})

test('claude: other settings, another session or a folder it cannot read start a new process', async () => {
  const others: Partial<AgentRunOptions>[] = [
    { mode: 'auto' }, { sessionId: 's2' }, { sessionId: null }, { cwd: '/q' },
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

/** A chat's turns one after another, each at its own model and effort; how many processes there were after each. */
async function switching(turns: Partial<AgentRunOptions>[], prepare: (p: FakeCli) => void = () => {}) {
  const cli = fakeClaude()
  const { kept, turn } = chat(cli)
  const counts: number[] = []
  for (const over of turns) {
    const events = await turn({ sessionId: counts.length ? 's1' : null, ...over })
    assert.deepEqual(endings(events), ['done'])
    if (!counts.length) prepare(cli.procs[0]!)
    counts.push(cli.procs.length)
  }
  kept.killAll()
  return { counts, procs: cli.procs }
}
const asked = (p: FakeCli) => p.got.flatMap(m => (m.type === 'user' ? ['prompt'] : ['set_model', 'apply_flag_settings', 'get_settings'].includes(m.request.subtype) ? [m.request.subtype] : []))

test('claude: another model or effort goes to the kept process, and is made sure of before the prompt', async () => {
  const { counts, procs: [p] } = await switching([
    { model: 'haiku' }, { model: 'opus' }, { model: 'opus', effort: 'low' }, { model: 'sonnet', effort: 'medium' }, { model: 'sonnet', effort: 'medium' },
  ])
  assert.deepEqual(counts, [1, 1, 1, 1, 1])
  assert.deepEqual([p!.model, p!.effort], ['claude-sonnet', 'medium'])
  assert.deepEqual(asked(p!), [
    'prompt',
    'set_model', 'get_settings', 'prompt',
    'apply_flag_settings', 'get_settings', 'prompt',
    'set_model', 'apply_flag_settings', 'get_settings', 'prompt',
    'prompt',
  ])
  assert.deepEqual(p!.args.slice(p!.args.indexOf('--model'), p!.args.indexOf('--model') + 2), ['--model', 'haiku'])
})

test('claude: back to what Claude Code picks by itself starts a new process', async () => {
  for (const [from, to] of [[{ model: 'opus' }, {}], [{ effort: 'low' }, {}], [{ model: 'opus', effort: 'low' }, { model: 'sonnet' }]] as Partial<AgentRunOptions>[][]) {
    const { counts, procs } = await switching([from!, to!])
    assert.deepEqual(counts, [1, 2], JSON.stringify([from, to]))
    assert.deepEqual(asked(procs[0]!), ['prompt'])
    assert.ok(procs[0]!.closed)
    assert.equal(procs[1]!.args.includes('--effort'), false)
    assert.equal(procs[1]!.args.includes('--model'), !!to!.model)
  }
  // Leaving it for the first time is fine, and so is switching once the effort was set.
  assert.deepEqual((await switching([{}, { model: 'opus' }, { model: 'opus', effort: 'low' }])).counts, [1, 1, 1])
})

test('claude: a switch that is refused, or cannot be made sure of, starts a new process at it', async () => {
  const cases: [string, (p: FakeCli) => void, Partial<AgentRunOptions>][] = [
    ['no set_model', (p) => { p.unknown = ['set_model'] }, { model: 'opus' }],
    ['no apply_flag_settings', (p) => { p.unknown = ['apply_flag_settings'] }, { effort: 'low' }],
    ['no get_settings', (p) => { p.unknown = ['get_settings'] }, { model: 'opus' }],
    ['a yes that changes no model', (p) => { p.ignores = true }, { model: 'opus' }],
    ['a yes that changes no effort', (p) => { p.ignores = true }, { effort: 'low' }],
    ['an effort it does not know', () => {}, { effort: 'nonsense' }],
    ['a model it does not know', () => {}, { model: 'none-such' }],
  ]
  for (const [what, prepare, to] of cases) {
    const { counts, procs } = await switching([{}, to], prepare)
    assert.deepEqual(counts, [1, 2], what)
    assert.ok(procs[0]!.killed, what)
    assert.equal(prompts(procs[0]!), 1, what)
    for (const v of [to.model ?? [], to.effort ?? []].flat()) assert.ok(procs[1]!.args.includes(v!), what)
    assert.ok(procs[1]!.args.includes('--resume'), what)
  }
})

test('claude: another mode always starts a new process, whatever else changes', async () => {
  const { counts } = await switching([{ mode: 'auto', model: 'haiku' }, { mode: 'ask', model: 'opus' }, { mode: 'plan', model: 'opus' }])
  assert.deepEqual(counts, [1, 2, 3])
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

/** Transcript lines as Claude Code writes them, what a kept process does not print among them. */
const said = (type: 'user' | 'assistant', uuid: string, content: unknown = [{ type: 'text', text: 'x' }], extra = {}) =>
  JSON.stringify({ type, uuid, message: { role: type, content }, ...extra })
const ownTurn = [said('user', 'u1-1'), said('assistant', 'r1-1')]
const bookkeeping = [
  JSON.stringify({ type: 'system', subtype: 'stop_hook_summary', uuid: 'h1' }),
  JSON.stringify({ type: 'attachment', uuid: 'at1', attachment: { type: 'date' } }),
  JSON.stringify({ type: 'last-prompt', leafUuid: 'h1' }),
  JSON.stringify({ type: 'cost-state', totalCostUSD: 1 }),
  said('user', 'cv1', '<local-command-caveat>…', { isMeta: true }),
  said('user', 'cv2', '<command-name>/context</command-name>'),
  said('user', 'cv3', '<local-command-stdout>(no content)</local-command-stdout>'),
  said('assistant', 'sub1', [], { isSidechain: true }),
  'not json',
]

test('claude: a session that went on elsewhere is resumed in a new process', async () => {
  const missed: [string, string[]][] = [
    ['an answer', [...ownTurn, said('user', 'x1', 'typed in a terminal'), said('assistant', 'x2'), ...bookkeeping]],
    ['a prompt not answered yet', [...ownTurn, said('user', 'x1', 'typed in a terminal')]],
    ['a compaction', [...ownTurn, said('user', 'x1', 'This session is being continued…', { isCompactSummary: true }), ...bookkeeping]],
    ['nothing it knows', [said('user', 'old1'), said('assistant', 'old2')]],
    ['no message at all', bookkeeping],
  ]
  for (const [what, lines] of missed) {
    const cli = fakeClaude()
    const { kept, turn } = chat(cli)
    await turn({ sessionId: null })
    const events = await turn({ readTranscript: async () => ({ lines, whole: true }) })
    assert.equal(cli.procs.length, 2, what)
    assert.ok(cli.procs[0]!.killed, what)
    assert.equal(prompts(cli.procs[0]!), 1, what)
    assert.deepEqual(cli.procs[1]!.args.slice(-2), ['--resume', 's1'], what)
    assert.equal(prompts(cli.procs[1]!), 1, what)
    assert.deepEqual(endings(events), ['done'], what)
    kept.killAll()
  }
})

test('claude: bookkeeping, a late flush and a transcript that cannot be read keep the process', async () => {
  const fine: [string, AgentRunOptions['readTranscript']][] = [
    ['bookkeeping', async () => ({ lines: [...ownTurn, ...bookkeeping], whole: true })],
    ['answer not written yet', async () => ({ lines: [said('assistant', 'old'), ownTurn[0]!], whole: false })],
    ['missing', async () => null],
    ['unreadable', async () => { throw new Error('denied') }],
    ['none to read', undefined],
  ]
  for (const [what, readTranscript] of fine) {
    const cli = fakeClaude()
    const { kept, turn } = chat(cli)
    await turn({ sessionId: null })
    assert.deepEqual(endings(await turn({ readTranscript })), ['done'], what)
    assert.equal(cli.procs.length, 1, what)
    assert.equal(prompts(cli.procs[0]!), 2, what)
    kept.killAll()
  }
})

test('claude: a tail without a message is read again, wider, and then no more', async () => {
  for (const found of [true, false]) {
    const cli = fakeClaude()
    const { kept, turn } = chat(cli)
    await turn({ sessionId: null })
    const asked: number[] = []
    await turn({
      async readTranscript(session, maxBytes) {
        assert.equal(session, 's1')
        asked.push(maxBytes)
        return { lines: found && asked.length === 2 ? [...ownTurn, ...bookkeeping] : bookkeeping, whole: false }
      },
    })
    assert.equal(asked.length, 2)
    assert.ok(asked[1]! > asked[0]!)
    assert.equal(cli.procs.length, found ? 1 : 2)
    kept.killAll()
  }
})

test('claude: a turn stopped while the transcript is read never sends its prompt', async () => {
  const cli = fakeClaude()
  const { kept, turn } = chat(cli)
  await turn({ sessionId: null })
  const events: AgentEvent[] = []
  const run = claudeAdapter.run({
    cwd: '/p', prompt: 'two', model: 'default', mode: 'ask', sessionId: 's1', spawn: cli.spawn,
    keeper: kept.keeperFor(owner('c'), '', () => ''), emit: e => events.push(e),
    readTranscript: async () => { run.interrupt(); await wait(10); return { lines: ownTurn, whole: true } },
  })
  await wait(50)
  assert.deepEqual(endings(events), ['stopped'])
  assert.equal(prompts(cli.procs[0]!), 1)
  assert.equal(cli.procs.length, 1)
  assert.ok(cli.procs[0]!.killed)
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
