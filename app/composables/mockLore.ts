import type { LoreCli, LoreMachine, LoreMachineAccess, LoreMachineAction, LoreMachineProbe, LoreServer, LoreServerCheck, LoreServerInput } from '~/types/ipc'
import { normalizeLoreServer, parseLoreRepoUrl } from '~/utils/lore'

/**
 * The browser preview's Lore (`lore_cli`, `lore_servers`, `lore_server_upsert`, `lore_server_remove`,
 * `lore_server_check`, `lore_login`, `lore_logout`, `setup_install` for lore, and Lore in `create_project`
 * and `git_clone`): in-memory state with the backend's checks, sign-ins and installs played into a fake
 * terminal. Each saved server answers one way, so every state shows: ready, needs sign-in, UDP blocked,
 * unreachable.
 */
type Emit = (event: string, payload: unknown) => void

const cli: LoreCli = {
  installed: true, version: '0.14.0', path: '/home/you/.local/bin/lore',
  install: { command: 'curl -fsSL https://raw.githubusercontent.com/EpicGames/lore/main/scripts/install.sh | bash', via: 'Epic Games\' installer' },
  helpUrl: 'https://epicgames.github.io/lore/how-to/install-lore-cli/',
}

let servers: LoreServer[] = [
  { id: 'studio', name: 'Studio', url: 'lore://lore.fruit.dev', insideUrl: null, origin: null },
  { id: 'build', name: 'Build farm', url: 'lore://10.0.4.20:41400', insideUrl: null, origin: null },
  { id: 'old', name: 'Old office', url: 'lore://lore.old-office.lan', insideUrl: null, origin: null },
]
/** Who is signed in where (by URL). */
const signedIn = new Map<string, string>([['lore://lore.fruit.dev', 'you']])
const wantsSignIn = new Set(['lore://lore.fruit.dev'])
const repos: Record<string, string[]> = {
  'lore://lore.fruit.dev': ['orchard', 'orchard-art', 'tools/pipeline'],
  'lore://10.0.4.20:41400': ['builds'],
}

const wait = (ms: number) => new Promise(r => setTimeout(r, ms))
const copy = (s: LoreServer): LoreServer => ({ ...s, origin: s.origin ? { ...s.origin } : null, machine: s.machine ? { ...s.machine } : null })

export const mockLoreCli = (): LoreCli => ({ ...cli })
export const mockLoreServers = () => servers.map(copy)

export function mockLoreUpsert(input: LoreServerInput): LoreServer[] {
  const url = normalizeLoreServer(input.url)
  if (!url) throw new Error(`"${input.url}" is not a Lore server address: use lore://host or lore://host:port.`)
  const at = input.id
    ? servers.findIndex(s => s.id === input.id)
    : input.origin ? servers.findIndex(s => s.origin?.hostId === input.origin!.hostId && s.origin?.instance === input.origin!.instance) : -1
  if (input.id && at < 0) throw new Error('That server is no longer in the list.')
  const id = at >= 0 ? servers[at]!.id : Math.random().toString(36).slice(2, 10)
  const other = servers.find(s => s.url === url && s.id !== id)
  if (other) throw new Error(`${url} is already in the list as "${other.name}".`)
  const entry: LoreServer = {
    id, name: input.name.trim() || url.slice(7).split(':')[0]!, url,
    insideUrl: input.insideUrl ? normalizeLoreServer(input.insideUrl) : null, origin: input.origin ?? null, machine: input.machine ?? null,
  }
  servers = at >= 0 ? servers.map((s, i) => (i === at ? entry : s)) : [...servers, entry]
  return mockLoreServers()
}

export function mockLoreRemove(id: string): LoreServer[] {
  servers = servers.filter(s => s.id !== id)
  return mockLoreServers()
}

export async function mockLoreCheck(input: string): Promise<LoreServerCheck> {
  const url = normalizeLoreServer(input)
  if (!url) throw new Error(`"${input}" is not a Lore server address.`)
  await wait(500 + Math.random() * 600)
  const host = url.slice(url.indexOf('://') + 3).replace(/:\d+$/, '')
  const port = /:(\d+)$/.exec(url)?.[1] ?? '41337'
  const base = { url, auth: 'unknown' as const, user: null, repositories: null, dataChecked: false }
  if (!cli.installed) return { ...base, reach: 'noCli', message: 'The Lore CLI (lore) is not installed on this computer. Install it in Settings > Lore.' }
  if (host.endsWith('.lan')) {
    return { ...base, reach: 'timeout', message: `${host} doesn't answer on port ${port}. The computer may be off or unreachable from here, or a firewall blocks the port: Lore needs TCP and UDP port ${port} open.` }
  }
  if (host.startsWith('10.')) {
    return {
      ...base, reach: 'udp', auth: 'notRequired', repositories: repos[url] ?? [], dataChecked: true,
      message: `${host} answers on TCP port ${port}, but its data connection (QUIC on UDP port ${port}) gets no answer. Open UDP port ${port} too (firewall, port forward or published port), or files can't be sent.`,
    }
  }
  const list = repos[url] ?? []
  // A lores:// server is one with sign-in (Mango's sign-in turns them into that).
  if (url.startsWith('lores://')) wantsSignIn.add(url)
  if (wantsSignIn.has(url) && !signedIn.has(url)) {
    return { ...base, reach: 'ok', auth: 'signedOut', repositories: null, message: `${url} wants you to sign in.` }
  }
  return {
    ...base, reach: 'ok', auth: wantsSignIn.has(url) ? 'signedIn' : 'notRequired', user: signedIn.get(url) ?? null,
    repositories: list, dataChecked: list.length > 0, message: null,
  }
}

function play(emit: Emit, id: string, lines: string[], done: () => number) {
  lines.forEach((line, i) => setTimeout(() => emit('pty://data', { id, data: `${line}\r\n` }), 250 + i * 420))
  setTimeout(() => emit('pty://exit', { id, code: done() }), 250 + lines.length * 420)
}

export function mockLoreLogin(emit: Emit, id: string, url: string) {
  const u = normalizeLoreServer(url)
  if (!u) throw new Error(`"${url}" is not a Lore server address.`)
  if (!cli.installed) throw new Error('The Lore CLI (lore) is not installed on this computer.')
  play(emit, id, [
    `\x1b[2m$ lore login ${u}\x1b[0m`,
    `Login at: https://${u.startsWith('lores://') ? '' : 'auth.'}${u.slice(u.indexOf('://') + 3).split(':')[0]}${u.startsWith('lores://') ? '/dex' : ''}/device`,
    'Code: MNGO-4217',
    'Authentication successful \x1b[2m(simulated: the browser preview signs in to nothing)\x1b[0m',
  ], () => {
    wantsSignIn.add(u)
    signedIn.set(u, 'you')
    return 0
  })
}

export function mockLoreLogout(url: string) {
  const u = normalizeLoreServer(url)
  if (u) signedIn.delete(u)
}

export function mockLoreInstall(emit: Emit, id: string) {
  play(emit, id, [
    `\x1b[2m$ ${cli.install?.command}\x1b[0m`,
    'installed lore 0.14.0+2389 -> /home/you/.local/bin/lore',
    '\x1b[32m✓\x1b[0m Lore CLI installed \x1b[2m(simulated: the browser preview installs nothing)\x1b[0m',
  ], () => {
    cli.installed = true
    return 0
  })
}

/** For a quick look at the missing-CLI states: `__mangoLoreMissing()` in the preview's console. */
if (typeof window !== 'undefined') {
  (window as unknown as { __mangoLoreMissing?: () => void }).__mangoLoreMissing = () => { cli.installed = false }
}

/** The preview's `lore repository create`: refuses what the real CLI would. */
export async function mockLoreCreate(server: string | null, repository: string) {
  await wait(400)
  if (!server) return
  const url = normalizeLoreServer(server)
  const check = await mockLoreCheck(server)
  if (check.reach !== 'ok' && check.reach !== 'udp') {
    throw new Error(`Could not create the Lore repository ${repository}: ${url} did not answer. Check that the server is running and that its port is open (Lore uses TCP and UDP on the same port). Settings > Lore can check it.`)
  }
  if (check.auth === 'signedOut') throw new Error(`Could not create the Lore repository ${repository}: you're not signed in to ${url}. Sign in in Settings > Lore, then try again.`)
  if (url && (repos[url] ?? []).includes(repository)) {
    throw new Error(`Could not create the Lore repository ${repository}: ${url} already has a repository with that name. Clone it instead, or pick another name.`)
  }
  if (url) repos[url] = [...(repos[url] ?? []), repository]
}

/** Lines a `lore clone` prints, for the clone dialog. */
export function mockLoreCloneLines(url: string): string[] {
  const r = parseLoreRepoUrl(url)
  return [
    `Cloning repository 01a217f34c5976989976465380d6f0ca branch main into ~/Projects/${r?.name.split('/').pop() ?? 'repo'}`,
    'Cloned 1284/1284 files (2.31 GiB/2.31 GiB)',
    'Branch main revision e7247e95021725b0d5024e66e8f4d03669f15c070da00041b7e22a66ad12b3db',
    'Clone complete in 14.2s',
  ]
}

/* ---------- a Lore server on a machine over SSH ---------- */

/** The preview's look at a machine: a name with "docker" has Docker, "incus" has Incus; "nokey" refuses keys. */
export async function mockLoreMachineProbe(access: LoreMachineAccess): Promise<LoreMachineProbe> {
  await wait(700)
  const host = access.ssh.slice(access.ssh.lastIndexOf('@') + 1)
  if (host.includes('nokey')) {
    throw new Error(`${host} refused the SSH sign-in. Mango uses your SSH keys and agent without prompting: check that \`ssh ${access.ssh}\` works in a terminal without a password.`)
  }
  const docker = host.includes('docker')
  return {
    os: 'Ubuntu 24.04.1 LTS', arch: 'x86_64', sudo: access.ssh.startsWith('root@') ? 'root' : 'password',
    systemd: true, incus: host.includes('incus'), docker, dockerReady: docker, dockerImage: true, installed: null,
    addresses: [
      { address: '100.88.12.4', kind: 'tailscale', interface: 'tailscale0' },
      { address: '192.168.1.30', kind: 'private', interface: 'enp3s0' },
      { address: '203.0.113.41', kind: 'public', interface: 'enp1s0' },
    ],
  }
}

/** The preview's setup, restart or removal, played into the terminal (a password asked first, when it wants one). */
export function mockLoreMachineRun(emit: Emit, id: string, m: LoreMachine, action: LoreMachineAction, email: string | null = null) {
  const host = m.ssh.slice(m.ssh.lastIndexOf('@') + 1)
  const docker = m.runtime === 'docker' || (m.runtime === 'auto' && host.includes('docker'))
  const lines = [
    ...(m.password ? [`${m.ssh}'s password: \x1b[2m(simulated)\x1b[0m`] : []),
    'This needs root: sudo asks for your password below.',
    `[sudo] password for ${m.ssh.split('@')[0] || 'you'}: \x1b[2m(simulated)\x1b[0m`,
  ]
  const typed = (what: string) => `${what}: \x1b[2m(simulated: typed here, on the server)\x1b[0m`
  const a = m.auth
  if (action === 'setup') {
    if (a) {
      lines.push(
        `\x1b[1m==> Lore sign-in for ${a.domain} (Dex 2.45.1 and Caddy 2.11.9)\x1b[0m`,
        'Downloading Caddy 2.11.9',
        'Downloading Dex 2.45.1',
        ...(a.github ? [`Paste the client secret of the GitHub OAuth app ${a.github.clientId} (it is not shown; Enter when done).`, typed('Client secret')] : []),
        ...(a.passwords && email ? [`Choose the password ${email} signs in to Lore with (it is not shown).`, typed('Enter password'), typed('Confirm password')] : []),
        `Waiting for Let's Encrypt's certificate for ${a.domain} (up to 3 minutes)...`,
        'Caddy has the certificate.',
      )
    }
    const url = a ? `lores://${a.domain}${m.listenPort === 443 ? '' : `:${m.listenPort}`}` : ''
    lines.push(
      docker ? '\x1b[1m==> Lore server in Docker (Epic\'s image for 0.14.0, pinned)\x1b[0m' : '\x1b[1m==> Lore server (loreserver, a pinned release from GitHub, as a service)\x1b[0m',
      docker ? 'Pulling ghcr.io/epicgames/lore/loreserver…' : 'Downloading loreserver-v0.14.0-x86_64-unknown-linux-gnu.tar.gz',
      a
        ? `The Lore server listens on ${m.address} port ${m.listenPort} (UDP and TCP), and only signed-in people get in: ${url}`
        : `The Lore server listens on ${m.address} port ${m.listenPort} (UDP and TCP). It has no sign-in: anyone who reaches that port can read and write.`,
    )
  } else if (action === 'user-add') {
    lines.push(`Choose the password ${email} signs in to Lore with (it is not shown).`, typed('Enter password'), typed('Confirm password'), `${email} can sign in with that password.`)
  } else if (action === 'user-remove') {
    lines.push(`${email} can no longer sign in with a password (a sign-in they already have ends within an hour).`)
  } else if (action === 'github-secret') {
    lines.push(`Paste the client secret of the GitHub OAuth app ${a?.github?.clientId ?? ''} (it is not shown; Enter when done).`, typed('Client secret'), 'Dex uses the new secret.')
  } else if (action === 'restart') {
    lines.push('\x1b[1m==> Restarting the Lore server\x1b[0m', `The Lore server listens on ${m.address} port ${m.listenPort} (UDP and TCP).`)
  } else {
    lines.push('\x1b[1m==> Removing the Lore server\x1b[0m', docker
      ? 'Removed the container. Its data stays in the Docker volume mango-lore-data and your settings in /etc/mango-lore.'
      : 'Removed the service. Its data stays in /var/lib/lore, your settings in /etc/lore, and the system user lore.')
  }
  lines.push('\x1b[1m==> Done.\x1b[0m \x1b[2m(simulated: the browser preview connects to nothing)\x1b[0m')
  play(emit, id, lines, () => {
    if (action === 'setup') repos[loreUrlOfMachine(m)] ??= []
    return 0
  })
}

function loreUrlOfMachine(m: LoreMachine) {
  if (m.auth) return m.listenPort === 443 ? `lores://${m.auth.domain}` : `lores://${m.auth.domain}:${m.listenPort}`
  const everywhere = m.address === '0.0.0.0' || m.address === '[::]'
  const host = everywhere ? m.ssh.slice(m.ssh.lastIndexOf('@') + 1) : m.address
  return m.listenPort === 41337 ? `lore://${host}` : `lore://${host}:${m.listenPort}`
}
