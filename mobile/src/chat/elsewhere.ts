import { ELSEWHERE_QUIET_MS, type ElsewhereRun } from '@/state/threadModel'

/*
 * What the phone says about a run another computer has going in a chat (the desktop, usually).
 * The phone only watches: it cannot answer that computer's approvals or stop its run.
 */

/** The line under the activity in an open chat: where it runs, and how stale the news is. */
export function elsewhereCaption(run: ElsewhereRun, now: number): string {
  const quiet = now - run.at
  if (run.at <= 0 || quiet <= ELSEWHERE_QUIET_MS) return 'On another computer'
  const min = Math.floor(quiet / 60000)
  return `On another computer · quiet for ${min < 60 ? `${min}m` : `${Math.floor(min / 60)}h`}`
}

/** The second line of a chat's row in a list. */
export function elsewhereSubtitle(run: ElsewhereRun): string {
  return run.status === 'waiting' ? 'Waiting for you on another computer' : 'Working on another computer…'
}
