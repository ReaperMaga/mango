import type { AgentTransport, SpawnHandlers } from '~/agents/types'
import type { ExecHandlers, ExecProcess, LineInfo, SshApi, SshEndpoint } from '@/ssh/types'

/**
 * One agent run in an environment that outlives the connection: the client side of
 * `RUN_SCRIPT` (`sshBackend.ts`; the desktop runs the same script from `agent_proc.rs`).
 *
 * The run is started detached inside the instance, and this process only attaches to it: its
 * stdout and stderr come from files there, its stdin goes to a FIFO. When the SSH channel ends
 * without the script's end marker, the connection was lost while the run goes on: the chat hears
 * `onConnection('lost')`, and the run is attached again (`attach <id> <out bytes> <err bytes>`, so
 * nothing is shown twice or lost) with a backoff, until it attaches, ends, is gone, or is killed.
 *
 * Each stream starts with the line `mango-run:attached`: what comes before it (a login shell's
 * noise) is not shown and not counted, and offsets are bytes after it.
 * Byte offsets count whole lines only, from the sizes the native module reports (`LineInfo`).
 * Without them (an older native build) a line counts as its UTF-8 length plus its `\n`, which is
 * exact unless the line had a `\r` or bad UTF-8 (agents print JSON lines: neither happens).
 */

/** `mango-run:exit <code>`, possibly glued to an err file's unfinished last line. */
const EXIT_MARK = /mango-run:exit (-?\d+)$/
const GONE_MARK = 'mango-run:gone'
/**
 * The first line of each stream once the script streams the run: what came before it (a login
 * shell's noise) is not the run's, so it is neither shown nor counted, and offsets start after it.
 */
const ATTACHED_MARK = 'mango-run:attached'
/** Waits between attempts to attach again: 1 s, 2 s, 4 s, 8 s, then every 15 s. */
export const BACKOFF_MS = [1000, 2000, 4000, 8000, 15000] as const
/** An attach (or the start) that stays up this long counts as connected. */
export const SETTLE_MS = 2000
/** After `kill()`, the channel's end is waited for this long at most. */
const KILL_GRACE_MS = 5000
/**
 * After the end marker, the channel's end is waited for this long at most (it closes within a few
 * seconds; this only guards against one that never does).
 */
export const END_GRACE_MS = 5000

/** Bytes of `s` as UTF-8 (lone surrogates count as U+FFFD, as `TextEncoder` writes them). */
export function utf8Length(s: string): number {
  let n = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c < 0x80) n += 1
    else if (c < 0x800) n += 2
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) { n += 4; i++ }
    else n += 3
  }
  return n
}

export interface RemoteRunOptions {
  ssh: SshApi
  endpoint: SshEndpoint
  /** The instance's name, for the "no longer in the environment" line. */
  instance: string
  /** The command line that starts the run (`start`), and the one that attaches to it again. */
  startLine: string
  attachLine(outBytes: number, errBytes: number): string
  /** Run `close <id>` in the environment (the run's stdin ends). Rejects when it did not get there. */
  close(): Promise<void>
  /** Run `STOP_SCRIPT` for the run. Rejects when it did not get there. */
  stop(): Promise<void>
  /** A `Mango: …` line explaining an end (`hint`), from the last stderr lines. */
  hint(code: number | null, stderr: string, sawStdout: boolean): string | null
  /** The start failed before the run existed: explain the rejection (`transportError`). */
  startError(e: unknown): Error
  /** The connection of this run was lost, or is back (the backend tracks its env's state). */
  onConnection?(state: 'lost' | 'back'): void
  /** True right after the connections were dropped on purpose: attach again without waiting. */
  quick?(): boolean
}

export interface RemoteRun {
  transport: AgentTransport
  /** Attach again now if the connection is lost, and send a stop or close still owed. */
  reconnectNow(): void
  /** Nothing left to do: ended, and no stop owed to the environment. */
  readonly settled: boolean
  /** Between `onConnection('lost')` and `'back'`. */
  readonly lost: boolean
}

/** Starts the run and resolves once the environment took the start command. */
export async function startRemoteRun(o: RemoteRunOptions, h: SpawnHandlers): Promise<RemoteRun> {
  let outBytes = 0
  let errBytes = 0
  /** The start reached the environment: from now on a drop is reattached, not an error. */
  let reached = false
  let sawStdout = false
  let ended = false
  let killed = false
  let lost = false
  let gen = 0
  let current: { g: number; exited: boolean } = { g: 0, exited: true }
  let proc: ExecProcess | null = null
  let attaching = false
  let attempt = 0
  let retry: ReturnType<typeof setTimeout> | null = null
  let settle: ReturnType<typeof setTimeout> | null = null
  let grace: ReturnType<typeof setTimeout> | null = null
  /** Lines for stdin, in order; written on the current channel (or the next one). */
  const queue: string[] = []
  let pumping = false
  let closeWanted = false
  /** The channel whose stdin was closed already. */
  let stdinClosed: ExecProcess | null = null
  let closeOwed = false
  let closing = false
  let stopOwed = false
  const tail: string[] = []

  const clear = (t: ReturnType<typeof setTimeout> | null) => { if (t) clearTimeout(t) }

  function finish(code: number | null) {
    if (ended) return
    ended = true
    clear(retry); clear(settle); clear(grace)
    retry = settle = grace = null
    // A run that ends during an outage is not "reconnecting" any more.
    if (lost) { lost = false; h.onConnection?.('back'); o.onConnection?.('back') }
    h.onExit?.(code)
  }

  function markLost() {
    if (lost) return
    lost = true
    h.onConnection?.('lost')
    o.onConnection?.('lost')
  }

  function markBack() {
    attempt = 0
    if (!lost) return
    lost = false
    h.onConnection?.('back')
    o.onConnection?.('back')
  }

  function explainEnd(code: number | null) {
    const why = o.hint(code, tail.join('\n'), sawStdout)
    if (why) h.onStderr?.(why)
  }

  function forwardErr(t: string) {
    if (!t) return
    if (tail.length === 20) tail.shift()
    tail.push(t)
    h.onStderr?.(t)
  }

  function handlersFor(g: number): ExecHandlers {
    let exitCode: number | undefined
    let gone = false
    /** Each stream's `mango-run:attached` came: from then on its lines are the run's. */
    let outAttached = false
    let errAttached = false
    /** Unfinished last lines: shown only if the run really ended (else they come again on attach). */
    const held: { err: boolean; text: string }[] = []
    /** Stderr before the marker: not shown, unless this ends without ever attaching (then it says why). */
    const before: string[] = []
    const live = () => g === gen && !ended
    const seen = () => {
      reached = true
      markBack()
    }
    return {
      onLine(l: string, info?: LineInfo) {
        if (!live()) return
        const t = l.replace(/\r+$/, '')
        if (!outAttached) {
          if (t === ATTACHED_MARK && !info?.partial) { outAttached = true; seen() }
          return
        }
        if (info?.partial) { held.push({ err: false, text: t }); return }
        outBytes += info ? info.bytes : utf8Length(l) + 1
        seen()
        if (!t) return
        sawStdout = true
        h.onLine(t)
      },
      onStderr(l: string, info?: LineInfo) {
        if (!live()) return
        const t = l.replace(/\r+$/, '')
        if (!errAttached && !info?.partial && t === ATTACHED_MARK) { errAttached = true; seen(); return }
        const m = errAttached ? EXIT_MARK.exec(t) : null
        const marked = m ? t.slice(0, m.index) : t.endsWith(GONE_MARK) ? t.slice(0, -GONE_MARK.length) : null
        if (marked !== null) {
          // Markers come from the script, not the run: never shown, never counted.
          if (m) exitCode = Number(m[1])
          else gone = true
          seen()
          if (marked && errAttached) forwardErr(marked)
          markerSeen()
          return
        }
        if (!errAttached) {
          if (t && !info?.partial) { if (before.length === 20) before.shift(); before.push(t) }
          return
        }
        if (info?.partial) { held.push({ err: true, text: t }); return }
        errBytes += info ? info.bytes : utf8Length(l) + 1
        seen()
        forwardErr(t)
      },
      onExit(code: number | null) {
        if (g !== gen) return
        current.exited = true
        proc = null
        clear(settle); settle = null
        clear(grace); grace = null
        if (!ended) end(code)
      },
    }

    function flushHeld() {
      for (const x of held.splice(0)) {
        if (x.err) forwardErr(x.text)
        else if (x.text) { sawStdout = true; h.onLine(x.text) }
      }
    }

    /** The marker came: the run is over, whether or not the channel closes soon. */
    function markerSeen() {
      if (ended || killed) return
      const p = proc
      // Lets the script's stdin `cat` end, so the channel can close.
      if (p && stdinClosed !== p) { stdinClosed = p; void p.closeStdin().catch(() => {}) }
      clear(grace)
      grace = setTimeout(() => {
        grace = null
        if (g !== gen || ended) return
        const q = proc
        gen++
        proc = null
        end(null)
        if (q) void q.kill().catch(() => {})
      }, END_GRACE_MS)
    }

    function end(code: number | null) {
      if (killed) { finish(code); return }
      if (exitCode !== undefined) {
        flushHeld()
        explainEnd(exitCode)
        finish(exitCode)
        return
      }
      if (gone) {
        h.onStderr?.(`Mango: this run is no longer in the environment ${o.instance}.`)
        finish(null)
        return
      }
      // An exit status other than SSH's own 255 came from inside (incus, the shell, the
      // script): the run failed there; a dropped connection ends with none (or 255).
      if ((code !== null && code !== 255) || !reached) {
        // It never got to stream the run: what it printed before is the explanation.
        if (!errAttached) for (const t of before) forwardErr(t)
        flushHeld()
        explainEnd(code)
        finish(code)
        return
      }
      held.length = 0
      markLost()
      schedule()
    }
  }

  function schedule() {
    if (ended || killed || retry || attaching || proc) return
    const wait = o.quick?.() ? 0 : BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)]!
    attempt++
    retry = setTimeout(() => { retry = null; void attach() }, wait)
  }

  /** Waits a moment on a fresh channel: if it is still up, the connection works. */
  function settleSoon(g: number) {
    clear(settle)
    settle = setTimeout(() => {
      settle = null
      if (g === gen && proc && !ended) { reached = true; markBack() }
    }, SETTLE_MS)
  }

  async function attach() {
    if (ended || killed || attaching || proc) return
    attaching = true
    const g = ++gen
    const mine = { g, exited: false }
    current = mine
    let p: ExecProcess
    try {
      p = await o.ssh.exec(o.endpoint, o.attachLine(outBytes, errBytes), handlersFor(g))
    } catch {
      attaching = false
      if (g === gen) { mine.exited = true; schedule() }
      return
    }
    attaching = false
    if (g !== gen || killed || ended) { if (!mine.exited) void p.kill().catch(() => {}); return }
    if (mine.exited) return
    proc = p
    settleSoon(g)
    pump()
  }

  /** Writes what is queued on the current channel, then closes its stdin if that was asked. */
  async function pump() {
    if (pumping) return
    pumping = true
    try {
      while (queue.length && proc) {
        const p = proc
        try {
          await p.write(queue[0]!)
        } catch {
          // The channel is going: the line waits for the next one.
          break
        }
        if (queue.length) queue.shift()
      }
      if (closeWanted && !queue.length && proc && stdinClosed !== proc) {
        stdinClosed = proc
        await proc.closeStdin().catch(() => {})
        runClose()
      }
    } finally {
      pumping = false
    }
  }

  function runClose() {
    if (!closeOwed || closing || ended) return
    closing = true
    o.close().then(() => { closeOwed = false }, () => {}).finally(() => { closing = false })
  }

  function runStop() {
    stopOwed = true
    o.stop().then(() => { stopOwed = false }, () => {})
  }

  // The start: a failure to get it there at all is today's error, thrown to the adapter.
  gen = 1
  current = { g: 1, exited: false }
  const first = current
  try {
    proc = await o.ssh.exec(o.endpoint, o.startLine, handlersFor(1))
  } catch (e) {
    first.exited = true
    throw o.startError(e)
  }
  if (first.exited) proc = null
  else settleSoon(1)

  const transport: AgentTransport = {
    async write(line) {
      if (ended) return
      queue.push(`${line}\n`)
      await pump()
    },
    async closeStdin() {
      if (ended || closeWanted) return
      closeWanted = true
      closeOwed = true
      await pump()
    },
    async kill() {
      if (killed || ended) return
      killed = true
      clear(retry); retry = null
      // In the background: closing the channel alone may leave the CLI running, and during an
      // outage the stop waits for the next reconnect.
      runStop()
      const p = proc
      if (p) {
        await p.kill().catch(() => {})
        // The channel's end calls `onExit`; should it never come, end anyway.
        clear(grace)
        grace = setTimeout(() => finish(null), KILL_GRACE_MS)
      } else {
        // No channel to close (lost, or attaching): this is the end, as far as the chat goes.
        gen++
        finish(null)
      }
    },
  }

  return {
    transport,
    reconnectNow() {
      if (stopOwed) runStop()
      if (ended || killed) return
      if (proc) { runClose(); return }
      if (!lost || attaching) return
      clear(retry); retry = null
      void attach()
    },
    get settled() { return ended && !stopOwed },
    get lost() { return lost },
  }
}
