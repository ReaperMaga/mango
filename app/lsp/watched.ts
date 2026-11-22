import { isWindowsPath, joinRoot, uriToFile } from './uri.ts'

/** `FileChangeType` */
export const FILE_CREATED = 1
export const FILE_CHANGED = 2
export const FILE_DELETED = 3
export type FileChange = typeof FILE_CREATED | typeof FILE_CHANGED | typeof FILE_DELETED

/** An LSP glob (`**`, `*`, `?`, `{a,b}`, `[…]`) as a regular expression; null when it cannot be read as one. */
export function globToRegExp(glob: string, ignoreCase = false): RegExp | null {
  if (glob.length > 1000) return null
  let out = ''
  let groups = 0
  let stars = 0
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!
    if (c === '*') {
      // A server's pattern must not be able to hang a match.
      if (++stars > 8) return null
      let end = i
      while (glob[end + 1] === '*') end++
      if (end === i) {
        out += '[^/]*'
      } else if (glob[end + 1] === '/') {
        out += '(?:.*/)?'
        end++
      } else {
        out += '.*'
      }
      i = end
    } else if (c === '?') {
      out += '[^/]'
    } else if (c === '{') {
      out += '(?:'
      groups++
    } else if (c === '}' && groups) {
      out += ')'
      groups--
    } else if (c === ',' && groups) {
      out += '|'
    } else if (c === '[') {
      const end = glob.indexOf(']', i + 1)
      if (end < 0) return null
      out += `[${glob.slice(i + 1, end).replace(/\\/g, '\\\\').replace(/^!/, '^')}]`
      i = end
    } else {
      out += c.replace(/[\\^$+.()|{}\]]/g, '\\$&')
    }
  }
  if (groups) return null
  try {
    return new RegExp(`^${out}$`, ignoreCase ? 'i' : '')
  } catch {
    return null
  }
}

type Test = (file: string, type: FileChange) => boolean

/** The files a server asked to hear about (`workspace/didChangeWatchedFiles` registrations). */
export class WatchedFiles {
  private byId = new Map<string, Test[]>()
  private root: string

  constructor(root: string) {
    this.root = root
  }

  get empty() { return !this.byId.size }

  register(id: string, watchers: unknown) {
    if (!Array.isArray(watchers)) return
    const windows = isWindowsPath(this.root)
    const tests: Test[] = []
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
      const glob = windows ? pattern.replace(/\\/g, '/') : pattern
      const re = globToRegExp(glob, windows)
      if (!re) continue
      const absolute = glob.startsWith('/') || (windows && /^[a-z]:/i.test(glob))
      const kinds = typeof w.kind === 'number' ? w.kind : 7
      tests.push((file, type) => {
        // Create 1, change 2, delete 4.
        if (!(kinds & (1 << (type - 1)))) return false
        if (absolute) return re.test(joinRoot(this.root, file))
        return file.startsWith(base) && re.test(file.slice(base.length))
      })
    }
    if (tests.length) this.byId.set(id, tests)
  }

  unregister(id: string) {
    this.byId.delete(id)
  }

  wants(file: string, type: FileChange): boolean {
    for (const tests of this.byId.values()) if (tests.some(test => test(file, type))) return true
    return false
  }
}
