import { afterEach, describe, expect, it, vi } from 'vitest'
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

  it('adds a worktree beside the project, which then has its own clean branch', async () => {
    const b = createMockBackend()
    const path = 'env://mock-forge/dev/home/agent/work/mango'
    const wt = await b.gitWorktreeAdd(path, 'fix-login')
    expect(wt).toEqual({ path: 'env://mock-forge/dev/home/agent/work/mango.worktrees/fix-login', branch: 'fix-login', isMain: false })
    expect(await b.gitState(wt.path)).toMatchObject({ repo: true, branch: 'fix-login', changes: [] })
    expect((await b.gitWorktrees(path)).worktrees.map(w => w.branch)).toEqual(['main', 'fix-login'])
    await expect(b.gitWorktreeAdd(path, 'fix-login')).rejects.toThrow(/already exists/)
  })

  afterEach(() => { vi.useRealTimers() })

  it('lists releases with Markdown notes, their builds and the build jobs\' logs', async () => {
    const b = createMockBackend()
    const path = 'env://mock-forge/dev/home/agent/work/mango'
    const r = await b.ghReleases(path, 5)
    expect(r.releases).toHaveLength(5)
    expect(r.releases.every(x => x.bodyHtml === '')).toBe(true)
    expect(r.releases[1]!.body).toContain('Simulated')
    const d = await b.ghTagRun(path, r.releases[1]!.tag)
    expect(d?.jobs.length).toBeGreaterThan(0)
    expect((await b.ghJob(path, d!.jobs[0]!.url)).name).toBe(d!.jobs[0]!.name)
    expect(await b.ghTagRun(path, 'nope')).toBeNull()
    // The trial build is still going: it cannot be re-run yet.
    await expect(b.ghRunAction(path, 9002, 'rerun')).rejects.toThrow(/can't re-run it yet/)
  }, 20_000)

  it('shows pull requests in full: checks, jobs with logs, merging, linking and opening', async () => {
    // The mock's delays pass at once.
    vi.useFakeTimers({ now: Date.now() })
    const settle = async <T>(p: Promise<T>): Promise<T> => {
      p.catch(() => {})
      await vi.advanceTimersByTimeAsync(2000)
      return p
    }
    const b = createMockBackend()
    const shop = 'env://mock-forge/dev/home/agent/work/shop-api'
    const ref = { kind: 'pr' as const, host: 'github.com', owner: 'acme', repo: 'shop-api', number: 134 }
    const pr = await settle(b.ghDetail(shop, ref))
    expect(pr).toMatchObject({ state: 'open', mergeState: 'unstable', canMerge: true, defaultMergeMethod: 'squash' })
    expect(pr.body).toMatch(/^## Why/)
    expect(new Set(pr.checkRuns.map(c => c.state))).toEqual(new Set(['success', 'failure', 'pending', 'skipped']))
    expect(pr.checkRuns.some(c => c.workflow === null && c.description)).toBe(true)

    const failing = await settle(b.ghJob(shop, pr.checkRuns.find(c => c.state === 'failure')!.url!))
    expect(failing).toMatchObject({ state: 'failure', logReady: true })
    const lines = failing.steps.flatMap(s => s.lines)
    expect(lines.some(l => l.startsWith('##[group]'))).toBe(true)
    expect(lines.some(l => l.startsWith('##[error]'))).toBe(true)
    expect(lines.some(l => l.startsWith('##[warning]'))).toBe(true)
    expect(lines.some(l => l.startsWith('[command]'))).toBe(true)
    expect(lines.some(l => l.includes('\x1b['))).toBe(true)
    // Every step that ran got its own lines from the split.
    expect(failing.steps.filter(s => s.state !== 'skipped').every(s => s.lines.length > 0)).toBe(true)
    const running = await settle(b.ghJob(shop, pr.checkRuns.find(c => c.state === 'pending')!.url!))
    expect(running).toMatchObject({ state: 'pending', logReady: false })
    expect(running.steps.some(s => s.state === 'pending') && running.steps.some(s => s.state === 'queued')).toBe(true)

    await expect(settle(b.ghMerge(shop, ref, 'squash', '0'.repeat(40)))).rejects.toThrow(/new commits/)
    await settle(b.ghMerge(shop, ref, 'squash', pr.headSha!))
    expect((await settle(b.ghDetail(shop, ref))).state).toBe('merged')
    expect((await settle(b.ghItem(shop, ref))).state).toBe('merged')

    expect((await settle(b.ghResolve(shop, '#97'))).kind).toBe('issue')
    expect((await settle(b.ghResolve(shop, 'https://github.com/acme/shop-api/pull/128'))).state).toBe('merged')
    await expect(settle(b.ghResolve(shop, '#999'))).rejects.toThrow('There is no pull request or issue #999 in acme/shop-api.')
    await expect(settle(b.ghResolve(shop, 'https://gitlab.com/a/b/pull/1'))).rejects.toThrow(/github\.com/)
    await expect(settle(b.ghDetail(shop, { ...ref, repo: 'shop-admin', number: 42 }))).rejects.toThrow(/not signed in/)

    const opened = await settle(b.ghPrCreate(shop, null))
    expect(opened).toMatchObject({ state: 'open', headRef: 'feat/orders', baseRef: 'main', owner: 'acme', repo: 'shop-api' })
    expect((await settle(b.ghPrCreate(shop, 'main'))).number).toBe(opened.number)
    await expect(settle(b.ghPrCreate('env://mock-forge/dev/home/agent/work/mango', null))).rejects.toThrow(/no commits/)
    await expect(settle(b.ghPrCreate(shop, '--force'))).rejects.toThrow(/not a valid branch name/)
  })
})
