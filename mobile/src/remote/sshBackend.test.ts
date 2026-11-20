import { describe, expect, it } from 'vitest'
import type { ExecHandlers, RunOptions, RunResult, SshApi, SshEndpoint } from '@/ssh/types'
import { toBase64, utf8Encode } from './bytes'
import { line } from './shell'
import {
  attachLine, closeLine, createSshBackend, explain, hint, isConnectionLoss, parseInstances, parseProjectPath, spawnLine, stopLine,
  RUN_SCRIPT, STOP_SCRIPT, RUN_TAG,
} from './sshBackend'
import type { Env } from './types'

/** Ported from the tests of `envs/ssh.rs`, `agent_proc.rs` and `envs/incus.rs`, plus the backend over a fake SSH. */

const HOST_KEY = 'AAAAC3NzaC1lZDI1NTE5AAAAIAUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUF'

function server(): Env {
  return {
    id: 'h',
    name: 'Lab',
    endpoint: { host: 'lab', port: 22, user: 'me', keyId: 'k', hostKey: HOST_KEY },
    server: { incusRemote: 'os1' },
    addedAt: 0,
  }
}

function joined(expiresAt: number | null = null): Env {
  return {
    id: 'j',
    name: 'dev (shared)',
    endpoint: { host: '203.0.113.24', port: 22001, user: 'agent', keyId: 'k2', hostKey: HOST_KEY },
    joined: { instance: 'dev', sharedFrom: 'forge/dev', shareId: 's1', expiresAt },
    addedAt: 0,
  }
}

describe('errors', () => {
  it('explains a joined environment', () => {
    const h = joined()
    const changed = '@@@@@@@@@@@\n@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @\nHost key verification failed.'
    expect(explain(h, 255, changed, '')).toContain('identity changed')
    let e = explain(h, 255, 'agent@203.0.113.24: Permission denied (publickey).', '')
    expect(e).toContain('no longer accepts this link')
    expect(e).toContain('forge/dev')
    e = explain(joined(1000), 255, 'agent@203.0.113.24: Permission denied (publickey).', '')
    expect(e.startsWith('Your access to dev (shared) ended on 1970-01-01')).toBe(true)
    e = explain(h, 255, 'ssh: connect to host 203.0.113.24 port 22001: Connection refused', '')
    expect(e.startsWith('Could not reach dev (shared) at 203.0.113.24 port 22001.')).toBe(true)
    expect(e).toContain('firewall')
    const ts = { ...h, endpoint: { ...h.endpoint, host: '100.101.7.8' } }
    expect(explain(ts, 255, 'ssh: connect to host 100.101.7.8 port 22: Connection timed out', '')).toContain('tailnet')
    expect(explain(h, 1, 'sudo: a password is required', '')).toContain('Base system')
    // Anything else reads as it does for a server.
    expect(explain(h, 2, 'boom', '')).toBe('boom')
  })

  it('explains a server', () => {
    const h = server()
    expect(explain(h, 255, 'Authentication failed', '')).toMatch(/^Lab refused the SSH sign-in\. .*authorized_keys/)
    expect(explain(h, 255, 'Host key mismatch for lab', '')).toMatch(/identity changed since this phone trusted it/)
    expect(explain(h, 127, 'bash: incus: command not found', '')).toMatch(/no `incus` command/)
    expect(explain(h, 3, '', '')).toBe('The command on Lab failed (exit 3).')
  })
})

describe('agent runs', () => {
  it('runs the CLI as the agent, tagged', () => {
    const argv = spawnLine(server(), 'dev', '/home/agent/work/my app', { B: '2', A: 'x y' }, 'run-1', 'claude', ['-p', '--output-format', 'stream-json'])
    const l = line(argv)
    expect(l.startsWith('incus exec os1:dev -T -- runuser -u agent -- env HOME=/home/agent')).toBe(true)
    expect(l).toContain(" 'A=x y' B=2 MANGO_RUN=run-1 bash -lc ")
    // Started detached through RUN_SCRIPT, from the project folder.
    expect(l).toContain(" mango '/home/agent/work/my app' sh -c '# mango-run:")
    expect(l.endsWith("' mango-run start run-1 claude -p --output-format stream-json")).toBe(true)
    // No folder: the agent's home.
    expect(line(spawnLine(server(), 'dev', ' ', undefined, 'r', 'codex', [])).endsWith("' mango-run start r codex")).toBe(true)
    expect(line(spawnLine(server(), 'dev', ' ', undefined, 'r', 'codex', []))).toContain(' mango /home/agent sh -c ')
    // Attach and close: from the agent's home, only the tag passed.
    const a = line(attachLine(server(), 'dev', 'run-1', 120, 7))
    expect(a).toContain(' SHELL=/bin/bash MANGO_RUN=run-1 bash -lc ')
    expect(a).toContain(' mango /home/agent sh -c ')
    expect(a.endsWith("' mango-run attach run-1 120 7")).toBe(true)
    expect(line(closeLine(joined(), 'dev', 'run-1')).endsWith("' mango-run close run-1")).toBe(true)
    expect(() => attachLine(server(), 'dev', 'run;1', 0, 0)).toThrow()
    expect(() => attachLine(server(), 'dev', 'run-1', -1, 0)).toThrow()
    expect(() => spawnLine(server(), 'dev', '', undefined, '../x', 'claude', [])).toThrow()
  })

  it('refuses bad input', () => {
    const h = server()
    expect(() => spawnLine(h, 'dev;rm', '', undefined, 'r', 'claude', [])).toThrow()
    expect(() => spawnLine(h, 'dev', 'work', undefined, 'r', 'claude', [])).toThrow()
    expect(() => spawnLine(h, 'dev', '/a/../etc', undefined, 'r', 'claude', [])).toThrow()
    expect(() => spawnLine(h, 'dev', '', { 'A=B': 'x' }, 'r', 'claude', [])).toThrow()
    expect(() => spawnLine(h, 'dev', '', { [RUN_TAG]: 'other' }, 'r', 'claude', [])).toThrow()
    expect(() => spawnLine(h, 'dev', '', undefined, 'r', 'claude', ['a\0b'])).toThrow()
  })

  it('stops the run by its tag', () => {
    const l = line(stopLine(server(), 'dev', '6f1c-77'))
    expect(l.startsWith("incus exec os1:dev -T -- sh -c '")).toBe(true)
    expect(l.endsWith("' mango-stop 6f1c-77")).toBe(true)
    expect(STOP_SCRIPT).toContain(`${RUN_TAG}=$1`)
    // The awk program's quotes survive the remote shell as one word.
    expect(l).toContain('awk -v roots=')
    expect(l).toContain(`'\\''`)
    expect(line(stopLine(joined(), 'dev', 'r')).startsWith("sudo -n -- sh -c '")).toBe(true)
  })

  it('hints', () => {
    const h = server()
    let m = hint(h, 'dev', 'claude', 255, 'me@lab: Permission denied (publickey).', false)!
    expect(m.startsWith('Mango: Lab refused the SSH sign-in.')).toBe(true)
    expect(m).not.toContain('\n')
    m = hint(h, 'dev', 'claude', 1, 'Error: Instance is not running', false)!
    expect(m).toContain('dev is not running')
    m = hint(h, 'dev', 'claude', 127, 'mango: line 1: exec: claude: not found', false)!
    expect(m).toContain('claude is not installed')
    // A dropped connection is no end any more: the run is attached again, nothing to explain.
    expect(hint(h, 'dev', 'claude', 255, '', true)).toBeNull()
    expect(hint(h, 'dev', 'claude', null, '', true)).toBeNull()
    expect(hint(h, 'dev', 'claude', 1, 'some CLI error', true)).toBeNull()
    expect(hint(h, 'dev', 'claude', 0, '', false)).toBeNull()
  })
})

describe('parsing', () => {
  it('reads incus instances', () => {
    const json = JSON.stringify([
      { name: 'dev', status: 'Running', type: 'container', state: { status: 'Running' } },
      { name: 'build-vm', status: 'Stopped', type: 'virtual-machine', state: { status: 'Stopped', network: null } },
      { name: 'odd', status: 'Freezing', type: 'container', state: null },
      { nameless: true },
    ])
    expect(parseInstances(json)).toEqual([
      { name: 'dev', state: 'running', kind: 'container' },
      { name: 'build-vm', state: 'stopped', kind: 'virtual-machine' },
      { name: 'odd', state: 'frozen', kind: 'container' },
    ])
    expect(() => parseInstances('nope')).toThrow(/not readable/)
  })

  it('reads env:// paths', () => {
    expect(parseProjectPath('env://6f1c-22/dev/home/agent/work/my shop')).toEqual({ hostId: '6f1c-22', instance: 'dev', dir: '/home/agent/work/my shop' })
    expect(parseProjectPath('env://h/dev').dir).toBe('/')
    for (const bad of ['/home/me', 'env://', 'env://h', 'env:///dev/x', 'env://h/1dev/x', 'env://h/dev/a/../b', 'env://h;x/dev/a', 'env://h/dev/a\nb']) {
      expect(() => parseProjectPath(bad), bad).toThrow()
    }
  })
})

/* ---------- the backend over a fake SSH ---------- */

interface Call { command: string; options?: RunOptions }

/** What `BATCH` prints for these results. */
function batchOut(outs: { code: number; stdout?: string; stderr?: string }[]): string {
  return outs.map((o) => {
    const out = utf8Encode(o.stdout ?? '')
    const err = utf8Encode(o.stderr ?? '')
    return `MANGO-RUN ${o.code} ${out.length} ${err.length}\n${toBase64(out)}\n${toBase64(err)}\n`
  }).join('')
}

function fakeSsh(answer: (command: string, call: number) => RunResult | Error) {
  const calls: Call[] = []
  const execs: { command: string; handlers: ExecHandlers; killed: boolean; written: string[] }[] = []
  const api: SshApi = {
    real: true,
    async importKey() {},
    async generateKey() { return 'ssh-ed25519 AAAA test' },
    async publicKey() { return null },
    async deleteKey() {},
    async probeHostKey() { return { type: 'ssh-ed25519', key: HOST_KEY, fingerprint: 'SHA256:x' } },
    async run(_ep: SshEndpoint, command: string, options?: RunOptions) {
      calls.push({ command, options })
      const r = answer(command, calls.length)
      if (r instanceof Error) throw r
      return r
    },
    async exec(_ep, command, handlers) {
      const e = { command, handlers, killed: false, written: [] as string[] }
      execs.push(e)
      return {
        async write(d: string) { e.written.push(d) },
        async closeStdin() {},
        async kill() { e.killed = true },
      }
    },
    async disconnect() {},
  }
  return { api, calls, execs }
}

const H = '1111111111111111111111111111111111111111'

function backendWith(answer: (command: string, call: number) => RunResult | Error, envs: Env[] = [server(), joined()]) {
  const f = fakeSsh(answer)
  const b = createSshBackend({ ssh: f.api, newId: () => 'run-1', now: () => 5000 })
  b.setEnvLookup(id => envs.find(e => e.id === id) ?? null)
  return { b, ...f }
}

describe('ssh backend', () => {
  it('saves a chat in one call, data on stdin', async () => {
    const { b, calls } = backendWith(() => ({ code: 0, stdout: 'ok\n', stderr: '' }))
    expect(await b.chatsPut({ hostId: 'j', instance: 'dev' }, 'c-1', 0, 10, '{"id":"c-1"}')).toBe('ok')
    expect(calls).toHaveLength(1)
    // Joined: SSH is already the agent user, so straight to `env … bash -c`, without a login shell.
    expect(calls[0]!.command.startsWith('env HOME=/home/agent USER=agent LOGNAME=agent SHELL=/bin/bash bash -c ')).toBe(true)
    expect(calls[0]!.command.endsWith(' sh c-1 0 10')).toBe(true)
    expect(calls[0]!.options?.stdin).toBe('{"id":"c-1"}')
    // Checked before anything is sent.
    await expect(b.chatsPut({ hostId: 'j', instance: 'dev' }, '../x', 0, 10, '{}')).rejects.toThrow(/not a chat id/)
    await expect(b.chatsPut({ hostId: 'j', instance: 'dev' }, 'c', 5, 5, '{}')).rejects.toThrow(/newer/)
    await expect(b.chatsPut({ hostId: 'j', instance: 'dev' }, 'c', 0, 1, '{bad')).rejects.toThrow(/not valid JSON/)
    await expect(b.chatsList({ hostId: 'j', instance: 'other' })).rejects.toThrow(/dev only/)
    expect(calls).toHaveLength(1)
  })

  it('reads git state in one round trip, and falls back to the login shell for good', async () => {
    const status = `# branch.oid ${H}\0# branch.head main\0# branch.upstream origin/main\0# branch.ab +1 -0\0`
      + `1 .M N... 100644 100644 100644 ${H} ${H} src/a.ts\0? notes.md\0`
    const good = batchOut([{ code: 0, stdout: '/home/agent/work/shop\n' }, { code: 0, stdout: status }, { code: 0, stdout: '2\t1\tsrc/a.ts\0' }])
    const { b, calls } = backendWith((command, n) => {
      if (n === 1) return { code: 0, stdout: batchOut([{ code: 127, stderr: 'env: \'git\': No such file or directory' }, { code: 127 }, { code: 127 }]), stderr: '' }
      return { code: 0, stdout: `profile says hi\n${good}`, stderr: '' }
    })
    const path = 'env://h/dev/home/agent/work/shop/src'
    const s = await b.gitState(path)
    expect(calls).toHaveLength(2)
    expect(calls[0]!.command).toContain(' bash -c ')
    expect(calls[0]!.command).not.toContain(' bash -lc ')
    expect(calls[1]!.command).toContain(' bash -lc ')
    expect(calls[1]!.command.startsWith('incus exec os1:dev -T -- runuser -u agent -- env HOME=/home/agent')).toBe(true)
    expect(s).toEqual({
      repo: true, branch: 'main', ahead: 1, behind: 0, upstream: true,
      changes: [
        { path: 'src/a.ts', kind: 'modified', staged: false, additions: 2, deletions: 1 },
        { path: 'notes.md', kind: 'untracked', staged: false, additions: null, deletions: null },
      ],
    })
    await b.gitState(path)
    expect(calls).toHaveLength(3)
    expect(calls[2]!.command).toContain(' bash -lc ')
  })

  it('diffs an untracked file from the known status, at the work tree root', async () => {
    const status = `# branch.oid ${H}\0# branch.head main\0? notes.md\0`
    let n = 0
    const { b, calls } = backendWith(() => {
      n++
      if (n === 1) return { code: 0, stdout: batchOut([{ code: 0, stdout: '/home/agent/work/shop\n' }, { code: 0, stdout: status }, { code: 0 }]), stderr: '' }
      return { code: 0, stdout: batchOut([{ code: 0, stdout: '+hello\n' }]), stderr: '' }
    })
    await b.gitState('env://h/dev/home/agent/work/shop/src')
    expect(await b.gitDiff('env://h/dev/home/agent/work/shop/src', 'notes.md')).toBe('+hello\n')
    expect(calls).toHaveLength(2)
    expect(calls[1]!.command).toContain(" mango /home/agent/work/shop bash -c ")
    await expect(b.gitDiff('env://h/dev/home/agent/work/shop', '../etc/passwd')).rejects.toThrow(/inside the repository/)
  })

  it('explains connection failures and a stopped instance', async () => {
    const { b } = backendWith((command) => {
      if (command.includes('chats')) return { code: 1, stdout: '', stderr: 'Error: Instance is not running\n' }
      return new Error('Connection refused')
    })
    await expect(b.instances(joined())).rejects.toThrow(/^Could not reach dev \(shared\) at 203\.0\.113\.24 port 22001\./)
    await expect(b.chatsList({ hostId: 'h', instance: 'dev' })).rejects.toThrow('Error: Instance is not running')
  })

  it('lists a server\'s instances', async () => {
    const { b, calls } = backendWith(() => ({ code: 0, stdout: JSON.stringify([{ name: 'dev', type: 'container', state: { status: 'Running' } }]), stderr: '' }))
    expect(await b.instances(server())).toEqual([{ name: 'dev', state: 'running', kind: 'container' }])
    expect(calls[0]!.command).toBe('incus list os1: --format json')
  })

  it('spawns an agent, and stops it by its tag', async () => {
    const { b, calls, execs } = backendWith(() => ({ code: 0, stdout: '', stderr: '' }))
    const lines: string[] = []
    const errs: string[] = []
    let exit: number | null | undefined
    const t = await b.spawnFor('claude', 'env://h/dev/home/agent/work/shop')(['-p'], {
      onLine: l => lines.push(l),
      onStderr: l => errs.push(l),
      onExit: (c) => { exit = c },
    }, { CLAUDE_X: '1' })
    expect(execs[0]!.command).toContain(' CLAUDE_X=1 MANGO_RUN=run-1 bash -lc ')
    expect(execs[0]!.command.endsWith('mango-run start run-1 claude -p')).toBe(true)
    await t.write('{"type":"user"}')
    expect(execs[0]!.written).toEqual(['{"type":"user"}\n'])
    // Login-shell noise, then the script's marker on each stream: only what follows is the run's.
    execs[0]!.handlers.onLine('Welcome to dev')
    execs[0]!.handlers.onLine('mango-run:attached')
    execs[0]!.handlers.onStderr?.('motd says hi')
    execs[0]!.handlers.onStderr?.('mango-run:attached')
    execs[0]!.handlers.onLine('{"a":1}\r')
    execs[0]!.handlers.onLine('')
    expect(lines).toEqual(['{"a":1}'])
    // The run ends: the script's marker carries its code, and is not shown.
    execs[0]!.handlers.onStderr?.('mango-run:exit 0')
    execs[0]!.handlers.onExit?.(0)
    expect(errs).toEqual([])
    expect(exit).toBe(0)

    // Stopped on request: no hint, the channel closes and the tag is stopped.
    const t2 = await b.spawnFor('codex', 'env://h/dev')([], { onLine() {}, onStderr: l => errs.push(l) })
    expect(execs[1]!.command.endsWith("' mango-run start run-1 codex")).toBe(true)
    await t2.kill()
    execs[1]!.handlers.onExit?.(null)
    expect(execs[1]!.killed).toBe(true)
    expect(errs).toEqual([])
    await new Promise(r => setTimeout(r, 0))
    expect(calls.filter(c => c.command.endsWith(' mango-stop run-1'))).toHaveLength(1)
    await expect(b.spawnFor('claude', 'env://gone/dev')([], { onLine() {} })).rejects.toThrow(/no longer in Mango's list/)
  })

  it('adds a worktree beside the repository: one read, then `git worktree add` in the login shell', async () => {
    const list = `worktree /home/agent/work/shop\0HEAD ${H}\0branch refs/heads/main\0\0`
    const { b, calls } = backendWith((_c, n) => {
      if (n === 1) return { code: 0, stdout: batchOut([{ code: 0, stdout: '/home/agent/work/shop\n' }, { code: 0, stdout: list }, { code: 0, stdout: 'fix-login\n' }, { code: 1 }]), stderr: '' }
      return { code: 0, stdout: '', stderr: "Preparing worktree (new branch 'fix-login')" }
    })
    const wt = await b.gitWorktreeAdd('env://h/dev/home/agent/work/shop/src', 'fix-login')
    expect(wt).toEqual({ path: 'env://h/dev/home/agent/work/shop.worktrees/fix-login', branch: 'fix-login', isMain: false })
    expect(calls).toHaveLength(2)
    expect(calls[0]!.command).toContain(' check-ref-format --branch fix-login ')
    expect(calls[0]!.command).toContain(' show-ref --verify --quiet refs/heads/fix-login')
    const add = calls[1]!.command
    expect(add.startsWith('incus exec os1:dev -T -- runuser -u agent -- env HOME=/home/agent')).toBe(true)
    expect(add).toContain(' bash -lc ')
    expect(add).toContain(' GIT_TERMINAL_PROMPT=0 GIT_LITERAL_PATHSPECS=1 ')
    expect(add.endsWith(' mango /home/agent/work/shop git --no-pager -c core.quotepath=off -c color.ui=never worktree add -b fix-login -- /home/agent/work/shop.worktrees/fix-login')).toBe(true)
  })

  it('refuses a taken or unsafe branch before adding anything, and words git\'s refusal', async () => {
    const list = `worktree /home/agent/work/my shop\0HEAD ${H}\0branch refs/heads/main\0\0`
    const read = (taken: boolean) => ({ code: 0, stdout: batchOut([{ code: 0, stdout: '/home/agent/work/my shop\n' }, { code: 0, stdout: list }, { code: 0 }, { code: taken ? 0 : 1 }]), stderr: '' })
    let { b, calls } = backendWith(() => read(true))
    await expect(b.gitWorktreeAdd('env://h/dev/home/agent/work/my shop', 'main')).rejects.toThrow('A branch named "main" already exists')
    expect(calls).toHaveLength(1)
    await expect(b.gitWorktreeAdd('env://h/dev/home/agent/work/my shop', '--force')).rejects.toThrow(/not a valid branch name/)
    await expect(b.gitWorktreeAdd('env://h/dev/home/agent/work/my shop', 'a b')).rejects.toThrow(/not a valid branch name/)
    expect(calls).toHaveLength(1);

    ({ b, calls } = backendWith((_c, n) => (n === 1 ? read(false) : { code: 128, stdout: '', stderr: "fatal: '/home/agent/work/my shop.worktrees/x' already exists\n" })))
    await expect(b.gitWorktreeAdd('env://h/dev/home/agent/work/my shop', 'x')).rejects.toThrow('env://h/dev/home/agent/work/my shop.worktrees/x already exists; pick another branch name')
    // The folder with a space reaches the shell as one quoted word.
    expect(calls[1]!.command).toContain(" -- '/home/agent/work/my shop.worktrees/x'")
  })

  it('lists worktrees and local branches in one round trip', async () => {
    const list = `worktree /home/agent/work/shop\0HEAD ${H}\0branch refs/heads/main\0\0worktree /home/agent/work/shop.worktrees/fix\0HEAD ${H}\0branch refs/heads/fix\0\0`
    const { b, calls } = backendWith(() => ({ code: 0, stdout: batchOut([{ code: 0, stdout: '/home/agent/work/shop\n' }, { code: 0, stdout: list }, { code: 0, stdout: 'refs/heads/fix\nrefs/heads/main\n' }]), stderr: '' }))
    expect(await b.gitWorktrees('env://h/dev/home/agent/work/shop')).toEqual({
      worktrees: [
        { path: 'env://h/dev/home/agent/work/shop', branch: 'main', isMain: true },
        { path: 'env://h/dev/home/agent/work/shop.worktrees/fix', branch: 'fix', isMain: false },
      ],
      branches: ['fix', 'main'],
    })
    expect(calls).toHaveLength(1)
  })

  it('reads a pull request in full with gh from the agent\'s home, and resolves #N from the remotes in one more call', async () => {
    const answer = JSON.stringify({ data: { repository: { viewerPermission: 'WRITE', squashMergeAllowed: true, issueOrPullRequest: {
      __typename: 'PullRequest', title: 'Fix', number: 12, state: 'OPEN', isDraft: false, body: '## Hi', headRefOid: H,
    } } } })
    const { b, calls } = backendWith((command) => {
      if (command.includes(' remote -v')) return { code: 0, stdout: batchOut([{ code: 0, stdout: 'origin\tgit@github.com:acme/shop.git (fetch)\norigin\tgit@github.com:acme/shop.git (push)\n' }]), stderr: '' }
      return { code: 0, stdout: answer, stderr: '' }
    })
    const ref = { kind: 'pr' as const, host: 'github.com', owner: 'acme', repo: 'shop', number: 12 }
    const d = await b.ghDetail('env://h/dev/home/agent/work/shop', ref)
    expect(d).toMatchObject({ kind: 'pr', title: 'Fix', body: '## Hi', state: 'open', mergeMethods: ['squash'], canMerge: true })
    expect(calls).toHaveLength(1)
    const c = calls[0]!.command
    expect(c).toContain(' GH_PROMPT_DISABLED=1 ')
    expect(c).toContain(' mango /home/agent gh api graphql --hostname github.com -f owner=acme -f name=shop -F number=12 ')
    // The query is one quoted word.
    expect(c).toContain(" 'query=query($owner: String!, $name: String!, $number: Int!) {")

    expect((await b.ghResolve('env://h/dev/home/agent/work/shop', ' #12 ')).number).toBe(12)
    expect(calls).toHaveLength(3)
    expect(calls[1]!.command).toContain(" mango /home/agent/work/shop bash -c ")
    expect(calls[2]!.command).toContain(' -f owner=acme -f name=shop -F number=12 ')
    await b.ghResolve('env://h/dev/home/agent/work/shop', 'https://github.com/other/repo/pull/3')
    expect(calls).toHaveLength(4)
    // Refused before anything is sent.
    await expect(b.ghResolve('env://h/dev/x', 'https://gitlab.com/a/b/pull/1')).rejects.toThrow(/github\.com/)
    await expect(b.ghResolve('env://h/dev/x', 'a;rm/b#1')).rejects.toThrow(/Paste a pull request/)
    await expect(b.ghDetail('env://h/dev/x', { ...ref, owner: 'a;rm' })).rejects.toThrow(/github\.com/)
    expect(calls).toHaveLength(4)
  })

  it('merges with the sha, and words a refusal', async () => {
    const { b, calls } = backendWith(() => ({ code: 1, stdout: '{"message":"Head branch was modified."}', stderr: 'gh: Head branch was modified. (HTTP 409)' }))
    const ref = { kind: 'pr' as const, host: 'github.com', owner: 'acme', repo: 'shop', number: 12 }
    await expect(b.ghMerge('env://h/dev/x', ref, 'squash', H)).rejects.toThrow(/new commits/)
    expect(calls[0]!.command).toContain(` gh api --hostname github.com --method PUT repos/acme/shop/pulls/12/merge -f merge_method=squash -f sha=${H}`)
    await expect(b.ghMerge('env://h/dev/x', ref, 'octopus' as never, H)).rejects.toThrow(/not a merge method/)
    await expect(b.ghMerge('env://h/dev/x', { ...ref, kind: 'issue' }, 'squash', H)).rejects.toThrow(/Only a pull request/)
    expect(calls).toHaveLength(1)
  })

  it('reads a finished job and its log in one round trip, and marks a capped log', async () => {
    const job = { id: 2, name: 'build', status: 'completed', conclusion: 'success', html_url: '', steps: [
      { number: 1, name: 'Set up job', status: 'completed', conclusion: 'success', started_at: '2026-11-16T20:29:33Z', completed_at: '2026-11-16T20:29:35Z' },
    ] }
    const url = 'https://github.com/o/r/actions/runs/1/job/2'
    let { b, calls } = backendWith(() => ({ code: 0, stdout: batchOut([{ code: 0, stdout: JSON.stringify(job) }, { code: 0, stdout: '2026-11-16T20:29:34.0Z \x1b[32mhello\x1b[0m\n' }]), stderr: '' }))
    const j = await b.ghJob('env://h/dev/x', url)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.command).toContain(' mango /home/agent bash -c ')
    expect(calls[0]!.command).toContain(' env GH_PROMPT_DISABLED=1 ')
    expect(calls[0]!.command).toContain(' gh api --hostname github.com repos/o/r/actions/jobs/2 ')
    expect(calls[0]!.command).toContain(' mango-job repos/o/r/actions/jobs/2 1')
    expect(j).toMatchObject({ logReady: true, logTruncated: false, logError: null, url })
    expect(j.steps[0]!.lines).toEqual(['\x1b[32mhello\x1b[0m'])

    // Capped: the header says one byte more than came, and gh died of the closed pipe.
    const cap = 8 * 1024 * 1024
    const capped = `MANGO-RUN 141 ${cap + 1} 0\n${toBase64(utf8Encode('2026-11-16T20:29:34.0Z x\n'.padEnd(cap, 'y')))}\n\n`;
    ({ b, calls } = backendWith(() => ({ code: 0, stdout: batchOut([{ code: 0, stdout: JSON.stringify(job) }]) + capped, stderr: '' })))
    expect(await b.ghJob('env://h/dev/x', url)).toMatchObject({ logReady: true, logTruncated: true })

    // An old gh without the flag: once more without it.
    ;({ b, calls } = backendWith((_c, n) => n === 1
      ? { code: 0, stdout: batchOut([{ code: 0, stdout: JSON.stringify(job) }, { code: 1, stderr: 'unknown flag: --allow-escape-sequences' }]), stderr: '' }
      : { code: 0, stdout: batchOut([{ code: 0, stdout: '2026-11-16T20:29:34.0Z plain\n' }]), stderr: '' }))
    expect((await b.ghJob('env://h/dev/x', url)).steps[0]!.lines).toEqual(['plain'])
    expect(calls[1]!.command).toContain(' mango-job repos/o/r/actions/jobs/2 0')

    // Running: no log asked for (JOB_LOG exits 75), none expected.
    ;({ b } = backendWith(() => ({ code: 0, stdout: batchOut([{ code: 0, stdout: JSON.stringify({ ...job, status: 'in_progress' }) }, { code: 75 }]), stderr: '' })))
    expect(await b.ghJob('env://h/dev/x', url)).toMatchObject({ state: 'pending', logReady: false, logError: null })

    // Expired log.
    ;({ b } = backendWith(() => ({ code: 0, stdout: batchOut([{ code: 0, stdout: JSON.stringify(job) }, { code: 1, stderr: 'gh: Gone (HTTP 410)' }]), stderr: '' })))
    expect((await b.ghJob('env://h/dev/x', url)).logError).toMatch(/expired/)
    await expect(b.ghJob('env://h/dev/x', 'https://ci.example.com/9')).rejects.toThrow(/not a GitHub Actions job/)
  })

  it('opens a pull request in the project folder through the login shell, then reads it back', async () => {
    const answer = JSON.stringify({ data: { repository: { issueOrPullRequest: { __typename: 'PullRequest', title: 'Feat y', number: 7, state: 'OPEN' } } } })
    const { b, calls } = backendWith((_c, n) => n === 1
      ? { code: 1, stdout: '', stderr: 'MANGO-BRANCH:feat/y\na pull request for branch "feat/y" into branch "main" already exists:\nhttps://github.com/acme/shop/pull/7\n' }
      : { code: 0, stdout: answer, stderr: '' })
    const d = await b.ghPrCreate('env://h/dev/home/agent/work/shop', 'main')
    expect(d).toMatchObject({ number: 7, owner: 'acme', repo: 'shop', title: 'Feat y' })
    expect(calls[0]!.command).toContain(' bash -lc ')
    expect(calls[0]!.command).toContain(' mango /home/agent/work/shop sh -c ')
    expect(calls[0]!.command.endsWith(' mango-pr main')).toBe(true)
    expect(calls[1]!.command).toContain(' -F number=7 ')
    await expect(b.ghPrCreate('env://h/dev/home/agent/work/shop', '-x')).rejects.toThrow(/not a valid branch name/)
    expect(calls).toHaveLength(2)
  })
})
