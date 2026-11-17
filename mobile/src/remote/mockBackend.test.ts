import { describe, expect, it } from 'vitest'
import { parseShared } from './chatSyncCore'
import { MOCK_ENVS, createMockBackend } from './mockBackend'
import { validHostKey } from './shareLink'

describe('mock backend', () => {
  const [forge, shared] = MOCK_ENVS as [typeof MOCK_ENVS[0], typeof MOCK_ENVS[0]]

  it('has two environments with instances and projects', async () => {
    const b = createMockBackend()
    expect(b.real).toBe(false)
    expect(validHostKey(forge.endpoint.hostKey)).toBe(true)
    expect((await b.instances(forge)).map(i => i.state)).toEqual(['running', 'running', 'stopped'])
    expect((await b.instances(shared))).toEqual([{ name: 'shop', state: 'running', kind: null }])
    const projects = await b.projects(forge, 'dev')
    expect(projects[0]).toEqual({ path: 'env://mock-forge/dev/home/agent/work/mango', name: 'mango', branch: 'main' })
    await expect(b.projects(forge, 'build-vm')).rejects.toThrow(/not running/)
  })

  it('keeps chats in the shared form, with the scripts\' revision rules', async () => {
    const b = createMockBackend()
    const at = { hostId: forge.id, instance: 'dev' }
    const list = await b.chatsList(at)
    expect(list.length).toBeGreaterThan(0)
    const [json] = await b.chatsFetch(at, [list[0]!.id])
    expect(json).toContain('env://@/home/agent/work/mango')
    expect(parseShared(json!, at)?.projectPath).toBe('env://mock-forge/dev/home/agent/work/mango')
    expect(await b.chatsPut(at, list[0]!.id, 0, 1, '{}')).toBe('stale')
    await b.chatsRemove(at, [list[0]!.id])
    expect(await b.chatsPut(at, list[0]!.id, list[0]!.rev!, list[0]!.rev! + 1, '{}')).toBe('gone')
  })

  it('commits and pushes', async () => {
    const b = createMockBackend()
    const path = 'env://mock-forge/dev/home/agent/work/mango'
    const before = await b.gitState(path)
    expect(before.changes.length).toBeGreaterThan(0)
    expect(await b.gitDiff(path, 'src/orders/checkout.ts')).toContain('@@')
    expect(await b.gitCommit(path, 'Orders', ['src/orders/checkout.ts'])).toMatch(/^[0-9a-f]+$/)
    const after = await b.gitState(path)
    expect(after.changes).toHaveLength(before.changes.length - 1)
    expect(await b.gitPush(path)).toMatch(/^Pushed 3 commits/)
    expect((await b.gitState('env://mock-forge/dev/home/agent/work/shop-api')).changes).toEqual([])
  })
})
