import { useWorkspace } from '~/stores/workspace'
import { useFiles } from '~/stores/files'
import { useGit } from '~/stores/git'
import { isEnvPath } from '~/utils/envPath'

/** A remote project is re-read on focus at most this often (its git status polls every 15 s). */
const REMOTE_FOCUS_MS = 15_000

/**
 * Keep the file tree and open files in step with the disk: an agent, the
 * terminal or another editor may change them at any time. Re-read when the
 * window comes back into focus, whenever the set of changed files moves
 * (git status is refreshed after agent turns and git actions), and when something
 * says it changed files (`mango:files-changed`). A remote project (`env://…`) is
 * read over SSH, so focus re-reads it at most every 15 seconds.
 */
export function useFilesSync() {
  const ws = useWorkspace()
  const files = useFiles()
  const git = useGit()

  const hasFiles = (path: string) => !!files.trees[path] || Object.values(files.open).some(f => f.projectPath === path)
  /** When each remote project was last re-read: every folder and file read there is an SSH round trip. */
  const lastRemote = new Map<string, number>()
  const sync = (fromFocus = false) => {
    const path = ws.activeProjectPath
    if (!path || !hasFiles(path)) return
    if (isEnvPath(path)) {
      const now = Date.now()
      if (fromFocus && now - (lastRemote.get(path) ?? 0) < REMOTE_FOCUS_MS) return
      lastRemote.set(path, now)
    }
    void files.refresh(path)
  }
  const onFocus = () => sync(true)

  /** A fingerprint of the changes, so an unchanged periodic status refresh costs nothing. */
  const changes = computed(() => {
    const status = git.status(ws.activeProjectPath)
    return status ? `${status.head}|${status.branch}|${status.files.map(f => `${f.path}:${f.index}${f.worktree}`).join(',')}` : ''
  })
  watch(changes, (now, before) => { if (before !== undefined && now !== before) sync() })

  /**
   * An edit to a file that already counts as modified leaves the fingerprint as it was. Its open tab
   * must still be read again, or the next keystroke there saves into a conflict.
   */
  const onChanged = (e: Event) => {
    const path = (e as CustomEvent<{ path?: string }>).detail?.path
    if (path && hasFiles(path)) void files.refresh(path)
  }

  onMounted(() => {
    window.addEventListener('focus', onFocus)
    window.addEventListener('mango:files-changed', onChanged)
  })
  onBeforeUnmount(() => {
    window.removeEventListener('focus', onFocus)
    window.removeEventListener('mango:files-changed', onChanged)
  })
}
