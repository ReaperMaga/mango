import type { DiffLine, Message, Part } from '~/types/chat'
import { changeTree, folderPaths, turnChanges, type ChangedFile, type ChangeNode } from '~/utils/turnChanges'

/**
 * The files an agent reply changed, for `ChatChanges.tsx`. The derivation itself is the desktop's
 * (`app/utils/turnChanges.ts`, shared); this adds what the phone's list needs around it. Pure.
 */
export { changeTree, folderPaths, turnChanges, type ChangedFile, type ChangeNode }

/** Folders start open while the list stays short; a longer one starts at its top level. */
export const SHORT = 8

/** Sub-agents nest at most this deep, as on the desktop. */
const DEPTH = 4

export interface ChangeRow { node: ChangeNode; depth: number; open: boolean }

/** The tree as the rows on screen: a closed folder hides what is under it. */
export function visibleRows(tree: ChangeNode[], closed: ReadonlySet<string>): ChangeRow[] {
  const out: ChangeRow[] = []
  const walk = (nodes: ChangeNode[], depth: number) => {
    for (const node of nodes) {
      const open = !node.file && !closed.has(node.path)
      out.push({ node, depth, open })
      if (open) walk(node.children, depth + 1)
    }
  }
  walk(tree, 0)
  return out
}

/** The folders closed at first: none for a short list, all of them for a long one. */
export function initiallyClosed(files: ChangedFile[], tree: ChangeNode[]): Set<string> {
  return new Set(files.length > SHORT ? folderPaths(tree) : [])
}

export function totals(files: ChangedFile[]): { add: number; del: number } {
  return files.reduce((t, f) => ({ add: t.add + f.add, del: t.del + f.del }), { add: 0, del: 0 })
}

export const changedFilesLabel = (n: number) => `${n} changed file${n === 1 ? '' : 's'}`

/**
 * The git change for a file the reply changed, or null when it has none left (committed since, or
 * changed back). Git's paths are relative to the repository root, the reply's to the chat's folder,
 * which may sit below it: an exact match first, else the one change whose path ends in the file's.
 */
export function gitChangeFor<C extends { path: string }>(changes: readonly C[], file: string): C | null {
  const exact = changes.find(c => c.path === file)
  if (exact) return exact
  const tail = changes.filter(c => c.path.endsWith(`/${file}`))
  return tail.length === 1 ? tail[0]! : null
}

const norm = (p: string) => p.trim().replace(/\\/g, '/').replace(/^\.\//, '')

/** As `turnChanges` names a tool row's file: a move ("a → b") counts for where the file went. */
function pathOf(target: string): string {
  const cut = target.lastIndexOf(' → ')
  return norm(cut >= 0 ? target.slice(cut + 3) : target)
}

/**
 * What the reply's own edit and write tools recorded for one file (sub-agents included), one edit
 * after another; each edit opens with a hunk band when there are several. Empty when the tools
 * recorded only a summary. Shown for a file git no longer has a change for.
 */
export function editsOf(parts: Part[], file: string, childMessages: (id: string) => Message[] = () => []): DiffLine[] {
  const edits: DiffLine[][] = []
  const visit = (list: Part[], depth: number) => {
    for (const p of list) {
      if (p.type !== 'tool') continue
      if (p.childId && depth < DEPTH) for (const m of childMessages(p.childId)) visit(m.parts, depth + 1)
      if ((p.tool !== 'edit' && p.tool !== 'write') || p.status !== 'ok' || pathOf(p.target) !== file) continue
      if (p.diff?.length) edits.push(p.diff)
    }
  }
  visit(parts, 0)
  if (edits.length < 2) return edits[0] ?? []
  return edits.flatMap((lines, i) => (lines[0]?.kind === 'hunk' ? lines : [{ kind: 'hunk' as const, text: `Edit ${i + 1} of ${edits.length}` }, ...lines]))
}
