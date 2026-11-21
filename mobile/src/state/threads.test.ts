import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Thread } from '~/types/chat'

const remote = vi.hoisted(() => ({
  gitWorktrees: vi.fn(async (_path: string): Promise<{ worktrees: { path: string; branch: string | null; isMain: boolean }[]; branches: string[] }> => ({ worktrees: [], branches: [] })),
  gitWorktreeAdd: vi.fn(async (_path: string, branch: string): Promise<{ path: string; branch: string | null; isMain: boolean }> => ({ path: `env://h1/dev/home/agent/shop.worktrees/${branch}`, branch, isMain: false })),
}))
vi.mock('@/remote', () => ({ backend: { real: true, spawnFor: () => { throw new Error('no spawning here') }, gitState: async () => ({ branch: null }), ...remote } }))
vi.mock('@/remote/chatSync', () => ({ attachRemoteChats: vi.fn(), noteSaved: vi.fn() }))

const { setStatusHook, useThreads } = await import('@/state/threads')
const { memoryChatFiles } = await import('@/state/chatHistory')
const chatSync = await import('@/remote/chatSync')

const PROJECT = 'env://h1/dev/home/agent/shop'
const store = () => useThreads.getState()

beforeEach(() => {
  vi.mocked(chatSync.noteSaved).mockClear()
  vi.mocked(chatSync.attachRemoteChats).mockClear()
})

/** A chat as an older desktop build left it: mid-run, an old status, an open approval. */
const oldChat = (over: Partial<Thread> = {}): Thread => ({
  id: 't-old1',
  projectPath: PROJECT,
  title: 'Old one',
  agent: 'claude',
  model: '',
  mode: 'weird' as Thread['mode'],
  status: 'idle' as Thread['status'],
  messages: [
    { id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hi' }], createdAt: 1, attachments: [{ bogus: true } as never] },
    {
      id: 'm2',
      role: 'agent',
      createdAt: 2,
      parts: [
        { type: 'tool', id: 'x', tool: 'bash', target: 'ls', status: 'running' },
        { type: 'approval', id: 'p', command: 'rm', reason: '', state: 'pending' },
      ],
    },
  ],
  createdAt: 1,
  updatedAt: 2,
  seen: false,
  ...over,
})

describe('the chat store', () => {
  it('saves chats and reads them back the same', async () => {
    const files = memoryChatFiles()
    await store().load(files)
    const a = store().create({ projectPath: PROJECT, agent: 'codex', model: 'gpt-5.5', mode: 'edits' })
    store()._appendUser(a.id, 'Make it faster', [])
    store().rename(a.id, 'Faster')
    const b = store().create({ projectPath: 'env://h1/dev/home/agent/other', agent: 'claude' })
    await store().flush()
    expect([...files.data.keys()].sort()).toEqual([a.id, b.id].sort())

    const before = { ...store().threads }
    await store().load(files)
    expect(store().threads).toEqual(before)
    expect(store().byProject(PROJECT).map(t => t.title)).toEqual(['Faster'])
    expect(store().byId(a.id)).toMatchObject({ agent: 'codex', model: 'gpt-5.5', mode: 'edits', status: 'working' })
  })

  it('writes only the chats that changed, and tells chat sync', async () => {
    const files = memoryChatFiles()
    await store().load(files)
    const a = store().create({ projectPath: PROJECT, agent: 'claude' })
    const b = store().create({ projectPath: 'env://h1/dev/x', agent: 'claude' })
    await store().flush()
    const write = vi.spyOn(files, 'write')
    vi.mocked(chatSync.noteSaved).mockClear()
    store().setMode(b.id, 'auto')
    await store().flush()
    expect(write.mock.calls.map(([id]) => id)).toEqual([b.id])
    expect(vi.mocked(chatSync.noteSaved)).toHaveBeenCalledWith([store().byId(b.id)], [])
    expect(files.data.has(a.id)).toBe(true)
  })

  it('deletes a chat with its sub-agents, from disk too', async () => {
    const files = memoryChatFiles()
    await store().load(files)
    const t = store().create({ projectPath: PROJECT, agent: 'claude' })
    const child = store()._createSubagent(t.id, { toolId: 'tool1', title: 'Look around' })!
    const grandchild = store()._createSubagent(child.id, { toolId: 'tool2', title: 'Deeper' })!
    await store().flush()
    expect(files.data.size).toBe(3)
    store().setDraft(t.id, 'half written')
    vi.mocked(chatSync.noteSaved).mockClear()
    store().remove(t.id)
    await store().flush()
    expect(files.data.size).toBe(0)
    expect(store().drafts[t.id]).toBeUndefined()
    const removed = vi.mocked(chatSync.noteSaved).mock.calls.flatMap(([, removed]) => removed)
    expect(removed.map(r => r.id).sort()).toEqual([t.id, child.id, grandchild.id].sort())
    expect(removed.every(r => r.projectPath === PROJECT)).toBe(true)
  })

  it('tolerates chats written by older builds', async () => {
    const files = memoryChatFiles({ 't-old1': JSON.stringify(oldChat()), broken: '{nope', 'x': JSON.stringify({ id: '../escape', messages: [] }) })
    await store().load(files)
    expect(Object.keys(store().threads)).toEqual(['t-old1'])
    const t = store().byId('t-old1')!
    expect(t).toMatchObject({ status: 'working', mode: 'ask', model: 'default', effort: null })
    expect(t.messages[0]!.attachments).toEqual([])
    expect(t.messages[1]!.parts).toEqual([
      { type: 'tool', id: 'x', tool: 'bash', target: 'ls', status: 'error', summary: 'did not finish' },
      { type: 'approval', id: 'p', command: 'rm', reason: '', state: 'cancelled' },
    ])
    // The normalised chat is saved back, and chat sync is attached to the store.
    await store().flush()
    expect(JSON.parse(files.data.get('t-old1')!).status).toBe('working')
    expect(vi.mocked(chatSync.attachRemoteChats)).toHaveBeenCalledOnce()
  })

  it('adopts chats from the environment and drops deleted ones', async () => {
    await store().load(memoryChatFiles())
    const source = vi.mocked(chatSync.attachRemoteChats).mock.calls[0]![0] as ReturnType<ReturnType<typeof store>['remoteSource']>
    const adopted = source.adopt([oldChat({ id: 't-remote', status: 'running' }), oldChat({ id: '../../etc' })])
    expect(adopted.map(t => t.id)).toEqual(['t-remote'])
    expect(store().byId('t-remote')!.status).toBe('working')
    expect(source.busy(store().byId('t-remote')!)).toBe(false)
    // A newer copy replaces the one here.
    source.adopt([{ ...store().byId('t-remote')!, title: 'Renamed elsewhere' }])
    expect(store().byId('t-remote')!.title).toBe('Renamed elsewhere')
    source.drop(['t-remote'])
    expect(store().byId('t-remote')).toBeNull()
  })

  it('remembers a run another computer has going, until a newer copy says it ended', async () => {
    await store().load(memoryChatFiles())
    const source = vi.mocked(chatSync.attachRemoteChats).mock.calls[0]![0] as ReturnType<ReturnType<typeof store>['remoteSource']>
    source.adopt([oldChat({ id: 't-pc', status: 'running', updatedAt: 42 })])
    // The copy here is plain Working (nothing runs here), but the phone knows who is running it.
    expect(store().byId('t-pc')!.status).toBe('working')
    expect(store().elsewhere['t-pc']).toEqual({ status: 'running', at: 42 })
    // It still takes the next copy: the chat is not "running here".
    expect(source.busy(store().byId('t-pc')!)).toBe(false)
    source.adopt([oldChat({ id: 't-pc', status: 'waiting', updatedAt: 50 })])
    expect(store().elsewhere['t-pc']).toEqual({ status: 'waiting', at: 50 })
    // The run ended there: the chat is just Working again, with no one running it.
    source.adopt([oldChat({ id: 't-pc', status: 'working', updatedAt: 60 })])
    expect(store().elsewhere['t-pc']).toBeUndefined()
    source.adopt([oldChat({ id: 't-pc2', status: 'running' })])
    expect(store().elsewhere['t-pc2']).toBeDefined()
    // Deleting the chat forgets it too.
    store().remove('t-pc2')
    expect(store().elsewhere['t-pc2']).toBeUndefined()
  })

  it('never saves what it knows of another computer\'s run into the chat', async () => {
    const files = memoryChatFiles()
    await store().load(files)
    const source = vi.mocked(chatSync.attachRemoteChats).mock.calls[0]![0] as ReturnType<ReturnType<typeof store>['remoteSource']>
    source.adopt([oldChat({ id: 't-pc', status: 'running' })])
    await store().flush()
    const saved = JSON.parse(files.data.get('t-pc')!)
    expect(saved.status).toBe('working')
    expect(JSON.stringify(saved)).not.toContain('elsewhere')
  })

  it('reuses an untouched new chat, and keeps busy chats from being archived', async () => {
    await store().load(memoryChatFiles())
    const a = store().create({ projectPath: PROJECT, agent: 'claude' })
    const again = store().create({ projectPath: PROJECT, agent: 'codex' })
    expect(again.id).toBe(a.id)
    expect(again).toMatchObject({ agent: 'codex', model: 'default' })
    store().edit(a.id, (d) => { d.status = 'running' })
    store().archive(a.id)
    expect(store().byId(a.id)!.archived).toBeUndefined()
    store().edit(a.id, (d) => { d.status = 'working' })
    store().archive(a.id)
    expect(store().byProject(PROJECT)).toEqual([])
    expect(store().archivedFor(PROJECT).map(t => t.id)).toEqual([a.id])
  })

  it('sets a chat working or settled as the desktop does, and leaves a run its status', async () => {
    const files = memoryChatFiles()
    await store().load(files)
    const a = store().create({ projectPath: PROJECT, agent: 'claude' })
    store().edit(a.id, (d) => { d.seen = false })
    await store().flush()
    vi.mocked(chatSync.noteSaved).mockClear()

    store().setStatus(a.id, 'done')
    expect(store().byId(a.id)).toMatchObject({ status: 'done', seen: true })
    await store().flush()
    expect(JSON.parse(files.data.get(a.id)!)).toMatchObject({ status: 'done' })
    expect(vi.mocked(chatSync.noteSaved)).toHaveBeenCalledWith([store().byId(a.id)], [])

    // Picking a status brings an archived chat back.
    store().archive(a.id)
    store().setStatus(a.id, 'working')
    expect(store().byId(a.id)).toMatchObject({ status: 'working', archived: false })
    expect(store().byProject(PROJECT).map(t => t.id)).toEqual([a.id])

    // While a run is active (or waits for the user) it owns the status.
    for (const busy of ['queued', 'running', 'waiting'] as const) {
      store().edit(a.id, (d) => { d.status = busy })
      store().setStatus(a.id, 'done')
      expect(store().byId(a.id)!.status).toBe(busy)
    }
    // A failed run can be moved on from.
    store().edit(a.id, (d) => { d.status = 'error' })
    store().setStatus(a.id, 'done')
    expect(store().byId(a.id)!.status).toBe('done')
    // An unknown chat is ignored.
    expect(() => store().setStatus('t-nope', 'done')).not.toThrow()
    expect(store().byId('t-nope')).toBeNull()
  })

  it('answers a question, keeping secret answers out of the chat', async () => {
    await store().load(memoryChatFiles())
    const t = store().create({ projectPath: PROJECT, agent: 'claude' })
    const m = store()._pushAgentMessage(t.id)!
    store()._pushPart(t.id, m.id, {
      type: 'question',
      id: 'q1',
      state: 'pending',
      questions: [{ question: 'Which?', options: [{ label: 'A' }] }, { question: 'Token?', options: [], freeText: true, secret: true }],
    })
    store().edit(t.id, (d) => { d.status = 'waiting' })
    store().answerQuestion(t.id, m.id, 0, [['A'], ['s3cret']])
    const part = store().byId(t.id)!.messages[0]!.parts[0]!
    expect(part).toMatchObject({ state: 'answered', answers: [['A'], ['••••••']] })
    expect(store().byId(t.id)!.status).toBe('running')
  })

  describe('a new chat in a worktree', () => {
    beforeEach(() => {
      remote.gitWorktrees.mockClear()
      remote.gitWorktreeAdd.mockClear()
    })

    it('is its own blank chat, waiting for the worktree', async () => {
      await store().load(memoryChatFiles())
      const plain = store().create({ projectPath: PROJECT, agent: 'claude' })
      const wt = store().create({ projectPath: PROJECT, agent: 'claude', inWorktree: true })
      expect(wt.id).not.toBe(plain.id)
      expect(wt.awaitingWorktree).toBe(true)
      expect(store().create({ projectPath: PROJECT, agent: 'codex', inWorktree: true }).id).toBe(wt.id)
      expect(plain.awaitingWorktree).toBeUndefined()
    })

    it('adds the worktree on a branch named from the first message, skipping taken names, then runs there', async () => {
      await store().load(memoryChatFiles())
      remote.gitWorktrees.mockResolvedValueOnce({
        worktrees: [
          { path: 'env://h1/dev/home/agent/shop', branch: 'main', isMain: true },
          { path: 'env://h1/dev/home/agent/shop.worktrees/fix-the-login-redirect', branch: 'other', isMain: false },
        ],
        branches: ['main', 'fix-the-login-redirect-2'],
      })
      // Taken since the list was read: the next number is tried.
      remote.gitWorktreeAdd.mockRejectedValueOnce(new Error('env://h1/dev/home/agent/shop.worktrees/fix-the-login-redirect-3 already exists; pick another branch name'))
      const t = store().create({ projectPath: PROJECT, agent: 'claude', inWorktree: true })
      await store().send(t.id, 'Fix the login redirect!')
      expect(remote.gitWorktreeAdd.mock.calls.map(c => c[1])).toEqual(['fix-the-login-redirect-3', 'fix-the-login-redirect-4'])
      const after = store().byId(t.id)!
      expect(after).toMatchObject({ worktree: 'env://h1/dev/home/agent/shop.worktrees/fix-the-login-redirect-4', branch: 'fix-the-login-redirect-4' })
      expect(after.awaitingWorktree).toBeUndefined()
      expect(store().workdirFor(t.id)).toBe(after.worktree)
      // The (fake) agent then ran and ended: the chat is not left working.
      expect(['queued', 'running', 'waiting']).not.toContain(after.status)
    })

    it('ends cleanly with the reason when the worktree cannot be made, and tries again on the next message', async () => {
      await store().load(memoryChatFiles())
      remote.gitWorktreeAdd.mockRejectedValueOnce(new Error('/home/agent/notes in dev is not inside a git repository'))
      const t = store().create({ projectPath: PROJECT, agent: 'claude', inWorktree: true })
      await store().send(t.id, 'Tidy up')
      let now = store().byId(t.id)!
      expect(now.status).toBe('error')
      expect(now.awaitingWorktree).toBe(true)
      const notice = now.messages.at(-1)!.parts[0]!
      expect(notice).toMatchObject({ type: 'notice', level: 'error' })
      expect((notice as { text: string }).text).toBe('Could not make a worktree for this chat: /home/agent/notes in dev is not inside a git repository. Nothing ran yet; send a message to try again (what you wrote goes along).')
      // Other failures are not retried under another name.
      expect(remote.gitWorktreeAdd).toHaveBeenCalledOnce()

      await store().send(t.id, 'and the tests')
      now = store().byId(t.id)!
      // Named from the first message still.
      expect(remote.gitWorktreeAdd.mock.calls.at(-1)![1]).toBe('tidy-up')
      expect(now.worktree).toBe('env://h1/dev/home/agent/shop.worktrees/tidy-up')
    })

    it('does not start the agent when stopped while the worktree is made', async () => {
      await store().load(memoryChatFiles())
      let release!: () => void
      remote.gitWorktreeAdd.mockImplementationOnce(async (_p, branch) => {
        await new Promise<void>((r) => { release = r })
        return { path: `env://h1/dev/home/agent/shop.worktrees/${branch}`, branch, isMain: false }
      })
      const t = store().create({ projectPath: PROJECT, agent: 'claude', inWorktree: true })
      const sending = store().send(t.id, 'Slow one')
      await vi.waitFor(() => expect(remote.gitWorktreeAdd).toHaveBeenCalled())
      expect(store().byId(t.id)!.status).toBe('queued')
      store().stop(t.id)
      expect(store().byId(t.id)!.status).toBe('working')
      release()
      await sending
      const now = store().byId(t.id)!
      expect(now).toMatchObject({ status: 'working', worktree: 'env://h1/dev/home/agent/shop.worktrees/slow-one' })
      // Only the user's message: no agent turn was started.
      expect(now.messages.map(m => m.role)).toEqual(['user'])
    })
  })

  describe('status hook', () => {
    it('hears a change with what the chat was, how it ended and what is on screen', () => {
      const t = store().create({ projectPath: PROJECT, agent: 'claude' })
      const heard: unknown[][] = []
      setStatusHook((c, before, outcome, ctx) => { heard.push([c.id, before, c.status, outcome, ctx]) })
      store()._setStatus(t.id, 'running')
      store().setViewing(t.id)
      store()._setStatus(t.id, 'working', 'done')
      expect(heard).toEqual([
        [t.id, 'working', 'running', undefined, { viewing: null, queued: 0 }],
        [t.id, 'running', 'working', 'done', { viewing: t.id, queued: 0 }],
      ])
      store().setViewing(null)
    })

    it('never lets a listener that throws break the chat', () => {
      const t = store().create({ projectPath: PROJECT, agent: 'claude' })
      setStatusHook(() => { throw new Error('boom') })
      expect(() => store()._setStatus(t.id, 'running')).not.toThrow()
      expect(store().byId(t.id)!.status).toBe('running')
      setStatusHook(null)
    })
  })
})

describe('message actions', () => {
  const chat = (): Thread => ({
    ...oldChat({ id: 't-act1', status: 'working', sessionId: 's1' }),
    messages: [
      { id: 'a', role: 'user', parts: [{ type: 'text', text: 'first' }], createdAt: 1 },
      { id: 'b', role: 'agent', parts: [{ type: 'text', text: 'answer' }], createdAt: 2 },
      { id: 'c', role: 'user', parts: [{ type: 'text', text: 'second' }], createdAt: 3, pinned: true },
    ],
  })
  const seed = () => useThreads.setState(s => ({ threads: { ...s.threads, 't-act1': chat() } }))

  it('pins and unpins a message', () => {
    seed()
    store().togglePin('t-act1', 'a')
    expect(store().byId('t-act1')!.messages[0]!.pinned).toBe(true)
    store().togglePin('t-act1', 'a')
    expect(store().byId('t-act1')!.messages[0]!.pinned).toBeUndefined()
  })

  it('counts what a cut would remove', () => {
    seed()
    expect(store().cutCount('t-act1', 'b')).toBe(2)
    expect(store().cutCount('t-act1', 'nope')).toBe(0)
  })

  it('branches a new chat with the earlier messages as text and nothing pinned', () => {
    seed()
    const made = store().branchFrom('t-act1', 'b')!
    expect(made.id).not.toBe('t-act1')
    expect(made.title).toBe('Old one (branch)')
    expect(made.messages.map(m => m.role)).toEqual(['user', 'agent'])
    expect(made.messages.every(m => !m.pinned)).toBe(true)
    expect(made.history).toMatch(/User: first\n\nAssistant: answer/)
    expect(made.sessionId).toBeUndefined()
    // The source is untouched.
    expect(store().byId('t-act1')!.messages).toHaveLength(3)
  })
})
