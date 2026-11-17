import type { BackgroundTask } from '~/types/chat'
import { formatDuration } from './time'

/** How a finished background task ended, in a word (the desktop's `ChatTasks.vue`). */
export const TASK_END_WORDS = { done: 'Finished', error: 'Failed', stopped: 'Stopped' } as const

/** How many of a run's background tasks still run, and the line that says so. */
export function tasksSummary(tasks: readonly BackgroundTask[]): { running: number; text: string } {
  const running = tasks.filter(t => t.status === 'running').length
  const finished = tasks.length - running
  if (!running) return { running, text: finished === 1 ? 'Finished' : 'All finished' }
  return { running, text: finished ? `${running} running, ${finished} finished` : `${running} running` }
}

/** How long a task has run (or ran). */
export const taskElapsed = (t: BackgroundTask, now: number): string =>
  formatDuration(Math.max(0, (t.endedAt ?? now) - t.startedAt))

/** The second line of a task's row: what it is doing, or how it ended. */
export function taskDetail(t: BackgroundTask): string | null {
  if (t.status !== 'running') return t.summary ? `${TASK_END_WORDS[t.status]}: ${t.summary}` : TASK_END_WORDS[t.status]
  return t.activity ?? null
}

/** The end of a terminal's output can carry colour codes: plain text reads better here. */
export const plainOutput = (text: string): string => text.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '')
