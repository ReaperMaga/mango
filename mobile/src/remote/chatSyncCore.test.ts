import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Thread } from '~/types/chat'
import { createChatSync, fromShared, parseShared, readState, toShared, type ChatBackend, type KeyValue, type RemoteSource } from './chatSyncCore'
import type { EnvRemote, RemotePut } from './types'

const env: EnvRemote = { hostId: 'phone-1', instance: 'dev' }

function chat(id: string, projectPath: string, updatedAt = 1, text = 'hi'): Thread {
  return {
    id, projectPath, title: id, agent: 'claude', model: 'default', mode: 'ask', status: 'working', seen: true,
    createdAt: 1, updatedAt, messages: [{ id: `${id}-m`, role: 'user', createdAt: 1, parts: [{ type: 'text', text }] }],
  }
}

describe('shared form', () => {
  it('swaps this device\'s env id for env://@ and back', () => {
    const t = { ...chat('a', 'env://phone-1/dev/home/agent/shop'), worktree: 'env://phone-1/dev/home/agent/shop-wt' }
    const json = JSON.stringify(t)
    const shared = toShared(json, env)
    expect(shared).toContain('"env://@/home/agent/shop"')
    expect(shared).not.toContain('phone-1')
    // Another instance on the same env, or another env, stays as it is.
    expect(toShared('"env://phone-1/devx/a"', env)).toBe('"env://phone-1/devx/a"')
    expect(fromShared(shared, env)).toBe(json)
    // The desktop wrote it with its own id: the phone reads it with its own.
    const desktop = toShared(JSON.stringify(chat('a', 'env://6f1c-22/dev/home/agent/shop')), { hostId: '6f1c-22', instance: 'dev' })
    expect(parseShared(desktop, env)?.projectPath).toBe('env://phone-1/dev/home/agent/shop')
  })

  it('refuses chats that point outside the environment', () => {
    expect(parseShared(JSON.stringify(chat('a', '/Users/me/shop')), env)).toBeNull()
    expect(parseShared(JSON.stringify(chat('a', 'env://other/dev/x')), env)).toBeNull()
    expect(parseShared(JSON.stringify({ ...chat('a', 'env://@/x'), worktree: '/tmp/x' }), env)).toBeNull()
    expect(parseShared('{"id":"a"}', env)).toBeNull()
    expect(parseShared('nope', env)).toBeNull()
    expect(parseShared(JSON.stringify(chat('a', 'env://@/home/agent')), env)?.id).toBe('a')
  })

  it('reads saved state from older or damaged data', () => {
    expect(readState(null)).toEqual({ known: {}, put: [], remove: {} })
    expect(readState('garbage')).toEqual({ known: {}, put: [], remove: {} })
    expect(readState('{"known":{"a":3},"put":["b",4]}')).toEqual({ known: { a: 3 }, put: ['b'], remove: {} })
  })
})

/* ---------- two devices sharing one environment ---------- */

/** The environment's chat folder, with the scripts' rules (`chats_remote.rs`). */
function environment() {
  const files = new Map<string, { rev: number; json: string } | { rev: null }>()
  const backend: ChatBackend = {
    async chatsList() { return [...files].map(([id, f]) => ({ id, rev: f.rev })) },
    async chatsFetch(_at, ids) { return ids.flatMap(id => { const f = files.get(id); return f && f.rev !== null ? [(f as { json: string }).json] : [] }) },
    async chatsPut(_at, id, base, rev, data): Promise<RemotePut> {
      const f = files.get(id)
      if (f && f.rev === null) return 'gone'
      if (f && f.rev > base) return 'stale'
      files.set(id, { rev, json: data })
      return 'ok'
    },
    async chatsRemove(_at, ids) { for (const id of ids) files.set(id, { rev: null }) },
  }
  return { files, backend }
}

/** One device: its chats, a source over them, and its mirror. */
function device(hostId: string, backend: ChatBackend, storage: KeyValue = memory()) {
  const threads = new Map<string, Thread>()
  const busy = new Set<string>()
  const source: RemoteSource = {
    byId: id => threads.get(id) ?? null,
    threads: () => [...threads.values()],
    busy: t => busy.has(t.id),
    adopt: (list) => { for (const t of list) threads.set(t.id, t); return list },
    drop: (ids) => { for (const id of ids) threads.delete(id) },
  }
  const sync = createChatSync(backend, storage)
  const at: EnvRemote = { hostId, instance: 'dev' }
  return { threads, busy, sync, at, source, path: (dir: string) => `env://${hostId}/dev${dir}` }
}

function memory(): KeyValue & { data: Map<string, string> } {
  const data = new Map<string, string>()
  return { data, async getItem(k) { return data.get(k) ?? null }, async setItem(k, v) { data.set(k, v) } }
}

describe('mirroring', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('carries chats, edits and deletes between a phone and a desktop', async () => {
    const { files, backend } = environment()
    const phone = device('phone-1', backend)
    const desk = device('6f1c-22', backend)
    await phone.sync.attachRemoteChats(phone.source)
    await desk.sync.attachRemoteChats(desk.source)

    // The phone starts a chat; it reaches the environment in the shared form.
    const a = chat('a', phone.path('/home/agent/shop'))
    phone.threads.set('a', a)
    phone.sync.noteSaved([a], [])
    await vi.advanceTimersByTimeAsync(3000)
    const kept = files.get('a') as { rev: number; json: string }
    expect(kept.json).toContain('env://@/home/agent/shop')

    // The desktop pulls it, with its own id put in.
    await desk.sync.syncEnv(desk.at)
    expect(desk.threads.get('a')?.projectPath).toBe('env://6f1c-22/dev/home/agent/shop')

    // The desktop edits it; the phone, which has not changed it, takes the newer copy.
    const edited = { ...desk.threads.get('a')!, title: 'edited' }
    desk.threads.set('a', edited)
    desk.sync.noteSaved([edited], [])
    await vi.advanceTimersByTimeAsync(3000)
    await phone.sync.syncEnv(phone.at)
    expect(phone.threads.get('a')?.title).toBe('edited')

    // Both edit: the phone's send is refused as stale, and the environment's copy wins.
    const fromDesk = { ...desk.threads.get('a')!, title: 'desk' }
    desk.threads.set('a', fromDesk)
    desk.sync.noteSaved([fromDesk], [])
    await vi.advanceTimersByTimeAsync(3000)
    const fromPhone = { ...phone.threads.get('a')!, title: 'phone' }
    phone.threads.set('a', fromPhone)
    phone.sync.noteSaved([fromPhone], [])
    await vi.advanceTimersByTimeAsync(3000)
    await vi.advanceTimersByTimeAsync(0)
    expect(phone.threads.get('a')?.title).toBe('desk')

    // A chat running on the phone is left alone.
    phone.busy.add('a')
    const again = { ...desk.threads.get('a')!, title: 'desk 2' }
    desk.threads.set('a', again)
    desk.sync.noteSaved([again], [])
    await vi.advanceTimersByTimeAsync(3000)
    await phone.sync.syncEnv(phone.at)
    expect(phone.threads.get('a')?.title).toBe('desk')
    phone.busy.delete('a')

    // The desktop deletes it: a tombstone, and the phone drops it.
    desk.threads.delete('a')
    desk.sync.noteSaved([], [{ id: 'a', projectPath: again.projectPath }])
    await vi.advanceTimersByTimeAsync(3000)
    expect(files.get('a')).toEqual({ rev: null })
    await phone.sync.syncEnv(phone.at)
    expect(phone.threads.has('a')).toBe(false)
  })

  it('keeps sending a running chat after another device saved it, and keeps its messages when the run ends', async () => {
    const { files, backend } = environment()
    const phone = device('phone-1', backend)
    const desk = device('6f1c-22', backend)
    await phone.sync.attachRemoteChats(phone.source)
    await desk.sync.attachRemoteChats(desk.source)
    const say = (t: Thread, n: number): Thread => ({
      ...t, updatedAt: t.updatedAt + 1,
      messages: [...t.messages, { id: `r${n}`, role: 'agent', createdAt: n, parts: [{ type: 'text', text: `reply ${n}` }] }],
    })

    // The desktop runs a chat and streams its first reply into the environment.
    let run = say({ ...chat('r', desk.path('/home/agent/shop')), seen: false }, 1)
    desk.busy.add('r')
    desk.threads.set('r', run)
    desk.sync.noteSaved([run], [])
    await vi.advanceTimersByTimeAsync(3000)

    // The phone opens it, which marks it seen: a new revision from the phone.
    await phone.sync.syncEnv(phone.at)
    const seen = { ...phone.threads.get('r')!, seen: true }
    phone.threads.set('r', seen)
    phone.sync.noteSaved([seen], [])
    await vi.advanceTimersByTimeAsync(3000)

    // The run goes on: its sends are refused once, then win.
    for (const n of [2, 3]) {
      run = say(desk.threads.get('r')!, n)
      desk.threads.set('r', run)
      desk.sync.noteSaved([run], [])
      await vi.advanceTimersByTimeAsync(3000)
      await vi.advanceTimersByTimeAsync(3000)
    }
    expect((files.get('r') as { json: string }).json).toContain('reply 3')
    await phone.sync.syncEnv(phone.at)
    expect(phone.threads.get('r')?.messages.map(m => m.id)).toEqual(['r-m', 'r1', 'r2', 'r3'])

    // The run ends: the desktop keeps its own messages rather than taking the phone's older copy back.
    desk.busy.delete('r')
    await desk.sync.syncEnv(desk.at)
    expect(desk.threads.get('r')?.messages.map(m => m.id)).toEqual(['r-m', 'r1', 'r2', 'r3'])
  })

  it('sends what the environment lacks, and keeps pending work across a restart', async () => {
    const { files, backend } = environment()
    const storage = memory()
    let phone = device('phone-1', backend, storage)
    const b = chat('b', phone.path('/home/agent/shop'))
    const local = chat('local', '/Users/me/project')
    phone.threads.set('b', b)
    phone.threads.set('local', local)
    await phone.sync.attachRemoteChats(phone.source)
    phone.sync.noteSaved([b, local], [])
    await vi.advanceTimersByTimeAsync(0)
    // Saved for later, then the app is closed before the send.
    expect(JSON.parse(storage.data.get('mango.envChats')!).put).toEqual(['b'])

    phone = device('phone-1', backend, storage)
    phone.threads.set('b', b)
    await phone.sync.attachRemoteChats(phone.source)
    await vi.advanceTimersByTimeAsync(3000)
    expect(files.has('b')).toBe(true)
    expect(files.has('local')).toBe(false)

    // A chat made before mirroring: the next pull sends it.
    const c = chat('c', phone.path('/home/agent/shop'))
    phone.threads.set('c', c)
    await phone.sync.syncEnv(phone.at)
    await vi.advanceTimersByTimeAsync(3000)
    expect(files.has('c')).toBe(true)
  })

  it('retries a failed send later', async () => {
    const { files, backend } = environment()
    let down = true
    const flaky: ChatBackend = { ...backend, chatsPut: (...a) => (down ? Promise.reject(new Error('offline')) : backend.chatsPut(...a)) }
    const phone = device('phone-1', flaky)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await phone.sync.attachRemoteChats(phone.source)
    const d = chat('d', phone.path('/home/agent/shop'))
    phone.threads.set('d', d)
    phone.sync.noteSaved([d], [])
    await vi.advanceTimersByTimeAsync(3000)
    expect(files.has('d')).toBe(false)
    down = false
    await vi.advanceTimersByTimeAsync(30_000)
    expect(files.has('d')).toBe(true)
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })
})
