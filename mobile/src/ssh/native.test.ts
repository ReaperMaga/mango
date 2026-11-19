import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'

import { MOCK_HOST_KEY, createMockSsh } from './mock'
import { createNativeSsh, type ExitEvent, type LinesEvent, type MangoSshModule } from './native'
import type { SshEndpoint } from './types'

const ENDPOINT: SshEndpoint = { host: '203.0.113.24', port: 22001, user: 'agent', keyId: 'share-a1', hostKey: MOCK_HOST_KEY.key }

/** The native module, faked: it records calls and lets a test emit its events. */
function fakeModule() {
  const listeners: { onLines: ((e: LinesEvent) => void)[]; onExit: ((e: ExitEvent) => void)[] } = { onLines: [], onExit: [] }
  const mod = {
    importKey: vi.fn(async () => {}),
    generateKey: vi.fn(async () => 'ssh-ed25519 AAAA c'),
    publicKey: vi.fn(async () => null),
    deleteKey: vi.fn(async () => {}),
    probeHostKey: vi.fn(async () => MOCK_HOST_KEY),
    run: vi.fn(async () => ({ code: 0, stdout: 'ok\n', stderr: '' })),
    exec: vi.fn(async (_id: string, _e: SshEndpoint, _c: string) => {}),
    write: vi.fn(async () => {}),
    closeStdin: vi.fn(async () => {}),
    kill: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    addListener(event: 'onLines' | 'onExit', listener: (e: never) => void) {
      ;(listeners[event] as ((e: never) => void)[]).push(listener)
      return { remove() {} }
    },
  }
  const lines = (e: LinesEvent) => listeners.onLines.forEach(l => l(e))
  const exit = (e: ExitEvent) => listeners.onExit.forEach(l => l(e))
  return { mod: mod as typeof mod & MangoSshModule, lines, exit }
}

describe('native ssh', () => {
  it('routes lines, stderr and the exit to the stream they belong to', async () => {
    const { mod, lines, exit } = fakeModule()
    let n = 0
    const ssh = createNativeSsh(mod, () => `p${++n}`)
    const a = { onLine: vi.fn(), onStderr: vi.fn(), onExit: vi.fn() }
    const b = { onLine: vi.fn(), onExit: vi.fn() }
    await ssh.exec(ENDPOINT, 'claude -p', a)
    await ssh.exec(ENDPOINT, 'codex exec', b)
    expect(mod.exec.mock.calls.map(c => c[0])).toEqual(['p1', 'p2'])

    lines({ id: 'p1', stream: 'stdout', lines: ['{"type":"init"}', ''] })
    lines({ id: 'p2', stream: 'stdout', lines: ['two'] })
    lines({ id: 'p1', stream: 'stderr', lines: ['warning'] })
    lines({ id: 'p2', stream: 'stderr', lines: ['ignored: b has no onStderr'] })
    lines({ id: 'nobody', stream: 'stdout', lines: ['dropped'] })
    exit({ id: 'p1', code: 0 })
    exit({ id: 'p1', code: 1 })
    lines({ id: 'p1', stream: 'stdout', lines: ['after the end'] })

    expect(a.onLine.mock.calls).toEqual([['{"type":"init"}'], ['']])
    expect(a.onStderr.mock.calls).toEqual([['warning']])
    expect(a.onExit.mock.calls).toEqual([[0]])
    expect(b.onLine.mock.calls).toEqual([['two']])
    expect(b.onExit).not.toHaveBeenCalled()
    exit({ id: 'p2', code: null })
    expect(b.onExit.mock.calls).toEqual([[null]])
  })

  it('passes on the bytes each line took, and marks an unfinished last line', async () => {
    const { mod, lines } = fakeModule()
    const ssh = createNativeSsh(mod, () => 'p')
    const a = { onLine: vi.fn(), onStderr: vi.fn() }
    await ssh.exec(ENDPOINT, 'x', a)
    lines({ id: 'p', stream: 'stdout', lines: ['é', 'b'], sizes: [3, 3] })
    lines({ id: 'p', stream: 'stdout', lines: ['tail'], sizes: [4], partial: true })
    lines({ id: 'p', stream: 'stderr', lines: ['w'], sizes: [2] })
    expect(a.onLine.mock.calls).toEqual([['é', { bytes: 3 }], ['b', { bytes: 3 }], ['tail', { bytes: 4, partial: true }]])
    expect(a.onStderr.mock.calls).toEqual([['w', { bytes: 2 }]])
  })

  it('has the handlers in place before the stream starts', async () => {
    const { mod, lines, exit } = fakeModule()
    const seen: string[] = []
    // The module emits output (and even the end) before its exec promise settles.
    mod.exec.mockImplementation(async id => {
      lines({ id, stream: 'stdout', lines: ['early'] })
      exit({ id, code: 3 })
    })
    const ssh = createNativeSsh(mod)
    await ssh.exec(ENDPOINT, 'true', { onLine: l => seen.push(l), onExit: c => seen.push(`exit ${c}`) })
    expect(seen).toEqual(['early', 'exit 3'])
  })

  it('forgets a stream that failed to start', async () => {
    const { mod, lines } = fakeModule()
    mod.exec.mockRejectedValueOnce(new Error('Connection refused by 203.0.113.24:22001'))
    const ssh = createNativeSsh(mod, () => 'x')
    const onLine = vi.fn()
    await expect(ssh.exec(ENDPOINT, 'true', { onLine })).rejects.toThrow('Connection refused')
    lines({ id: 'x', stream: 'stdout', lines: ['stray'] })
    expect(onLine).not.toHaveBeenCalled()
  })

  it('keeps delivering when a handler throws', async () => {
    const { mod, lines } = fakeModule()
    const ssh = createNativeSsh(mod, () => 'p')
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const got: string[] = []
    await ssh.exec(ENDPOINT, 'true', {
      onLine(l) {
        if (l === 'bad') throw new Error('boom')
        got.push(l)
      },
    })
    lines({ id: 'p', stream: 'stdout', lines: ['a', 'bad', 'b'] })
    expect(got).toEqual(['a', 'b'])
    expect(error).toHaveBeenCalledOnce()
    error.mockRestore()
  })

  it('addresses writes, EOF and kill by the stream id', async () => {
    const { mod } = fakeModule()
    const ssh = createNativeSsh(mod, () => 'p9')
    const p = await ssh.exec(ENDPOINT, 'cat', { onLine() {} })
    await p.write('hello\n')
    await p.closeStdin()
    await p.kill()
    expect(mod.write).toHaveBeenCalledWith('p9', 'hello\n')
    expect(mod.closeStdin).toHaveBeenCalledWith('p9')
    expect(mod.kill).toHaveBeenCalledWith('p9')
  })

  it('passes only the endpoint fields and the options given', async () => {
    const { mod } = fakeModule()
    const ssh = createNativeSsh(mod)
    const extra = { ...ENDPOINT, name: 'dev', joined: true } as SshEndpoint
    await ssh.run(extra, 'echo ok', { stdin: 'x', timeoutMs: 5000 })
    await ssh.run(extra, 'echo ok')
    expect(mod.run.mock.calls).toEqual([
      [ENDPOINT, 'echo ok', { stdin: 'x', timeoutMs: 5000 }],
      [ENDPOINT, 'echo ok', {}],
    ])
    await ssh.disconnect(extra)
    expect(mod.disconnect).toHaveBeenCalledWith(ENDPOINT)
    expect(ssh.real).toBe(true)
  })
})

describe('mock ssh', () => {
  it('keeps keys in memory and connects nowhere', async () => {
    const ssh = createMockSsh()
    expect(ssh.real).toBe(false)
    const line = await ssh.generateKey('k', 'mango-phone')
    expect(line).toMatch(/^ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI\S+ mango-phone$/)
    expect(await ssh.publicKey('k')).toBe(line)
    await ssh.importKey('j', 'nWGxne_9WmC6hEr0kuwsxERJxWl7MmkZcDusAxyuf2A')
    expect(await ssh.publicKey('j')).toMatch(/^ssh-ed25519 \S+$/)
    await ssh.deleteKey('k')
    expect(await ssh.publicKey('k')).toBeNull()
    await expect(ssh.run(ENDPOINT, 'true')).rejects.toThrow('The browser preview has no SSH.')
    await expect(ssh.exec(ENDPOINT, 'true', { onLine() {} })).rejects.toThrow('The browser preview has no SSH.')
  })

  it('probes a well-formed host key with its real fingerprint', async () => {
    const info = await createMockSsh().probeHostKey('example.com', 22)
    const raw = Buffer.from(info.key, 'base64')
    expect(raw.length).toBe(51)
    expect(raw.subarray(4, 15).toString()).toBe('ssh-ed25519')
    const digest = createHash('sha256').update(raw).digest('base64').replace(/=+$/, '')
    expect(info.fingerprint).toBe(`SHA256:${digest}`)
  })
})
