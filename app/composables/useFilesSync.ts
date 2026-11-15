import { useWorkspace } from '~/stores/workspace'
import { useFiles } from '~/stores/files'
import { useGit } from '~/stores/git'

/**
 * Keep the file tree and open files in step with the disk: an agent, the
 * terminal or another editor may change them at any time. Re-read when the
 * window comes back into focus and whenever the set of changed files moves
 * (git status is refreshed after agent turns and git actions).
 */
export function useFilesSync() {
  const ws = useWorkspace()
  const files = useFiles()
  const git = useGit()

  const hasFiles = (path: string) => !!files.trees[path] || Object.values(files.open).some(f => f.projectPath === path)
  const sync = () => {
    const path = ws.activeProjectPath
    if (path && hasFiles(path)) void files.refresh(path)
  }

  /** A fingerprint of the changes, so an unchanged periodic status refresh costs nothing. */
  const changes = computed(() => {
    const status = git.status(ws.activeProjectPath)
    return status ? `${status.head}|${status.branch}|${status.files.map(f => `${f.path}:${f.index}${f.worktree}`).join(',')}` : ''
  })
  watch(changes, (now, before) => { if (before !== undefined && now !== before) sync() })

  onMounted(() => window.addEventListener('focus', sync))
  onBeforeUnmount(() => window.removeEventListener('focus', sync))
}
