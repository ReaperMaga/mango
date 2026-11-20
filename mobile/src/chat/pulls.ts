import type { GhCheck, GhJob, GhMergeMethod, GhRunState } from '~/types/ipc'
import { GITHUB_HOST, type GhDetail } from '@/remote/github'

/**
 * What the pull request screen works out from a read: the desktop's `LinksItem.vue`, `LinksMerge.vue`,
 * `LinksPanel.vue` and `LinksCheckLog.vue` logic, as plain TypeScript (tested in `pulls.test.ts`).
 * The wording is the desktop's.
 */

/* ---------- checks ---------- */

export type CheckState = GhCheck['state']

/** Failures first, then what was cancelled, what runs, what passed, and the rest. */
export const CHECK_ORDER: CheckState[] = ['failure', 'cancelled', 'pending', 'success', 'neutral', 'skipped']

export const CHECK_WORD: Record<GhRunState, string> = {
  failure: 'Failed',
  cancelled: 'Cancelled',
  pending: 'Running',
  queued: 'Queued',
  success: 'Passed',
  neutral: 'Neutral',
  skipped: 'Skipped',
}

/** The checks in the order the list shows them (stable within a state). */
export function sortChecks(runs: readonly GhCheck[]): GhCheck[] {
  return runs
    .map((c, i) => ({ c, i }))
    .sort((a, b) => CHECK_ORDER.indexOf(a.c.state) - CHECK_ORDER.indexOf(b.c.state) || a.i - b.i)
    .map(x => x.c)
}

export interface CheckSummary {
  tone: 'success' | 'failure' | 'pending'
  text: string
}

const ROLLUP = { success: 'Passed', failure: 'Failed', pending: 'Running' } as const

/** One line for all the checks: what failed first, then what runs, then what passed. */
export function checkSummary(item: Pick<GhDetail, 'checkRuns' | 'checks'>): CheckSummary | null {
  const all = item.checkRuns
  if (!all.length) return item.checks ? { tone: item.checks, text: ROLLUP[item.checks] } : null
  const n = (s: CheckState) => all.filter(c => c.state === s).length
  const failed = n('failure')
  const cancelled = n('cancelled')
  const running = n('pending')
  const passed = n('success')
  const skipped = n('skipped') + n('neutral')
  if (!failed && !cancelled && !running) {
    return { tone: 'success', text: skipped ? `${passed} passed, ${skipped} skipped` : passed === 1 ? 'Passed' : `All ${passed} passed` }
  }
  const parts = [
    failed && `${failed} failed`,
    cancelled && `${cancelled} cancelled`,
    running && `${running} running`,
    passed && `${passed} passed`,
  ].filter(Boolean)
  return { tone: failed || cancelled ? 'failure' : 'pending', text: parts.join(', ') }
}

/** A check's details link that `ghJob` can read: a GitHub Actions job on github.com. */
export const isJobUrl = (url: string | null | undefined): url is string =>
  !!url && /^https:\/\/github\.com\/[^/]+\/[^/]+\/actions\/runs\/\d+\/job\/\d+(?:[?#].*)?$/.test(url)

/**
 * Where tapping a check that is not an Actions job goes: its details link, only when that is an
 * https address (the check's own site, or github.com). Anything else stays unopened.
 */
export function checkLink(url: string | null | undefined): string | null {
  if (!url) return null
  let parsed: URL
  try { parsed = new URL(url) } catch { return null }
  return parsed.protocol === 'https:' && !!parsed.hostname ? parsed.href : null
}

/* ---------- facts ---------- */

export const REVIEW_WORD = { approved: 'Approved', changes_requested: 'Changes requested', review_required: 'Required' } as const

/** A label's colour from GitHub (hex without `#`), or null when it is not one. */
export const labelColor = (hex: string): string | null => (/^[0-9a-f]{6}$/i.test(hex) ? `#${hex}` : null)

/* ---------- merging ---------- */

export const MERGE_METHODS: Record<GhMergeMethod, { action: string; label: string; short: string; hint: string }> = {
  squash: { action: 'Squash and merge', label: 'Squash and merge', short: 'Squash', hint: 'All commits become one' },
  merge: { action: 'Merge', label: 'Create a merge commit', short: 'Merge', hint: 'Keeps every commit, adds a merge commit' },
  rebase: { action: 'Rebase and merge', label: 'Rebase and merge', short: 'Rebase', hint: 'Replays each commit onto the base' },
}

/** The method picked first: the repository's default when it is allowed, else the first allowed. */
export function defaultMethod(item: Pick<GhDetail, 'mergeMethods' | 'defaultMergeMethod'>): GhMergeMethod {
  return item.defaultMergeMethod && item.mergeMethods.includes(item.defaultMergeMethod)
    ? item.defaultMergeMethod
    : item.mergeMethods[0] ?? 'squash'
}

export type MergeTone = 'done' | 'running' | 'queued' | 'error' | 'idle' | 'checking'

export interface MergeStatus {
  tone: MergeTone
  title: string
  detail?: string
  /** The merge button may be pressed. */
  ready: boolean
}

type MergeFacts = Pick<GhDetail, 'state' | 'baseRef' | 'checkRuns' | 'checks' | 'mergeable' | 'mergeState'>

/** What GitHub says about merging it now: a short title, the detail under it, and whether it may be pressed. */
export function mergeStatus(it: MergeFacts): MergeStatus {
  const base = it.baseRef ?? 'the base branch'
  const running = it.checkRuns.some(c => c.state === 'pending') || (!it.checkRuns.length && it.checks === 'pending')
  if (it.state === 'draft') return { tone: 'idle', title: 'Draft', detail: 'Mark it ready for review on GitHub to merge it.', ready: false }
  if (it.mergeable === 'conflicting' || it.mergeState === 'dirty') return { tone: 'error', title: `Conflicts with ${base}`, detail: 'Resolve them before merging.', ready: false }
  if (!it.mergeState || it.mergeState === 'unknown' || it.mergeable === 'unknown') return { tone: 'checking', title: 'Checking whether it can merge', detail: 'GitHub is still working it out.', ready: false }
  if (it.mergeState === 'blocked') return { tone: 'error', title: 'Blocked', detail: running ? 'Required checks have not passed yet.' : 'Branch protection wants approvals or passing checks.', ready: true }
  if (it.mergeState === 'behind') return { tone: 'queued', title: `Behind ${base}`, detail: 'It can still be merged.', ready: true }
  if (it.mergeState === 'unstable') {
    return running
      ? { tone: 'running', title: 'Checks are running', detail: 'It can be merged anyway.', ready: true }
      : { tone: 'error', title: 'Some checks failed', detail: 'It can still be merged.', ready: true }
  }
  return { tone: 'done', title: 'Ready to merge', detail: `Into ${base}.`, ready: true }
}

/** Checks that did not pass (failed or cancelled), for the merge question. */
export const failingChecks = (runs: readonly GhCheck[]): number =>
  runs.filter(c => c.state === 'failure' || c.state === 'cancelled').length

/** The merge question: "Squash and merge #42 into main on GitHub? 2 checks have not passed." */
export function mergeQuestion(item: Pick<GhDetail, 'number' | 'baseRef' | 'checkRuns'>, method: GhMergeMethod): string {
  const failing = failingChecks(item.checkRuns)
  const more = failing ? ` ${failing} check${failing === 1 ? ' has' : 's have'} not passed.` : ''
  return `${MERGE_METHODS[method].label} #${item.number} into ${item.baseRef ?? 'the base branch'} on GitHub?${more}`
}

/** Why the merge controls are missing, when the account or the repository rules them out. */
export function mergeUnavailable(item: Pick<GhDetail, 'canMerge' | 'mergeMethods' | 'owner' | 'repo'>): string | null {
  if (!item.canMerge) return `The account gh is signed in with cannot merge pull requests in ${item.owner}/${item.repo}.`
  if (!item.mergeMethods.length) return 'GitHub did not say which merge methods this repository allows; merge it on GitHub.'
  return null
}

/* ---------- keeping it current ---------- */

/** While checks run or GitHub works out mergeability, look often; otherwise now and then. */
export const POLL_BUSY_MS = 10_000
export const POLL_IDLE_MS = 60_000

/** How often an open item is read again; null: never (an issue, or a merged or closed pull request). */
export function pollDelay(it: Pick<GhDetail, 'kind' | 'state' | 'checkRuns' | 'checks' | 'mergeable' | 'mergeState'> | null | undefined): number | null {
  if (!it || it.kind !== 'pr' || it.state === 'merged' || it.state === 'closed') return null
  const busy = it.checkRuns.some(c => c.state === 'pending') || it.checks === 'pending'
    || it.mergeable === 'unknown' || it.mergeState === 'unknown'
  return busy ? POLL_BUSY_MS : POLL_IDLE_MS
}

/**
 * How long until the next read: counted from the last good one, so an item opened again catches up
 * at once; after a failed read, the whole interval rather than straight away.
 */
export function pollWait(delay: number, fetchedAt: number, failed: boolean, now = Date.now()): number {
  return failed ? delay : Math.max(0, delay - (now - fetchedAt))
}

/** A running job's steps are read again this often. */
export const JOB_POLL_MS = 5_000
/** Just after a job ends GitHub may not have its log yet: ask again for this long. */
export const LOG_GRACE_MS = 120_000

export const jobRunning = (s: GhRunState): boolean => s === 'pending' || s === 'queued'

/** The job is worth reading again: it runs, or it just ended and its log is not there yet. */
export function jobWantsMore(job: Pick<GhJob, 'state' | 'logReady' | 'completedAt'> | null | undefined, now = Date.now()): boolean {
  if (!job) return false
  if (jobRunning(job.state)) return true
  if (job.logReady) return false
  const ended = job.completedAt ? Date.parse(job.completedAt) : 0
  return now - ended < LOG_GRACE_MS
}

/* ---------- linking by hand ---------- */

/**
 * What the person typed, tidied for `ghResolve`: a github.com link, `owner/repo#12`, `#12` or `12`.
 * Null when it is none of these (the field then says so rather than asking the environment).
 */
export function tidyReference(input: string): string | null {
  const s = input.trim()
  if (!s || s.length > 300 || /\s/.test(s)) return null
  if (/^#?\d{1,9}$/.test(s)) return s
  if (/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}#\d{1,9}$/.test(s)) return s
  let url: URL
  try { url = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`) } catch { return null }
  if (url.hostname.toLowerCase() !== GITHUB_HOST && url.hostname.toLowerCase() !== `www.${GITHUB_HOST}`) return null
  return /^\/[^/]+\/[^/]+\/(?:pull|issues)\/\d+(?:\/.*)?$/.test(url.pathname) ? `https://${GITHUB_HOST}${url.pathname}` : null
}

/** A reference `tidyReference` turned down: what to say under the field. */
export const REFERENCE_HINT = 'Paste a github.com link to a pull request or issue, or type owner/repo#12 or #12.'

/* ---------- times ---------- */

/** How long from `from` to `to` (or now): null when either is not a time. */
export function tookMs(from: string | null, to: string | null, now = Date.now()): number | null {
  if (!from) return null
  const start = Date.parse(from)
  const end = to ? Date.parse(to) : now
  return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : null
}
