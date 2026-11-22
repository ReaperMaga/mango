import { isWindowsPath, joinRoot, uriToFile } from './uri.ts'

/** `FileChangeType` */
export const FILE_CREATED = 1
export const FILE_CHANGED = 2
export const FILE_DELETED = 3
export type FileChange = typeof FILE_CREATED | typeof FILE_CHANGED | typeof FILE_DELETED

export interface Glob { test(path: string): boolean }

/** A longer pattern is not one of a real server's. */
const MAX_GLOB = 1000
/** What all the patterns of one server may add up to: matching costs at most this per character of a path. */
const MAX_GLOBS = 20_000

/**
 * An LSP glob (`**`, `*`, `?`, `{a,b}`, `[…]`); null when it cannot be read as one. A server writes
 * it, so it is matched by following all its readings at once: the time is the pattern's length times
 * the path's, where a regular expression could take for ever.
 */
export function compileGlob(pattern: string, ignoreCase = false): Glob | null {
  if (pattern.length > MAX_GLOB) return null
  const chars = [...(ignoreCase ? pattern.toLowerCase() : pattern)]
  /** Per state: the states reached without a character, and by one. */
  const skips: number[][] = []
  const moves: Array<Array<{ takes(c: string): boolean; to: number }>> = []
  const state = () => {
    skips.push([])
    moves.push([])
    return skips.length - 1
  }
  const any = () => true
  const inSegment = (c: string) => c !== '/'
  const start = state()
  let at = start
  const step = (takes: (c: string) => boolean) => {
    const to = state()
    moves[at]!.push({ takes, to })
    at = to
  }
  const groups: Array<{ start: number; end: number }> = []

  for (let i = 0; i < chars.length; i++) {
    const c = chars[i]!
    if (c === '*') {
      let end = i
      while (chars[end + 1] === '*') end++
      const from = at
      const loop = state()
      skips[from]!.push(loop)
      moves[loop]!.push({ takes: end === i ? inSegment : any, to: loop })
      at = loop
      if (end > i && chars[end + 1] === '/') {
        step(ch => ch === '/')
        // `**/` may also stand for no folder at all.
        skips[from]!.push(at)
        end++
      }
      i = end
    } else if (c === '?') {
      step(inSegment)
    } else if (c === '{') {
      const group = { start: at, end: state() }
      groups.push(group)
      at = state()
      skips[group.start]!.push(at)
    } else if (c === ',' && groups.length) {
      const group = groups.at(-1)!
      skips[at]!.push(group.end)
      at = state()
      skips[group.start]!.push(at)
    } else if (c === '}' && groups.length) {
      const group = groups.pop()!
      skips[at]!.push(group.end)
      at = group.end
    } else if (c === '[') {
      let end = i + 1
      while (end < chars.length && chars[end] !== ']') end++
      if (end === chars.length) return null
      let body = chars.slice(i + 1, end)
      const not = body[0] === '!' || body[0] === '^'
      if (not) body = body.slice(1)
      const spans: Array<[string, string]> = []
      for (let j = 0; j < body.length; j++) {
        if (body[j + 1] === '-' && j + 2 < body.length) {
          spans.push([body[j]!, body[j + 2]!])
          j += 2
        } else {
          spans.push([body[j]!, body[j]!])
        }
      }
      step(ch => ch !== '/' && spans.some(([low, high]) => low <= ch && ch <= high) !== not)
      i = end
    } else {
      step(ch => ch === c)
    }
  }
  if (groups.length) return null
  const last = at

  return {
    test(path) {
      const seen = new Uint32Array(skips.length)
      let round = 1
      let now: number[] = []
      const enter = (first: number, into: number[]) => {
        const todo = [first]
        while (todo.length) {
          const s = todo.pop()!
          if (seen[s] === round) continue
          seen[s] = round
          into.push(s)
          for (const next of skips[s]!) todo.push(next)
        }
      }
      enter(start, now)
      for (const c of ignoreCase ? path.toLowerCase() : path) {
        round++
        const next: number[] = []
        for (const s of now) for (const move of moves[s]!) if (move.takes(c)) enter(move.to, next)
        if (!next.length) return false
        now = next
      }
      return now.includes(last)
    },
  }
}

interface Watch { size: number; wants(file: string, type: FileChange): boolean }

/** The files a server asked to hear about (`workspace/didChangeWatchedFiles` registrations). */
export class WatchedFiles {
  private byId = new Map<string, Watch[]>()
  private root: string

  constructor(root: string) {
    this.root = root
  }

  get empty() { return !this.byId.size }

  register(id: string, watchers: unknown) {
    if (!Array.isArray(watchers)) return
    this.byId.delete(id)
    let room = MAX_GLOBS
    for (const list of this.byId.values()) for (const watch of list) room -= watch.size
    const windows = isWindowsPath(this.root)
    const added: Watch[] = []
    for (const w of watchers) {
      let pattern: unknown = w?.globPattern
      let base = ''
      if (pattern && typeof pattern === 'object') {
        const relative = pattern as { baseUri?: any; pattern?: unknown }
        const uri = typeof relative.baseUri === 'string' ? relative.baseUri : relative.baseUri?.uri
        // Through a name inside it: the project's own folder has no path relative to itself.
        const inside = uriToFile(this.root, `${String(uri).replace(/\/$/, '')}/_`)
        if (inside === null) continue
        base = inside.slice(0, -1)
        pattern = relative.pattern
      }
      if (typeof pattern !== 'string') continue
      // At least one, so no number of empty ones is free.
      const size = pattern.length + 1
      if (size > room) continue
      const text = windows ? pattern.replace(/\\/g, '/') : pattern
      const glob = compileGlob(text, windows)
      if (!glob) continue
      room -= size
      const absolute = text.startsWith('/') || (windows && /^[a-z]:/i.test(text))
      const kinds = typeof w.kind === 'number' ? w.kind : 7
      added.push({
        size,
        wants: (file, type) => {
          // Create 1, change 2, delete 4.
          if (!(kinds & (1 << (type - 1)))) return false
          if (absolute) return glob.test(joinRoot(this.root, file))
          return file.startsWith(base) && glob.test(file.slice(base.length))
        },
      })
    }
    if (added.length) this.byId.set(id, added)
  }

  unregister(id: string) {
    this.byId.delete(id)
  }

  wants(file: string, type: FileChange): boolean {
    for (const list of this.byId.values()) if (list.some(watch => watch.wants(file, type))) return true
    return false
  }
}
