import { describe, expect, it } from 'vitest'
import {
  asAgent, asAgentPlain, inInstance, line, quote, remotePrefix, target, utcText,
  validEnvKey, validInstance, validInstanceDir, validRemote, validSshDest,
} from './shell'
import type { Env } from './types'

/** Ported from `src-tauri/src/envs/ssh.rs` and `envs/mod.rs`. */

const HOST_KEY = 'AAAAC3NzaC1lZDI1NTE5AAAAIAUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUF'

function server(): Env {
  return {
    id: 'h',
    name: 'Lab',
    endpoint: { host: 'lab', port: 2222, user: 'me', keyId: 'k', hostKey: HOST_KEY },
    server: { incusRemote: 'os1' },
    addedAt: 0,
  }
}

function joined(): Env {
  return {
    id: 'j',
    name: 'dev (shared)',
    endpoint: { host: '203.0.113.24', port: 22001, user: 'agent', keyId: 'k2', hostKey: HOST_KEY },
    joined: { instance: 'dev', sharedFrom: 'forge/dev', shareId: 's1', expiresAt: null },
    addedAt: 0,
  }
}

describe('shell lines', () => {
  it('quotes', () => {
    expect(quote('incus')).toBe('incus')
    expect(quote('os1:dev')).toBe('os1:dev')
    expect(quote('')).toBe("''")
    expect(quote('a b')).toBe("'a b'")
    expect(quote("it's")).toBe(`'it'\\''s'`)
    expect(quote('$(id)')).toBe("'$(id)'")
    expect(quote('x;y')).toBe("'x;y'")
    expect(quote('é')).toBe("'é'")
  })

  it('targets incus remotes', () => {
    const h = server()
    expect(target(h, 'dev')).toBe('os1:dev')
    const local = { ...h, server: { incusRemote: null } }
    expect(target(local, 'dev')).toBe('dev')
    expect(remotePrefix(local)).toBeNull()
    expect(remotePrefix(h)).toBe('os1:')

    const inner = asAgent('/home/agent/work/my app', [['K', 'v w']], ['claude', '-p'])
    const l = line(inInstance(h, 'dev', 'batch', inner))
    expect(l.startsWith('incus exec os1:dev -T -- runuser -u agent -- env HOME=/home/agent')).toBe(true)
    expect(l).toContain("'K=v w'")
    expect(l.endsWith("mango '/home/agent/work/my app' claude -p")).toBe(true)
  })

  it('uses sudo instead of incus in a joined environment', () => {
    const h = joined()
    expect(line(inInstance(h, 'dev', 'batch', ['sh', '-c', 'id -u']))).toBe("sudo -n -- sh -c 'id -u'")
    // As the agent: SSH already is the agent user, so no sudo and no runuser.
    const inner = asAgent('/home/agent/work', [], ['claude'])
    let l = line(inInstance(h, 'dev', 'tty', inner))
    expect(l.startsWith('env HOME=/home/agent USER=agent')).toBe(true)
    expect(l.endsWith('mango /home/agent/work claude')).toBe(true)
    // Another user in the link: through sudo, which runs runuser as root.
    const other = { ...h, endpoint: { ...h.endpoint, user: 'dev' } }
    l = line(inInstance(other, 'dev', 'batch', inner))
    expect(l.startsWith('sudo -n -- runuser -u agent -- env')).toBe(true)
    // Only the shared environment.
    expect(() => inInstance(h, 'other', 'batch', inner)).toThrow(/dev only/)
    // A server still goes through incus.
    expect(line(inInstance(server(), 'dev', 'batch', inner)).startsWith('incus exec os1:dev -T -- runuser')).toBe(true)
  })

  it('skips the login shell for plain reads', () => {
    const login = asAgent('/w', [], ['git', 'status'])
    const plain = asAgentPlain('/w', [], ['git', 'status'])
    expect(login).toContain('-lc')
    expect(plain).toContain('-c')
    expect(plain).not.toContain('-lc')
    const script = plain.find(a => a.startsWith('PATH='))!
    expect(script).toContain('$HOME/.local/bin:')
    expect(script).toContain('cd -- "$1"')
    expect(plain.slice(-4)).toEqual(['mango', '/w', 'git', 'status'])
    expect(asAgent(null, [], ['x']).slice(-2)).toEqual(['/home/agent', 'x'])
  })
})

describe('validators', () => {
  it('instance names', () => {
    for (const ok of ['dev', 'mango-1', 'a']) expect(() => validInstance(ok)).not.toThrow()
    for (const bad of ['', '1abc', 'dev-', 'a_b', 'a.b', '-x', 'a'.repeat(64)]) expect(() => validInstance(bad)).toThrow()
  })

  it('other values', () => {
    expect(() => validInstanceDir('/home/agent/work/my app')).not.toThrow()
    expect(() => validInstanceDir('work')).toThrow()
    expect(() => validInstanceDir('/home/../etc')).toThrow()
    expect(() => validInstanceDir('/a\nb')).toThrow()
    expect(() => validRemote('incusos-1')).not.toThrow()
    expect(() => validRemote('a:b')).toThrow()
    expect(validEnvKey('CLAUDE_CODE_X')).toBe(true)
    expect(validEnvKey('A=B')).toBe(false)
    expect(validEnvKey('1A')).toBe(false)
  })

  it('ssh destinations', () => {
    for (const ok of ['master', 'me@10.0.0.4', 'ops@incus.example.com', 'box_1']) expect(() => validSshDest(ok)).not.toThrow()
    for (const bad of ['', '-oProxyCommand=x', 'a b', 'me@host;rm', 'x$(id)', 'a\nb']) expect(() => validSshDest(bad)).toThrow()
  })

  it('utc dates', () => {
    expect(utcText(0)).toBe('1970-01-01 00:00 UTC')
    expect(utcText(951_868_800_500)).toBe('2000-03-01 00:00 UTC')
    expect(utcText(1_793_518_930_123)).toBe('2026-11-01 07:42 UTC')
  })
})
