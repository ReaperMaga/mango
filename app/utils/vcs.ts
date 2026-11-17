import type { VcsKind, VcsLock } from '~/types/ipc'

/**
 * What differs between git and Unity Version Control in the shared source
 * control UI: the words for things, and which actions exist at all. Actions
 * a system doesn't have are left out, never imitated.
 */
export interface VcsTerms {
  /** Name of the system, for messages. */
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
  /** Branch names are paths from the root (`/main/task`), and a new one is a child of its base. */
  pathBranches: boolean
  /** Files can be locked (exclusive checkout), and other people's locks are shown. */
  locks: boolean
  /** Periodic refresh. Unity VCS scans the whole workspace, which can take seconds on a big project. */
  pollMs: number
}

const TERMS: Record<VcsKind, VcsTerms> = {
  git: {
    name: 'git', commit: 'Commit', commitAll: 'Commit all', committed: 'Committed', message: 'Commit message', unit: 'commit',
    pull: 'Pull', remotes: true, amend: true, merge: true, mergePreview: false, rebase: true, pathBranches: false, locks: false, pollMs: 4000,
  },
  plastic: {
    name: 'Unity VCS', commit: 'Check in', commitAll: 'Check in all', committed: 'Checked in', message: 'Checkin comment', unit: 'changeset',
    pull: 'Update', remotes: false, amend: false, merge: true, mergePreview: true, rebase: false, pathBranches: true, locks: true, pollMs: 15000,
  },
}

export function vcsTerms(kind: VcsKind | null | undefined): VcsTerms {
  return TERMS[kind ?? 'git'] ?? TERMS.git
}

/** "n changesets" / "1 commit". */
export function units(n: number, t: VcsTerms): string {
  return `${n} ${t.unit}${n === 1 ? '' : 's'}`
}

/** Who holds a lock, short: "you", or the user name without its email domain. */
export function lockHolder(lock: VcsLock): string {
  return lock.mine ? 'you' : lock.owner.split('@')[0] || lock.owner
}

/** One line on a lock, for tooltips and screen readers. */
export function lockSummary(lock: VcsLock): string {
  const who = lock.mine ? 'you' : lock.owner
  if (lock.status === 'retained') return `Lock kept for ${who} until ${lock.branch || 'their branch'} is merged`
  const ws = lock.workspace ? ` in workspace ${lock.workspace}` : ''
  return `Locked by ${who}${ws}${lock.branch ? `, on ${lock.branch}` : ''}`
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
