import type {
  EnvComponent, EnvComponentId, EnvCreateInput, EnvDesktop, EnvHost, EnvInstance, EnvInstanceAction, EnvLoginTool, EnvProbe,
} from '~/types/ipc'

/**
 * Remote environments for the browser preview (no Tauri): the `env_*` commands from
 * types/ipc.ts against two made-up master servers whose instances really start, stop,
 * get created and get things installed. Terminal-based commands play plausible output
 * into a fake terminal (the same `pty://data` / `pty://exit` events a real one sends),
 * then change the state the way the real thing would. Nothing leaves the browser.
 */

export interface MockEnvContext {
  emit(event: string, payload: unknown): void
  /** A fresh pty id that nothing answers yet. */
  newPty(): string
  /**
   * Start the preview's fake shell for an instance: `label` is the prompt's `user@host`,
   * `cwd` the folder it starts in. Returns the pty id.
   */
  openShell(opts: { cwd: string; label: string; banner: string }): string
}

const MIN = 60_000
const DAY = 24 * 60 * MIN
const wait = (ms: number) => new Promise(r => setTimeout(r, ms))
/** Network-ish latency: a little different every time. */
const latency = (base: number) => wait(base + Math.round(Math.random() * base * 0.6))
const rid = (n = 8) => Math.random().toString(36).slice(2, 2 + n)

const AGENT_HOME = '/home/agent'
const WORK_DIR = `${AGENT_HOME}/work`

/** What can be installed, in install order. */
const CATALOG: Array<Omit<EnvComponent, 'installed' | 'version'> & { latest: string }> = [
  { id: 'base', name: 'Base system', description: 'The agent user, git, curl, build tools and a work folder.', requires: [], latest: '2026.11' },
  { id: 'node', name: 'Node.js', description: 'The current LTS, with npm.', requires: ['base'], latest: 'v24.11.1' },
  { id: 'claude', name: 'Claude Code', description: "Anthropic's coding agent.", requires: ['base'], latest: '2.4.1' },
  { id: 'codex', name: 'Codex', description: "OpenAI's coding agent.", requires: ['base'], latest: '0.98.0' },
  { id: 'gh', name: 'GitHub CLI', description: 'Pull requests, issues and git sign-in.', requires: ['base'], latest: '2.83.1' },
  { id: 'desktop', name: 'Desktop', description: 'An XFCE desktop you can view in Mango.', requires: ['base'], latest: 'xfce 4.20' },
  { id: 'tailscale', name: 'Tailscale', description: "Joins the server's tailnet.", requires: ['base'], latest: '1.90.6' },
]

interface MockInstance extends Omit<EnvInstance, 'ipv4' | 'tailscaleIp'> {
  /** Addresses while it runs (a stopped instance reports none). */
  addr: string
  tsIp: string | null
  /** Installed components and their versions. */
  installed: Partial<Record<EnvComponentId, string>>
}

interface MockHost {
  host: EnvHost
  instances: MockInstance[]
  /** null: Incus is not installed yet. */
  incusVersion: string | null
  os: string
}

const now = Date.now()
const all = (ids: EnvComponentId[]) => Object.fromEntries(ids.map(id => [id, CATALOG.find(c => c.id === id)!.latest])) as MockInstance['installed']

const hosts: MockHost[] = [
  {
    host: {
      id: 'h-forge',
      name: 'forge',
      ssh: 'you@forge.lan',
      port: null,
      identityFile: null,
      incusRemote: null,
      tailscale: { tags: ['tag:mango'], authKeyFile: '/root/.config/mango/tailscale.key' },
    },
    incusVersion: '6.18',
    os: 'Ubuntu 24.04.3 LTS',
    instances: [
      {
        name: 'dev', kind: 'container', status: 'running', image: 'Ubuntu noble amd64 (20261101_07:42)',
        addr: '10.88.0.12', tsIp: '100.101.7.33', cpus: 4, memory: '8GiB', createdAt: now - 12 * DAY,
        installed: { ...all(['base', 'node', 'claude', 'codex', 'gh', 'tailscale']), claude: '2.3.9' },
      },
      {
        name: 'gpu-box', kind: 'vm', status: 'stopped', image: 'Ubuntu noble amd64 cloud (20261028_07:42)',
        addr: '10.88.0.40', tsIp: null, cpus: 8, memory: '16GiB', createdAt: now - 3 * DAY,
        installed: all(['base', 'claude', 'desktop']),
      },
      {
        name: 'scratch', kind: 'container', status: 'running', image: 'Debian trixie amd64 (20261110_05:24)',
        addr: '10.88.0.31', tsIp: null, cpus: null, memory: null, createdAt: now - 5 * 60 * MIN,
        installed: all(['base']),
      },
    ],
  },
  {
    host: {
      id: 'h-hetzner',
      name: 'hetzner-ax41',
      ssh: 'root@203.0.113.24',
      port: 2222,
      identityFile: '~/.ssh/id_ed25519',
      incusRemote: null,
      tailscale: null,
    },
    incusVersion: '6.0.4',
    os: 'Debian GNU/Linux 13 (trixie)',
    instances: [
      {
        name: 'ci-runner', kind: 'container', status: 'running', image: 'Ubuntu noble amd64 (20261020_07:42)',
        addr: '10.12.4.7', tsIp: null, cpus: 2, memory: '4GiB', createdAt: now - 40 * DAY,
        installed: all(['base', 'node', 'gh', 'codex']),
      },
      {
        name: 'staging', kind: 'vm', status: 'stopped', image: 'Debian trixie amd64 cloud (20261002_05:24)',
        addr: '10.12.4.19', tsIp: null, cpus: 4, memory: '8GiB', createdAt: now - 21 * DAY,
        installed: all(['base', 'node', 'claude', 'desktop']),
      },
    ],
  },
  {
    // A fresh server: reachable over SSH, no Incus yet (Mango offers to install it).
    host: {
      id: 'h-fresh',
      name: 'fresh-vps',
      ssh: 'ops@198.51.100.7',
      port: null,
      identityFile: null,
      incusRemote: null,
      tailscale: null,
    },
    incusVersion: null,
    os: 'Ubuntu 24.04.3 LTS',
    instances: [],
  },
]

function hostOf(hostId: string): MockHost {
  const h = hosts.find(x => x.host.id === hostId)
  if (!h) throw new Error('That server is no longer saved in Mango. Add it again.')
  return h
}

function instanceOf(hostId: string, name: string): { h: MockHost; i: MockInstance } {
  const h = hostOf(hostId)
  const i = h.instances.find(x => x.name === name)
  if (!i) throw new Error(`There is no instance called "${name}" on ${h.host.name}.`)
  return { h, i }
}

function mustRun(h: MockHost, i: MockInstance) {
  if (i.status !== 'running') throw new Error(`${i.name} on ${h.host.name} is ${i.status}. Start it first.`)
}

/** A simulated server is unreachable when its address says so (to see the error states). */
const unreachable = (h: EnvHost) => /(^|@)(bad|unreachable|offline)/i.test(h.ssh)

const view = (i: MockInstance): EnvInstance => ({
  name: i.name,
  kind: i.kind,
  status: i.status,
  image: i.image,
  ipv4: i.status === 'running' ? [i.addr] : [],
  tailscaleIp: i.status === 'running' ? i.tsIp : null,
  cpus: i.cpus,
  memory: i.memory,
  createdAt: i.createdAt,
})

/** `ids` plus what they require, in install order. */
function withRequired(ids: EnvComponentId[]): EnvComponentId[] {
  const want = new Set<EnvComponentId>()
  const add = (id: EnvComponentId) => {
    if (want.has(id)) return
    want.add(id)
    CATALOG.find(c => c.id === id)?.requires.forEach(add)
  }
  ids.forEach(add)
  return CATALOG.map(c => c.id).filter(id => want.has(id))
}

const IMAGE_NAMES: Record<string, string> = {
  'images:ubuntu/24.04': 'Ubuntu noble amd64',
  'images:ubuntu/26.04': 'Ubuntu resolute amd64',
  'images:debian/13': 'Debian trixie amd64',
}

function validHost(host: EnvHost): EnvHost {
  const name = host.name.trim()
  const ssh = host.ssh.trim()
  if (!name) throw new Error('Give the server a name.')
  if (!ssh) throw new Error('Enter how to reach the server: user@host, or a Host alias from ~/.ssh/config.')
  if (/\s/.test(ssh) || ssh.startsWith('-')) throw new Error('The SSH address cannot contain spaces or start with "-".')
  if (host.port !== null && !(Number.isInteger(host.port) && host.port > 0 && host.port < 65536)) throw new Error('The port must be a number from 1 to 65535.')
  if (host.tailscale?.tags.some(t => !/^tag:[a-z0-9-]+$/i.test(t))) throw new Error('Tailscale tags look like tag:name.')
  return { ...host, name, ssh, identityFile: host.identityFile?.trim() || null, incusRemote: host.incusRemote?.trim() || null }
}

/** A placeholder for the instance's desktop: what the iframe shows in the preview. */
function desktopPage(instance: string, host: string): string {
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${instance} desktop</title><style>
html,body{margin:0;height:100%;background:#151515;color:#e8e8e8;font:14px/1.6 system-ui,sans-serif}
body{display:grid;place-items:center}
main{max-width:46ch;text-align:center;padding:24px}
h1{font-size:16px;font-weight:600;margin:0 0 6px}
p{margin:0;color:#a3a3a3}
code{font:12.5px ui-monospace,monospace;color:#e8e8e8}
</style></head><body><main><h1>Simulated desktop</h1>
<p>The desktop of <code>${instance}</code> on <code>${host}</code> appears here inside the Mango app, through noVNC. The browser preview has nothing to connect to.</p>
</main></body></html>`
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`
}

export function createMockEnvs(ctx: MockEnvContext) {
  const out = (id: string, line: string) => ctx.emit('pty://data', { id, data: `${line}\r\n` })

  /** Play `steps` into terminal `id` (each after its delay), then exit with `code`. */
  function play(id: string, steps: Array<[number, string | (() => void)]>, code = 0) {
    let at = 120
    for (const [delay, step] of steps) {
      at += delay
      setTimeout(() => (typeof step === 'string' ? out(id, step) : step()), at)
    }
    setTimeout(() => ctx.emit('pty://exit', { id, code }), at + 200)
  }

  const dim = (s: string) => `\x1b[2m${s}\x1b[0m`
  const ok = (s: string) => `\x1b[32m✓\x1b[0m ${s}`
  const head = (s: string) => `\x1b[1m==> ${s}\x1b[0m`

  /** The output of installing `ids` (already with what they require), marking each installed as it finishes. */
  function installSteps(id: string, i: MockInstance, ids: EnvComponentId[]): Array<[number, string | (() => void)]> {
    const steps: Array<[number, string | (() => void)]> = []
    for (const cid of ids) {
      const c = CATALOG.find(x => x.id === cid)!
      const had = i.installed[cid]
      steps.push([300, head(had ? `Updating ${c.name}` : `Installing ${c.name}`)])
      if (cid === 'base') steps.push([500, dim('apt-get install -y git curl ca-certificates build-essential sudo')], [700, 'Setting up git (1:2.47.1-1) ...'])
      else if (cid === 'node') steps.push([450, dim('curl -fsSL https://deb.nodesource.com/setup_24.x | bash -')], [650, 'Setting up nodejs (24.11.1-1nodesource1) ...'])
      else if (cid === 'claude') steps.push([450, dim('curl -fsSL https://claude.ai/install.sh | bash')], [600, `Installing Claude Code to ${AGENT_HOME}/.local/bin`])
      else if (cid === 'codex') steps.push([450, dim('curl -fsSL https://chatgpt.com/codex/install.sh | sh')], [600, `Installed codex to ${AGENT_HOME}/.local/bin/codex`])
      else if (cid === 'gh') steps.push([450, dim('apt-get install -y gh')], [500, 'Setting up gh (2.83.1) ...'])
      else if (cid === 'desktop') steps.push([500, dim('apt-get install -y xfce4 tigervnc-standalone-server novnc chromium')], [900, 'Setting up xfce4 (4.20) ...'], [400, 'noVNC listening on 127.0.0.1:6080'])
      else if (cid === 'tailscale') steps.push([450, dim('curl -fsSL https://tailscale.com/install.sh | sh')], [600, 'Installing Tailscale for ubuntu noble'])
      steps.push([350, () => {
        i.installed[cid] = c.latest
        out(id, ok(`${c.name} ${c.latest}`))
      }])
    }
    return steps
  }

  async function call(cmd: string, args: any): Promise<any> {
    switch (cmd) {
      case 'env_hosts':
        await latency(40)
        return hosts.map(h => structuredClone(h.host))

      case 'env_host_save': {
        await latency(120)
        const host = validHost(args.host as EnvHost)
        if (!host.id) {
          const saved = { ...host, id: `h-${rid()}` }
          hosts.push({ host: saved, instances: [], incusVersion: null, os: 'Ubuntu 24.04.3 LTS' })
          return structuredClone(saved)
        }
        const h = hostOf(host.id)
        h.host = host
        return structuredClone(host)
      }

      case 'env_host_remove': {
        await latency(60)
        const at = hosts.findIndex(h => h.host.id === args.id)
        if (at >= 0) hosts.splice(at, 1)
        return
      }

      case 'env_probe': {
        const h = hostOf(args.hostId)
        await latency(650)
        if (unreachable(h.host)) {
          const where = h.host.ssh.replace(/^[^@]*@/, '')
          return {
            ok: false, reachable: false, incus: null, incusVersion: null, os: null, canSetup: false, setupNote: null, remotes: [],
            error: `ssh: connect to host ${where} port ${h.host.port ?? 22}: Connection timed out (simulated)`,
          } satisfies EnvProbe
        }
        if (!h.incusVersion) {
          return {
            ok: false, reachable: true, incus: 'missing', incusVersion: null, os: h.os, canSetup: true, setupNote: null,
            remotes: [], error: null,
          } satisfies EnvProbe
        }
        return {
          ok: true, reachable: true, incus: 'ready', incusVersion: h.incusVersion, os: h.os, canSetup: true, setupNote: null,
          remotes: ['local', 'images'], error: null,
        } satisfies EnvProbe
      }

      case 'env_server_setup': {
        const h = hostOf(args.hostId)
        if (unreachable(h.host)) throw new Error(`Could not reach ${h.host.name} over SSH: connection timed out (simulated).`)
        await latency(150)
        const id = ctx.newPty()
        const fresh = !h.incusVersion
        play(id, [
          [0, dim(`$ ssh ${h.host.ssh} sh -s  # Mango's Incus setup`)],
          [300, `==> ${h.os}`],
          ...(fresh
            ? [
                [500, '==> Adding the Zabbly package repository for Incus (stable)'],
                [900, '==> Installing incus'],
                [1600, 'Setting up incus (1:6.18-ubuntu24.04-202611080412) ...'],
                [700, '==> Initialising: storage pool "default" (btrfs, 60 GiB), network incusbr0 (NAT)'],
                [600, `==> Adding ${h.host.ssh.replace(/@.*/, '')} to the incus-admin group`],
              ] as Array<[number, string]>
            : [
                [600, '==> Updating incus'],
                [1200, 'incus is already the newest version (1:6.18-ubuntu24.04-202611080412).'],
                [300, '==> Already initialised'],
              ] as Array<[number, string]>),
          [400, ok(`Incus 6.18 is ready ${dim('(simulated: the browser preview installs nothing)')}`)],
        ])
        setTimeout(() => { h.incusVersion = '6.18' }, fresh ? 4300 : 2200) // before the terminal exits, so the re-check sees it
        return id
      }

      case 'env_instances': {
        const h = hostOf(args.hostId)
        await latency(450)
        if (unreachable(h.host)) throw new Error(`Could not reach ${h.host.name} over SSH: connection timed out (simulated).`)
        if (!h.incusVersion) throw new Error(`Incus is not installed on ${h.host.name} yet.`)
        return h.instances.map(view)
      }

      case 'env_instance_action': {
        const { h, i } = instanceOf(args.hostId, args.instance)
        const action = args.action as EnvInstanceAction
        if (action === 'delete') {
          await latency(900)
          h.instances = h.instances.filter(x => x !== i)
          return
        }
        if (action === 'start' && i.status === 'running') return
        if (action === 'stop' && i.status === 'stopped') return
        const settled = action === 'stop' ? 'stopped' : 'running'
        i.status = action === 'stop' ? 'stopping' : 'starting'
        await latency(action === 'restart' ? 1300 : i.kind === 'vm' ? 1600 : 900)
        i.status = settled
        return
      }

      case 'env_components': {
        const { h, i } = instanceOf(args.hostId, args.instance)
        await latency(600)
        mustRun(h, i)
        return CATALOG.map(c => ({
          id: c.id, name: c.name, description: c.description, requires: [...c.requires],
          installed: !!i.installed[c.id], version: i.installed[c.id] ?? null,
        })) satisfies EnvComponent[]
      }

      case 'env_create': {
        const input = args.input as EnvCreateInput
        const h = hostOf(input.hostId)
        const name = input.name.trim()
        if (!/^[a-z][a-z0-9-]{0,62}$/.test(name) || name.endsWith('-')) {
          throw new Error('Instance names start with a letter and use lower-case letters, digits and "-" (at most 63).')
        }
        if (h.instances.some(x => x.name === name)) throw new Error(`${h.host.name} already has an instance called "${name}".`)
        await latency(150)
        const id = ctx.newPty()
        const vm = input.kind === 'vm'
        const image = vm ? `${input.image}/cloud` : input.image
        const flags = [
          vm ? '--vm' : '',
          input.cpus ? `-c limits.cpu=${input.cpus}` : '',
          input.memoryGib ? `-c limits.memory=${input.memoryGib}GiB` : '',
          input.diskGib ? `-d root,size=${input.diskGib}GiB` : '',
        ].filter(Boolean).join(' ')
        const inst: MockInstance = {
          name, kind: input.kind, status: 'starting',
          image: `${IMAGE_NAMES[input.image] ?? input.image}${vm ? ' cloud' : ''} (20261114_07:42)`,
          addr: `10.88.0.${50 + Math.floor(Math.random() * 150)}`, tsIp: null,
          cpus: input.cpus, memory: input.memoryGib ? `${input.memoryGib}GiB` : null, createdAt: Date.now(), installed: {},
        }
        const ids = withRequired(input.components)
        play(id, [
          [0, dim(`$ incus launch ${image} ${name}${flags ? ` ${flags}` : ''}`)],
          [500, `Launching ${name}`],
          [700, () => { h.instances.push(inst); out(id, 'Retrieving image: Unpack: 100% (4.41GB/s)') }],
          [vm ? 1800 : 900, `Starting ${name}`],
          [700, () => { inst.status = 'running'; out(id, `Waiting for the network… ${inst.addr}`) }],
          ...installSteps(id, inst, ids),
          [300, ok(`${name} is ready ${dim('(simulated: the browser preview creates nothing)')}`)],
        ])
        return id
      }

      case 'env_install': {
        const { h, i } = instanceOf(args.hostId, args.instance)
        mustRun(h, i)
        const ids = withRequired(args.components as EnvComponentId[])
        if (!ids.length) throw new Error('Pick something to install.')
        await latency(150)
        const id = ctx.newPty()
        play(id, [
          [0, dim(`$ incus exec ${i.name} -- mango-install ${ids.join(' ')}`)],
          ...installSteps(id, i, ids),
          [300, ok(`Done ${dim('(simulated: the browser preview installs nothing)')}`)],
        ])
        return id
      }

      case 'env_shell': {
        const { h, i } = instanceOf(args.hostId, args.instance)
        mustRun(h, i)
        await latency(250)
        return ctx.openShell({
          cwd: args.cwd || AGENT_HOME,
          label: `agent@${i.name}`,
          banner: dim(`Simulated shell in ${i.name} on ${h.host.name}. Inside the Mango app this is a real login shell in the instance.`),
        })
      }

      case 'env_login': {
        const { h, i } = instanceOf(args.hostId, args.instance)
        mustRun(h, i)
        const tool = args.tool as EnvLoginTool
        if (!i.installed[tool]) {
          const c = CATALOG.find(x => x.id === tool)
          throw new Error(`${c?.name ?? tool} is not installed in ${i.name}. Install it first.`)
        }
        await latency(200)
        const id = ctx.newPty()
        const code = `${rid(4)}-${rid(4)}`.toUpperCase()
        const lines: Record<EnvLoginTool, Array<[number, string | (() => void)]>> = {
          claude: [
            [0, dim('$ claude auth login')],
            [600, 'Browser didn\'t open? Use the url below to sign in:'],
            [200, `https://claude.ai/oauth/authorize?code=true&client_id=${rid(12)}&state=${rid(10)}`],
            [2400, ok(`Signed in as you@example.com ${dim('(simulated)')}`)],
          ],
          codex: [
            [0, dim('$ codex login --device-auth')],
            [600, 'Open https://auth.openai.com/codex/device and enter this code:'],
            [200, `  \x1b[1m${code}\x1b[0m`],
            [2400, ok(`Signed in with ChatGPT ${dim('(simulated)')}`)],
          ],
          gh: [
            [0, dim('$ gh auth login --web --git-protocol https')],
            [500, `! First copy your one-time code: ${code}`],
            [200, 'Open this URL to continue in your web browser: https://github.com/login/device'],
            [2400, ok('Authentication complete.')],
            [300, ok(`Logged in as you ${dim('(simulated)')}`)],
          ],
          tailscale: [
            [0, dim(`$ sudo tailscale up${h.host.tailscale?.tags.length ? ` --advertise-tags=${h.host.tailscale.tags.join(',')}` : ''}`)],
            [700, 'To authenticate, visit:'],
            [200, `\thttps://login.tailscale.com/a/${rid(12)}`],
            [2600, () => {
              i.tsIp = `100.${64 + Math.floor(Math.random() * 60)}.${Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}`
              out(id, ok(`Success. ${i.name} is on the tailnet at ${i.tsIp} ${dim('(simulated)')}`))
            }],
          ],
        }
        play(id, lines[tool])
        return id
      }

      case 'env_prepare_dir': {
        const { h, i } = instanceOf(args.hostId, args.instance)
        mustRun(h, i)
        const raw = String(args.dir ?? '').trim()
        if (!raw) throw new Error('Enter a folder.')
        const dir = (raw.startsWith('/') ? raw : raw.startsWith('~') ? `${AGENT_HOME}${raw.slice(1)}` : `${WORK_DIR}/${raw}`).replace(/\/+$/, '') || '/'
        if (dir.split('/').includes('..')) throw new Error('The folder cannot contain "..".')
        await latency(args.cloneUrl ? 1800 : 300)
        if (args.cloneUrl && !/^(https:\/\/|git@|ssh:\/\/)/.test(String(args.cloneUrl))) {
          throw new Error(`git clone failed: "${args.cloneUrl}" is not a repository URL Mango can clone.`)
        }
        return dir
      }

      case 'env_desktop_open': {
        const { h, i } = instanceOf(args.hostId, args.instance)
        mustRun(h, i)
        if (!i.installed.desktop) throw new Error(`${i.name} has no desktop yet. Install Desktop first.`)
        await latency(900)
        return { url: desktopPage(i.name, h.host.name) } satisfies EnvDesktop
      }

      case 'env_desktop_close':
        await latency(60)
        return
    }
    throw new Error(`mock: unknown command ${cmd}`)
  }

  return call
}
