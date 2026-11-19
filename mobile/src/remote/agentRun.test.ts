/// <reference types="node" />
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SpawnHandlers } from '~/agents/types'
import type { ExecHandlers, RunOptions, RunResult, SshApi } from '@/ssh/types'
import { BACKOFF_MS, END_GRACE_MS, SETTLE_MS, utf8Length } from './agentRun'
import { createSshBackend, isConnectionLoss, RUN_SCRIPT } from './sshBackend'
import type { Env } from './types'

/**
 * Remote runs that survive a dropped connection (`agentRun.ts`, the protocol of `RUN_SCRIPT`),
 * over a fake SSH whose channels a test opens, feeds and drops.
 */

const ENV: Env = {
  id: 'h',
  name: 'Lab',
  endpoint: { host: 'lab', port: 22, user: 'me', keyId: 'k', hostKey: 'x' },
  server: { incusRemote: null },
  addedAt: 0,
}

interface Exec { command: string; h: ExecHandlers; written: string[]; stdinClosed: boolean; killed: boolean }

function fake() {
  const execs: Exec[] = []
  const runs: string[] = []
  /** What the next `exec` calls do: undefined opens a channel, an Error rejects. */
  const nextExec: (Error | undefined)[] = []
  let runAnswer: () => RunResult | Error = () => ({ code: 0, stdout: '', stderr: '' })
  const api: SshApi = {
    real: true,
    async importKey() {},
    async generateKey() { return '' },
    async publicKey() { return null },
    async deleteKey() {},
    async probeHostKey() { return { type: 'ssh-ed25519', key: 'x', fingerprint: 'x' } },
    async run(_ep, command: string, _o?: RunOptions) {
      runs.push(command)
      const r = runAnswer()
      if (r instanceof Error) throw r
      return r
    },
    async exec(_ep, command, h) {
      const plan = nextExec.shift()
      if (plan) throw plan
      const e: Exec = { command, h, written: [], stdinClosed: false, killed: false }
      execs.push(e)
      return {
        async write(d: string) { e.written.push(d) },
        async closeStdin() { e.stdinClosed = true },
        async kill() { e.killed = true },
      }
    },
    disconnect: vi.fn(async () => {}),
  }
  const backend = createSshBackend({ ssh: api, newId: () => 'run-1', now: () => Date.now() })
  backend.setEnvLookup(id => (id === 'h' ? ENV : null))
  const envEvents: string[] = []
  backend.watchConnections((id, s) => envEvents.push(`${id} ${s}`))
  return {
    api, backend, execs, runs, nextExec, envEvents,
    answerRuns(fn: () => RunResult | Error) { runAnswer = fn },
  }
}

function handlers() {
  const out: string[] = []
  const err: string[] = []
  const conn: string[] = []
  const exits: (number | null)[] = []
  const h: SpawnHandlers = {
    onLine: l => out.push(l),
    onStderr: l => err.push(l),
    onExit: c => exits.push(c),
    onConnection: s => conn.push(s),
  }
  return { h, out, err, conn, exits }
}

/** The script's `mango-run:attached` on both streams of a channel, after some login-shell noise. */
function attached(e: Exec) {
  e.h.onLine('Last login: yesterday', { bytes: 22 })
  e.h.onLine('mango-run:attached', { bytes: 19 })
  e.h.onStderr!('bash: warning: noise', { bytes: 21 })
  e.h.onStderr!('mango-run:attached', { bytes: 19 })
}

const OFFLINE = new Error('Could not reach lab: the network is unreachable from here. Check your connection.')

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

async function started() {
  const f = fake()
  const r = handlers()
  const t = await f.backend.spawnFor('claude', 'env://h/dev/home/agent/work/shop')(['-p'], r.h)
  return { ...f, ...r, t }
}

describe('a run that loses its connection', () => {
  it('attaches again from the byte counts of whole lines, and nothing is shown twice', async () => {
    const { execs, t, out, err, conn, exits, envEvents } = await started()
    attached(execs[0]!)
    const s = execs[0]!.h
    s.onLine('{"a":"é"}', { bytes: 11 })
    s.onLine('{"b":2}', { bytes: 9 })   // had a \r: the native side counts it
    s.onStderr!('warn', { bytes: 5 })
    s.onLine('{"c":', { bytes: 5, partial: true })   // cut off by the drop: comes again
    s.onExit!(null)
    expect(conn).toEqual(['lost'])
    expect(exits).toEqual([])
    expect(envEvents).toEqual(['h lost'])
    expect(err).toEqual(['warn'])

    // Written while lost: kept, in order.
    await t.write('one')
    await t.write('two')
    expect(execs).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(BACKOFF_MS[0])
    expect(execs).toHaveLength(2)
    const a = execs[1]!
    attached(a)
    expect(a.command).toContain(" MANGO_RUN=run-1 bash -lc ")
    expect(a.command.endsWith("' mango-run attach run-1 20 5")).toBe(true)
    expect(a.written).toEqual(['one\n', 'two\n'])
    a.h.onLine('{"c":3}', { bytes: 8 })
    expect(conn).toEqual(['lost', 'back'])
    expect(envEvents).toEqual(['h lost', 'h back'])
    expect(out).toEqual(['{"a":"é"}', '{"b":2}', '{"c":3}'])
    await t.write('three')
    expect(a.written).toEqual(['one\n', 'two\n', 'three\n'])

    a.h.onStderr!('mango-run:exit 0', { bytes: 17 })
    a.h.onExit!(0)
    expect(exits).toEqual([0])
    expect(err).toEqual(['warn'])
  })

  it('counts UTF-8 bytes itself when the transport does not say', async () => {
    expect(utf8Length('aé€😀')).toBe(1 + 2 + 3 + 4)
    const { execs } = await started()
    execs[0]!.h.onLine('noise')
    execs[0]!.h.onLine('mango-run:attached')
    execs[0]!.h.onStderr!('mango-run:attached')
    execs[0]!.h.onLine('{"t":"€"}')
    execs[0]!.h.onStderr!('x')
    execs[0]!.h.onExit!(255)
    await vi.advanceTimersByTimeAsync(BACKOFF_MS[0])
    expect(execs[1]!.command.endsWith(' attach run-1 12 2')).toBe(true)
  })

  it('backs off 1 s, 2 s, 4 s … up to 15 s, and reconnectNow skips the wait', async () => {
    const { execs, nextExec, backend, conn } = await started()
    attached(execs[0]!)
    execs[0]!.h.onLine('x', { bytes: 2 })
    nextExec.push(OFFLINE, OFFLINE, OFFLINE, OFFLINE, OFFLINE, OFFLINE)
    execs[0]!.h.onExit!(null)
    const attempts = () => 6 - nextExec.length
    await vi.advanceTimersByTimeAsync(999)
    expect(attempts()).toBe(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(attempts()).toBe(1)
    await vi.advanceTimersByTimeAsync(2000)
    expect(attempts()).toBe(2)
    await vi.advanceTimersByTimeAsync(4000)
    expect(attempts()).toBe(3)
    await vi.advanceTimersByTimeAsync(8000)
    expect(attempts()).toBe(4)
    await vi.advanceTimersByTimeAsync(14_999)
    expect(attempts()).toBe(4)
    await vi.advanceTimersByTimeAsync(1)
    expect(attempts()).toBe(5)
    // Back online: no waiting out the 15 s.
    backend.reconnectNow()
    await vi.advanceTimersByTimeAsync(0)
    expect(attempts()).toBe(6)
    backend.reconnectNow()
    await vi.advanceTimersByTimeAsync(0)
    expect(execs).toHaveLength(2)
    expect(conn).toEqual(['lost'])
    // A channel that stays up counts as connected even before output comes.
    await vi.advanceTimersByTimeAsync(SETTLE_MS)
    expect(conn).toEqual(['lost', 'back'])
  })

  it('attaches again at once after the connections were dropped on purpose', async () => {
    const { execs, backend } = await started()
    attached(execs[0]!)
    execs[0]!.h.onLine('x', { bytes: 2 })
    await backend.reset()
    execs[0]!.h.onExit!(null)
    await vi.advanceTimersByTimeAsync(0)
    expect(execs).toHaveLength(2)
  })

  it('ends when the script says the run ended, glued to an unfinished line or not', async () => {
    const { execs, out, err, exits, conn } = await started()
    attached(execs[0]!)
    execs[0]!.h.onLine('a', { bytes: 2 })
    execs[0]!.h.onExit!(null)
    await vi.advanceTimersByTimeAsync(BACKOFF_MS[0])
    attached(execs[1]!)
    const a = execs[1]!.h
    a.onLine('last words', { bytes: 10, partial: true })
    a.onStderr!('oopsmango-run:exit 3', { bytes: 20 })
    a.onExit!(3)
    expect(out).toEqual(['a', 'last words'])
    expect(err).toEqual(['oops'])
    expect(exits).toEqual([3])
    // Not "reconnecting" any more.
    expect(conn.at(-1)).toBe('back')
  })

  it('ends on the marker even if the channel stays open a while', async () => {
    const { execs, exits } = await started()
    attached(execs[0]!)
    execs[0]!.h.onLine('a', { bytes: 2 })
    execs[0]!.h.onStderr!('mango-run:exit 0', { bytes: 17 })
    // Its stdin closes so the script's `cat` lets go.
    await vi.advanceTimersByTimeAsync(0)
    expect(execs[0]!.stdinClosed).toBe(true)
    expect(exits).toEqual([])
    await vi.advanceTimersByTimeAsync(END_GRACE_MS)
    expect(exits).toEqual([0])
    expect(execs[0]!.killed).toBe(true)
    execs[0]!.h.onExit!(null)
    expect(exits).toEqual([0])
  })

  it('says so when the run is no longer in the environment', async () => {
    const { execs, err, exits } = await started()
    attached(execs[0]!)
    execs[0]!.h.onLine('a', { bytes: 2 })
    execs[0]!.h.onExit!(null)
    await vi.advanceTimersByTimeAsync(BACKOFF_MS[0])
    // Gone comes before any `attached`, after the login shell's noise.
    execs[1]!.h.onLine('noise')
    execs[1]!.h.onStderr!('mango-run:gone')
    execs[1]!.h.onExit!(1)
    expect(err).toEqual(['Mango: this run is no longer in the environment dev.'])
    expect(exits).toEqual([null])
  })

  it('kill during an outage: no more attaching, and the stop is sent again on the next reconnect', async () => {
    const { execs, runs, t, exits, backend, nextExec, answerRuns } = await started()
    attached(execs[0]!)
    execs[0]!.h.onLine('a', { bytes: 2 })
    nextExec.push(OFFLINE)
    execs[0]!.h.onExit!(null)
    answerRuns(() => OFFLINE)
    await t.kill()
    expect(exits).toEqual([null])
    await vi.advanceTimersByTimeAsync(60_000)
    expect(nextExec).toHaveLength(1)   // never tried to attach
    expect(execs).toHaveLength(1)
    expect(runs.filter(r => r.endsWith(' mango-stop run-1'))).toHaveLength(1)
    answerRuns(() => ({ code: 0, stdout: '', stderr: '' }))
    backend.reconnectNow()
    await vi.advanceTimersByTimeAsync(0)
    expect(runs.filter(r => r.endsWith(' mango-stop run-1'))).toHaveLength(2)
    // Stopped: nothing is owed any more.
    backend.reconnectNow()
    await vi.advanceTimersByTimeAsync(0)
    expect(runs.filter(r => r.endsWith(' mango-stop run-1'))).toHaveLength(2)
    expect(exits).toEqual([null])
  })

  it('closes stdin on the channel and in the environment, queued while lost', async () => {
    const { execs, runs, t } = await started()
    attached(execs[0]!)
    execs[0]!.h.onLine('a', { bytes: 2 })
    execs[0]!.h.onExit!(null)
    await t.write('last')
    await t.closeStdin()
    expect(runs.some(r => r.includes(' mango-run close '))).toBe(false)
    await vi.advanceTimersByTimeAsync(BACKOFF_MS[0])
    expect(execs[1]!.written).toEqual(['last\n'])
    expect(execs[1]!.stdinClosed).toBe(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(runs.filter(r => r.endsWith("' mango-run close run-1"))).toHaveLength(1)
  })

  it('does not loop on an environment the start never reached', async () => {
    const { execs, err, exits, conn } = await started()
    // Noise from a login shell is not the run: it never attached.
    execs[0]!.h.onLine('Last login: yesterday')
    execs[0]!.h.onExit!(255)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(execs).toHaveLength(1)
    expect(conn).toEqual([])
    expect(exits).toEqual([255])
    expect(err).toEqual(['Mango: Could not connect to Lab over SSH.'])

    // Nor on a failure inside it: an exit status that is not SSH's own.
    const f = await started()
    f.execs[0]!.h.onStderr!('Error: Instance is not running')
    expect(f.err).toEqual([])
    f.execs[0]!.h.onExit!(1)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(f.execs).toHaveLength(1)
    expect(f.exits).toEqual([1])
    // What it printed before attaching explains the failure, then the hint.
    expect(f.err[0]).toBe('Error: Instance is not running')
    expect(f.err.at(-1)).toContain('dev is not running')
  })

  it('treats a start that stayed up a moment as one that reached the environment', async () => {
    const { execs, conn } = await started()
    await vi.advanceTimersByTimeAsync(SETTLE_MS)
    execs[0]!.h.onExit!(null)
    expect(conn).toEqual(['lost'])
    await vi.advanceTimersByTimeAsync(BACKOFF_MS[0])
    expect(execs[1]!.command.endsWith(' attach run-1 0 0')).toBe(true)
  })

  it('explains a start that could not connect at all', async () => {
    const f = fake()
    f.nextExec.push(OFFLINE)
    await expect(f.backend.spawnFor('claude', 'env://h/dev')([], handlers().h)).rejects.toThrow(/^Could not reach Lab/)
    expect(f.envEvents).toEqual(['h lost'])
  })

  it('tells connection losses from refusals', () => {
    expect(isConnectionLoss(OFFLINE)).toBe(true)
    expect(isConnectionLoss(new Error('Connecting to lab timed out. Check your connection and that the server is up.'))).toBe(true)
    expect(isConnectionLoss(new Error('The connection to lab was reset.'))).toBe(true)
    expect(isConnectionLoss(new Error('Signing in to lab failed: authentication failed with this device\'s key.'))).toBe(false)
    expect(isConnectionLoss(new Error("The server's identity changed: the host key of lab does not match the one this device trusts."))).toBe(false)
  })
})

describe('RUN_SCRIPT', () => {
  it('is the desktop\'s, byte for byte', () => {
    const rust = new URL('../../../src-tauri/src/agent_proc.rs', import.meta.url)
    const src = readFileSync(rust, 'utf8')
    const m = /const RUN_SCRIPT: &str = r#"([\s\S]*?)"#;/.exec(src)
    expect(m, 'agent_proc.rs has no RUN_SCRIPT raw string yet').not.toBeNull()
    expect(m![1]).toBe(RUN_SCRIPT)
  })

  const haveTools = process.platform === 'linux'
    && ['setsid', 'mkfifo', 'tail'].every(t => spawnSync('sh', ['-c', `command -v ${t}`]).status === 0)

  it.runIf(haveTools)('starts, reattaches from offsets and reports the end (this computer\'s sh)', { timeout: 30_000 }, () => {
    vi.useRealTimers()
    const home = mkdtempSync(join(tmpdir(), 'mango-run-'))
    try {
      const cli = 'echo "env=$MANGO_RUN"; while read -r l; do echo "got:$l"; echo "err:$l" >&2; [ "$l" = quit ] && exit 7; done; exit 3'
      // Output to files, not pipes: the script's helpers outlive it for a few seconds with its
      // stderr open (over SSH the client ends on the marker for that reason, see `END_GRACE_MS`).
      const run = (args: string[], input = '') => {
        const io = join(home, 'io')
        writeFileSync(`${io}.in`, input)
        const r = spawnSync('sh', ['-c', 'sh -c "$0" "$@" <"$IO.in" >"$IO.out" 2>"$IO.err"', RUN_SCRIPT, 'mango-run', ...args], {
          env: { ...process.env, HOME: home, MANGO_RUN: 'r-1', IO: io }, stdio: 'ignore', timeout: 20_000,
        })
        return { status: r.status, stdout: readFileSync(`${io}.out`, 'utf8'), stderr: readFileSync(`${io}.err`, 'utf8') }
      }
      const first = run(['start', 'r-1', 'sh', '-c', cli], 'a\nquit\n')
      expect(first.stdout).toBe('mango-run:attached\nenv=r-1\ngot:a\ngot:quit\n')
      expect(first.stderr).toBe('mango-run:attached\nerr:a\nerr:quit\nmango-run:exit 7\n')
      expect(first.status).toBe(7)
      // From the byte counts of the first line of each stream after its marker.
      const again = run(['attach', 'r-1', String(utf8Length('env=r-1') + 1), String(utf8Length('err:a') + 1)])
      expect(again.stdout).toBe('mango-run:attached\ngot:a\ngot:quit\n')
      expect(again.stderr).toBe('mango-run:attached\nerr:quit\nmango-run:exit 7\n')
      expect(run(['attach', 'nope', '0', '0']).stderr).toBe('mango-run:gone\n')
      expect(run(['close', 'r-1']).status).toBe(0)
      expect(existsSync(join(home, '.cache/mango/runs/r-1/closed'))).toBe(true)
      expect(run(['attach', '../x', '0', '0']).stderr).toBe('Mango: bad run id.\n')
    } finally {
      // The keep-alive loop of each attach ends on its own within 10 s; the folder goes now.
      rmSync(home, { recursive: true, force: true })
    }
  })
})
