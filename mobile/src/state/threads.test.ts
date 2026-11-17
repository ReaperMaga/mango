import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Thread } from '~/types/chat'

vi.mock('@/remote', () => ({ backend: { real: true, spawnFor: () => { throw new Error('no spawning here') }, gitState: async () => ({ branch: null }) } }))
vi.mock('@/remote/chatSync', () => ({ attachRemoteChats: vi.fn(), noteSaved: vi.fn() }))

const { useThreads } = await import('@/state/threads')
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
})
