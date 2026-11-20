import type { LinkedItem } from '~/types/chat'
import type { GhItem } from '~/types/ipc'
import { tidyOutput } from './git'

/**
 * Pull requests and issues linked to a chat, read with the GitHub CLI inside the environment.
 * The desktop runs `gh` on its own computer (`src-tauri/src/github.rs`); a phone has none, but the
 * environment usually does: that is where the agent ran `gh pr create`. Only the title and the
 * state are read (one `gh api` call), enough for the list; everything else opens on github.com.
 *
 * Links come from chat files (untrusted): owner, repository and number pass the validators here
 * and reach the shell only quoted (`line()` in `shell.ts`). Only github.com is read or opened.
 */

/** The only host the phone reads or opens. */
export const GITHUB_HOST = 'github.com'

/** A GitHub user or organisation: letters, digits and single hyphens, at most 39. */
export const validGhOwner = (s: string): boolean => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(s)

/** A repository name: letters, digits, `.`, `-`, `_`, at most 100, never `.` or `..`. */
export const validGhRepo = (s: string): boolean => /^[A-Za-z0-9._-]{1,100}$/.test(s) && s !== '.' && s !== '..'

const validNumber = (n: number): boolean => Number.isSafeInteger(n) && n > 0

export type GhRef = Pick<LinkedItem, 'kind' | 'host' | 'owner' | 'repo' | 'number'>

/** The item is on github.com and every part of it is well formed. */
export function validGhRef(ref: GhRef): boolean {
  return ref.host.toLowerCase() === GITHUB_HOST && validGhOwner(ref.owner) && validGhRepo(ref.repo) && validNumber(ref.number)
}

/**
 * Where the item opens in the browser, built from its validated parts (never the stored `url`,
 * which a chat file could point anywhere). Null for anything not on github.com.
 */
export function ghWebUrl(ref: GhRef): string | null {
  if (!validGhRef(ref)) return null
  return `https://${GITHUB_HOST}/${ref.owner}/${ref.repo}/${ref.kind === 'pr' ? 'pull' : 'issues'}/${ref.number}`
}

/**
 * One pull request or issue in full, as the pull request screen shows it: the desktop's `GhItem`
 * (`gh_item`, `src-tauri/src/github.rs`), except that the description is GitHub's Markdown source
 * (`body`) rather than its rendered HTML: the phone renders no HTML, and `ChatMarkdown` shows the
 * Markdown as text, links and code without fetching anything. Untrusted, like everything from GitHub.
 */
export type GhDetail = Omit<GhItem, 'bodyHtml'> & { body: string }

/** What the phone shows of an item in the list, read from GitHub. */
export interface GhState {
  kind: 'pr' | 'issue'
  title: string
  state: NonNullable<LinkedItem['state']>
  /** An issue closed as "completed", "not_planned" or "duplicate". */
  stateReason: string | null
}

/**
 * The issues endpoint answers for pull requests too (with `pull_request` set), so one call reads
 * either. Only the fields the list needs leave gh: a description can be large.
 */
const JQ = '{title, state, state_reason, draft, merged_at: .pull_request.merged_at, pr: (.pull_request != null)}'

/** Environment for gh: never wait on a prompt nobody sees, no colour in what it prints. */
export const GH_ENV: [string, string][] = [['GH_PROMPT_DISABLED', '1'], ['NO_COLOR', '1']]

/** The command that reads one item. Throws for a reference that is not a valid github.com item. */
export function ghItemArgv(ref: GhRef): string[] {
  if (!validGhRef(ref)) throw new Error('Only pull requests and issues on github.com can be read here.')
  return ['gh', 'api', '--hostname', GITHUB_HOST, `repos/${ref.owner}/${ref.repo}/issues/${ref.number}`, '--jq', JQ]
}

/** What `ghItemArgv` printed, or null when it is not the expected answer. */
export function parseGhItem(stdout: string): GhState | null {
  let v: any
  try { v = JSON.parse(stdout.trim()) } catch { return null }
  if (!v || typeof v !== 'object' || typeof v.title !== 'string') return null
  const pr = v.pr === true
  const open = v.state === 'open'
  if (!open && v.state !== 'closed') return null
  const state: GhState['state'] = pr
    ? (open ? (v.draft === true ? 'draft' : 'open') : (typeof v.merged_at === 'string' && v.merged_at ? 'merged' : 'closed'))
    : (open ? 'open' : 'closed')
  return {
    kind: pr ? 'pr' : 'issue',
    title: v.title,
    state,
    stateReason: !pr && typeof v.state_reason === 'string' && v.state_reason ? v.state_reason.toLowerCase() : null,
  }
}

/** Why reading failed, in words a person can act on (the desktop's `MISSING` / `SIGNED_OUT`). */
export function ghFailure(instance: string, ref: GhRef, code: number | null, stderr: string): string {
  const lower = stderr.toLowerCase()
  // `sh: 1: gh: not found` and `bash: gh: command not found`; gh's own `gh: Not Found (HTTP 404)` goes on.
  if (code === 127 || /\bgh: (?:command )?not found\s*$/m.test(lower)) {
    return `The GitHub CLI (gh) is not installed in ${instance}, so the latest state can't be read. Install it there, then sign in with gh auth login.`
  }
  if (code === 4 || lower.includes('gh auth login') || lower.includes('not logged in') || lower.includes('http 401') || lower.includes('bad credentials')) {
    return `The GitHub CLI in ${instance} is not signed in. Run gh auth login in its terminal, then try again.`
  }
  if (lower.includes('http 404') || lower.includes('not found')) {
    return `GitHub doesn't show ${ref.owner}/${ref.repo}#${ref.number} to the account gh uses in ${instance}.`
  }
  if (code === null) return 'Reading from GitHub was interrupted.'
  const detail = tidyOutput(stderr).split('\n')[0]
  return detail ? `Could not read from GitHub: ${detail}` : `Could not read from GitHub (exit code ${code}).`
}
