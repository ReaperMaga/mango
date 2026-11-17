import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentEvent } from '~/agents/types'
import type { Thread } from '~/types/chat'

vi.mock('@/remote', () => ({ backend: { real: true, spawnFor: () => { throw new Error('no spawning here') }, gitState: async () => ({ branch: 'feature/x' }) } }))
vi.mock('@/remote/chatSync', () => ({ attachRemoteChats: vi.fn(), noteSaved: vi.fn() }))

const { useThreads } = await import('@/state/threads')
const { memoryChatFiles } = await import('@/state/chatHistory')
const { createTurn } = await import('@/agents/turn')

const PROJECT = 'env://h1/dev/home/agent/shop'
const store = () => useThreads.getState()

/** A chat with one user message and an empty agent reply, and a turn applying events to it. */
function start() {
  const t = store().create({ projectPath: PROJECT, agent: 'claude' })
  store()._appendUser(t.id, 'Fix the greeting', [])
  const first = store()._pushAgentMessage(t.id)!
  store()._setStatus(t.id, 'running')
  const onEnd = vi.fn()
  const turn = createTurn(store(), t.id, first, PROJECT, onEnd)
  return { id: t.id, turn, onEnd, thread: () => store().byId(t.id) as Thread }
}

const play = (emit: (e: AgentEvent) => void, events: AgentEvent[]) => { for (const e of events) emit(e) }

beforeEach(async () => {
  await store().load(memoryChatFiles())
  useThreads.setState({ viewing: null })
})

describe('applying agent events (desktop parity)', () => {
  it('turns a recorded turn into the expected chat', async () => {
    const { id, turn, onEnd, thread } = start()
    play(turn.emit, [
      { type: 'session', sessionId: 'sess-1' },
      { type: 'thinking-delta', id: 'm1:0', text: 'Look first. ' },
      { type: 'thinking-delta', id: 'm1:0', text: 'Then edit.' },
      { type: 'thinking-end', id: 'm1:0', seconds: 2 },
      { type: 'text-delta', id: 'm1:1', text: 'Reading ' },
      { type: 'text-delta', id: 'm1:1', text: 'the file.' },
      { type: 'tool-start', id: 'read1', tool: 'read', target: '' },
      { type: 'tool-update', id: 'read1', target: 'README.md' },
      { type: 'tool-end', id: 'read1', status: 'ok', summary: '3 lines' },
      { type: 'tool-start', id: 'edit1', tool: 'edit', target: 'src/index.ts' },
      { type: 'tool-update', id: 'edit1', summary: '+1 −1', diff: [{ kind: 'del', text: 'a' }, { kind: 'add', text: 'b' }] },
      { type: 'text-delta', id: 'm1:2', text: 'After the edit.' },
      { type: 'approval', id: 'perm1', title: 'Edit file', command: 'src/index.ts', reason: '', toolId: 'edit1' },
    ])
    expect(thread().status).toBe('waiting')
    const reply = thread().messages[1]!
    // The approval sits right under the row it is about, not after later text.
    expect(reply.parts.map(p => p.type)).toEqual(['thinking', 'text', 'tool', 'tool', 'approval', 'text'])

    store().resolveApproval(id, reply.id, 4, true)
    expect(thread().status).toBe('running')
    play(turn.emit, [
      { type: 'tool-end', id: 'edit1', status: 'ok' },
      { type: 'tool-start', id: 'agent1', tool: 'other', label: 'Delegated', target: 'Map the code' },
      { type: 'subagent-start', id: 'agent1', title: 'Map the code', agentType: 'Explore', prompt: 'Find the store.' },
      { type: 'text', id: 'sub:1', text: 'Found it.', agent: 'agent1' },
      { type: 'subagent-end', id: 'agent1', status: 'done' },
      { type: 'tool-end', id: 'agent1', status: 'ok', output: 'Found it.' },
      { type: 'text', id: 'm2:0', text: 'Done.' },
      { type: 'turn-end', status: 'done' },
    ])
    await turn.finished
    expect(onEnd).toHaveBeenCalledOnce()

    const t = thread()
    expect(t.status).toBe('working')
    expect(t.sessionId).toBe('sess-1')
    const done = t.messages[1]!
    expect(done.outcome).toBe('done')
    expect(typeof done.elapsedMs).toBe('number')
    expect(done.parts).toMatchObject([
      { type: 'thinking', text: 'Look first. Then edit.', seconds: 2 },
      { type: 'text', text: 'Reading the file.' },
      { type: 'tool', id: 'read1', tool: 'read', target: 'README.md', status: 'ok', summary: '3 lines' },
      { type: 'tool', id: 'edit1', status: 'ok', summary: '+1 −1', diff: [{ kind: 'del', text: 'a' }, { kind: 'add', text: 'b' }] },
      { type: 'approval', id: 'perm1', state: 'allowed' },
      { type: 'text', text: 'After the edit.' },
      { type: 'tool', id: 'agent1', label: 'Delegated', status: 'ok' },
      { type: 'text', id: 'm2:0', text: 'Done.' },
    ])
    // The sub-agent got a chat of its own, listed under this one and opened from its row.
    const [child] = store().childrenOf(id)
    expect(child).toMatchObject({ parentId: id, toolId: 'agent1', agentType: 'Explore', status: 'done', title: 'Map the code' })
    expect(child!.messages[0]).toMatchObject({ role: 'user', fromAgent: true, parts: [{ type: 'text', text: 'Find the store.' }] })
    expect(child!.messages[1]!.parts).toEqual([{ type: 'text', id: 'sub:1', text: 'Found it.' }])
    expect(done.parts[6]).toMatchObject({ childId: child!.id })
    expect(store().byProject(PROJECT).map(x => x.id)).toEqual([id])
  })

  it('ends an empty turn with an error notice and forgets a lost session', async () => {
    const { turn, thread } = start()
    store().edit(thread().id, (d) => { d.sessionId = 'old' })
    play(turn.emit, [
      { type: 'tool-start', id: 'b1', tool: 'bash', target: 'npm test' },
      { type: 'turn-end', status: 'error', error: 'Codex no longer has this conversation on disk.' },
    ])
    await turn.finished
    const t = thread()
    expect(t.status).toBe('error')
    expect(t.sessionId).toBeNull()
    expect(t.messages[1]!.parts).toEqual([
      { type: 'tool', id: 'b1', tool: 'bash', target: 'npm test', status: 'error', summary: 'did not finish', label: undefined },
      { type: 'notice', level: 'error', text: 'Codex no longer has this conversation on disk.' },
    ])
    expect(t.messages[1]!.outcome).toBe('error')
  })

  it('drops a reply that stayed empty, and says it stopped', async () => {
    const { turn, thread } = start()
    play(turn.emit, [
      { type: 'thinking-delta', id: 't', text: '' },
      { type: 'thinking-end', id: 't' },
      { type: 'approval', id: 'p', title: 'Run', command: 'ls', reason: '' },
      { type: 'turn-end', status: 'stopped' },
    ])
    await turn.finished
    const t = thread()
    // The empty thinking block is noise and goes; the open approval is cancelled.
    expect(t.messages[1]!.parts).toEqual([
      { type: 'approval', id: 'p', title: 'Run', command: 'ls', reason: '', state: 'cancelled' },
      { type: 'notice', level: 'info', text: 'Stopped.' },
    ])
    expect(t.status).toBe('working')
    expect(t.messages[1]!.outcome).toBe('stopped')
  })

  it('keeps background tasks live, and starts a new reply when the agent resumes', async () => {
    const { id, turn, thread } = start()
    play(turn.emit, [
      { type: 'tool-start', id: 'bg', tool: 'bash', target: 'npm run dev' },
      { type: 'tool-end', id: 'bg', status: 'ok', summary: 'in background' },
      { type: 'task-start', id: 'task1', kind: 'command', title: 'npm run dev', toolId: 'bg' },
      { type: 'answered' },
    ])
    expect(store().liveOf(id)).toMatchObject({ idle: true, tasks: [{ id: 'task1', status: 'running' }] })
    play(turn.emit, [
      { type: 'task-end', id: 'task1', status: 'done' },
      { type: 'resume', reason: 'Background command finished: npm run dev' },
      { type: 'text', id: 'r', text: 'The server is up.' },
    ])
    expect(store().liveOf(id)?.idle).toBe(false)
    expect(thread().messages).toHaveLength(3)
    expect(thread().messages[1]!.parts[0]).toMatchObject({ id: 'bg', summary: 'finished' })
    expect(thread().messages[2]!.parts).toEqual([
      { type: 'notice', level: 'info', text: 'Background command finished: npm run dev' },
      { type: 'text', id: 'r', text: 'The server is up.' },
    ])
    turn.emit({ type: 'turn-end', status: 'done' })
    await turn.finished
    expect(store().liveOf(id)).toBeUndefined()
  })

  it('links a pull request the agent created', async () => {
    const { turn, thread } = start()
    play(turn.emit, [
      { type: 'tool-start', id: 'gh', tool: 'bash', target: 'gh pr create --fill' },
      { type: 'tool-end', id: 'gh', status: 'ok', output: 'https://github.com/acme/shop/pull/12\n' },
      { type: 'turn-end', status: 'done' },
    ])
    await turn.finished
    expect(thread().links).toMatchObject([{ key: 'github.com/acme/shop#12', kind: 'pr', number: 12, source: 'agent' }])
  })

  it('follows the session into a worktree inside the environment', async () => {
    const { id, turn, thread } = start()
    turn.emit({ type: 'workdir', path: '/home/agent/shop/.claude/worktrees/fix', branch: null })
    turn.emit({ type: 'turn-end', status: 'done' })
    await turn.finished
    await vi.waitFor(() => expect(thread().worktree).toBe(`${PROJECT}/.claude/worktrees/fix`))
    expect(thread().branch).toBe('feature/x')
    expect(store().workdirFor(id)).toBe(`${PROJECT}/.claude/worktrees/fix`)
    expect(turn.moved).toEqual(new Set([`${PROJECT}/.claude/worktrees/fix`]))
  })

  it('leaves older snapshots unchanged (chats are immutable)', () => {
    const { turn, thread } = start()
    turn.emit({ type: 'text-delta', id: 'x', text: 'one' })
    const before = thread()
    const firstMessage = before.messages[0]
    turn.emit({ type: 'text-delta', id: 'x', text: ' two' })
    expect(before.messages[1]!.parts).toEqual([{ type: 'text', id: 'x', text: 'one' }])
    expect(thread().messages[1]!.parts).toEqual([{ type: 'text', id: 'x', text: 'one two' }])
    // Messages the turn does not touch keep their identity, so their rows need not re-render.
    expect(thread().messages[0]).toBe(firstMessage)
  })
})
