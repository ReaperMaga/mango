import { reactive } from 'vue'
import type { PluginCatalogEntry, PluginSource } from '~/types/ipc'
import { on, pickFolder } from '~/composables/useBackend'
import { pluginJobId, usePlugins } from '~/stores/plugins'
import { useWorkspace } from '~/stores/workspace'
import { repoLabel } from '~/utils/pluginSource'
import { shortAgo } from '~/utils/time'

/**
 * What Settings > Plugins shows (tab, the plugin open in detail, the Add plugin dialog) and the jobs it
 * started (installs from the catalog, updates), kept outside the components so a job keeps going and
 * stays visible while the user looks at another tab or section.
 *
 * `openPlugins()` is the way in from elsewhere (the command palette: "Browse plugins", "Add plugin from link").
 */

export type PluginsTab = 'browse' | 'installed'

export interface PluginJob {
  /** What is happening: checking the repository, installing, updating. */
  phase: 'waiting' | 'probe' | 'install' | 'update'
  /** Last line of git's progress. */
  line: string
  error: string | null
}

const state = reactive({
  /** Null: Installed when something is installed, else Browse. */
  tab: null as PluginsTab | null,
  /** The plugin open in detail (its id), or null for the lists. */
  detail: null as string | null,
  addOpen: false,
  /** Prefilled into the Add plugin dialog's link field when it opens. */
  addLink: '',
  /** Running or failed jobs, by plugin id. A finished one is removed. */
  jobs: {} as Record<string, PluginJob>,
})

export function usePluginsView() {
  return state
}

/** Open Settings > Plugins: a tab, a plugin's detail, or the Add plugin dialog (with a link in it). */
export function openPlugins(opts: { tab?: PluginsTab; detail?: string; add?: boolean | string } = {}) {
  if (opts.tab) state.tab = opts.tab
  state.detail = opts.detail ?? null
  if (opts.add) {
    state.addLink = typeof opts.add === 'string' ? opts.add : ''
    state.addOpen = true
  }
  useWorkspace().openSettings('plugins')
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

/**
 * Catalog jobs run one at a time: git is easier on the network one clone at a time, and the backend keeps
 * only the newest few staged checkouts. Queued jobs show "Waiting…".
 */
let chain: Promise<unknown> = Promise.resolve()
function queued<T>(work: () => Promise<T>): Promise<T> {
  const next = chain.then(work, work)
  chain = next.catch(() => {})
  return next
}

/** Run `work` with git's progress lines for `jobId` going into the job's `line`. */
async function withProgress<T>(job: PluginJob, jobId: string, work: () => Promise<T>): Promise<T> {
  const stop = await on('plugins://progress', (p) => { if (p.jobId === jobId) job.line = p.line.trim() })
  try {
    return await work()
  } finally {
    stop()
  }
}

/** Install one catalog entry: check its source, install the plugin with the entry's id, switch it on. */
export async function installFromCatalog(entry: PluginCatalogEntry): Promise<boolean> {
  const plugins = usePlugins()
  if (state.jobs[entry.id] && !state.jobs[entry.id]!.error) return false
  const job: PluginJob = reactive({ phase: 'waiting', line: '', error: null })
  state.jobs[entry.id] = job
  return queued(async () => {
    const jobId = pluginJobId()
    job.phase = 'probe'
    try {
      const source: Extract<PluginSource, { kind: 'git' }> = { kind: 'git', ...entry.source }
      const probe = await withProgress(job, jobId, () => plugins.probe(source, jobId))
      const match = probe.candidates.find(c => c.manifest.id === entry.id)
        ?? (probe.candidates.length === 1 ? probe.candidates[0] : undefined)
      if (!match) {
        throw new Error(`${repoLabel(entry.source.url)} has no plugin with the id ${entry.id}${entry.source.subpath ? ` in ${entry.source.subpath}` : ''}. The catalog may be ahead of the repository; try again later.`)
      }
      job.phase = 'install'
      job.line = ''
      const [added] = await plugins.install(probe.probeId, [match.subpath])
      if (added && !added.enabled) await plugins.setEnabled(added.manifest.id, true)
      delete state.jobs[entry.id]
      return true
    } catch (e) {
      job.error = message(e)
      return false
    }
  })
}

/** Move an installed plugin to the latest commit of its source. */
export async function updatePlugin(id: string): Promise<boolean> {
  const plugins = usePlugins()
  if (state.jobs[id] && !state.jobs[id]!.error) return false
  const job: PluginJob = reactive({ phase: 'waiting', line: '', error: null })
  state.jobs[id] = job
  return queued(async () => {
    const jobId = pluginJobId()
    job.phase = 'update'
    try {
      await withProgress(job, jobId, () => plugins.update(id, jobId))
      delete state.jobs[id]
      return true
    } catch (e) {
      job.error = message(e)
      return false
    }
  })
}

export function dismissJob(id: string) {
  delete state.jobs[id]
}

/** The words for a job in progress. */
export function jobLabel(job: PluginJob): string {
  if (job.phase === 'waiting') return 'Waiting…'
  if (job.phase === 'probe') return 'Downloading…'
  if (job.phase === 'install') return 'Installing…'
  return 'Updating…'
}

/** "just now", "3h ago", "on 12 Mar". */
export function agoText(ts: number): string {
  const s = shortAgo(ts)
  if (s === 'now') return 'just now'
  return /^\d+[mhd]$/.test(s) ? `${s} ago` : `on ${s}`
}

/**
 * "Add local folder": pick a folder holding a `mango-plugin.json` and use it in place. Resolves to the
 * plugin's id, null when the picker was cancelled; throws the backend's reason when it can't be added.
 */
export async function addLocalFolder(): Promise<string | null> {
  const path = await pickFolder('Add a plugin folder')
  if (!path) return null
  const plugin = await usePlugins().addLocal(path)
  return plugin.manifest.id
}

/** Put text on the clipboard; false when the webview refused. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}
