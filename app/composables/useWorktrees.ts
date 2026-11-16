import { FolderGit2, FolderPlus, House } from 'lucide-vue-next'
import type { GitWorktree } from '~/types/ipc'
import type { MenuItem } from '~/types/ui'
import { useWorkspace } from '~/stores/workspace'
import { useThreads } from '~/stores/threads'
import { useGit } from '~/stores/git'
import { modLabel } from '~/composables/useShortcuts'
import { worktreeName } from '~/utils/worktrees'

/**
 * The active project's working trees, for the titlebar's switcher and the command palette: the
 * project folder and each linked worktree, which one is in view, and going to one (its latest chat,
 * or a new chat there when none works in it yet).
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
  /** The working copy in view (the active chat's worktree, or the project). */
  const current = computed(() => threads.workdir)
  /** The worktree in view when it is a linked one; null in the project folder. */
  const currentLinked = computed(() => {
    const at = current.value
    if (!at || at === project.value) return null
    return linked.value.find(w => w.path === at) ?? { path: at, branch: git.status(at)?.branch ?? null, head: null, isMain: false, isCurrent: false, locked: false, prunable: false }
  })

  /** Top-level chats of the project working in `w` (the project folder: those with no worktree). */
  function chatsIn(w: GitWorktree) {
    const path = project.value
    return path ? threads.forProject(path).filter(t => (isProject(w) ? !t.worktree : t.worktree === w.path)) : []
  }

  function isInView(w: GitWorktree) {
    return isProject(w) ? !currentLinked.value : current.value === w.path
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

  const menuItems = computed<MenuItem[]>(() => [
    ...list.value.map((w, i): MenuItem => ({
      label: label(w),
      hint: hint(w),
      icon: isProject(w) ? House : FolderGit2,
      checked: isInView(w),
      disabled: w.prunable,
      group: i === 0 ? 'Working copies' : undefined,
      onSelect: () => void goTo(w).catch(() => {}),
    })),
    { label: 'New chat in a worktree…', icon: FolderPlus, kbd: `${modLabel()}+Shift+N`, divider: true, onSelect: () => ws.openWorktreeDialog() },
  ])

  return { supported, list, linked, current, currentLinked, chatsIn, goTo, label, hint, menuItems, isInView }
}
