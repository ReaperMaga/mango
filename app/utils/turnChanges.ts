import type { Message, Part } from '~/types/chat'

type ToolPart = Extract<Part, { type: 'tool' }>

/** One file an agent changed during a turn, with its line counts summed over every edit to it. */
export interface ChangedFile {
  /** As the agent named it: relative to the chat's folder (forward slashes), or absolute when outside it. */
  path: string
  add: number
  del: number
  /** Inside the chat's folder, so it can be opened there. */
  inside: boolean
}

/** A folder or file of the changed-files tree. Folders with one sub-folder and nothing else are merged ("app/components"). */
export interface ChangeNode {
  /** What the row shows: a file's name, or a folder's (possibly merged) path segment. */
  name: string
  /** Full path of the folder or file. */
  path: string
  add: number
  del: number
  file?: ChangedFile
  children: ChangeNode[]
}

const isAbsolute = (p: string) => p.startsWith('/') || /^[a-z]:\//i.test(p)

/** "+4 −1", "+12", "−3" (the summaries the adapters write for edits). */
const SUMMARY = /^\+(\d+)(?:\s*[−-](\d+))?$|^[−-](\d+)$/

function counts(part: ToolPart): { add: number; del: number } {
  // The summary counts the whole change; a diff may be capped for display.
  const m = part.summary?.trim().match(SUMMARY)
  if (m) return { add: Number(m[1] ?? 0), del: Number(m[2] ?? m[3] ?? 0) }
  let add = 0
  let del = 0
  for (const l of part.diff ?? []) {
    if (l.kind === 'add') add++
    else if (l.kind === 'del') del++
  }
  return { add, del }
}

/** The file a tool row changed; a move ("a → b") counts for where the file went. */
function changedPath(part: ToolPart): string {
  const target = part.target.includes(' → ') ? part.target.slice(part.target.lastIndexOf(' → ') + 3) : part.target
  return target.trim().replace(/\\/g, '/').replace(/^\.\//, '')
}

/**
 * The files a turn changed through the agent's own edit and write tools, in the order they were
 * first touched. Sub-agents started in the turn are included through `childMessages`. Changes made
 * any other way (a shell command, a formatter) are not seen here.
 */
export function turnChanges(parts: Part[], childMessages: (id: string) => Message[] = () => []): ChangedFile[] {
  const files = new Map<string, ChangedFile>()
  const visit = (list: Part[], depth: number) => {
    for (const p of list) {
      if (p.type !== 'tool') continue
      if (p.childId && depth < 4) for (const m of childMessages(p.childId)) visit(m.parts, depth + 1)
      if ((p.tool !== 'edit' && p.tool !== 'write') || p.status !== 'ok') continue
      const path = changedPath(p)
      if (!path) continue
      const { add, del } = counts(p)
      const f = files.get(path)
      if (f) { f.add += add; f.del += del }
      else files.set(path, { path, add, del, inside: !isAbsolute(path) && !path.startsWith('../') })
    }
  }
  visit(parts, 0)
  return [...files.values()]
}

/** Folders, then files, then anything outside the chat's folder; each by name. */
const rank = (n: ChangeNode) => (n.path.startsWith('/') || /^[a-z]:/i.test(n.path) ? 2 : n.file ? 1 : 0)
const byPlace = (a: ChangeNode, b: ChangeNode) => rank(a) - rank(b) || a.name.localeCompare(b.name, undefined, { numeric: true })

/** The changed files as a folder tree. */
export function changeTree(files: ChangedFile[]): ChangeNode[] {
  const root: ChangeNode = { name: '', path: '', add: 0, del: 0, children: [] }
  for (const f of files) {
    const segs = f.path.split('/').filter(Boolean)
    // An absolute path keeps its leading slash on the first folder, so it never merges with a project folder.
    if (f.path.startsWith('/') && segs.length) segs[0] = `/${segs[0]}`
    let node = root
    node.add += f.add
    node.del += f.del
    segs.forEach((seg, i) => {
      const path = segs.slice(0, i + 1).join('/')
      const last = i === segs.length - 1
      let next = node.children.find(c => c.name === seg && !!c.file === last)
      if (!next) {
        next = { name: seg, path, add: 0, del: 0, children: [], ...(last ? { file: f } : {}) }
        node.children.push(next)
      }
      next.add += f.add
      next.del += f.del
      node = next
    })
  }
  const tidy = (n: ChangeNode): ChangeNode => {
    let node = n
    while (!node.file && node.children.length === 1 && !node.children[0]!.file) {
      const only = node.children[0]!
      node = { ...only, name: `${node.name}/${only.name}` }
    }
    return { ...node, children: node.children.map(tidy).sort(byPlace) }
  }
  return root.children.map(tidy).sort(byPlace)
}

/** Every folder path in the tree, for expanding or collapsing them all. */
export function folderPaths(nodes: ChangeNode[]): string[] {
  return nodes.flatMap(n => (n.file ? [] : [n.path, ...folderPaths(n.children)]))
}
