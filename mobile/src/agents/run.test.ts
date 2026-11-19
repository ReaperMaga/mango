import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentId, Thread } from '~/types/chat'

/** The environment is the simulated CLI, in memory: what the web preview runs. */
vi.mock('@/remote', async () => {
  const { simulatedSpawn } = await import('@/agents/simulated')
  return {
    backend: {
      real: false,
      spawnFor: (agent: AgentId, path: string) => {
        const spawn = simulatedSpawn(agent, path, { pace: 0 })
        // Each run's handlers, so a test can drop its connection.
        return async (args: string[], h: { onConnection?(s: 'lost' | 'back'): void }, env?: Record<string, string>) => {
          ;(globalThis as { lastRun?: typeof h }).lastRun = h
          return spawn(args, h as never, env)
        }
      },
      gitState: async () => ({ branch: null }),
    },
  }
})
vi.mock('@/remote/chatSync', () => ({ attachRemoteChats: vi.fn(), noteSaved: vi.fn() }))

const { useThreads } = await import('@/state/threads')
const { memoryChatFiles } = await import('@/state/chatHistory')
const { isRunning, onFilesChanged } = await import('@/agents/run')
const chatSync = await import('@/remote/chatSync')

const PROJECT = 'env://h1/dev/home/agent/shop'
const store = () => useThreads.getState()
let files: ReturnType<typeof memoryChatFiles>
let unsubscribe = () => {}

/** Answer every approval as it shows up, the way a person tapping "Allow" would. */
function autoApprove(allow = true) {
  const answer = (s: ReturnType<typeof store>) => {
    for (const t of Object.values(s.threads)) {
      t.messages.forEach(m => m.parts.forEach((p, i) => {
        if (p.type === 'approval' && p.state === 'pending') queueMicrotask(() => store().resolveApproval(t.id, m.id, i, allow))
      }))
    }
  }
  unsubscribe = useThreads.subscribe(answer)
  answer(store())
}

beforeEach(async () => {
  files = memoryChatFiles()
  await store().load(files)
  useThreads.setState({ viewing: null, followUp: 'queue', drafts: {} })
  vi.mocked(chatSync.noteSaved).mockClear()
})
afterEach(() => unsubscribe())

const agentText = (t: Thread) => t.messages.filter(m => m.role === 'agent').flatMap(m => m.parts).map(p => (p.type === 'text' ? p.text : '')).join('')

for (const agent of ['claude', 'codex'] as const) {
  describe(`a ${agent} turn on the phone`, () => {
    it('runs end to end through the store: statuses, parts, saving', async () => {
      autoApprove()
      const statuses: string[] = []
      const t = store().create({ projectPath: PROJECT, agent, mode: 'ask' })
      const seen = useThreads.subscribe((s) => {
        const st = s.threads[t.id]?.status
        if (st && statuses[statuses.length - 1] !== st) statuses.push(st)
      })
      const changed: string[] = []
      const off = onFilesChanged(path => changed.push(path))
      await store().send(t.id, 'Fix the greeting')
      seen()
      off()

      const done = store().byId(t.id)!
      expect(isRunning(t.id)).toBe(false)
      // A new chat is Working; a turn takes it through Queued, Running, Needs you and back.
      expect(statuses).toEqual(['working', 'queued', 'running', 'waiting', 'running', 'working'])
      expect(done.title).toBe('Fix the greeting')
      expect(done.simulated).toBe(true)
      expect(done.sessionId).toBeTruthy()
      expect(done.messages.map(m => m.role)).toEqual(['user', 'agent'])
      expect(agentText(done)).toContain('Simulated')
      const reply = done.messages[1]!
      expect(reply.outcome).toBe('done')
      const tools = reply.parts.filter(p => p.type === 'tool')
      expect(tools.map(p => [p.tool, p.target, p.status])).toEqual([['read', 'README.md', 'ok'], ['edit', 'src/index.ts', 'ok']])
      expect(tools[1]!.diff).toContainEqual({ kind: 'add', text: 'const greeting = \'Hello from Mango\'' })
      expect(reply.parts.find(p => p.type === 'approval')).toMatchObject({ state: 'allowed' })
      expect(changed).toEqual([PROJECT])

      // Saved to the phone's files, and handed on to chat sync for the environment.
      await store().flush()
      expect(JSON.parse(files.data.get(t.id)!)).toEqual(done)
      const saved = vi.mocked(chatSync.noteSaved).mock.calls.flatMap(([changed]) => changed.map(x => x.id))
      expect(saved).toContain(t.id)
    })

    it('continues the same session on the next turn, and queues a message sent meanwhile', async () => {
      const t = store().create({ projectPath: PROJECT, agent, mode: 'auto' })
      await store().send(t.id, 'First')
      const session = store().byId(t.id)!.sessionId
      const second = store().send(t.id, 'Second')
      // Written while the agent works: it waits for the turn, then goes out as its own.
      await vi.waitFor(() => expect(store().byId(t.id)!.status).toBe('running'))
      await store().send(t.id, 'Third')
      expect(store().queue[t.id]?.map(q => q.text)).toEqual(['Third'])
      await second
      await vi.waitFor(() => expect(store().queue[t.id]).toBeUndefined())
      await vi.waitFor(() => expect(store().byId(t.id)!.status).toBe('working'))
      const done = store().byId(t.id)!
      expect(done.sessionId).toBe(session)
      expect(done.messages.map(m => m.role)).toEqual(['user', 'agent', 'user', 'agent', 'user', 'agent'])
      expect(done.messages[5]!.outcome).toBe('done')
    })

    it('stops when asked', async () => {
      const t = store().create({ projectPath: PROJECT, agent, mode: 'ask' })
      const sent = store().send(t.id, 'Fix it')
      await vi.waitFor(() => expect(store().byId(t.id)!.status).toBe('waiting'))
      store().stop(t.id)
      await sent
      const done = store().byId(t.id)!
      expect(done.status).toBe('working')
      const reply = done.messages[1]!
      expect(reply.outcome).toBe('stopped')
      expect(reply.parts.find(p => p.type === 'approval')).toMatchObject({ state: 'cancelled' })
      expect(reply.parts[reply.parts.length - 1]).toEqual({ type: 'notice', level: 'info', text: 'Stopped.' })
    })

    it('hands a message to the running turn when steering', async () => {
      useThreads.setState({ followUp: 'steer' })
      const t = store().create({ projectPath: PROJECT, agent, mode: 'ask' })
      const sent = store().send(t.id, 'Fix it')
      // Steered while the agent waits for an approval: the turn is certainly still running.
      await vi.waitFor(() => expect(store().byId(t.id)!.status).toBe('waiting'))
      await store().send(t.id, 'and say hi')
      expect(store().queue[t.id]).toBeUndefined()
      autoApprove()
      await sent
      const done = store().byId(t.id)!
      // The steered message sits in the chat, and what the agent does next goes below it.
      expect(done.messages.map(m => m.role)).toEqual(['user', 'agent', 'user', 'agent'])
      expect(done.messages[1]!.parts.find(p => p.type === 'approval')).toMatchObject({ state: 'allowed' })
      expect(agentText(done)).toContain('and say hi')
      expect(done.messages[3]!.outcome).toBe('done')
    })
  })
}

it('stays Working while its connection is lost, and says it is reconnecting', async () => {
  const t = store().create({ projectPath: PROJECT, agent: 'claude', mode: 'ask' })
  const sent = store().send(t.id, 'Fix it')
  await vi.waitFor(() => expect(store().byId(t.id)!.status).toBe('waiting'))
  const run = (globalThis as { lastRun?: { onConnection?(s: 'lost' | 'back'): void } }).lastRun!
  run.onConnection!('lost')
  expect(store().live[t.id]?.reconnecting).toBe(true)
  expect(store().byId(t.id)!.status).toBe('waiting')
  run.onConnection!('back')
  expect(store().live[t.id]?.reconnecting).toBe(false)
  run.onConnection!('lost')
  autoApprove()
  await sent
  const done = store().byId(t.id)!
  expect(done.messages[1]!.outcome).toBe('done')
  // The run's end clears it.
  expect(store().live[t.id]?.reconnecting).toBeFalsy()
})

it('/clear starts a fresh conversation without running the agent', async () => {
  const t = store().create({ projectPath: PROJECT, agent: 'claude' })
  store().edit(t.id, (d) => { d.sessionId = 'abc' })
  await store().send(t.id, '/clear')
  const done = store().byId(t.id)!
  expect(done.sessionId).toBeNull()
  expect(done.title).toBe('New chat')
  expect(done.messages[1]!.parts[0]).toMatchObject({ type: 'notice', level: 'info' })
})
