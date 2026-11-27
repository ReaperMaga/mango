/**
 * Keeping the Files view in step with the disk without redoing work when nothing changed: a Unity
 * project lists thousands of entries per folder and tens of thousands of changed files.
 * Plain functions, testable in Node.
 */
import type { FsEntry, GitStatus } from '~/types/ipc'

/** Whether two listings of a folder say the same, so the one on screen (and all that is worked out from it) can stay. */
export function sameEntries(a: readonly FsEntry[] | null | undefined, b: readonly FsEntry[] | null | undefined): boolean {
  if (a === b) return true
  if (!a || !b || a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!
    const y = b[i]!
    if (x.path !== y.path || x.name !== y.name || x.isDir !== y.isDir || x.ignored !== y.ignored) return false
  }
  return true
}

/**
 * Whether two status reads name the same changed files at the same commit: what the Files view
 * re-reads the disk for. The git store keeps the same object while a read says the same, so this
 * only walks the files when it was replaced.
 */
export function sameChanges(a: GitStatus | null | undefined, b: GitStatus | null | undefined): boolean {
  if (a === b) return true
  if (!a || !b || a.head !== b.head || a.branch !== b.branch || a.files.length !== b.files.length) return false
  for (let i = 0; i < a.files.length; i++) {
    const x = a.files[i]!
    const y = b.files[i]!
    if (x.path !== y.path || x.index !== y.index || x.worktree !== y.worktree) return false
  }
  return true
}

/**
 * Mark the folders above `file` (a relative path) as holding a change of `rank`, keeping the higher
 * one. Walks up only until a folder already holds one as high: every folder above it does too.
 */
export function markFolders<K>(kinds: Map<string, K>, file: string, kind: K, rank: (k: K) => number) {
  const r = rank(kind)
  for (let i = file.lastIndexOf('/'); i > 0; i = file.lastIndexOf('/', i - 1)) {
    const dir = file.slice(0, i)
    const had = kinds.get(dir)
    if (had !== undefined && rank(had) >= r) return
    kinds.set(dir, kind)
  }
}
