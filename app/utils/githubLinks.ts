import type { LinkedItem, Part } from '~/types/chat'
import type { ForgeProvider, GhItem } from '~/types/ipc'

/** Where a pull request, merge request or issue lives, as read from its link. */
export interface ItemRef {
  key: string
  provider: ForgeProvider
  kind: 'pr' | 'issue'
  url: string
  host: string
  /** On GitLab the whole namespace (`group/subgroup`). */
  owner: string
  repo: string
  number: number
}

/**
 * The item's key, lower case: the same item however it was written. GitHub: `host/owner/repo#12`,
 * whether the link said `/pull/` or `/issues/` (they share one number space). GitLab numbers merge
 * requests and issues separately, so a merge request is `host/group/project!12` and an issue
 * `host/group/project#12`.
 */
export function itemKey(host: string, owner: string, repo: string, number: number, kind: 'pr' | 'issue' = 'issue', provider: ForgeProvider = 'github') {
  const mark = provider === 'gitlab' && kind === 'pr' ? '!' : '#'
  return `${host}/${owner}/${repo}${mark}${number}`.toLowerCase()
}

/**
 * GitHub links to pull requests and issues in any text. API addresses (`api.github.com/repos/…`) do
 * not match: their path has `repos` where the owner would be, and the kind in the wrong place.
 */
const GITHUB_URL = /\bhttps?:\/\/([a-z0-9.-]+(?::\d+)?)\/([\w.-]+)\/([\w.-]+)\/(pull|issues)\/(\d+)\b/gi

/**
 * GitLab links (gitlab.com or any self-managed server, which the path shape alone gives away): the
 * project's path, any depth of groups, then `/-/merge_requests/12`, `/-/issues/12` or `/-/work_items/12`.
 * API addresses (`/api/v4/projects/…`) have no `/-/` and do not match.
 */
const GITLAB_URL = /\bhttps?:\/\/([a-z0-9.-]+(?::\d+)?)\/((?:[\w.-]+\/){2,})-\/(merge_requests|issues|work_items)\/(\d+)\b/gi

const cleanHost = (host: string) => host.toLowerCase().replace(/^www\./, '')

export function findItemRefs(text: string): ItemRef[] {
  const found: Array<{ at: number; ref: ItemRef }> = []
  for (const m of text.matchAll(GITHUB_URL)) {
    const host = cleanHost(m[1]!)
    const [owner, repo, kind, num] = [m[2]!, m[3]!, m[4]!.toLowerCase(), Number(m[5])]
    // `/-/` is GitLab's separator, never a repository (`gitlab.com/group/-/issues/3`).
    if (host.startsWith('api.') || !num || repo === '-') continue
    const k = kind === 'pull' ? 'pr' : 'issue'
    found.push({ at: m.index!, ref: {
      key: itemKey(host, owner, repo, num), provider: 'github', kind: k,
      url: `https://${host}/${owner}/${repo}/${kind}/${num}`,
      host, owner, repo, number: num,
    } })
  }
  for (const m of text.matchAll(GITLAB_URL)) {
    const host = cleanHost(m[1]!)
    const parts = m[2]!.slice(0, -1).split('/')
    const [kind, num] = [m[3]!.toLowerCase(), Number(m[4])]
    // Group-level items (`/groups/a/-/work_items/5`, epics) belong to no project; nor does anything under `api/`.
    if (host.startsWith('api.') || !num || parts[0] === 'groups' || parts[0] === 'api') continue
    const repo = parts.pop()!
    const owner = parts.join('/')
    const k = kind === 'merge_requests' ? 'pr' : 'issue'
    found.push({ at: m.index!, ref: {
      key: itemKey(host, owner, repo, num, k, 'gitlab'), provider: 'gitlab', kind: k,
      url: `https://${host}/${owner}/${repo}/-/${k === 'pr' ? 'merge_requests' : 'issues'}/${num}`,
      host, owner, repo, number: num,
    } })
  }
  const out: ItemRef[] = []
  for (const { ref } of found.sort((a, b) => a.at - b.at)) if (!out.some(r => r.key === ref.key)) out.push(ref)
  return out
}

/** `gh pr create …`, `gh issue create …`, `glab mr create …`, `glab issue create …`, also inside a longer command line. */
const CLI_CREATE = /\b(?:gh(?:\.exe)?\s+(pr|issue)|glab(?:\.exe)?\s+(mr|issue))\s+create\b/i
/**
 * MCP tools that create one: GitHub's `create_pull_request` / `create_issue`, GitLab's
 * `create_merge_request` / `create_issue` (`github · create_pull_request` in Claude Code,
 * `gitlab.create_merge_request` in Codex).
 */
const MCP_CREATE = /\bcreate[_-]?(pull[_-]?request|merge[_-]?request|issue)\b/i

/**
 * The pull requests, merge requests and issues a finished tool call created: a `gh … create` or
 * `glab … create` command, or a GitHub or GitLab MCP tool, whose output names the new item's link
 * (or the existing one it refused to repeat). Anything else (a `gh pr view`, a link the agent only
 * mentions) is not taken as created in this chat.
 */
export function createdBy(part: Extract<Part, { type: 'tool' }>): ItemRef[] {
  if (part.status === 'running' || !part.output) return []
  // `gh pr create` for a branch that has one already fails, naming it: that is the one this chat is about.
  if (part.status === 'error' && !/already exists/i.test(part.output)) return []
  const cli = CLI_CREATE.exec(part.target)
  const mcp = !cli && part.tool !== 'bash' ? MCP_CREATE.exec(part.target) : null
  if (!cli && !mcp) return []
  const what = cli ? (cli[1] ?? cli[2]!).toLowerCase() : mcp![1]!.toLowerCase()
  const want = what === 'issue' ? 'issue' : 'pr'
  // A `gh` command makes a GitHub item, a `glab` one a GitLab item; an MCP tool's server could be either.
  const provider: ForgeProvider | null = cli ? (cli[1] ? 'github' : 'gitlab') : /merge/.test(what) ? 'gitlab' : /pull/.test(what) ? 'github' : null
  // One call creates one item; the first link of the right kind is it (later ones are templates, related issues…).
  const ref = findItemRefs(part.output).find(r => r.kind === want && (!provider || r.provider === provider))
  return ref ? [ref] : []
}

/** A chat's link for an item found in text. A GitHub link carries no `provider`, as before GitLab support. */
export function linkFromRef(ref: ItemRef, source: LinkedItem['source']): LinkedItem {
  const { provider, ...rest } = ref
  return { ...rest, ...(provider === 'gitlab' ? { provider } : {}), source, linkedAt: Date.now() }
}

/** A chat's link for a fetched item. A GitHub item's link carries no `provider`, as before GitLab support. */
export function linkFromItem(item: GhItem, source: LinkedItem['source']): LinkedItem {
  const provider = item.provider === 'gitlab' ? 'gitlab' : 'github'
  return {
    key: itemKey(item.host, item.owner, item.repo, item.number, item.kind, provider),
    ...(provider === 'gitlab' ? { provider } : {}),
    kind: item.kind,
    url: item.url,
    host: item.host,
    owner: item.owner,
    repo: item.repo,
    number: item.number,
    title: item.title,
    state: item.state,
    source,
    linkedAt: Date.now(),
  }
}

export const STATE_LABELS = { open: 'Open', draft: 'Draft', merged: 'Merged', closed: 'Closed' } as const
