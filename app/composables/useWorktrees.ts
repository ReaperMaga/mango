import type { GitWorktree } from '~/types/ipc'
import { useWorkspace } from '~/stores/workspace'
import { useThreads } from '~/stores/threads'
import { useGit } from '~/stores/git'
import { worktreeName } from '~/utils/worktrees'

/**
 * The active project's working trees, for the sidebar's new-chat menu and the command palette: the
 * project folder and each linked worktree, and going to one (its latest chat, or a new chat there
 * when none works in it yet).
 */
export function useWorktrees() {
  const ws = useWorkspace()
  const threads = useThreads()
  const git = useGit()

  const project = computed(() => ws.activeProjectPath)
  /** Worktrees are a git feature: none for Unity VCS or a folder without version control. */
  const supported = computed(() => !!ws.activeProject?.isGit && ws.activeProject.vcs !== 'plastic')
  const list = computed(() => (supported.value ? git.worktrees(project.value) : []))
  /** The other working trees: every one but the project folder's own (`isCurrent`, asked about the project). */
  const linked = computed(() => list.value.filter(w => !w.isCurrent))
  const isProject = (w: GitWorktree) => w.isCurrent

  /** Top-level chats of the project working in `w` (the project folder: those with no worktree). */
  function chatsIn(w: GitWorktree) {
    const path = project.value
    return path ? threads.forProject(path).filter(t => (isProject(w) ? !t.worktree : t.worktree === w.path)) : []
  }

  /** Show the latest chat that works in `w`; start one there when there is none. */
  async function goTo(w: GitWorktree) {
    const path = project.value
    if (!path) return
    const latest = [...chatsIn(w)].sort((a, b) => b.updatedAt - a.updatedAt)[0]
    if (latest) threads.show(latest.id)
    else if (isProject(w)) threads.create(path)
    else await threads.createInWorktree(path, { existing: w.path })
  }

  function label(w: GitWorktree) {
    return isProject(w) ? 'Project folder' : w.isMain ? `${worktreeName(w.path)} (main)` : worktreeName(w.path)
  }

  function hint(w: GitWorktree) {
    const n = chatsIn(w).length
    const branch = w.branch ?? (w.head ? `${w.head} detached` : 'detached')
    return w.prunable ? `${branch} · folder is gone` : `${branch}${n ? ` · ${n} chat${n === 1 ? '' : 's'}` : ''}`
  }

  return { supported, list, linked, chatsIn, goTo, label, hint }
}
