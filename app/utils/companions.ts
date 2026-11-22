/**
 * Renaming and deleting an entry with the files that go with it (`ui.files.companions`: Unity's
 * `Player.cs.meta`), so the two are never separated without saying so. A failed call is no proof that
 * nothing happened (a remote reply can be lost after the work was done): the folder is read again
 * before anything is put back or reported. Pure, so it runs in plain Node (tests/companions.test.ts).
 * Everything is by name, inside the entry's own folder.
 */

export interface Folder {
  /** Its names as they are spelt; null when it is too big to list whole. Throws when it cannot be read. */
  list(): Promise<ReadonlySet<string> | null>
  /** For a folder too big to list. */
  has(name: string): Promise<boolean>
  rename(from: string, to: string): Promise<void>
}

export interface Move { from: string, to: string }
export interface Companion { name: string, suffix: string }

/** The pair is apart, or may be: to be shown whatever the view does meanwhile. */
export class SplitError extends Error {
  moved: Move[]
  constructor(message: string, moved: Move[] = []) {
    super(message)
    this.moved = moved
  }
}

const reason = (e: unknown) => (e instanceof Error ? e.message : String(e)).trim()
const sameButCase = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

/**
 * The companions `entry` has. One spelt in another case counts (Windows and macOS take it for the
 * companion) unless that spelling is another entry's own.
 */
export async function companionsOf(folder: Folder, entry: string, suffixes: readonly string[]): Promise<{ found: Companion[], names: ReadonlySet<string> | null }> {
  if (!suffixes.length) return { found: [], names: null }
  const names = await folder.list()
  const found: Companion[] = []
  for (const suffix of suffixes) {
    const exact = entry + suffix
    if (names ? names.has(exact) : await folder.has(exact)) {
      found.push({ name: exact, suffix })
      continue
    }
    if (!names) continue
    const other = [...names].filter(n => sameButCase(n, exact) && !names.has(n.slice(0, -suffix.length)))
    if (other.length === 1) found.push({ name: other[0]!, suffix })
  }
  return { found, names }
}

/**
 * Rename `entry` to `to` with its companions: all of them or none. `check` sees the moves before the
 * first. Resolves with what moved; a `SplitError` carries what stayed moved.
 */
export async function renameTogether(folder: Folder, entry: string, to: string, suffixes: readonly string[], check: (moves: Move[]) => void = () => {}): Promise<Move[]> {
  const { found, names: before } = await companionsOf(folder, entry, suffixes)
  const moves = [{ from: entry, to }, ...found.map(c => ({ from: c.name, to: to + c.suffix }))].filter(m => m.from !== m.to)
  check(moves)
  for (const m of moves) {
    if (m.from === entry) continue
    const taken = before
      ? [...before].some(n => n !== m.from && sameButCase(n, m.to))
      : !sameButCase(m.from, m.to) && await folder.has(m.to)
    if (taken) throw new Error(`${m.to} already exists, and ${m.from} has to take that name. Move or delete it first.`)
  }
  const done: Move[] = []
  try {
    for (const m of moves) {
      await folder.rename(m.from, m.to)
      done.push(m)
    }
    return moves
  } catch (e) {
    if (moves.length < 2) throw e
    const all = moves.map(m => m.from).join(' and ')
    let now: ReadonlySet<string> | null
    try {
      now = await folder.list()
    } catch {
      throw new SplitError(`${reason(e)}. It is not known whether ${all} were renamed: check that their names still match.`)
    }
    // A name that was taken before is someone else's, never a move to undo.
    const moved = now && before ? moves.filter(m => now.has(m.to) && !now.has(m.from) && !before.has(m.to)) : [...done]
    if (moved.length === moves.length) return moves
    if (!moved.length) throw e

    const back = new Set<Move>()
    for (const m of [...moved].reverse()) {
      try {
        await folder.rename(m.to, m.from)
        back.add(m)
      } catch { /* looked at below */ }
    }
    let after: ReadonlySet<string> | null = null
    try {
      after = await folder.list()
    } catch { /* what the calls said has to do */ }
    const stuck = moved.filter(m => (after ? !after.has(m.from) : !back.has(m)))
    const failed = moves.find(m => !moved.includes(m))!
    if (stuck.length) {
      throw new SplitError(`${failed.from} could not be renamed (${reason(e)}), and ${stuck.map(m => m.to).join(', ')} could not get the old name back. Rename one by hand so they match.`, stuck)
    }
    throw new Error(`Nothing was renamed: ${failed.from} could not be renamed along with it. ${reason(e)}`)
  }
}

export interface Removed { deleted: boolean, reason: string | null }
export interface RemovedTogether extends Removed {
  /** What is gone. */
  gone: string[]
  left: { name: string, why: string }[]
}

/** Delete `entry`, then `along` (what the user was asked about, nothing more). */
export async function removeTogether(folder: Folder, entry: string, along: readonly string[], remove: (name: string) => Promise<Removed>): Promise<RemovedTogether> {
  const absent = async (name: string) => {
    try {
      const names = await folder.list()
      return !!names && !names.has(name)
    } catch {
      return false
    }
  }
  let main: Removed
  try {
    main = await remove(entry)
  } catch (e) {
    if (!along.length || !(await absent(entry))) throw e
    main = { deleted: true, reason: null }
  }
  if (!main.deleted) return { ...main, gone: [], left: [] }
  const gone = [entry]
  const left: RemovedTogether['left'] = []
  for (const name of along) {
    try {
      const got = await remove(name)
      if (got.deleted) gone.push(name)
      else left.push({ name, why: got.reason ?? '' })
    } catch (e) {
      // Unity removes a .meta by itself when its asset goes.
      if (await absent(name)) gone.push(name)
      else left.push({ name, why: reason(e) })
    }
  }
  return { ...main, gone, left }
}
