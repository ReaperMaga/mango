import type { HostingCli, HostingToolId } from '~/types/ipc'
import { GITLAB_COM, normalizeHost } from '~/utils/gitHosts'

/**
 * The browser preview's GitHub CLI and GitLab CLI (`hosting_status`, `hosting_login`, `hosting_logout`,
 * `gitlab_hosts`, `gitlab_hosts_save`, and `setup_install` for gh / glab): in-memory state with the
 * backend's checks, and sign-ins and installs played into a fake terminal.
 */
type Emit = (event: string, payload: unknown) => void

const home = '/home/you'

const clis: HostingCli[] = [
  {
    id: 'gh', name: 'GitHub CLI', installed: true, version: '2.101.0', path: '/usr/bin/gh', error: null,
    accounts: [{ host: 'github.com', user: 'you', ok: true, active: true, fromEnv: false, error: null }],
    install: { command: 'brew install gh', via: 'Homebrew' }, helpUrl: 'https://cli.github.com',
  },
  {
    id: 'glab', name: 'GitLab CLI', installed: false, version: null, path: null, error: null, accounts: [],
    install: { command: 'brew install glab', via: 'Homebrew' }, helpUrl: 'https://gitlab.com/gitlab-org/cli#installation',
  },
]

let gitlabHosts: string[] = ['git.fruit.dev']

const cli = (tool: HostingToolId) => clis.find(c => c.id === tool)!
const copy = (c: HostingCli): HostingCli => ({ ...c, accounts: c.accounts.map(a => ({ ...a })) })

function remember(host: string) {
  if (host !== GITLAB_COM && !gitlabHosts.includes(host)) gitlabHosts = [...gitlabHosts, host]
}

export function mockHostingStatus(): HostingCli[] {
  for (const a of cli('glab').accounts) remember(a.host)
  return clis.map(copy)
}

function play(emit: Emit, id: string, lines: string[], done: () => number) {
  lines.forEach((line, i) => setTimeout(() => emit('pty://data', { id, data: `${line}\r\n` }), 250 + i * 420))
  setTimeout(() => emit('pty://exit', { id, code: done() }), 250 + lines.length * 420)
}

export function mockHostingLogin(emit: Emit, id: string, tool: HostingToolId, input: string) {
  const host = normalizeHost(input)
  if (!host) throw new Error(`"${input.trim()}" is not a server name.`)
  const c = cli(tool)
  if (!c.installed) throw new Error(`The ${c.name} (${tool}) is not installed.`)
  const lines = tool === 'gh'
    ? [`\x1b[2m$ gh auth login --hostname ${host} --git-protocol https --web\x1b[0m`, '! First copy your one-time code: \x1b[1mAB12-CD34\x1b[0m', `Open this URL to continue in your web browser: https://${host}/login/device`]
    : [`\x1b[2m$ glab auth login --hostname ${host} --git-protocol https${host === GITLAB_COM ? ' --web' : ''}\x1b[0m`, `Opening https://${host}/oauth/authorize in your browser…`]
  lines.push(`\x1b[32m✓\x1b[0m Logged in to ${host} as you \x1b[2m(simulated: the browser preview signs in to nothing)\x1b[0m`)
  play(emit, id, lines, () => {
    c.accounts = [...c.accounts.filter(a => a.host !== host), { host, user: 'you', ok: true, active: true, fromEnv: false, error: null }]
    if (tool === 'glab') remember(host)
    return 0
  })
}

export function mockHostingLogout(tool: HostingToolId, host: string, user: string | null) {
  const c = cli(tool)
  c.accounts = c.accounts.filter(a => a.host !== host || (user != null && a.user !== user))
}

export function mockHostingInstall(emit: Emit, id: string, tool: HostingToolId) {
  const c = cli(tool)
  play(emit, id, [
    `\x1b[2m$ ${c.install?.command}\x1b[0m`,
    `==> Downloading ${tool}…`,
    `\x1b[32m✓\x1b[0m ${c.name} installed \x1b[2m(simulated: the browser preview installs nothing)\x1b[0m`,
  ], () => {
    Object.assign(c, { installed: true, version: tool === 'gh' ? '2.101.0' : '1.131.0', path: `${home}/.local/bin/${tool}` })
    return 0
  })
}

export const mockGitlabHosts = () => [...gitlabHosts]

export function mockGitlabHostsSave(hosts: string[]): string[] {
  const out: string[] = []
  for (const h of hosts) {
    const n = normalizeHost(h)
    if (!n) throw new Error(`"${h}" is not a server name. Type it like gitlab.example.com.`)
    if (n !== GITLAB_COM && !out.includes(n)) out.push(n)
  }
  gitlabHosts = out.slice(0, 50)
  return [...gitlabHosts]
}
