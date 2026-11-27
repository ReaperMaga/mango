import { useWorkspace } from '~/stores/workspace'
import { useActions } from '~/stores/actions'
import { useReleases } from '~/stores/releases'
import { useGit } from '~/stores/git'
import { useThreads } from '~/stores/threads'
import { actionsMark } from '~/utils/actionRuns'
import { vcsTerms } from '~/utils/vcs'

/**
 * Keeps the active project's workflow runs current for the Actions button on the tool stripe and
 * the tool window. Nothing is read until the window is first opened for a project (the button's mark
 * falls back on the runs the Releases window read). Then: on open and when the app gets focus (at
 * most every 20 seconds), every 10 seconds while a run goes with the window open and every 30
 * without, every minute while the window is open otherwise. Never while the app is hidden, and not
 * again after a failed read until something changes.
 */
export function useActionsWatch() {
  const ws = useWorkspace()
  const actions = useActions()
  const releases = useReleases()
  const git = useGit()
  const threads = useThreads()

  const path = computed(() => (ws.activeProjectPath && vcsTerms(ws.activeProject?.vcs).forge ? ws.activeProjectPath : null))
  /** The branch the user is looking at (the active chat's worktree, or the project). */
  const branch = computed(() => git.status(threads.workdir ?? ws.activeProjectPath)?.branch ?? null)
  /** The list shown: all runs, or the branch's. */
  const shownBranch = computed(() => (actions.scope === 'branch' ? branch.value : null))
  const open = computed(() => ws.toolPanel === 'actions')
  const list = computed(() => actions.list(path.value, shownBranch.value))

  const mark = computed(() => {
    const runs = list.value?.data?.runs ?? (path.value ? releases.lists[path.value]?.data?.runs : null)
    return runs ? actionsMark(runs, branch.value) : null
  })

  let timer: ReturnType<typeof setTimeout> | undefined

  function delay(): number | null {
    const l = list.value
    if (!l?.data || l.error) return null
    if (l.data.runs.some(r => r.state === 'pending' || r.state === 'queued')) return open.value ? 10_000 : 30_000
    return open.value ? 60_000 : null
  }

  function schedule() {
    clearTimeout(timer)
    const p = path.value
    const b = shownBranch.value
    const l = list.value
    if (!p || !l || l.loading) return
    const wait = delay()
    if (wait === null) return
    timer = setTimeout(() => {
      if (document.hidden) { schedule(); return }
      void actions.load(p, b, { force: true, quiet: true })
    }, Math.max(0, wait - (Date.now() - l.fetchedAt)))
  }

  /** On open, or when something changes while it is open (or was read before). */
  function readNow() {
    if (!path.value || (actions.scope === 'branch' && !branch.value)) return
    if (open.value || list.value) void actions.load(path.value, shownBranch.value)
  }

  watch([path, shownBranch, open], readNow, { immediate: true })
  watch(() => `${path.value}|${shownBranch.value}|${list.value?.loading}|${list.value?.fetchedAt}|${open.value}`, schedule, { immediate: true })
  onMounted(() => window.addEventListener('focus', readNow))
  onBeforeUnmount(() => {
    clearTimeout(timer)
    window.removeEventListener('focus', readNow)
  })

  return { path, branch, shownBranch, mark }
}
