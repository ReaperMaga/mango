import { defineStore } from 'pinia'
import { AGENTS, type AgentCommand, type AgentId } from '~/types/chat'
import { listAgentCommands } from '~/agents'
import { pluginSlashList } from '~/plugin-host/registry'

/**
 * The slash commands the composer offers, per agent and project: what the agent's CLI
 * reports (its built-ins, the user's and the project's commands, skills), plus Mango's
 * own. Read without running a turn, cached on disk so the list is there at once on the
 * next launch, and refreshed now and then. Until a CLI has answered, a short built-in
 * list stands in (it is also what the browser preview shows).
 */

const KEY = 'mango.commands.v1'
/** How long a list is trusted before the next look (opening the list refreshes a stale one). */
const FRESH_MS = 10 * 60 * 1000
/** Projects whose lists are kept on disk; the least recently fetched go first. */
const MAX_CACHED = 24

/** Handled by Mango for every agent (`threads.send`). */
export const MANGO_COMMANDS: AgentCommand[] = [
  { name: 'clear', description: 'Start a new conversation in this chat. The agent forgets the messages above.', mango: true },
  { name: 'create-pr', description: 'Commit, check, push and open a pull request (on GitLab a merge request) for this branch', argumentHint: '[notes, e.g. draft]', mango: true },
{ name: 'create-release', description: 'Version, tag, push and publish a GitHub or GitLab release from the default branch', argumentHint: '[notes, e.g. minor]', mango: true },
]

/** Stand-ins until the CLI has answered. */
const FALLBACK: Record<AgentId, AgentCommand[]> = {
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

const keyOf = (agent: AgentId, cwd: string) => `${agent}\n${cwd}`

interface Cached { lists: Record<string, AgentCommand[]>; fetchedAt: Record<string, number> }

function load(): Cached {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') ?? {}
    const lists: Cached['lists'] = {}
    for (const [k, list] of Object.entries(raw.lists ?? {})) {
      if (Array.isArray(list) && list.every((c: AgentCommand) => typeof c?.name === 'string')) lists[k] = list
    }
    return { lists, fetchedAt: raw.fetchedAt ?? {} }
  } catch {
    return { lists: {}, fetchedAt: {} }
  }
}

const inflight = new Map<string, Promise<void>>()

export const useCommands = defineStore('commands', {
  state: () => load(),

  getters: {
    /** Commands for `agent` in the project at `cwd`: Mango's first, then plugins' (Mango runs them too), then the CLI's. */
    list: s => (agent: AgentId, cwd: string | null): AgentCommand[] => {
      const live = cwd ? s.lists[keyOf(agent, cwd)] : undefined
      const plugins = pluginSlashList(agent)
      const own = (live?.length ? live : FALLBACK[agent]).filter(c => !MANGO_COMMANDS.some(m => m.name === c.name) && !plugins.some(m => m.name === c.name))
      return [...MANGO_COMMANDS, ...plugins, ...own]
    },
  },

  actions: {
    persist() {
      const keys = Object.keys(this.lists).sort((a, b) => (this.fetchedAt[b] ?? 0) - (this.fetchedAt[a] ?? 0))
      for (const k of keys.slice(MAX_CACHED)) { delete this.lists[k]; delete this.fetchedAt[k] }
      try { localStorage.setItem(KEY, JSON.stringify({ lists: this.lists, fetchedAt: this.fetchedAt })) } catch { /* not persisted */ }
    },

    /** Ask the CLI for its commands in `cwd`. Quietly keeps the last list when it is missing or slow. */
    refresh(agent: AgentId, cwd: string | null, force = false): Promise<void> {
      if (!cwd || !AGENTS[agent]) return Promise.resolve()
      const key = keyOf(agent, cwd)
      if (!force && Date.now() - (this.fetchedAt[key] ?? 0) < FRESH_MS) return Promise.resolve()
      const running = inflight.get(key)
      if (running) return running
      const job = listAgentCommands(agent, cwd)
        .then((commands) => {
          if (!commands?.length) return
          this.lists[key] = commands
          this.fetchedAt[key] = Date.now()
          this.persist()
        })
        .catch(() => { /* keep what we have */ })
        .finally(() => inflight.delete(key))
      inflight.set(key, job)
      return job
    },
  },
})
