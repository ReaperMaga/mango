import type { LinkedItem, Part } from '~/types/chat'
import type { GhItem } from '~/types/ipc'

/** Where a pull request or issue lives, as read from its link. */
export interface ItemRef {
  key: string
  kind: 'pr' | 'issue'
  url: string
  host: string
  owner: string
  repo: string
  number: number
}

/** `host/owner/repo#number`, lower case. The same item whether it was written `/pull/` or `/issues/`. */
export const itemKey = (host: string, owner: string, repo: string, number: number) =>
  `${host}/${owner}/${repo}#${number}`.toLowerCase()

/**
 * Links to pull requests and issues in any text. API addresses (`api.github.com/repos/…`) do not
 * match: their path has `repos` where the owner would be, and the kind in the wrong place.
 */
const ITEM_URL = /\bhttps?:\/\/([a-z0-9.-]+(?::\d+)?)\/([\w.-]+)\/([\w.-]+)\/(pull|issues)\/(\d+)\b/gi

export function findItemRefs(text: string): ItemRef[] {
  const out: ItemRef[] = []
  for (const m of text.matchAll(ITEM_URL)) {
    const host = m[1]!.toLowerCase().replace(/^www\./, '')
    const [owner, repo, kind, num] = [m[2]!, m[3]!, m[4]!, Number(m[5])]
    if (host.startsWith('api.') || !num) continue
    const ref: ItemRef = {
      key: itemKey(host, owner, repo, num),
      kind: kind.toLowerCase() === 'pull' ? 'pr' : 'issue',
      url: `https://${host}/${owner}/${repo}/${kind.toLowerCase()}/${num}`,
      host, owner, repo, number: num,
    }
    if (!out.some(r => r.key === ref.key)) out.push(ref)
  }
  return out
}

/** `gh pr create …`, `gh issue create …`, also inside a longer command line. */
const GH_CREATE = /\bgh(?:\.exe)?\s+(pr|issue)\s+create\b/i
/** GitHub MCP tools: `github · create_pull_request` (Claude Code), `github.create_issue` (Codex). */
const MCP_CREATE = /\bcreate[_-]?(pull[_-]?request|issue)\b/i

/**
 * The pull requests and issues a finished tool call created: a `gh … create` command or a
 * GitHub MCP tool, whose output names the new item's link (or the existing one it refused to
 * repeat). Anything else (a `gh pr view`, a link the agent only mentions) is not taken as
 * created in this chat.
 */
export function createdBy(part: Extract<Part, { type: 'tool' }>): ItemRef[] {
  if (part.status === 'running' || !part.output) return []
  // `gh pr create` for a branch that has one already fails, naming it: that is the one this chat is about.
  if (part.status === 'error' && !/already exists/i.test(part.output)) return []
  const cli = GH_CREATE.exec(part.target)
  const mcp = !cli && part.tool !== 'bash' ? MCP_CREATE.exec(part.target) : null
  if (!cli && !mcp) return []
  const want = cli ? (cli[1]!.toLowerCase() === 'pr' ? 'pr' : 'issue') : (/pull/i.test(mcp![1]!) ? 'pr' : 'issue')
  // One call creates one item; the first link of the right kind is it (later ones are templates, related issues…).
  const ref = findItemRefs(part.output).find(r => r.kind === want)
  return ref ? [ref] : []
}

/** A chat's link for a fetched item. */
export function linkFromItem(item: GhItem, source: LinkedItem['source']): LinkedItem {
  return {
    key: itemKey(item.host, item.owner, item.repo, item.number),
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
