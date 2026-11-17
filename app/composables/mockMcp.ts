import type { McpPair, McpServerConfig } from '~/types/ipc'
import { mcpNameProblem } from '~/agents/mcp'

/**
 * The browser preview's MCP servers (`mcp_servers`, `mcp_servers_save`): an in-memory list with the
 * same checks as src-tauri/src/mcp.rs, so the Settings pages behave as they do in the app.
 */
const home = '/home/you'

let servers: McpServerConfig[] = [
  {
    id: 'mock-github', name: 'github', project: null, enabled: true, agents: ['claude', 'codex'],
    transport: 'http', command: '', args: [], env: [],
    url: 'https://api.githubcopilot.com/mcp/', headers: [{ name: 'Authorization', value: 'Bearer ghp_simulated' }],
  },
  {
    id: 'mock-context7', name: 'context7', project: null, enabled: false, agents: ['claude'],
    transport: 'stdio', command: 'npx', args: ['-y', '@upstash/context7-mcp'], env: [], url: '', headers: [],
  },
  {
    id: 'mock-unity', name: 'unity', project: `${home}/Projects/fruit-stand`, enabled: true, agents: ['claude', 'codex'],
    transport: 'stdio', command: 'unity-mcp', args: ['--port', '6400'], env: [{ name: 'UNITY_PROJECT', value: `${home}/Projects/fruit-stand` }], url: '', headers: [],
  },
]

const copy = (list: McpServerConfig[]) => list.map(s => ({ ...s, agents: [...s.agents], args: [...s.args], env: s.env.map(p => ({ ...p })), headers: s.headers.map(p => ({ ...p })) }))

function cleanPairs(label: string, pairs: McpPair[], what: string, valid: RegExp): McpPair[] {
  const out = pairs.map(p => ({ name: p.name.trim(), value: p.value })).filter(p => p.name)
  const seen = new Set<string>()
  for (const p of out) {
    if (!valid.test(p.name)) throw new Error(`${label}: "${p.name}" can't be used as a ${what} name.`)
    if (seen.has(p.name.toLowerCase())) throw new Error(`${label}: the ${what} ${p.name} is set twice.`)
    seen.add(p.name.toLowerCase())
    if (/[\0\r\n]/.test(p.value)) throw new Error(`${label}: the value of ${p.name} can't contain line breaks, or is too long.`)
  }
  return out
}

function clean(s: McpServerConfig): McpServerConfig {
  const name = s.name.trim()
  const problem = mcpNameProblem(name)
  if (problem) throw new Error(name ? `${name}: ${problem}` : problem)
  if (!s.agents.length) throw new Error(`${name}: pick at least one agent to give it to.`)
  if (s.transport === 'stdio') {
    if (!s.command.trim()) throw new Error(`${name}: give the command that starts the server.`)
    return { ...s, name, command: s.command.trim(), env: cleanPairs(name, s.env, 'variable', /^[A-Za-z_]\w*$/), url: '', headers: [] }
  }
  const url = s.url.trim()
  if (!/^https?:\/\/[^/\s]\S*$/i.test(url)) throw new Error(`${name}: the address must start with http:// or https://.`)
  return { ...s, name, url, headers: cleanPairs(name, s.headers, 'header', /^[\w!#$%&'*+.^`|~-]+$/), command: '', args: [], env: [] }
}

export function mockMcpServers(): McpServerConfig[] {
  return copy(servers)
}

export async function mockMcpSave(list: McpServerConfig[]): Promise<McpServerConfig[]> {
  await new Promise(r => setTimeout(r, 160))
  const names = new Set<string>()
  const cleaned = list.map((s) => {
    const c = clean(s)
    const key = `${c.project ?? ''}\u0000${c.name.toLowerCase()}`
    if (names.has(key)) throw new Error(`There is already a server named ${c.name} for ${c.project ? 'this project' : 'all projects'}.`)
    names.add(key)
    return { ...c, id: c.id || `mock-${Math.random().toString(36).slice(2, 10)}` }
  })
  servers = copy(cleaned)
  return copy(servers)
}
