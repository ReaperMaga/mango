import type { AgentId } from '~/types/chat'

/**
 * Whether the agent CLIs in an environment are signed in: the desktop's `auth.rs` (`claude auth
 * status`, `codex login status`), run inside the instance and read here. Only what the CLIs print
 * is used; no credential file is opened, so no token reaches the phone.
 */
export interface AgentAuth {
  agent: AgentId
  installed: boolean
  loggedIn: boolean
  /** The account email, when the CLI says one. */
  account: string | null
  /** "max", "pro", … when the CLI says one. */
  plan: string | null
  /** The organization, when it says more than the email. */
  organization: string | null
  /** How it signs in: "claude.ai", "ChatGPT", "API key". */
  method: string | null
  /** The CLI's first line, for when nothing else parses. */
  detail: string | null
}

const AGENTS_WITH_STATUS: AgentId[] = ['claude', 'codex']

/**
 * Runs in the instance (`sh -c`): for each CLI that is installed, its status command between
 * markers. `timeout` stops a CLI that waits on something; the exit code follows its output.
 */
export const AUTH_SCRIPT = [
  'if command -v timeout >/dev/null 2>&1; then T="timeout 10"; else T=""; fi',
  'if command -v claude >/dev/null 2>&1; then echo "@@claude"; $T claude auth status 2>/dev/null </dev/null; echo "@@exit $?"; fi',
  'if command -v codex >/dev/null 2>&1; then echo "@@codex"; $T codex login status 2>&1 </dev/null; echo "@@exit $?"; fi',
  'exit 0',
].join('\n')

const firstLine = (s: string): string | null => s.split('\n').map(l => l.trim()).find(Boolean) ?? null

const blank = (agent: AgentId): AgentAuth => ({
  agent, installed: false, loggedIn: false, account: null, plan: null, organization: null, method: null, detail: null,
})

const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)

/** `claude auth status` prints JSON (`loggedIn`, `email`, `subscriptionType`, …); older builds print a sentence. */
export function parseClaude(stdout: string, into: AgentAuth): void {
  let json: unknown = null
  try { json = JSON.parse(stdout) } catch { /* a sentence */ }
  if (json && typeof json === 'object') {
    const v = json as Record<string, unknown>
    into.loggedIn = v.loggedIn === true
    into.account = text(v.email)
    into.plan = text(v.subscriptionType)
    into.method = text(v.authMethod)
    const org = text(v.orgName)
    // A personal account is named "<email>'s Organization": that adds nothing.
    into.organization = org && !(into.account && org.startsWith(into.account)) ? org : null
    return
  }
  const lower = stdout.toLowerCase()
  into.loggedIn = lower.includes('logged in') && !lower.includes('not logged in')
  into.detail = firstLine(stdout)
}

/** `codex login status` prints "Logged in using ChatGPT" or "Not logged in", and exits non-zero when signed out. */
export function parseCodex(ok: boolean, output: string, into: AgentAuth): void {
  const line = firstLine(output) ?? ''
  const lower = line.toLowerCase()
  into.loggedIn = ok && lower.includes('logged in') && !lower.includes('not logged in')
  if (into.loggedIn) into.method = line.split('using ')[1]?.trim().replace(/\.$/, '') || null
  into.detail = line || null
}

/** The script's output as one entry per installed CLI (an agent that did not answer is not installed). */
export function parseAuthOutput(stdout: string): AgentAuth[] {
  const found = new Map<AgentId, AgentAuth>()
  let current: AgentAuth | null = null
  let body: string[] = []
  for (const line of stdout.split('\n')) {
    const mark = /^@@(\w+)(?: (\d+))?\s*$/.exec(line)
    if (mark && (AGENTS_WITH_STATUS as string[]).includes(mark[1]!) && mark[2] === undefined) {
      current = { ...blank(mark[1] as AgentId), installed: true }
      found.set(current.agent, current)
      body = []
    } else if (mark && mark[1] === 'exit' && current) {
      const output = body.join('\n')
      if (current.agent === 'claude') parseClaude(output, current)
      else parseCodex(mark[2] === '0', output, current)
      if (!current.loggedIn && !current.detail) current.detail = firstLine(output)
      current = null
    } else if (current) {
      body.push(line)
    }
  }
  // Both are always listed: one that is not installed says so.
  return AGENTS_WITH_STATUS.map(a => found.get(a) ?? blank(a))
}
