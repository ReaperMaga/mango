import type { AgentCommand, AgentId } from '~/types/chat'

/**
 * The composer's slash command list, as pure functions: the desktop's `stores/commands.ts` (which
 * commands there are) and the matching in `ChatComposer.vue` (which of them a typed `/que` shows).
 * Keep both in step with the desktop.
 */

/** Handled by Mango for every agent (`threads.send`: `/clear`, `/create-pr` and `/create-release`). */
export const MANGO_COMMANDS: readonly AgentCommand[] = [
  { name: 'clear', description: 'Start a new conversation in this chat. The agent forgets the messages above.', mango: true },
  { name: 'create-pr', description: 'Commit, check, push and open a pull request (on GitLab a merge request) for this branch', argumentHint: '[notes, e.g. draft]', mango: true },
{ name: 'create-release', description: 'Version, tag, push and publish a GitHub or GitLab release from the default branch', argumentHint: '[notes, e.g. minor]', mango: true },
]

/** Stand-ins until the agent's CLI has listed its own (the desktop's fallback list). */
export const FALLBACK_COMMANDS: Record<AgentId, readonly AgentCommand[]> = {
  claude: [
    { name: 'compact', description: 'Free up context by summarizing the conversation so far', argumentHint: '<optional custom summarization instructions>' },
    { name: 'context', description: 'Show current context usage' },
    { name: 'code-review', description: 'Review the current diff for correctness bugs', argumentHint: '[low|medium|high] [<pr#>|<branch>|<path>]', aliases: ['review'] },
    { name: 'security-review', description: 'Complete a security review of the pending changes on the current branch' },
    { name: 'init', description: 'Initialize a new CLAUDE.md file with codebase documentation' },
    { name: 'usage', description: 'Show session cost, plan usage, and what is contributing to your limits', aliases: ['cost'] },
  ],
  codex: [
    { name: 'review', description: 'Review the uncommitted changes, or what the instructions ask for', argumentHint: '[instructions]' },
    { name: 'compact', description: 'Summarize the conversation so far to free up context' },
    { name: 'init', description: 'Create an AGENTS.md with instructions for Codex' },
  ],
}

/**
 * The commands offered for `agent`: Mango's first, then what its CLI reported (`live`), or the
 * fallback list while there is none. A CLI command with a Mango command's name is Mango's.
 */
export function commandsFor(agent: AgentId, live?: readonly AgentCommand[] | null): AgentCommand[] {
  const own = (live?.length ? live : FALLBACK_COMMANDS[agent] ?? []).filter(c => !MANGO_COMMANDS.some(m => m.name === c.name))
  return [...MANGO_COMMANDS, ...own]
}

/** What follows the slash while only a command name is typed (lower case); null otherwise. */
export function slashQuery(text: string): string | null {
  const m = /^\/([\w.:-]*)$/.exec(text)
  return m ? m[1]!.toLowerCase() : null
}

export interface CommandMatch {
  command: AgentCommand
  /** Where the query sits in the name, for highlighting; null when it matched an alias (or the query is empty). */
  at: number | null
}

/**
 * The commands that match `query` (from `slashQuery`), best first: a prefix of the name, then a
 * prefix of an alias or of the part after a plugin's "plugin:", then anywhere in the name. Ties
 * keep the list's order. An empty query matches everything.
 */
export function matchCommands(all: readonly AgentCommand[], query: string): CommandMatch[] {
  const q = query.toLowerCase()
  if (!q) return all.map(command => ({ command, at: null }))
  const ranked: Array<CommandMatch & { rank: number; order: number }> = []
  all.forEach((command, order) => {
    const name = command.name.toLowerCase()
    const at = name.indexOf(q)
    const tail = name.lastIndexOf(':') + 1
    let rank = -1
    if (at === 0) rank = 0
    else if (tail > 0 && name.startsWith(q, tail)) rank = 1
    else if (command.aliases?.some(a => a.toLowerCase().startsWith(q))) rank = 1
    else if (at > 0) rank = 2
    if (rank >= 0) ranked.push({ command, at: at >= 0 ? at : null, rank, order })
  })
  return ranked.sort((a, b) => a.rank - b.rank || a.order - b.order).map(({ command, at }) => ({ command, at }))
}

/** The name split around the matched characters, for drawing the hit in Mango Ink. */
export function nameParts(m: CommandMatch, query: string): Array<{ text: string; hit: boolean }> {
  const name = m.command.name
  if (m.at === null || !query) return [{ text: name, hit: false }]
  const end = m.at + query.length
  return [
    { text: name.slice(0, m.at), hit: false },
    { text: name.slice(m.at, end), hit: true },
    { text: name.slice(end), hit: false },
  ].filter(p => p.text)
}

/** The draft after picking `command`: its name and a space, ready for arguments (which also closes the list). */
export const pickedText = (command: AgentCommand) => `/${command.name} `
