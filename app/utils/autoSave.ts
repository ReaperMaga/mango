/**
 * When an open file saves itself (Settings > Editor), as data and plain functions, so it runs in
 * plain Node (`tests/autoSave.test.ts`): stores/files.ts does the writing.
 *
 * - A file saves once typing rests (`saveTiming`), and at once when attention moves away (`soon`).
 * - A file has one write at a time; a remote project has one among all its files (`lane`).
 * - What changes files from outside the editor runs in `around`: the text is saved first, nothing
 *   saves itself until it is done, and the disk is looked at before saving goes on.
 * - A save that failed is tried again a few times, ever later, and then when asked or edited. One
 *   that may have left the file broken (`keepsBackup`) only when asked.
 */

/** What decides whether a file may save itself. */
export interface SaveFile {
  dirty: boolean
  loading: boolean
  conflict: boolean
  /** Asked "save before closing?": the answer is the user's. */
  closing: boolean
  error: string | null
  /** Why the last save failed. */
  saveError?: string | null
  binary: boolean
  tooLarge: boolean
  disk: string | null
}

/**
 * The failure that may have left the file broken, saying where its text from before is kept
 * (`not_restored` in src-tauri/src/files.rs): never tried again by itself, and never replaced.
 */
export const keepsBackup = (why: string | null | undefined): boolean => !!why?.includes('Its text from before is kept')

/**
 * Whether a save that failed with `why` was refused before it wrote (src-tauri/src/files.rs). Of any
 * other failure only the disk can tell what it left.
 */
export function nothingWritten(why: string, file: string): boolean {
  return [
    `${file} is read-only`,
    `${file} is not a file`,
    `${file} no longer exists`,
    `${file} links to a place outside the project`,
    `Could not save ${file}: the connection dropped before all of it arrived. Try again.`,
  ].includes(why)
}

const AGAIN = ' Trying again: '

/** What to show for a save that failed with `why`, while `before` was showing. */
export function saveFailure(before: string | null | undefined, why: string): string {
  return keepsBackup(before) ? `${before!.split(AGAIN)[0]}${AGAIN}${why}` : why
}

export function canAutoSave(f: SaveFile): boolean {
  return f.dirty && !f.loading && !f.conflict && !f.closing && !f.error && !f.binary && !f.tooLarge && f.disk !== null
    && !keepsBackup(f.saveError)
}

export interface SaveTiming {
  /** Saved once typing rested this long. */
  idle: number
  /** Saved at least this often while typing goes on. */
  max: number
}

/** A large file takes its whole text to the backend with each save. */
const LARGE = 512 * 1024

/**
 * A second is longer than the gaps between keys and shorter than reaching for another window, so
 * it feels continuous without file watchers seeing every half word. A remote save is an SSH round trip.
 */
export function saveTiming(remote: boolean, chars: number): SaveTiming {
  if (remote) return { idle: 3000, max: 20_000 }
  return chars > LARGE ? { idle: 3000, max: 15_000 } : { idle: 1000, max: 10_000 }
}

/** How long to wait before each retry of a failing save. */
export const RETRY_MS = [5000, 15_000, 45_000, 120_000]

/**
 * What a file's text on disk is to the edits being made: the text being edited itself (`same`), one
 * they started from or that Mango wrote (`known`: safe to write over), or someone else's (`changed`).
 * `attempted`: the last write whose answer never came.
 */
export function compareDisk(now: string | null, disk: string | null, attempted: string | undefined, editing: () => string | null): 'same' | 'known' | 'changed' {
  if (now === null) return 'changed'
  if (now === editing()) return 'same'
  return now === disk || now === attempted ? 'known' : 'changed'
}

/** A folder's path in the one spelling compared here: either slash, Windows ignoring case. */
function norm(p: string): string {
  const path = `${p.replace(/\\/g, '/').replace(/\/+$/, '')}/`
  return /^([a-z]:|\/\/)/i.test(path) ? path.toLowerCase() : path
}

export const sameFolder = (a: string, b: string): boolean => norm(a) === norm(b)

/** One folder lies within the other (project paths, git roots). */
export function overlaps(a: string, b: string): boolean {
  const [x, y] = [norm(a), norm(b)]
  return x.startsWith(y) || y.startsWith(x)
}

export interface AutoSaveHost<F extends SaveFile> {
  on(): boolean
  /** The open files, each the same object for as long as it is open (renames included). */
  open(): F[]
  timing(f: F): SaveTiming
  /** Files with the same lane are written one after another; null: no waiting for others. */
  lane(f: F): string | null
  /** One write of the text as it is when called. Resolves true when saved. */
  write(f: F, force: boolean): Promise<boolean>
}

/** Saves wait at most this often for typing to pause when asked to save everything. */
const ROUNDS = 3

interface State {
  timer?: ReturnType<typeof setTimeout>
  busy: Promise<boolean> | null
  /** The last edit, and the first one since the last save. */
  last: number
  since: number
  fails: number
  retryAt: number
}

export function createAutoSave<F extends SaveFile>(host: AutoSaveHost<F>) {
  type Match = (f: F) => boolean
  interface Hold { match: Match; still: boolean; done: Promise<void> }

  const states = new WeakMap<F, State>()
  const holds = new Set<Hold>()
  const lanes = new Map<string, Promise<void>>()

  function stateOf(f: F): State {
    let s = states.get(f)
    if (!s) {
      s = { busy: null, last: 0, since: 0, fails: 0, retryAt: 0 }
      states.set(f, s)
    }
    return s
  }
  function holdOn(f: F, stillOnly = false): Hold | null {
    for (const h of holds) if ((h.still || !stillOnly) && h.match(f)) return h
    return null
  }
  const may = (f: F) => host.on() && canAutoSave(f) && host.open().includes(f)

  function stopTimer(s: State) {
    clearTimeout(s.timer)
    s.timer = undefined
  }

  function schedule(f: F) {
    const s = stateOf(f)
    stopTimer(s)
    if (!f.dirty) s.since = 0
    if (s.busy || !may(f) || holdOn(f)) return
    const { idle, max } = host.timing(f)
    const due = Math.min(s.last + idle, s.since ? s.since + max : Infinity)
    s.timer = setTimeout(() => {
      s.timer = undefined
      if (!s.busy && may(f) && !holdOn(f)) void start(f)
    }, Math.max(0, Math.max(due, s.retryAt) - Date.now()))
  }

  function inLane(key: string | null, work: () => Promise<boolean>): Promise<boolean> {
    if (key === null) return work()
    const before = lanes.get(key)
    const run = before ? before.then(work) : work()
    const done = run.then(() => {}, () => {})
    lanes.set(key, done)
    void done.then(() => { if (lanes.get(key) === done) lanes.delete(key) })
    return run
  }

  function start(f: F, manual?: { force: boolean }): Promise<boolean> {
    const s = stateOf(f)
    stopTimer(s)
    s.since = 0
    // A write that waited its turn looks again: it may have met a conflict meanwhile.
    const write = () => (manual || may(f) ? host.write(f, !!manual?.force) : Promise.resolve(false))
    const run = inLane(host.lane(f), write).catch(() => false).then((ok) => {
      s.busy = null
      if (ok) {
        s.fails = s.retryAt = 0
      } else if (may(f)) {
        s.retryAt = Date.now() + RETRY_MS[Math.min(s.fails, RETRY_MS.length - 1)]!
        s.fails++
      }
      if (s.fails <= RETRY_MS.length) schedule(f)
      return ok
    })
    s.busy = run
    return run
  }

  /** The text of `f` changed. */
  function edited(f: F) {
    if (!host.on()) return
    const s = stateOf(f)
    s.last = Date.now()
    if (f.dirty && !s.since) s.since = s.last
    schedule(f)
  }

  /** Attention moved away: save what can be saved now. A failing save keeps waiting for its retry. */
  function soon() {
    for (const f of host.open()) {
      if (!may(f)) continue
      const s = stateOf(f)
      // Being written or held: it saves as soon as that is over.
      s.last = -Infinity
      if (!s.busy && !holdOn(f) && Date.now() >= s.retryAt) void start(f)
    }
  }

  async function flushOne(f: F) {
    for (let round = 0; round < ROUNDS; round++) {
      for (;;) {
        // A file with nothing to save doesn't wait for a pull to end (closing would).
        const wait = stateOf(f).busy ?? (f.dirty ? holdOn(f)?.done : undefined)
        if (!wait) break
        await wait
      }
      if (!may(f) || !await start(f)) return
    }
  }

  /** Save now and wait for it, whatever was under way or failed before. */
  async function flush(match: Match = () => true) {
    if (host.on()) await Promise.all(host.open().filter(match).map(flushOne))
  }

  /** The user's own save: always goes, after the write under way (and a rename or delete of the file). */
  async function save(f: F, force = false): Promise<boolean> {
    for (;;) {
      const wait = stateOf(f).busy ?? holdOn(f, true)?.done
      if (!wait) break
      await wait
    }
    return host.open().includes(f) ? start(f, { force }) : false
  }

  /** Nothing matching saves itself until the returned function runs. `still`: the user's own saves wait too. */
  function hold(match: Match, still = false): () => void {
    let end!: () => void
    const h: Hold = { match, still, done: new Promise<void>(resolve => (end = resolve)) }
    holds.add(h)
    for (const f of host.open()) if (match(f)) stopTimer(stateOf(f))
    return () => {
      if (!holds.delete(h)) return
      end()
      for (const f of host.open()) if (f.dirty && match(f)) schedule(f)
    }
  }

  /** The writes under way are over. */
  async function settle(match: Match) {
    await Promise.all(host.open().filter(match).map(f => states.get(f)?.busy))
  }

  /**
   * Run `work`, which reads or changes these files from outside the editor: it sees the saved text,
   * and no save lands on what it did before `after` looked at the disk. Without `after` it only reads.
   */
  async function around<T>(match: Match, work: () => Promise<T>, after?: () => Promise<unknown>): Promise<T> {
    if (!host.on()) return work()
    await flush(match)
    if (!after) return work()
    const release = hold(match)
    try {
      await settle(match)
      return await work()
    } finally {
      try {
        await after()
      } finally {
        release()
      }
    }
  }

  return { edited, soon, flush, save, hold, settle, around }
}
