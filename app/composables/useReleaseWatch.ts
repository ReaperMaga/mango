import { useWorkspace } from '~/stores/workspace'
import { useReleases } from '~/stores/releases'
import { useForge } from '~/stores/forge'
import { vcsTerms } from '~/utils/vcs'
import { focusGate } from '~/utils/focusGate'

/**
 * Keeps the active project's releases current for the Releases button on the tool stripe and the
 * tool window: read when the project comes to the front or the window gets focus (at most every 30
 * seconds), then while a release builds every 15 seconds with the window open and every 30 without,
 * and every two minutes while the window is open otherwise. Never while the app is hidden, and not
 * again after a failed read until the project or the focus changes. Only projects whose git remotes name a
 * GitHub or GitLab repository have releases: no button and no reads for the others (Unity VCS and Lore included).
 */
export function useReleaseWatch() {
  const ws = useWorkspace()
  const releases = useReleases()

  const forge = useForge()

  /** The git project in view, whatever its remotes say. */
  const project = computed(() => (ws.activeProjectPath && vcsTerms(ws.activeProject?.vcs).forge ? ws.activeProjectPath : null))
  watch(project, p => forge.ensure(p), { immediate: true })
  /** The project, only while its remotes name a GitHub or GitLab repository (the forges with releases). */
  const path = computed(() => (forge.connected(project.value) ? project.value : null))
  // The window open for a project with no such repository: put it away.
  watch(() => [ws.toolPanel, project.value, project.value ? project.value in forge.links : false, path.value] as const, ([tool, p, read, connected]) => {
    if (tool === 'releases' && p && read && !connected) ws.closeTool()
  }, { immediate: true })
  const open = computed(() => ws.toolPanel === 'releases')
  const mark = computed(() => releases.mark(path.value))

  let timer: ReturnType<typeof setTimeout> | undefined

  function delay(): number | null {
    const list = path.value ? releases.lists[path.value] : undefined
    if (!list?.data || list.error) return null
    if (mark.value === 'running') return open.value ? 15_000 : 30_000
    return open.value ? 120_000 : null
  }

  function schedule() {
    clearTimeout(timer)
    const p = path.value
    const list = p ? releases.lists[p] : undefined
    if (!p || !list || list.loading) return
    const wait = delay()
    if (wait === null) return
    timer = setTimeout(() => {
      if (document.hidden) { schedule(); return }
      void releases.load(p, { force: true, quiet: true })
    }, Math.max(0, wait - (Date.now() - list.fetchedAt)))
  }

  function readNow() { if (path.value) void releases.load(path.value) }

  watch(path, readNow, { immediate: true })
  watch(open, (o) => { if (o) readNow() })
  const list = computed(() => (path.value ? releases.lists[path.value] : undefined))
  watch(() => `${path.value}|${list.value?.loading}|${list.value?.fetchedAt}|${open.value}|${mark.value}`, schedule, { immediate: true })
  // A failed read is tried again on focus: alt-tabbing back and forth does so at most every few seconds.
  const onFocus = focusGate(readNow)
  onMounted(() => window.addEventListener('focus', onFocus))
  onBeforeUnmount(() => {
    clearTimeout(timer)
    onFocus.cancel()
    window.removeEventListener('focus', onFocus)
  })

  return { path, mark }
}
