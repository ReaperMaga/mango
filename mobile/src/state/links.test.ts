import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LinkedItem } from '~/types/chat'
import type { GhDetail } from '@/remote/github'

const remote = vi.hoisted(() => ({
  ghDetail: vi.fn(),
  ghResolve: vi.fn(),
  ghMerge: vi.fn(),
  ghJob: vi.fn(),
}))
const threads = vi.hoisted(() => ({
  chat: { id: 'c1', projectPath: 'env://h1/dev/home/agent/shop', links: [] as LinkedItem[] },
  link: vi.fn(),
}))
vi.mock('@/remote', () => ({ backend: remote }))
vi.mock('@/state/threads', () => ({
  useThreads: { getState: () => ({ rootOf: (id: string) => (id === 'c1' ? threads.chat : null), link: threads.link }) },
}))

const { useLinks } = await import('@/state/links')

const PATH = threads.chat.projectPath
const link: LinkedItem = {
  key: 'github.com/acme/shop#42', kind: 'pr', url: 'https://github.com/acme/shop/pull/42', host: 'github.com',
  owner: 'acme', repo: 'shop', number: 42, title: 'Old title', state: 'open', source: 'agent', linkedAt: 1,
}
const detail = (over: Partial<GhDetail> = {}): GhDetail => ({
  provider: 'github',
  kind: 'pr', url: link.url, host: 'github.com', owner: 'acme', repo: 'shop', number: 42, title: 'Add cart', state: 'open',
  stateReason: null, author: null, createdAt: '', updatedAt: '', body: '', labels: [], comments: 0, headRef: 'cart', baseRef: 'main',
  additions: 1, deletions: 0, changedFiles: 1, reviewDecision: null, checks: null, checkRuns: [], headSha: 'abc', mergeable: 'mergeable',
  mergeState: 'clean', mergeMethods: ['squash'], defaultMergeMethod: 'squash', canMerge: true, ...over,
})

/** A promise the test settles by hand. */
function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

beforeEach(() => {
  useLinks.setState({ details: {}, jobs: {} })
  for (const f of Object.values(remote)) f.mockReset()
  threads.link.mockReset()
  threads.chat.links = [link]
})

describe('links store', () => {
  it('reads an item and keeps its title and state on the chat', async () => {
    remote.ghDetail.mockResolvedValue(detail())
    await useLinks.getState().load('c1', link, PATH)
    expect(useLinks.getState().details[link.key]).toMatchObject({ loading: false, error: null, item: { title: 'Add cart' } })
    expect(threads.link).toHaveBeenCalledWith('c1', expect.objectContaining({ key: link.key, title: 'Add cart', state: 'open' }))
  })

  it('does not read again what is fresh, unless forced', async () => {
    remote.ghDetail.mockResolvedValue(detail())
    await useLinks.getState().load('c1', link, PATH)
    await useLinks.getState().load('c1', link, PATH)
    expect(remote.ghDetail).toHaveBeenCalledTimes(1)
    await useLinks.getState().load('c1', link, PATH, true)
    expect(remote.ghDetail).toHaveBeenCalledTimes(2)
  })

  it('lets the newest read win', async () => {
    const first = deferred<GhDetail>()
    const second = deferred<GhDetail>()
    remote.ghDetail.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const a = useLinks.getState().load('c1', link, PATH, true)
    const b = useLinks.getState().load('c1', link, PATH, true)
    second.resolve(detail({ title: 'Newer' }))
    await b
    first.resolve(detail({ title: 'Older' }))
    await a
    expect(useLinks.getState().details[link.key]?.item?.title).toBe('Newer')
  })

  it('keeps what it had when a read fails, with the reason', async () => {
    remote.ghDetail.mockResolvedValueOnce(detail())
    await useLinks.getState().load('c1', link, PATH)
    remote.ghDetail.mockRejectedValueOnce(new Error('The GitHub CLI in dev is not signed in.'))
    await useLinks.getState().load('c1', link, PATH, true)
    expect(useLinks.getState().details[link.key]).toMatchObject({ error: 'The GitHub CLI in dev is not signed in.', item: { title: 'Add cart' } })
  })

  it('never reads a link that is not on github.com', async () => {
    await useLinks.getState().load('c1', { ...link, key: 'evil.example/acme/shop#42', host: 'evil.example' }, PATH)
    expect(remote.ghDetail).not.toHaveBeenCalled()
    expect(useLinks.getState().details['evil.example/acme/shop#42']?.error).toContain('github.com')
  })

  it('merges at the head it read, then reads again', async () => {
    remote.ghDetail.mockResolvedValueOnce(detail()).mockResolvedValueOnce(detail({ state: 'merged' }))
    await useLinks.getState().load('c1', link, PATH)
    remote.ghMerge.mockResolvedValue(undefined)
    await useLinks.getState().merge('c1', link, PATH, 'squash')
    expect(remote.ghMerge).toHaveBeenCalledWith(PATH, link, 'squash', 'abc')
    expect(useLinks.getState().details[link.key]?.item?.state).toBe('merged')
  })

  it('refuses to merge what it never read', async () => {
    await expect(useLinks.getState().merge('c1', link, PATH, 'squash')).rejects.toThrow('Read the pull request again')
    expect(remote.ghMerge).not.toHaveBeenCalled()
  })

  it('links by reference, turning down nonsense before asking', async () => {
    await expect(useLinks.getState().linkByReference('c1', 'rm -rf ~')).rejects.toThrow('github.com or GitLab link')
    expect(remote.ghResolve).not.toHaveBeenCalled()
    remote.ghResolve.mockResolvedValue(detail({ number: 7, url: 'https://github.com/acme/shop/pull/7' }))
    const made = await useLinks.getState().linkByReference('c1', ' #7 ')
    expect(remote.ghResolve).toHaveBeenCalledWith(PATH, '#7')
    expect(made).toMatchObject({ key: 'github.com/acme/shop#7', number: 7, source: 'user' })
    expect(threads.link).toHaveBeenCalledWith('c1', made)
    expect(useLinks.getState().details[made.key]?.item?.number).toBe(7)
  })

  it('reads jobs only from an Actions link, and retries what failed', async () => {
    await useLinks.getState().loadJob(PATH, 'https://evil.example/x')
    expect(remote.ghJob).not.toHaveBeenCalled()
    const url = 'https://github.com/acme/shop/actions/runs/1/job/2'
    remote.ghJob.mockRejectedValueOnce(new Error('offline'))
    await useLinks.getState().loadJob(PATH, url)
    expect(useLinks.getState().jobs[url]?.error).toBe('offline')
    remote.ghJob.mockResolvedValueOnce({ id: 2, name: 'test', workflow: 'CI', url, state: 'success', startedAt: null, completedAt: null, steps: [], logReady: true, logError: null, logTruncated: false })
    useLinks.getState().retryFailed()
    await vi.waitFor(() => expect(useLinks.getState().jobs[url]?.job?.name).toBe('test'))
  })
})
