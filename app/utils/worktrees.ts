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

/** How long a branch named after a chat's first message may get, before `-2`, `-3` … */
const SLUG_MAX = 40

/**
 * A branch name from a chat's first message: lower-case ASCII words joined with `-`, cut on a word
 * boundary at about 40 characters ("Fix the login redirect!" → `fix-the-login-redirect`). "chat"
 * when nothing usable is left (a message in another script, or only punctuation).
 */
export function branchFromMessage(text: string): string {
  const words = text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '') // accents go, their letters stay
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
  let slug = ''
  for (const w of words) {
    const next = slug ? `${slug}-${w}` : w
    if (next.length > SLUG_MAX) {
      // A first word longer than the limit is cut; later ones end the name.
      if (!slug) slug = w.slice(0, SLUG_MAX)
      break
    }
    slug = next
  }
  return slug || 'chat'
}

/** `name`, or `name-2`, `name-3` … whichever is not in `taken` yet. */
export function untakenName(name: string, taken: Iterable<string>): string {
  const used = new Set(taken)
  if (!used.has(name)) return name
  for (let n = 2; n < 1000; n++) if (!used.has(`${name}-${n}`)) return `${name}-${n}`
  return `${name}-${Date.now().toString(36)}`
}
