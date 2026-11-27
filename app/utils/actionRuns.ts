import type { GhRun } from '~/types/ipc'
import { isActive, isBad } from './releaseRuns.ts'

/**
 * The Actions tool window's reading of a repository's runs (GitHub Actions runs, GitLab pipelines):
 * which are going and which are done, which workflows there are, and the mark on the stripe button.
 * Plain Node: imports only types and other plain helpers.
 */

export interface GroupedRuns {
  /** Running or waiting, newest first. */
  active: GhRun[]
  /** Finished, newest first. */
  done: GhRun[]
}

const newestFirst = (a: GhRun, b: GhRun) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0) || b.id - a.id

/** The runs of one workflow (or all when `workflowId` is null), split into going and done. */
export function groupRuns(runs: GhRun[], workflowId: number | null = null): GroupedRuns {
  const mine = runs.filter(r => workflowId === null || r.workflowId === workflowId).sort(newestFirst)
  return { active: mine.filter(r => isActive(r.state)), done: mine.filter(r => !isActive(r.state)) }
}

/** The workflows the runs belong to, by name, each once: the filter's choices. */
export function workflowsOf(runs: GhRun[]): { id: number; name: string; count: number }[] {
  const by = new Map<number, { id: number; name: string; count: number }>()
  for (const r of runs) {
    const w = by.get(r.workflowId)
    if (w) w.count++
    else by.set(r.workflowId, { id: r.workflowId, name: r.workflow || '—', count: 1 })
  }
  return [...by.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * The stripe button's corner mark: a run going, or the newest finished run of each workflow on
 * `branch` failed (an old failure that a later run fixed says nothing). Without a branch, only
 * running counts.
 */
export function actionsMark(runs: GhRun[], branch: string | null): 'running' | 'failed' | null {
  if (runs.some(r => isActive(r.state))) return 'running'
  if (!branch) return null
  const newest = new Map<number, GhRun>()
  for (const r of [...runs].sort(newestFirst)) {
    if (r.headBranch === branch && !newest.has(r.workflowId)) newest.set(r.workflowId, r)
  }
  return [...newest.values()].some(r => r.state === 'failure') ? 'failed' : null
}

/** Whether the run may be re-run (finished badly) and how: just its failed jobs, or all of it. */
export function rerunOf(run: GhRun): 'rerun-failed' | 'rerun' | null {
  if (!isBad(run.state)) return null
  return run.state === 'failure' ? 'rerun-failed' : 'rerun'
}

/** What started a run, as a short key for the interface's words (`actions.event.*`); null for others. */
const EVENTS = ['push', 'pull_request', 'merge_request_event', 'schedule', 'workflow_dispatch', 'web', 'release', 'api', 'trigger'] as const
export type RunEvent = (typeof EVENTS)[number]
export const knownEvent = (e: string): RunEvent | null => ((EVENTS as readonly string[]).includes(e) ? (e as RunEvent) : null)
