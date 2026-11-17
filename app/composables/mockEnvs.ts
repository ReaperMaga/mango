import type {
  EnvComponent, EnvComponentId, EnvCreateInput, EnvDesktop, EnvDirListing, EnvHost, EnvInstance, EnvInstanceAction, EnvJoinPreview, EnvLoginTool,
  EnvProbe, EnvShare, EnvShareLink, EnvShareVia,
} from '~/types/ipc'

/**
 * Remote environments for the browser preview (no Tauri): the `env_*` commands from
 * types/ipc.ts against two made-up master servers whose instances really start, stop,
 * get created and get things installed. Terminal-based commands play plausible output
 * into a fake terminal (the same `pty://data` / `pty://exit` events a real one sends),
 * then change the state the way the real thing would. Nothing leaves the browser.
 * Sharing works too: a share makes a real-looking `mango://join/…` link (made-up keys), and
 * joining one adds a direct host whose one instance is the very instance it was shared from.
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

interface MockInstance extends Omit<EnvInstance, 'ipv4' | 'tailscaleIp' | 'disk'> {
  /** The root disk's size, when set. */
  disk?: string | null
  /** Addresses while it runs (a stopped instance reports none). */
  addr: string
  tsIp: string | null
  /** Installed components and their versions. */
  installed: Partial<Record<EnvComponentId, string>>
  /** Who it is shared with (keys in its agent user's authorized_keys). */
  shares?: EnvShare[]
  /** Its own SSH server is set up (the first share does that, slowly). */
  sshd?: boolean
}

interface MockHost {
  host: EnvHost
  instances: MockInstance[]
  /** null: Incus is not installed yet. */
  incusVersion: string | null
  os: string
}

/**
 * What a share link carries (the same fields as the backend's `ShareToken`, src-tauri/src/envs/token.rs):
 * `mango://join/` + base64url of this as JSON. The preview's keys are made up.
 */
interface ShareToken { v: 1; id: string; n: string; f: string; h: string; p: number; u: string; k: string; hk: string; e: number }
const JOIN_PREFIX = 'mango://join/'

const b64url = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const unb64url = (s: string) => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0)))
const fakeKey = (n: number) => b64url(Array.from({ length: n }, () => String.fromCharCode(33 + Math.floor(Math.random() * 90))).join(''))

/** Read a pasted link the way the backend does: whitespace and line breaks from chat apps don't count. */
function readLink(raw: string): ShareToken {
  const link = String(raw ?? '').replace(/\s+/g, '')
  if (!link) throw new Error('Paste the link you were sent.')
  if (!link.startsWith(JOIN_PREFIX)) throw new Error('That is not a Mango share link. Share links start with mango://join/.')
  let t: ShareToken
  try {
    t = JSON.parse(unb64url(link.slice(JOIN_PREFIX.length)))
  } catch {
    throw new Error('This link is incomplete or damaged. Copy the whole link again; it is one long line.')
  }
  if (t?.v !== 1 || !t.id || !t.n || !t.h || !t.k || !t.hk) throw new Error('This link is incomplete or damaged. Copy the whole link again; it is one long line.')
  return t
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
        addr: '10.88.0.12', tsIp: '100.101.7.33', cpus: 4, memory: '8GiB', disk: '40GiB', createdAt: now - 12 * DAY,
        installed: { ...all(['base', 'node', 'claude', 'codex', 'gh', 'tailscale']), claude: '2.3.9' },
        sshd: true,
        shares: [
          { id: 'sh-sam', label: 'Sam', via: 'public', endpoint: 'forge.lan:22101', createdAt: now - 2 * DAY, expiresAt: now + 5 * DAY },
          { id: 'sh-ci', label: 'Review bot', via: 'tailscale', endpoint: '100.101.7.33:22022', createdAt: now - 9 * DAY, expiresAt: now - DAY },
        ],
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
  {
    // Joined from someone else's link: one environment, no server, no Incus.
    host: {
      id: 'h-joined-review',
      name: 'review',
      ssh: 'agent@198.51.100.42',
      port: 2203,
      identityFile: null,
      incusRemote: null,
      tailscale: null,
      direct: { instance: 'review', hostKey: 'AAAAC3NzaC1lZDI1NTE5AAAAIMockHostKeyForThePreview', sharedFrom: 'lab/review', shareId: 'sh-lab-review', expiresAt: now + 6 * DAY },
    },
    incusVersion: null,
    os: 'Ubuntu 24.04.3 LTS',
    instances: [
      {
        name: 'review', kind: 'container', status: 'running', image: 'Ubuntu noble amd64 (20261101_07:42)',
        addr: '10.40.0.9', tsIp: null, cpus: 4, memory: '8GiB', createdAt: now - 20 * DAY,
        installed: all(['base', 'node', 'claude', 'gh']),
      },
    ],
  },
]

/** Share ids a joined environment's key was revoked under (by its owner, here in the preview). */
const revoked = new Set<string>()

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
  disk: i.disk ?? null,
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
  const publicAddress = host.publicAddress?.trim() || null
  if (publicAddress && !/^[\w.:-]+$/.test(publicAddress)) throw new Error('The public address is a host name or an IP address, without spaces.')
  return { ...host, name, ssh, identityFile: host.identityFile?.trim() || null, incusRemote: host.incusRemote?.trim() || null, publicAddress, direct: null }
}

/* ---------- folders inside the instances (env_list_dir, env_prepare_dir) ---------- */

/** Every folder an instance has, as absolute paths, and whether each is a git repository. */
type Tree = Map<string, boolean>

/** The usual top of a Linux system, the same everywhere. */
const SYSTEM_DIRS = ['/bin', '/boot', '/dev', '/etc', '/home', '/lib', '/media', '/mnt', '/opt', '/proc', '/root', '/run', '/srv', '/sys', '/tmp', '/usr', '/usr/local', '/usr/share', '/var', '/var/log', '/var/lib']

/** What is in `~/work` per instance, by name: [folder, is a git repo, its sub-folders]. */
const WORK: Record<string, Array<[string, boolean, string[]]>> = {
  dev: [
    ['shop', true, ['src', 'src/components', 'src/pages', 'public', 'tests', 'scripts', 'node_modules']],
    ['api', true, ['cmd', 'internal', 'internal/http', 'internal/store', 'migrations', 'deploy']],
    ['docs-site', true, ['content', 'content/guides', 'static', 'themes']],
    ['playground', false, ['notes', 'sketches']],
  ],
  'gpu-box': [
    ['vision-train', true, ['data', 'notebooks', 'models', 'scripts']],
    ['datasets', false, ['coco', 'imagenet-mini']],
  ],
  'ci-runner': [
    ['runner-config', true, ['jobs', 'templates']],
  ],
  staging: [
    ['shop', true, ['src', 'public', 'deploy']],
  ],
  review: [
    ['shop', true, ['src', 'src/components', 'tests', 'node_modules']],
    ['pr-1482', true, ['src', 'tests']],
  ],
}

const trees = new Map<string, Tree>()

function treeOf(hostId: string, i: MockInstance): Tree {
  const key = `${hostId}/${i.name}`
  let t = trees.get(key)
  if (t) return t
  t = new Map<string, boolean>()
  for (const d of SYSTEM_DIRS) t.set(d, false)
  for (const d of [AGENT_HOME, `${AGENT_HOME}/.cache`, `${AGENT_HOME}/.config`, `${AGENT_HOME}/.local`, `${AGENT_HOME}/bin`, WORK_DIR]) t.set(d, false)
  for (const [name, git, subs] of WORK[i.name] ?? []) {
    t.set(`${WORK_DIR}/${name}`, git)
    for (const sub of subs) t.set(`${WORK_DIR}/${name}/${sub}`, false)
  }
  trees.set(key, t)
  return t
}

/** An absolute, normalised path: `~` is the agent's home, `.` and `..` are resolved. */
function resolveDir(raw: string): string {
  let s = String(raw ?? '').trim()
  if (!s) throw new Error('Enter a folder.')
  if (s === '~' || s.startsWith('~/')) s = AGENT_HOME + s.slice(1)
  else if (!s.startsWith('/')) s = `${WORK_DIR}/${s}`
  const parts: string[] = []
  for (const p of s.split('/')) {
    if (!p || p === '.') continue
    if (p === '..') parts.pop()
    else parts.push(p)
  }
  return `/${parts.join('/')}`
}

const parentOf = (dir: string) => (dir === '/' ? null : dir.slice(0, dir.lastIndexOf('/')) || '/')

/** Adds `dir` and every folder above it. */
function mkdirs(t: Tree, dir: string) {
  for (let d: string | null = dir; d && d !== '/'; d = parentOf(d)) if (!t.has(d)) t.set(d, false)
}

function children(t: Tree, dir: string): string[] {
  const prefix = dir === '/' ? '/' : `${dir}/`
  return [...t.keys()].filter(p => p.startsWith(prefix) && p !== dir && !p.slice(prefix.length).includes('/'))
}

/** `forge/dev`: where a share link says it is from. */
const sharedFrom = (h: MockHost, i: MockInstance) => `${h.host.name}/${i.name}`

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
        const given = args.host as EnvHost
        if (given.id && hostOf(given.id).host.direct) {
          // A joined environment: only its name is the user's to change; the rest came from the link.
          const h = hostOf(given.id)
          const name = given.name.trim()
          if (!name) throw new Error('Give it a name.')
          h.host = { ...h.host, name }
          return structuredClone(h.host)
        }
        if (!given.id && given.direct) throw new Error('Join a shared environment with its link instead.')
        const host = validHost(given)
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
        const d = h.host.direct
        if (d) {
          // Straight into the environment, as its agent user, with the key from the link.
          const i = h.instances[0]!
          const where = `${h.host.ssh} port ${h.host.port ?? 22}`
          const fail = (error: string): EnvProbe => ({
            ok: false, reachable: false, incus: null, incusVersion: null, os: null, canSetup: false, setupNote: null, remotes: [], error,
          })
          if (revoked.has(d.shareId) || (d.expiresAt && d.expiresAt <= Date.now())) return fail(`${h.host.ssh}: Permission denied (publickey). (simulated)`)
          if (i.status !== 'running') return fail(`ssh: connect to host ${where}: Connection refused (simulated)`)
          return { ok: true, reachable: true, incus: null, incusVersion: null, os: h.os, canSetup: false, setupNote: null, remotes: [], error: null }
        }
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
        if (h.host.direct) throw new Error('A shared environment has no server of yours to set up.')
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
        if (h.host.direct) return h.instances.map(view)
        if (unreachable(h.host)) throw new Error(`Could not reach ${h.host.name} over SSH: connection timed out (simulated).`)
        if (!h.incusVersion) throw new Error(`Incus is not installed on ${h.host.name} yet.`)
        return h.instances.map(view)
      }

      case 'env_instance_action': {
        const { h, i } = instanceOf(args.hostId, args.instance)
        if (h.host.direct) throw new Error(`${i.name} is shared with you: only its owner can start, stop or delete it.`)
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

      case 'env_rename': {
        const { h, i } = instanceOf(args.hostId, args.instance)
        if (h.host.direct) throw new Error('Only the owner can rename this environment.')
        const name = String(args.newName ?? '').trim()
        if (!/^[a-z][a-z0-9-]{0,62}$/i.test(name) || name.endsWith('-')) {
          throw new Error(`"${name}" can't be an instance name. Use a letter, then letters, digits and dashes (up to 63).`)
        }
        if (name === i.name) return null
        if (h.instances.some(x => x.name === name)) throw new Error(`${h.host.name} already has an instance called ${name}.`)
        const wasRunning = i.status === 'running'
        if (wasRunning) { i.status = 'stopping'; await latency(700) }
        i.status = 'stopped'
        await latency(400)
        i.name = name
        if (wasRunning) { i.status = 'starting'; await latency(800); i.status = 'running' }
        return null
      }

      case 'env_resize': {
        const { h, i } = instanceOf(args.hostId, args.instance)
        if (h.host.direct) throw new Error('Only the owner can resize this environment.')
        const input = args.input as { cpus: number | null; memoryGib: number | null; diskGib: number | null }
        if (input.cpus == null && input.memoryGib == null && input.diskGib == null) throw new Error('Nothing to change.')
        if (input.cpus != null && (input.cpus < 1 || input.cpus > 64)) throw new Error('Pick 1 to 64 CPUs.')
        if (input.memoryGib != null && (input.memoryGib < 1 || input.memoryGib > 512)) throw new Error('Pick 1 to 512 GiB of memory.')
        if (input.diskGib != null && (input.diskGib < 4 || input.diskGib > 2048)) throw new Error('Pick 4 to 2048 GiB of disk.')
        const current = parseInt(i.disk ?? '', 10)
        if (input.diskGib != null && current && input.diskGib < current) {
          throw new Error(`Could not change the disk size of ${i.name}: a disk can only grow.`)
        }
        await latency(700)
        if (input.cpus != null) i.cpus = input.cpus
        if (input.memoryGib != null) i.memory = `${input.memoryGib}GiB`
        if (input.diskGib != null) i.disk = `${input.diskGib}GiB`
        return input.diskGib != null && i.kind === 'vm' ? "The VM's file system grows to the new disk size when it next starts." : null
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
        if (h.host.direct) throw new Error('A shared environment has no server to create environments on.')
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
          cpus: input.cpus, memory: input.memoryGib ? `${input.memoryGib}GiB` : null, disk: input.diskGib ? `${input.diskGib}GiB` : null, createdAt: Date.now(), installed: {},
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
        const dir = resolveDir(args.dir)
        if (dir === '/') throw new Error('Pick a folder below /.')
        await latency(args.cloneUrl ? 1800 : 300)
        const t = treeOf(h.host.id, i)
        if (args.cloneUrl) {
          const url = String(args.cloneUrl)
          if (!/^(https:\/\/|git@|ssh:\/\/)/.test(url)) {
            throw new Error(`git clone failed: "${url}" is not a repository URL Mango can clone`)
          }
          if (/private|secret/i.test(url)) {
            throw new Error('git clone failed: could not read Username for \'https://github.com\': terminal prompts disabled')
          }
          if (t.has(dir) && (t.get(dir) || children(t, dir).length)) {
            throw new Error(`git clone failed: destination path '${dir.slice(dir.lastIndexOf('/') + 1)}' already exists and is not an empty directory`)
          }
          mkdirs(t, dir)
          t.set(dir, true)
          for (const sub of ['src', 'tests', '.github']) t.set(`${dir}/${sub}`, false)
          return dir
        }
        mkdirs(t, dir)
        if (args.gitInit) t.set(dir, true)
        return dir
      }

      case 'env_list_dir': {
        const { h, i } = instanceOf(args.hostId, args.instance)
        mustRun(h, i)
        const dir = resolveDir(args.dir)
        await latency(160)
        const t = treeOf(h.host.id, i)
        if (dir !== '/' && !t.has(dir)) throw new Error(`There is no folder ${dir} in ${i.name}`)
        const entries = children(t, dir)
          .map(path => ({ name: path.slice(path.lastIndexOf('/') + 1), path, isGit: t.get(path) === true }))
          .filter(e => !e.name.startsWith('.'))
          .sort((a, b) => a.name.localeCompare(b.name))
        return { dir, parent: parentOf(dir), entries, truncated: false } satisfies EnvDirListing
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

      /* ---- sharing ---- */

      case 'env_shares': {
        const { h, i } = instanceOf(args.hostId, args.instance)
        if (h.host.direct) throw new Error('Only the owner of an environment can share it.')
        await latency(350)
        mustRun(h, i)
        return structuredClone(i.shares ?? []).sort((a, b) => b.createdAt - a.createdAt)
      }

      case 'env_share_create': {
        const { h, i } = instanceOf(args.hostId, args.instance)
        if (h.host.direct) throw new Error('Only the owner of an environment can share it.')
        mustRun(h, i)
        const label = String(args.label ?? '').trim()
        if (!label) throw new Error('Say who the link is for, so you know whose access to revoke later.')
        if (label.length > 60) throw new Error('Keep who it is for under 60 characters.')
        const via = args.via as EnvShareVia
        if (via === 'tailscale' && !i.tsIp) throw new Error(`Install Tailscale on ${i.name} and sign it in first.`)
        if (!i.installed.base) throw new Error(`${i.name} has no agent user yet. Install the Base system component first.`)
        // The first share sets up the environment's own SSH server: slow, once.
        await latency(i.sshd ? 900 : 4200)
        i.sshd = true
        const shares = (i.shares ??= [])
        const host = via === 'public' ? (h.host.publicAddress || h.host.ssh.replace(/^[^@]*@/, '')) : i.tsIp!
        // Public shares of one instance share its forwarded port (22100–22999); Tailscale ones use 22022.
        const taken = h.instances.flatMap(x => x.shares ?? []).filter(s => s.via === 'public').map(s => Number(s.endpoint.split(':').pop()))
        const own = shares.find(s => s.via === 'public')
        const port = via === 'tailscale' ? 22022 : own ? Number(own.endpoint.split(':').pop()) : Math.max(22100, ...taken) + 1
        const days = args.expiresInDays as number | null
        const created = Date.now()
        const share: EnvShare = {
          id: `sh-${rid()}`, label, via, endpoint: `${host}:${port}`, createdAt: created,
          expiresAt: days ? created + days * DAY : null,
        }
        shares.unshift(share)
        const token: ShareToken = {
          v: 1, id: share.id, n: i.name, f: sharedFrom(h, i), h: host, p: port, u: 'agent',
          k: fakeKey(32), hk: `AAAAC3NzaC1lZDI1NTE5AAAAI${fakeKey(24)}`, e: share.expiresAt ? Math.floor(share.expiresAt / 1000) : 0,
        }
        // What the owner may still need to do, the way the backend words it.
        const note = via === 'public'
          ? `If a firewall guards ${h.host.name}, open TCP port ${port} there. ufw is active on it: sudo ufw allow ${port}/tcp`
          : `Only devices your tailnet's access rules let reach ${host} can use this link.`
        return { share: structuredClone(share), url: `${JOIN_PREFIX}${b64url(JSON.stringify(token))}`, note } satisfies EnvShareLink
      }

      case 'env_share_revoke': {
        const { h, i } = instanceOf(args.hostId, args.instance)
        mustRun(h, i)
        await latency(500)
        i.shares = (i.shares ?? []).filter(s => s.id !== args.shareId)
        revoked.add(String(args.shareId))
        return
      }

      case 'env_join_preview': {
        await latency(120)
        const t = readLink(args.link)
        return {
          instance: t.n,
          sharedFrom: t.f,
          endpoint: `${t.h}:${t.p}`,
          expiresAt: t.e ? t.e * 1000 : null,
          alreadyJoined: hosts.some(x => x.host.direct?.shareId === t.id),
        } satisfies EnvJoinPreview
      }

      case 'env_join': {
        const t = readLink(args.link)
        if (t.e && t.e * 1000 <= Date.now()) throw new Error('Access through this link has ended. Ask for a new one.')
        await latency(400)
        const name = String(args.name ?? '').trim() || t.n
        const existing = hosts.find(x => x.host.direct?.shareId === t.id)
        // A link from one of the preview's own servers leads into that very instance (installs show on both sides).
        const [ownerName, instName] = t.f.split('/')
        const owner = hosts.find(x => !x.host.direct && x.host.name === ownerName)?.instances.find(x => x.name === instName)
        const inst: MockInstance = owner ?? {
          name: t.n, kind: 'container', status: 'running', image: 'Ubuntu noble amd64 (20261101_07:42)',
          addr: `10.60.0.${10 + Math.floor(Math.random() * 200)}`, tsIp: null, cpus: null, memory: null, createdAt: Date.now() - 4 * DAY,
          installed: all(['base', 'claude']),
        }
        const host: EnvHost = {
          id: existing?.host.id ?? `h-${rid()}`, name, ssh: `${t.u}@${t.h}`, port: t.p, identityFile: null, incusRemote: null, tailscale: null,
          direct: { instance: t.n, hostKey: t.hk, sharedFrom: t.f, shareId: t.id, expiresAt: t.e ? t.e * 1000 : null },
        }
        if (existing) {
          existing.host = host
          existing.instances = [inst]
        } else {
          hosts.push({ host, instances: [inst], incusVersion: null, os: 'Ubuntu 24.04.3 LTS' })
        }
        return structuredClone(host)
      }
    }
    throw new Error(`mock: unknown command ${cmd}`)
  }

  return call
}
