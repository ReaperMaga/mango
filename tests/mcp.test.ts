/**
 * The command-line MCP config for each CLI, and server names. Plain Node, no dependencies:
 *
 *   node --test tests/mcp.test.ts      (or: pnpm test)
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { AgentMcpServer, BrowserMcpServer } from '../app/agents/types.ts'
import { claudeMcp, codexMcp, mcpNameProblem, tomlString } from '../app/agents/mcp.ts'

const browser: BrowserMcpServer = { name: 'mango-browser', url: 'http://127.0.0.1:4100/t0k/mcp', readOnlyTools: ['snapshot', 'screenshot'] }
const stdio: AgentMcpServer = { name: 'unity', transport: 'stdio', command: 'npx', args: ['-y', '@acme/unity-mcp', '--port=6400'], env: { API_KEY: 's3cret', EMPTY: '' } }
const http: AgentMcpServer = { name: 'github', transport: 'http', url: 'https://api.example.com/mcp', headers: { 'Authorization': 'Bearer t0ken', 'X-Empty': '' } }

const argAfter = (args: string[], flag: string) => args[args.indexOf(flag) + 1]!

test('server names', () => {
  for (const ok of ['github', 'unity-editor', 'a', 'my_server2']) assert.equal(mcpNameProblem(ok), null, ok)
  for (const bad of ['', '-x', '_x', 'a b', 'a.b', 'a__b', 'mango-browser', 'Mango-Unity', 'mango', 'x'.repeat(49)]) {
    assert.ok(mcpNameProblem(bad), bad)
  }
})

test('claude: nothing to add', () => {
  assert.deepEqual(claudeMcp([]), { args: [], env: {} })
})

test('claude: one --mcp-config with the browser and the user servers, secrets by reference', () => {
  const { args, env } = claudeMcp([stdio, http], browser)
  assert.equal(args.filter(a => a === '--mcp-config').length, 1)
  const config = JSON.parse(argAfter(args, '--mcp-config'))
  assert.deepEqual(Object.keys(config.mcpServers), ['mango-browser', 'unity', 'github'])
  assert.deepEqual(config.mcpServers['mango-browser'], { type: 'http', url: browser.url })
  assert.deepEqual(config.mcpServers.unity, {
    type: 'stdio',
    command: 'npx',
    args: ['-y', '@acme/unity-mcp', '--port=6400'],
    env: { API_KEY: '${MANGO_MCP_SECRET_1}', EMPTY: '' },
  })
  assert.deepEqual(config.mcpServers.github, {
    type: 'http',
    url: 'https://api.example.com/mcp',
    headers: { 'Authorization': '${MANGO_MCP_SECRET_2}', 'X-Empty': '' },
  })
  assert.deepEqual(env, { MANGO_MCP_SECRET_1: 's3cret', MANGO_MCP_SECRET_2: 'Bearer t0ken' })
  assert.ok(!args.join(' ').includes('s3cret') && !args.join(' ').includes('t0ken'), 'no secret on the command line')
  assert.equal(argAfter(args, '--allowedTools'), 'mcp__mango-browser__snapshot,mcp__mango-browser__screenshot')
})

test('claude: user servers without the browser', () => {
  const { args } = claudeMcp([{ ...http, headers: {} }])
  assert.ok(!args.includes('--allowedTools'))
  assert.deepEqual(JSON.parse(argAfter(args, '--mcp-config')).mcpServers.github, { type: 'http', url: http.url })
})

test('claude: a user server never replaces the browser', () => {
  const { args } = claudeMcp([{ ...http, name: 'mango-browser' }], browser)
  assert.equal(JSON.parse(argAfter(args, '--mcp-config')).mcpServers['mango-browser'].url, browser.url)
})

test('toml strings', () => {
  assert.equal(tomlString('plain'), '"plain"')
  assert.equal(tomlString('a "q" \\ b'), '"a \\"q\\" \\\\ b"')
  assert.equal(tomlString('tab\there\u007f'), '"tab\\u0009here\\u007f"')
  assert.equal(tomlString('C:\\tools\\mcp.exe'), '"C:\\\\tools\\\\mcp.exe"')
})

test('codex: -c tables, secrets from the environment', () => {
  const { args, env } = codexMcp([stdio, http], browser)
  assert.deepEqual(args, [
    '-c', `mcp_servers.mango-browser.url="${browser.url}"`,
    '-c', 'mcp_servers.unity={ command = "npx", args = ["-y", "@acme/unity-mcp", "--port=6400"], env_vars = ["API_KEY"], env = { "EMPTY" = "" } }',
    '-c', 'mcp_servers.github={ url = "https://api.example.com/mcp", env_http_headers = { "Authorization" = "MANGO_MCP_SECRET_1" }, http_headers = { "X-Empty" = "" } }',
  ])
  assert.deepEqual(env, { API_KEY: 's3cret', MANGO_MCP_SECRET_1: 'Bearer t0ken' })
})

test('codex: the same variable with two values: the second goes inline', () => {
  const other: AgentMcpServer = { ...stdio, name: 'other', env: { API_KEY: 'different', SHARED: 'x' } }
  const same: AgentMcpServer = { ...stdio, name: 'same', env: { API_KEY: 's3cret' } }
  const { args, env } = codexMcp([stdio, other, same])
  assert.equal(env.API_KEY, 's3cret')
  assert.ok(args[3]!.includes('env_vars = ["SHARED"], env = { "API_KEY" = "different" }'), args[3])
  assert.ok(args[5]!.includes('env_vars = ["API_KEY"]') && !args[5]!.includes('env = '), args[5])
})

test('codex: a variable that would change how Codex runs goes inline', () => {
  const s: AgentMcpServer = { ...stdio, env: { PATH: '/opt/unity/bin', NODE_OPTIONS: '--max-old-space-size=4096', MANGO_RUN: 'x', https_proxy: 'http://p', TOKEN: 't' } }
  const { args, env } = codexMcp([s])
  assert.deepEqual(env, { TOKEN: 't' })
  assert.ok(args[1]!.includes('env_vars = ["TOKEN"], env = { "PATH" = "/opt/unity/bin", "NODE_OPTIONS" = "--max-old-space-size=4096", "MANGO_RUN" = "x", "https_proxy" = "http://p" }'), args[1])
})

test('codex: nothing to add', () => {
  assert.deepEqual(codexMcp([]), { args: [], env: {} })
  assert.deepEqual(codexMcp([], browser).args, ['-c', `mcp_servers.mango-browser.url="${browser.url}"`])
})
