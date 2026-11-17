import type { AgentMcpServer, BrowserMcpServer } from './types.ts'

/**
 * MCP servers for one agent run: Mango's browser server (`browser_mcp`) plus the ones the user
 * added (Settings > MCP servers), turned into what each CLI takes on its command line. Every server
 * is registered for that run only; nothing is written to the CLI's own settings, whose servers
 * (Claude Code's ~/.claude.json and .mcp.json, Codex's config.toml) keep loading as usual. A server
 * of ours with the same name as one of theirs takes its place for the run.
 *
 * Secrets (the values of a command's environment variables and of HTTP headers) stay off the
 * command line, where any user of the computer could read them in the process list: they go into
 * the CLI's own environment under a variable of their own, and the config only names it.
 *
 * Runs in plain Node with type stripping (scripts/try-agent.ts, tests/mcp.test.ts): type-only imports,
 * erasable syntax.
 */

/** The name Mango registers its browser tools under (src-tauri/src/browser_mcp.rs). */
export const BROWSER_SERVER = 'mango-browser'

export const MCP_NAME_MAX = 48

/**
 * Why `name` can't name a server, or null. A name becomes the tools' prefix (`mcp__<name>__<tool>`)
 * and a key of Codex's config, and `mango-…` is kept for Mango's own servers.
 * Mirrors `name_problem` in src-tauri/src/mcp.rs.
 */
export function mcpNameProblem(name: string): string | null {
  if (!name) return 'Give the server a name.'
  if (name.length > MCP_NAME_MAX) return `Keep the name under ${MCP_NAME_MAX + 1} characters.`
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(name)) return 'Use letters, digits, - and _, starting with a letter or digit.'
  if (name.includes('__')) return 'Two underscores in a row can\'t be used: tools are named mcp__<server>__<tool>.'
  if (/^mango(-|$)/i.test(name)) return 'Names starting with mango- are kept for Mango\'s own servers.'
  return null
}

/** What a CLI gets for the run's MCP servers: arguments, and the variables to add to its environment. */
export interface CliMcp {
  args: string[]
  env: Record<string, string>
}

/** The environment variable that carries the `n`th secret of a run. */
const secretVar = (n: number) => `MANGO_MCP_SECRET_${n}`

/* ------------------------------------------------------------------ */
/* Claude Code: one --mcp-config JSON                                  */
/* ------------------------------------------------------------------ */

/**
 * `--mcp-config` with every server (Claude Code adds them to its own for the session), and
 * `--allowedTools` for the browser tools that only read the page. A secret is written as
 * `${MANGO_MCP_SECRET_n}`, which Claude Code expands from its environment when it starts the server.
 */
export function claudeMcp(servers: AgentMcpServer[], browser?: BrowserMcpServer): CliMcp {
  const env: Record<string, string> = {}
  let n = 0
  const hide = (values: Record<string, string>) => Object.fromEntries(Object.entries(values).map(([k, v]) => {
    // An empty value is no secret, and an empty variable may read as a missing one.
    if (!v) return [k, v]
    const name = secretVar(++n)
    env[name] = v
    return [k, `\${${name}}`]
  }))
  const config: Record<string, unknown> = {}
  if (browser) config[browser.name] = { type: 'http', url: browser.url }
  for (const s of servers) {
    if (browser && s.name === browser.name) continue
    config[s.name] = s.transport === 'stdio'
      ? { type: 'stdio', command: s.command, args: s.args, ...(Object.keys(s.env).length ? { env: hide(s.env) } : {}) }
      : { type: 'http', url: s.url, ...(Object.keys(s.headers).length ? { headers: hide(s.headers) } : {}) }
  }
  if (!Object.keys(config).length) return { args: [], env }
  const args = ['--mcp-config', JSON.stringify({ mcpServers: config })]
  if (browser?.readOnlyTools.length) args.push('--allowedTools', browser.readOnlyTools.map(t => `mcp__${browser.name}__${t}`).join(','))
  return { args, env }
}

/* ------------------------------------------------------------------ */
/* Codex: -c mcp_servers.<name>=<TOML>                                 */
/* ------------------------------------------------------------------ */

/** A TOML basic string. JSON's escapes are TOML's, but JSON leaves DEL raw, which TOML refuses. */
export function tomlString(s: string): string {
  return `"${s.replace(/["\\\u0000-\u001f\u007f]/g, c => (c === '"' || c === '\\' ? `\\${c}` : `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`))}"`
}

const tomlArray = (items: string[]) => `[${items.map(tomlString).join(', ')}]`
/** An inline table of already-written values. Keys are quoted unless `bare` (Mango's own field names). */
const tomlTable = (entries: Array<[string, string]>, bare = false) =>
  `{ ${entries.map(([k, v]) => `${bare ? k : tomlString(k)} = ${v}`).join(', ')} }`
const tomlStrings = (values: Record<string, string>) => tomlTable(Object.entries(values).map(([k, v]) => [k, tomlString(v)]))

/**
 * Variables that change how the CLI itself (or anything it starts) runs. Forwarding one by its own
 * name would set it for Codex too, so a server's value for one of these goes inline instead.
 */
const SHAPES_THE_CLI = /^(PATH|HOME|USER|USERNAME|LOGNAME|SHELL|PWD|TERM|TMPDIR|TEMP|TMP|LANG|LANGUAGE|SYSTEMROOT|COMSPEC|PATHEXT|APPDATA|LOCALAPPDATA|USERPROFILE|(HTTPS?|ALL|NO)_PROXY|(LC|LD|DYLD|NODE|NPM|CODEX|OPENAI|RUST|SSL|MANGO)_\w*)$/i

/**
 * `-c` overrides (before the subcommand) that register each server for this process. A user server
 * is set as one whole table, so it replaces a same-named one from config.toml instead of merging
 * into it (a `command` from there next to our `url` would be an invalid server).
 *
 * Secrets: a header's value goes through `env_http_headers` (header -> variable name). A command's
 * variable is forwarded by its own name with `env_vars`, its value set in the CLI's environment. It
 * goes inline instead when another server of the run needs the same name with another value, or
 * when the name would change how Codex itself runs (PATH, HOME, NODE_OPTIONS, …).
 */
export function codexMcp(servers: AgentMcpServer[], browser?: BrowserMcpServer): CliMcp {
  const env: Record<string, string> = {}
  const args: string[] = []
  let n = 0
  if (browser) args.push('-c', `mcp_servers.${browser.name}.url=${tomlString(browser.url)}`)
  for (const s of servers) {
    if (browser && s.name === browser.name) continue
    const fields: Array<[string, string]> = []
    if (s.transport === 'stdio') {
      fields.push(['command', tomlString(s.command)], ['args', tomlArray(s.args)])
      const forwarded: string[] = []
      const inline: Record<string, string> = {}
      for (const [k, v] of Object.entries(s.env)) {
        if (v && !SHAPES_THE_CLI.test(k) && (env[k] === undefined || env[k] === v)) {
          env[k] = v
          forwarded.push(k)
        } else inline[k] = v
      }
      if (forwarded.length) fields.push(['env_vars', tomlArray(forwarded)])
      if (Object.keys(inline).length) fields.push(['env', tomlStrings(inline)])
    } else {
      fields.push(['url', tomlString(s.url)])
      const fromEnv: Record<string, string> = {}
      const plain: Record<string, string> = {}
      for (const [k, v] of Object.entries(s.headers)) {
        if (!v) { plain[k] = v; continue }
        const name = secretVar(++n)
        env[name] = v
        fromEnv[k] = name
      }
      if (Object.keys(fromEnv).length) fields.push(['env_http_headers', tomlStrings(fromEnv)])
      if (Object.keys(plain).length) fields.push(['http_headers', tomlStrings(plain)])
    }
    args.push('-c', `mcp_servers.${s.name}=${tomlTable(fields, true)}`)
  }
  return { args, env }
}
