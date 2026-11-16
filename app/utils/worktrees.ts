import type { Thread } from '~/types/chat'
import { baseName } from '~/utils/paths'

/**
 * Git worktrees let several chats of one project work at the same time without touching each
 * other's files: each such chat has its own folder (a linked worktree) on its own branch. A chat
 * without one works in the project folder itself.
 */

/** The folder a chat's agent works in: its worktree, or the project. */
export const workdirOf = (t: Pick<Thread, 'projectPath' | 'worktree'>) => t.worktree || t.projectPath

/** How a worktree folder is named in the chrome: its last folder (`mango.worktrees/fix-login` → `fix-login`). */
export const worktreeName = (path: string) => baseName(path)

const WORDS = ['pear', 'fig', 'lime', 'plum', 'kiwi', 'yuzu', 'date', 'quince', 'guava', 'lychee', 'papaya', 'cherry']

/**
 * A branch name for a new worktree chat that is not taken yet: `mango/<word>`, then `mango/<word>-2` …
 * The user can type their own; this only spares them from having to.
 */
export function suggestBranch(taken: Iterable<string>): string {
  const used = new Set(taken)
  const start = Math.floor(Math.random() * WORDS.length)
  for (let n = 1; n < 100; n++) {
    for (let i = 0; i < WORDS.length; i++) {
      const name = `mango/${WORDS[(start + i) % WORDS.length]}${n > 1 ? `-${n}` : ''}`
      if (!used.has(name)) return name
    }
  }
  return `mango/${Date.now().toString(36)}`
}

/**
 * Whether `name` would be a usable new branch name, checked the way the user types it (git's own
 * `check-ref-format` rules, the parts that matter in practice). Returns why not, or null.
 */
export function branchNameProblem(name: string): string | null {
  const n = name.trim()
  if (!n) return 'Give the branch a name'
  if (/\s/.test(n)) return 'Branch names cannot contain spaces'
  if (/[~^:?*[\\\x00-\x1f\x7f]/.test(n) || n.includes('..') || n.includes('@{')) return 'That name has characters git does not allow'
  if (n.startsWith('-') || n.startsWith('/') || n.endsWith('/') || n.endsWith('.') || n.endsWith('.lock') || n.includes('//') || n === '@') {
    return 'That is not a valid branch name'
  }
  if (n.split('/').some(part => part.startsWith('.'))) return 'No part of the name may start with a dot'
  return null
}
