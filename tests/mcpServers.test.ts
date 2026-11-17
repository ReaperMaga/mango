/**
 * Which MCP servers a run gets, and the one-line command. Plain Node:
 *
 *   node --test tests/mcpServers.test.ts      (or: pnpm test)
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { McpServerConfig } from '../app/types/ipc.ts'
import { joinCommandLine, mcpInEffect, mcpServersForRun, splitCommandLine } from '../app/utils/mcpServers.ts'

const base: McpServerConfig = {
  id: '', name: '', project: null, enabled: true, agents: ['claude', 'codex'],
  transport: 'stdio', command: 'npx', args: ['-y', 'x'], env: [], url: '', headers: [],
}
const server = (over: Partial<McpServerConfig>): McpServerConfig => ({ ...base, id: over.name ?? '', ...over })

const local = '/home/me/shop'
const remote = 'env://host-1/dev/home/agent/shop'
const list: McpServerConfig[] = [
  server({ name: 'github', transport: 'http', url: 'https://gh.example/mcp', headers: [{ name: 'Authorization', value: 'Bearer x' }] }),
  server({ name: 'unity', agents: ['claude'], env: [{ name: 'PORT', value: '6400' }] }),
  server({ name: 'off', enabled: false }),
  server({ name: 'Unity', project: local, command: 'unity-mcp', args: [] }),
  server({ name: 'remote-only', project: remote }),
  server({ name: 'elsewhere', project: '/home/me/other' }),
]

test('a project gets its own servers and the global ones, its own winning a name', () => {
  const inEffect = mcpInEffect(list, local)
  assert.deepEqual(inEffect.map(e => [e.server.name, e.scope, e.skipped ?? null]), [
    ['Unity', 'project', null],
    ['github', 'global', null],
    ['unity', 'global', 'replaced'],
    ['off', 'global', null],
  ])
})

test('a run gets what is switched on and given to its agent', () => {
  assert.deepEqual(mcpServersForRun(list, 'claude', local).map(s => s.name), ['Unity', 'github'])
  assert.deepEqual(mcpServersForRun(list, 'codex', '/home/me/plain').map(s => s.name), ['github'])
  assert.deepEqual(mcpServersForRun(list, 'claude', '/home/me/plain').map(s => s.name), ['github', 'unity'])
})

test('a remote project gets only its own servers', () => {
  assert.deepEqual(mcpServersForRun(list, 'claude', remote).map(s => s.name), ['remote-only'])
  assert.ok(mcpInEffect(list, remote).filter(e => e.scope === 'global').every(e => e.skipped === 'remote'))
})

test('servers as the adapters take them', () => {
  const [unity] = mcpServersForRun(list, 'claude', '/home/me/plain').filter(s => s.name === 'unity')
  assert.deepEqual(unity, { name: 'unity', transport: 'stdio', command: 'npx', args: ['-y', 'x'], env: { PORT: '6400' } })
  const gh = mcpServersForRun(list, 'codex', local).find(s => s.name === 'github')
  assert.deepEqual(gh, { name: 'github', transport: 'http', url: 'https://gh.example/mcp', headers: { Authorization: 'Bearer x' } })
})

test('command lines', () => {
  assert.deepEqual(splitCommandLine('  npx -y  @acme/mcp '), ['npx', '-y', '@acme/mcp'])
  assert.deepEqual(splitCommandLine('node "/Users/me/My Tools/server.js" --name \'a b\''), ['node', '/Users/me/My Tools/server.js', '--name', 'a b'])
  assert.deepEqual(splitCommandLine('C:\\tools\\unity-mcp.exe --port 6400'), ['C:\\tools\\unity-mcp.exe', '--port', '6400'])
  assert.deepEqual(splitCommandLine('x "" --flag=a"b c"'), ['x', '', '--flag=ab c'])
  assert.deepEqual(splitCommandLine(''), [])
})

test('a joined command line reads back the same', () => {
  const cases: Array<[string, string[]]> = [
    ['npx', ['-y', '@acme/mcp']],
    ['C:\\Program Files\\Unity\\mcp.exe', ['--project', 'D:\\Games\\My Game']],
    ['node', ['', 'say "hi"', 'it\'s', 'both "a" and \'b\'']],
  ]
  for (const [command, args] of cases) {
    const line = joinCommandLine(command, args)
    assert.deepEqual(splitCommandLine(line), [command, ...args], line)
  }
  assert.equal(joinCommandLine('npx', ['-y', 'x']), 'npx -y x')
})
