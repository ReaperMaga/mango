import type { KeptProcess, ProcessKeeper } from './types.ts'

/**
 * Keeps a chat's CLI process running between its turns. A new process that resumes a session reads the
 * project's instruction files again, and when one changed since the last turn (agents edit AGENTS.md as
 * they work) Claude Code adds the whole file to the conversation once more. A process that stays does not.
 *
 * A process is kept only for the chat it belongs to and taken back only under the key it was kept with
 * (same settings, same session, nothing added to the chat elsewhere); otherwise it is closed and the turn
 * starts a new one. It goes after a while of idling, when too many are kept, and whenever its owner says so.
 *
 * Runs in plain Node (tests/keeper.test.ts): no Vue, Pinia or Tauri.
 */

/** How long a process waits for its chat's next message: as long as Claude Code's prompt cache lasts on a plan. */
export const KEEP_MS = 60 * 60_000
/** Each is a whole CLI with its MCP servers: the one idle longest goes first. */
export const KEEP_MAX = 4
/** How long a process told to finish gets before it is killed. */
const CLOSE_MS = 5000

/** What a kept process belongs to. */
export interface KeptFor {
  chat: string
  agent: string
  /** The folder it runs in. */
  folder: string
}

interface Entry extends KeptFor {
  key: string
  process: KeptProcess
  idle?: ReturnType<typeof setTimeout>
  /** Set once it was told to go; resolves when it is gone. */
  gone?: Promise<void>
  exited(): void
}

export class KeptProcesses {
  private kept = new Map<string, Entry>()
  /** Told to go, still running. */
  private closing = new Set<Entry>()
  private keepMs: number
  private max: number
  private closeMs: number

  constructor(options: { keepMs?: number; max?: number; closeMs?: number } = {}) {
    this.keepMs = options.keepMs ?? KEEP_MS
    this.max = options.max ?? KEEP_MAX
    this.closeMs = options.closeMs ?? CLOSE_MS
  }

  get size() {
    return this.kept.size
  }

  /**
   * The keeper one run gets. `taken` is what the chat held when the run began and `stamp` what it holds
   * when its process is kept: a process kept under another stamp has missed something. A null stamp:
   * the chat is gone, its process goes too.
   */
  keeperFor(owner: KeptFor, taken: string, stamp: () => string | null): ProcessKeeper {
    return {
      take: (key, fits) => this.take(owner.chat, `${taken}\0${key}`, fits),
      keep: (key, process) => {
        const now = stamp()
        this.keep(owner, now === null ? null : `${now}\0${key}`, process)
      },
    }
  }

  private take(chat: string, key: string, fits: (p: KeptProcess) => boolean): KeptProcess | null {
    const entry = this.kept.get(chat)
    if (!entry) return null
    if (entry.key !== key || !fits(entry.process)) {
      void this.close(entry)
      return null
    }
    this.kept.delete(chat)
    clearTimeout(entry.idle)
    return entry.process
  }

  private keep(owner: KeptFor, key: string | null, process: KeptProcess) {
    const before = this.kept.get(owner.chat)
    if (before) void this.close(before)
    const entry: Entry = { ...owner, key: key ?? '', process, exited: () => {} }
    process.handlers = {
      // It went to work by itself (something it had scheduled): nobody would see that, or what it spends.
      onLine: (line) => { if (!entry.gone && process.wakes(line)) void this.close(entry, true) },
      onExit: () => {
        clearTimeout(entry.idle)
        if (this.kept.get(entry.chat) === entry) this.kept.delete(entry.chat)
        entry.exited()
      },
    }
    if (key === null) {
      void this.close(entry)
      return
    }
    this.kept.set(owner.chat, entry)
    entry.idle = setTimeout(() => void this.close(entry), this.keepMs)
    // A Map lists in the order added: the first is the one idle longest.
    for (const oldest of [...this.kept.values()]) {
      if (this.kept.size <= this.max) break
      void this.close(oldest)
    }
  }

  /** End a kept process: its input closes, and it is killed when that does not end it (`now`: at once). */
  private close(entry: Entry, now = false): Promise<void> {
    if (entry.gone) return entry.gone
    clearTimeout(entry.idle)
    if (this.kept.get(entry.chat) === entry) this.kept.delete(entry.chat)
    this.closing.add(entry)
    const { transport } = entry.process
    entry.gone = new Promise<void>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const done = () => {
        clearTimeout(timer)
        this.closing.delete(entry)
        resolve()
      }
      const kill = () => void transport.kill().catch(() => {}).then(done)
      entry.exited = done
      if (now) {
        kill()
        return
      }
      timer = setTimeout(kill, this.closeMs)
      transport.closeStdin().catch(kill)
    })
    return entry.gone
  }

  /** End the kept processes `which` picks; resolves when they, and those already ending, are gone. */
  async release(which: (p: KeptFor) => boolean): Promise<void> {
    const ending = [...this.closing].filter(which).map(e => e.gone)
    await Promise.all([...ending, ...[...this.kept.values()].filter(which).map(e => this.close(e))])
  }

  /** The page goes away: no process it kept outlives it. */
  killAll() {
    for (const entry of [...this.kept.values()]) void this.close(entry, true)
  }
}
