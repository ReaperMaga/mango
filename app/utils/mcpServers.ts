/**
 * The MCP servers the user added (Settings > MCP servers, and a project's own in Settings > Projects):
 * which ones a run gets, and the command line as one editable line.
 *
 * Plain TypeScript with relative imports only, so tests/mcpServers.test.ts runs in Node.
 */
import type { McpPair, McpServerConfig } from '~/types/ipc'
import type { AgentId } from '~/types/chat'
import type { AgentMcpServer } from '~/agents/types'
import { isEnvPath } from './envPath.ts'

/** Where one server comes from, as a project sees it. */
export interface McpInEffect {
  server: McpServerConfig
  /** The project's own, or one set for all projects. */
  scope: 'project' | 'global'
  /** A global server this project does not get: its own server has the name, or it is a remote project. */
  skipped?: 'replaced' | 'remote'
}

/**
 * Every server that concerns `projectPath`, its own first, then the global ones. A project's own
 * server takes the place of a global one with the same name. A remote project (`env://…`) gets only
 * its own servers: its agent runs inside the environment, where a global server's command (or a
 * local address) means something else, so those are left out rather than started in the wrong place.
 */
export function mcpInEffect(list: McpServerConfig[], projectPath: string): McpInEffect[] {
  const own = list.filter(s => s.project === projectPath)
  const names = new Set(own.map(s => s.name.toLowerCase()))
  const remote = isEnvPath(projectPath)
  return [
    ...own.map(server => ({ server, scope: 'project' as const })),
    ...list.filter(s => s.project === null).map(server => ({
      server,
      scope: 'global' as const,
      ...(names.has(server.name.toLowerCase()) ? { skipped: 'replaced' as const } : remote ? { skipped: 'remote' as const } : {}),
    })),
  ]
}

const record = (pairs: McpPair[]) => Object.fromEntries(pairs.filter(p => p.name).map(p => [p.name, p.value]))

/** A saved server as an adapter takes it. */
export function toAgentServer(s: McpServerConfig): AgentMcpServer {
  return s.transport === 'stdio'
    ? { name: s.name, transport: 'stdio', command: s.command, args: [...s.args], env: record(s.env) }
    : { name: s.name, transport: 'http', url: s.url, headers: record(s.headers) }
}

/** The servers a run of `agent` in `projectPath` gets: in effect there, switched on, and given to that agent. */
export function mcpServersForRun(list: McpServerConfig[], agent: AgentId, projectPath: string): AgentMcpServer[] {
  return mcpInEffect(list, projectPath)
    .filter(e => !e.skipped && e.server.enabled && (e.server.agents as AgentId[]).includes(agent))
    .map(e => toAgentServer(e.server))
}

/* ------------------------------------------------------------------ */
/* The command as one line                                             */
/* ------------------------------------------------------------------ */

/**
 * Splits a command line the way a person types it: words split on spaces, "double" or 'single'
 * quotes keep spaces in a word. A backslash is an ordinary character, so Windows paths
 * (`C:\tools\server.exe`) come through as typed. Nothing is expanded; no shell runs it.
 */
export function splitCommandLine(line: string): string[] {
  const words: string[] = []
  let word = ''
  let inWord = false
  let quote: '"' | '\'' | null = null
  for (const c of line) {
    if (quote) {
      if (c === quote) quote = null
      else word += c
    } else if (c === '"' || c === '\'') {
      quote = c
      inWord = true
    } else if (/\s/.test(c)) {
      if (inWord) words.push(word)
      word = ''
      inWord = false
    } else {
      word += c
      inWord = true
    }
  }
  if (inWord) words.push(word)
  return words
}

/** The command and its arguments as one line that `splitCommandLine` reads back the same. */
export function joinCommandLine(command: string, args: string[]): string {
  const quote = (w: string) => {
    if (w && !/[\s"']/.test(w)) return w
    if (!w.includes('"')) return `"${w}"`
    if (!w.includes('\'')) return `'${w}'`
    // Both kinds of quote: double-quoted pieces, each " between them in single quotes.
    return w.split('"').map(p => `"${p}"`).join('\'"\'')
  }
  return [command, ...args].filter((w, i) => i > 0 || w).map(quote).join(' ')
}
