/**
 * The folder a Claude Code session works in, told apart from a folder its shell only moved to.
 * Plain TypeScript (the adapters and the phone app use it): no Vue, Pinia or Tauri.
 *
 * Claude Code's system/init `cwd` is the session's folder: a worktree it entered (EnterWorktree)
 * and did not leave. It also follows the Bash tool's `cd` inside that folder, so a `cd Assets/Scripts`
 * would read as a move into a worktree named Scripts. A worktree is either one of Claude Code's own
 * (`<repo>/.claude/worktrees/<name>`) or a folder outside the one the session was started in.
 */

/** A path to compare: no trailing separator; a Windows path also in one case and with one kind of separator. */
export const comparable = (p: string) => {
  const t = p.replace(/(?<=.)[\\/]+$/, '')
  return /^[a-z]:/i.test(t) ? t.replace(/\//g, '\\').toLowerCase() : t
}

/**
 * Whether `cwd` is another folder than `spawned`, not just another spelling of it
 * (a trailing separator, a Windows drive letter's case, or macOS's /private/tmp for /tmp).
 */
export function movedFrom(spawned: string, cwd: string): boolean {
  const a = comparable(spawned)
  const b = comparable(cwd)
  return a !== b && b !== `/private${a}`
}

/** `path` is `base` or inside it (macOS may report /tmp as /private/tmp). */
export function isWithin(base: string, path: string): boolean {
  const b = comparable(path)
  return [comparable(base), `/private${comparable(base)}`].some((a) => {
    const sep = /^[a-z]:/i.test(a) ? '\\' : '/'
    return b === a || b.startsWith(a.endsWith(sep) ? a : a + sep)
  })
}

const CLAUDE_TREE = /^(.*)[\\/]\.claude[\\/]worktrees[\\/]([^\\/]+)(?:[\\/]|$)/

/** The Claude Code worktree (`<repo>/.claude/worktrees/<name>`) `path` is in, spelled as in `path`; the innermost one. */
export function claudeWorktreeOf(path: string): { root: string; repo: string } | null {
  const m = CLAUDE_TREE.exec(path)
  if (!m) return null
  const repo = m[1] || path.slice(0, 1)
  const at = m[0].length - (/[\\/]$/.test(m[0]) ? 1 : 0)
  return { root: path.slice(0, at), repo }
}

/**
 * Where a resumed session goes on, from the `cwd` its system/init reports: a folder other than
 * `spawned`, or null when it is still there (a `cd` inside it included).
 */
export function resumedFolder(spawned: string, cwd: string): string | null {
  const tree = claudeWorktreeOf(cwd)?.root
  let folder = cwd
  if (tree) folder = tree
  else if (isWithin(spawned, cwd)) folder = spawned
  else {
    // Started in a Claude Code worktree, left it, then moved about the repository: the repository.
    const repo = claudeWorktreeOf(spawned)?.repo
    if (repo && isWithin(repo, cwd)) folder = repo
  }
  return movedFrom(spawned, folder) ? folder : null
}

/**
 * The working copy a chat saved with `worktree` really works in, for chats older builds moved into a
 * plain folder of their project on a `cd`: such a folder is the project itself (null), and one inside a
 * Claude Code worktree is that worktree. Any other folder is kept as it is.
 */
export function savedWorktree(projectPath: string, worktree: string): string | null {
  if (!movedFrom(projectPath, worktree)) return null
  if (!isWithin(projectPath, worktree)) return worktree
  const tree = claudeWorktreeOf(worktree)
  return tree && isWithin(projectPath, tree.repo) && movedFrom(projectPath, tree.root) ? tree.root : null
}
