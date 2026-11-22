import type { GitRef } from '~/types/ipc'

/*
 * The Git log's pure parts: the lane layout of the commit graph, what the search field means, and where a
 * commit's file is in the folder. Plain Node (tests/gitLog.test.ts): only types are imported.
 */

/** How many lane colours there are (`.lane-0` … in GitLogGraph.vue). */
export const LANE_COLORS = 5

/** A commit's row of the graph. */
export interface GraphRow {
  /** The node's column and its colour. */
  lane: number
  color: number
  /** Lines coming from the top into the node. */
  up: Array<{ from: number; color: number }>
  /** Lanes passing by, top to bottom. */
  through: Array<{ lane: number; color: number }>
  /** Lines leaving the node for the bottom, to the parents' lanes. */
  down: Array<{ to: number; color: number }>
  /** The columns the row uses. */
  width: number
}

/**
 * The lane layout over a list of commits in date order (a commit never before its children), one commit at a
 * time, so later pages continue where the earlier ones stopped.
 *
 * `active` holds, per lane, the commit that lane is waiting for. A commit takes the lane waiting for it (the
 * leftmost when several are; the others merge into it), or a free one when nothing waits for it (a branch tip).
 * Its first parent continues in the same lane; each further parent joins a lane already waiting for it, or
 * starts a new one in the leftmost free slot. A slot freed in this row is not reused in the same row, so a lane
 * never both ends and starts in one row. A parent that is not loaded (yet) keeps its lane open, so its line
 * runs off the bottom of the last row and picks up again when the next page comes in.
 */
export function createLaneLayout(colors = LANE_COLORS) {
  const active: Array<{ hash: string; color: number } | null> = []
  let nextColor = 0
  const newColor = () => nextColor++ % colors
  const freeSlot = (skip: Set<number>) => {
    for (let i = 0; i < active.length; i++) if (!active[i] && !skip.has(i)) return i
    return active.length
  }

  function place(commit: { hash: string; parents: string[] }): GraphRow {
    const up: GraphRow['up'] = []
    active.forEach((slot, from) => {
      if (slot?.hash === commit.hash) up.push({ from, color: slot.color })
    })
    const freed = new Set<number>()
    const lane = up[0]?.from ?? freeSlot(freed)
    const color = up[0]?.color ?? newColor()
    for (const { from } of up) {
      active[from] = null
      if (from !== lane) freed.add(from)
    }
    const through: GraphRow['through'] = []
    active.forEach((slot, i) => {
      if (slot && i !== lane) through.push({ lane: i, color: slot.color })
    })

    const down: GraphRow['down'] = []
    const [first, ...others] = commit.parents
    if (first) {
      active[lane] = { hash: first, color }
      down.push({ to: lane, color })
      for (const parent of new Set(others)) {
        if (parent === first) continue
        const joins = active.findIndex(s => s?.hash === parent)
        if (joins >= 0) {
          down.push({ to: joins, color: active[joins]!.color })
          continue
        }
        const slot = freeSlot(freed)
        const c = newColor()
        active[slot] = { hash: parent, color: c }
        down.push({ to: slot, color: c })
      }
    } else if (lane < active.length) {
      active[lane] = null
    }
    while (active.length && !active[active.length - 1]) active.pop()

    const width = 1 + Math.max(lane, ...through.map(t => t.lane), ...up.map(u => u.from), ...down.map(d => d.to))
    return { lane, color, up, through, down, width }
  }

  return { place, lanes: () => active.length }
}

/** A search that may be a commit hash: 4 to 64 hex digits. */
export const looksLikeHash = (q: string) => /^[0-9a-f]{4,64}$/i.test(q.trim())

/** The search field's text: `author:name` (or `author:"two words"`) picks the author, the rest is message text. */
export function parseLogQuery(q: string): { text: string; author: string } {
  let author = ''
  const text = q.replace(/(?:^|\s)author:(?:"([^"]*)"|(\S+))/i, (_, quoted?: string, word?: string) => {
    author = (quoted ?? word ?? '').trim()
    return ' '
  }).replace(/\s+/g, ' ').trim()
  return { text, author }
}

const REF_ORDER: Record<GitRef['kind'], number> = { head: 0, branch: 1, remote: 2, tag: 3 }

/** The checked-out branch (or detached HEAD) first, then branches, remote branches, tags. */
export const sortGitRefs = (refs: readonly GitRef[]): GitRef[] => [...refs].sort((a, b) =>
  Number(b.current) - Number(a.current) || REF_ORDER[a.kind] - REF_ORDER[b.kind] || a.name.localeCompare(b.name))

/**
 * A commit's file (relative to the repository root) as a path relative to `folder`, which may sit below that
 * root; null when the file is outside the folder. `folder` is a plain path: for a remote project, the one
 * inside its environment, as git reports `root` there.
 */
export function fileInFolder(folder: string, root: string, file: string): string | null {
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '')
  const dir = norm(folder)
  const top = norm(root)
  // Windows paths differ in case between what the user opened and what git prints.
  const anyCase = /^[a-z]:/i.test(top)
  const key = (p: string) => (anyCase ? p.toLowerCase() : p)
  if (!key(dir).startsWith(`${key(top)}/`)) return file
  const below = `${dir.slice(top.length + 1)}/`
  return key(file).startsWith(key(below)) ? file.slice(below.length) : null
}
