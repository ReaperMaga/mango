import { t } from '../i18n/index.ts'
import type { VcsKind, VcsLock } from '~/types/ipc'

/**
 * What differs between git, Unity Version Control and Lore in the shared source
 * control UI: the words for things, and which actions exist at all. Actions
 * a system doesn't have are left out, never imitated.
 */
export interface VcsTerms {
  /** Name of the system, for messages and the label in the Changes header. */
  name: string
  /** Verb on the commit button: "Commit" / "Check in". */
  commit: string
  /** The same with nothing staged, which takes every change. */
  commitAll: string
  /** Past tense for the result line: "Committed a1b2c3d" / "Checked in cs:12". */
  committed: string
  /** Placeholder of the message box. */
  message: string
  /** One recorded change: "commit" / "changeset". */
  unit: string
  /** Several of them: "commits" / "changesets". */
  units: string
  /** n of them: "2 commits" / "1 changeset". */
  count: (n: number) => string
  /** Pull: "Pull" / "Update". */
  pull: string
  /** Branches have git-style remotes: fetch, push, publish, remote branches, upstream tracking. */
  remotes: boolean
  /** Amend the last commit. */
  amend: boolean
  /** Merge another branch into the current one from the branch popup. */
  merge: boolean
  /**
   * Merge asks first, showing what it brings and any conflicts (`git_merge_preview`). Unity VCS: the
   * result is pending changes to check in, and conflicts are left to the Unity VCS app.
   */
  mergePreview: boolean
  /** Rebase the current branch onto another from the branch popup. */
  rebase: boolean
  /** Rename a branch from the branch popup. */
  rename: boolean
  /** Clear local branches in one go (only where deleting one is local: git). */
  clearBranches: boolean
  /** Hint under the delete confirmation: what deleting a branch does here. */
  deleteHint: string
  /** Branch names are paths from the root (`/main/task`), and a new one is a child of its base. */
  pathBranches: boolean
  /** Files can be locked (exclusive checkout), and other people's locks are shown. */
  locks: boolean
  /** Shelves: park pending changes on the server and apply them back later (Unity VCS's stash). */
  shelves: boolean
  /** A chat can run in its own working copy: a linked worktree, or an extra Unity VCS workspace. */
  worktrees: boolean
  /** The project lives on GitHub or GitLab: pull requests, issues and releases. */
  forge: boolean
  /** The commit graph (Git log tab) reads its history. */
  log: boolean
  /** What that working copy is called: "worktree" / "workspace". */
  worktree: string
  /** Periodic refresh. Unity VCS scans the whole workspace, which can take seconds on a big project. */
  pollMs: number
}

const TERMS: Record<VcsKind, VcsTerms> = {
  git: {
    name: 'Git',
    get commit() { return t('shell.vcs.git.commit') }, get commitAll() { return t('shell.vcs.git.commitAll') }, get committed() { return t('shell.vcs.git.committed') }, get message() { return t('shell.vcs.git.message') },
    get unit() { return t('shell.vcs.git.unit') }, get units() { return t('shell.vcs.git.units') }, get pull() { return t('shell.vcs.git.pull') }, get worktree() { return t('shell.vcs.git.worktree') },
    count: n => t('shell.vcs.git.count', n), get deleteHint() { return t('git.branches.deleteLocalHint') },
    remotes: true, amend: true, merge: true, mergePreview: false, rebase: true, rename: true, clearBranches: true, pathBranches: false, locks: false, shelves: false, worktrees: true, forge: true, log: true, pollMs: 4000,
  },
  plastic: {
    name: 'Unity VCS',
    get commit() { return t('shell.vcs.plastic.commit') }, get commitAll() { return t('shell.vcs.plastic.commitAll') }, get committed() { return t('shell.vcs.plastic.committed') }, get message() { return t('shell.vcs.plastic.message') },
    get unit() { return t('shell.vcs.plastic.unit') }, get units() { return t('shell.vcs.plastic.units') }, get pull() { return t('shell.vcs.plastic.pull') }, get worktree() { return t('shell.vcs.plastic.worktree') },
    count: n => t('shell.vcs.plastic.count', n), get deleteHint() { return t('git.branches.deleteUnityHint') },
    remotes: false, amend: false, merge: true, mergePreview: true, rebase: false, rename: true, clearBranches: false, pathBranches: true, locks: true, shelves: true, worktrees: true, forge: false, log: false, pollMs: 15000,
  },
  /**
   * Lore: one server, shown as the remote (`remote/main`); amend changes only an unpushed revision's
   * message; a branch can't be renamed, and deleting one archives it on the server for everyone.
   * Its status walks the whole working tree, so it is read as seldom as Unity VCS's.
   */
  lore: {
    name: 'Lore',
    get commit() { return t('shell.vcs.lore.commit') }, get commitAll() { return t('shell.vcs.lore.commitAll') }, get committed() { return t('shell.vcs.lore.committed') }, get message() { return t('shell.vcs.lore.message') },
    get unit() { return t('shell.vcs.lore.unit') }, get units() { return t('shell.vcs.lore.units') }, get pull() { return t('shell.vcs.lore.pull') }, get worktree() { return t('shell.vcs.lore.worktree') },
    count: n => t('shell.vcs.lore.count', n), get deleteHint() { return t('git.branches.deleteLoreHint') },
    remotes: true, amend: true, merge: true, mergePreview: false, rebase: false, rename: false, clearBranches: false, pathBranches: false, locks: true, shelves: false, worktrees: false, forge: false, log: true, pollMs: 15000,
  },
}

export function vcsTerms(kind: VcsKind | null | undefined): VcsTerms {
  return TERMS[kind ?? 'git'] ?? TERMS.git
}

/** "n changesets" / "1 commit". */
export function units(n: number, terms: VcsTerms): string {
  return terms.count(n)
}

/** Who holds a lock, short: "you", or the user name without its email domain. */
export function lockHolder(lock: VcsLock): string {
  return lock.mine ? t('shell.locks.you') : lock.owner.split('@')[0] || lock.owner
}

/** One line on a lock, for tooltips and screen readers. */
export function lockSummary(lock: VcsLock): string {
  const who = lock.mine ? t('shell.locks.you') : lock.owner
  const { branch, workspace } = lock
  if (lock.status === 'retained') return branch ? t('shell.locks.kept', { who, branch }) : t('shell.locks.keptTheirs', { who })
  if (workspace) return branch ? t('shell.locks.byBoth', { who, workspace, branch }) : t('shell.locks.byWorkspace', { who, workspace })
  return branch ? t('shell.locks.byBranch', { who, branch }) : t('shell.locks.by', { who })
}

/**
 * A sync result or failure as a headline and the lines under it: the backend
 * writes "Pulled 3 commits into main." then "12 files changed, +80 -10".
 */
export function resultLines(text: string): { title: string; detail: string } {
  const at = text.indexOf('\n')
  if (at < 0) return { title: text.trim(), detail: '' }
  return { title: text.slice(0, at).trim(), detail: text.slice(at + 1).trim() }
}
