import { defineStore } from 'pinia'
import type {
  EnvComponent, EnvComponentId, EnvCreateInput, EnvDesktop, EnvHost, EnvInstance, EnvInstanceAction, EnvJoinPreview, EnvLoginTool,
  EnvProbe, EnvShare, EnvShareVia,
} from '~/types/ipc'
import { call } from '~/composables/useBackend'
import { useWorkspace } from '~/stores/workspace'

/** `${hostId}/${instance}`: the key for per-instance state. */
export const instanceKey = (hostId: string, instance: string) => `${hostId}/${instance}`

/** Images offered when creating an instance (any other `remote:alias` can be typed). */
export const ENV_IMAGES = [
  { id: 'images:ubuntu/24.04', name: 'Ubuntu 24.04 LTS' },
  { id: 'images:ubuntu/26.04', name: 'Ubuntu 26.04 LTS' },
  { id: 'images:debian/13', name: 'Debian 13' },
] as const

/** Where projects go inside an instance unless the user picks another folder. */
export const ENV_WORK_DIR = '/home/agent/work'

/**
 * The one-click components, for choosing them before an instance exists (the create dialog).
 * Once an instance runs, `env_components` is the source of truth for names, versions and requirements.
 */
export const ENV_COMPONENTS: ReadonlyArray<{ id: EnvComponentId; name: string; description: string; requires: EnvComponentId[] }> = [
  // Same order and requirements as the backend's recipes (src-tauri/src/envs/recipes.rs).
  { id: 'base', name: 'Base system', description: 'The agent user, git, curl, build tools and a work folder.', requires: [] },
  { id: 'node', name: 'Node.js', description: 'The current LTS release, with npm.', requires: ['base'] },
  { id: 'gh', name: 'GitHub CLI', description: 'Pull requests, issues and git sign-in.', requires: ['base'] },
  { id: 'claude', name: 'Claude Code', description: "Anthropic's coding agent.", requires: ['base'] },
  { id: 'codex', name: 'Codex', description: "OpenAI's coding agent.", requires: ['base'] },
  { id: 'desktop', name: 'Desktop', description: 'An XFCE desktop you can open from Mango.', requires: ['base'] },
  { id: 'tailscale', name: 'Tailscale', description: 'Joins your tailnet, with Tailscale SSH.', requires: ['base'] },
]

/**
 * Where Settings > Environments is: a server's page, or one instance on it.
 * `null` (the store's `selected`) is the section's first page, the list of servers.
 */
export interface EnvSelection { hostId: string; instance: string | null }

/** Dialogs the Environments section owns. */
export type EnvDialog =
  | { kind: 'host'; id: string } // id '' adds a server; a joined environment's id renames it
  | { kind: 'create'; hostId: string }
  | { kind: 'join'; link: string } // link '' asks for one; a deep link fills it in

/**
 * Something to do once a page shows: for an instance (keyed by `instanceKey`) a next step chosen
 * after creating it; for a server (keyed by its id) leading to the Incus setup after adding it.
 */
export type EnvIntent = 'login-claude' | 'open-project' | 'setup-incus'

/** How a server is doing, for its row and its page: reachability first, then Incus. */
export type HostTone = 'ready' | 'setup' | 'bad' | 'checking' | 'unknown'
export function hostState(probe: EnvProbe | null | undefined, probing: boolean): { tone: HostTone; label: string } {
  if (probing && !probe) return { tone: 'checking', label: 'Checking…' }
  if (!probe) return { tone: 'unknown', label: 'Not checked' }
  if (!probe.reachable) return { tone: 'bad', label: 'Can\'t reach it' }
  switch (probe.incus) {
    case 'ready': return { tone: 'ready', label: probe.incusVersion ? `Incus ${probe.incusVersion}` : 'Ready' }
    case 'missing': return { tone: 'setup', label: 'Incus not installed' }
    case 'uninitialised': return { tone: 'setup', label: 'Incus not set up' }
    case 'no-access': return { tone: 'setup', label: 'No access to Incus' }
    default: return { tone: probe.ok ? 'ready' : 'setup', label: probe.ok ? 'Ready' : 'Incus not ready' }
  }
}

/** The login part of `user@host`, for copy that names who gets access ("your SSH user" for an alias). */
export const sshUser = (ssh: string) => (ssh.includes('@') ? ssh.slice(0, ssh.lastIndexOf('@')) : null)

/** The host part of `user@host` (an ssh_config alias as it is): where a share over the internet points by default. */
export const sshHostName = (ssh: string) => (ssh.includes('@') ? ssh.slice(ssh.lastIndexOf('@') + 1) : ssh)

/** Access has ended (a share, or a joined environment, carries its own end date; null never ends). */
export const shareExpired = (expiresAt: number | null | undefined, now = Date.now()) => !!expiresAt && expiresAt <= now

/** "23 Nov", or "23 Nov 2027" outside this year: when a share was made or ends. */
export function shareDay(ms: number, now = Date.now()) {
  const d = new Date(ms)
  const sameYear = d.getFullYear() === new Date(now).getFullYear()
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }) })
}

/**
 * Why a joined environment can't be used, from what the backend said: its access ended, its
 * identity changed (Mango refuses to connect), its key was refused (probably revoked), or it
 * didn't answer. The page says what to do; this only sorts.
 */
export type DirectProblem = 'expired' | 'host-key' | 'refused' | 'unreachable'
export function directProblem(host: EnvHost, probe: EnvProbe | null | undefined, now = Date.now()): DirectProblem | null {
  if (shareExpired(host.direct?.expiresAt, now)) return 'expired'
  if (!probe || probe.reachable) return null
  const e = (probe.error ?? '').toLowerCase()
  if (/host key|host identification|known_hosts/.test(e)) return 'host-key'
  if (/permission denied|publickey|access (has )?ended|expired|revoked/.test(e)) return 'refused'
  return 'unreachable'
}

/** How a joined environment is doing, for its row and its page. */
export function directState(host: EnvHost, probe: EnvProbe | null | undefined, probing: boolean): { tone: HostTone; label: string } {
  const problem = directProblem(host, probe)
  if (problem === 'expired') return { tone: 'setup', label: 'Access ended' }
  if (probing && !probe) return { tone: 'checking', label: 'Checking…' }
  if (!probe) return { tone: 'unknown', label: 'Not checked' }
  switch (problem) {
    case 'host-key': return { tone: 'bad', label: 'Identity changed' }
    case 'refused': return { tone: 'setup', label: 'Access refused' }
    case 'unreachable': return { tone: 'bad', label: 'Can\'t reach it' }
  }
  return { tone: 'ready', label: 'Connected' }
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** A joined environment before (or without) the backend listing it: just its name and whether it answers. */
const directInstance = (host: EnvHost, reachable: boolean): EnvInstance => ({
  name: host.direct!.instance,
  kind: 'container',
  status: reachable ? 'running' : 'unknown',
  image: null,
  ipv4: [],
  tailscaleIp: null,
  cpus: null,
  memory: null,
  createdAt: 0,
})

/**
 * Remote environments: master servers (reached over SSH) and the Incus instances on them,
 * shown in Settings > Environments. Servers are saved by the backend (`environments.json`);
 * everything else is fetched on demand.
 * Terminal-based actions (create, install, shell, sign-in) return a pty id for a terminal view.
 */
export const useEnvironments = defineStore('environments', {
  state: () => ({
    hosts: [] as EnvHost[],
    loaded: false,
    /** Result of the last reachability check per server; absent until checked. */
    probes: {} as Record<string, EnvProbe>,
    probing: {} as Record<string, boolean>,
    instances: {} as Record<string, EnvInstance[]>,
    loadingInstances: {} as Record<string, boolean>,
    /** Last error listing a server's instances. */
    errors: {} as Record<string, string | null>,
    /** Per instance (see `instanceKey`). */
    components: {} as Record<string, EnvComponent[]>,
    loadingComponents: {} as Record<string, boolean>,
    componentErrors: {} as Record<string, string | null>,
    /** Instances with an action in flight, and which. */
    busy: {} as Record<string, EnvInstanceAction | null>,
    desktops: {} as Record<string, EnvDesktop>,
    /** Who an instance is shared with, per instance (see `instanceKey`). */
    shares: {} as Record<string, EnvShare[]>,
    loadingShares: {} as Record<string, boolean>,
    shareErrors: {} as Record<string, string | null>,
    /** Shares being revoked, by share id. */
    revoking: {} as Record<string, boolean>,

    /* ---- UI (Settings > Environments) ---- */
    /** The page showing: null is the list of servers. */
    selected: null as EnvSelection | null,
    dialog: null as EnvDialog | null,
    /** Per instance (see `instanceKey`) or server (its id): picked up by its page when it shows. */
    intents: {} as Record<string, EnvIntent>,
  }),

  getters: {
    host: s => (id: string) => s.hosts.find(h => h.id === id) ?? null,
    /** The user's own servers (masters). */
    servers: s => s.hosts.filter(h => !h.direct),
    /** Environments joined from a share link ("Shared with you"). */
    joined: s => s.hosts.filter(h => !!h.direct),
    instance: s => (hostId: string, name: string) => s.instances[hostId]?.find(i => i.name === name) ?? null,
  },

  actions: {
    /**
     * Open Settings > Environments, on a server or instance page when given
     * (otherwise where the user left it).
     */
    openView(selection?: EnvSelection | null) {
      if (selection !== undefined) this.selected = selection
      useWorkspace().openSettings('environments')
    },
    select(hostId: string, instance: string | null = null) {
      // A joined environment has no server page: it is its one instance.
      const direct = this.hosts.find(h => h.id === hostId)?.direct
      this.selected = { hostId, instance: direct ? direct.instance : instance }
    },
    /** The join dialog over Settings > Environments, filled in with `link` (from a deep link) or empty. */
    openJoin(link = '') {
      this.dialog = { kind: 'join', link }
      this.openView()
    },
    /** Back to the list of servers. */
    home() {
      this.selected = null
    },

    async load() {
      try {
        this.hosts = await call('env_hosts')
      } finally {
        this.loaded = true
      }
    },

    /** Add (id '') or update a server. Throws with a readable message when the input is refused. */
    async saveHost(host: EnvHost) {
      const saved = await call('env_host_save', { host })
      const i = this.hosts.findIndex(h => h.id === saved.id)
      if (i >= 0) this.hosts.splice(i, 1, saved)
      else this.hosts.push(saved)
      return saved
    },

    async removeHost(id: string) {
      await call('env_host_remove', { id })
      this.hosts = this.hosts.filter(h => h.id !== id)
      delete this.probes[id]
      delete this.instances[id]
      delete this.errors[id]
      delete this.intents[id]
      if (this.selected?.hostId === id) this.selected = null
    },

    /** Leave a joined environment: forget it and delete its key here (its owner can still revoke it). */
    leave(id: string) {
      return this.removeHost(id)
    },

    async probe(hostId: string) {
      this.probing[hostId] = true
      try {
        this.probes[hostId] = await call('env_probe', { hostId })
      } catch (e) {
        this.probes[hostId] = {
          ok: false, reachable: false, incus: null, incusVersion: null, os: null,
          canSetup: false, setupNote: null, remotes: [], error: message(e),
        }
      } finally {
        this.probing[hostId] = false
      }
      return this.probes[hostId]!
    },

    /**
     * Check the server again, and list its instances when Incus is ready there. A joined
     * environment has no Incus: reaching it is enough, and it is always its one instance.
     */
    async refreshHost(hostId: string) {
      const host = this.host(hostId)
      if (host?.direct) {
        // There at once (not checked yet), so its page has something to stand on while it connects.
        if (!this.instances[hostId]) this.instances[hostId] = [directInstance(host, false)]
        const p = await this.probe(hostId)
        await this.refreshInstances(hostId)
        return p
      }
      const p = await this.probe(hostId)
      if (p.ok) await this.refreshInstances(hostId)
      else delete this.instances[hostId]
      return p
    },

    async refreshInstances(hostId: string) {
      const host = this.host(hostId)
      if (host?.direct) {
        // Listed by the backend when it can say more (image, addresses); otherwise it is just there.
        const reachable = this.probes[hostId]?.reachable === true
        const list = reachable ? await call('env_instances', { hostId }).catch(() => [] as EnvInstance[]) : []
        this.instances[hostId] = [list.find(i => i.name === host.direct!.instance) ?? directInstance(host, reachable)]
        this.errors[hostId] = null
        return
      }
      this.loadingInstances[hostId] = true
      try {
        this.instances[hostId] = await call('env_instances', { hostId })
        this.errors[hostId] = null
      } catch (e) {
        this.errors[hostId] = message(e)
      } finally {
        this.loadingInstances[hostId] = false
      }
    },

    /** Start, stop, restart or delete; the list refreshes afterwards. Throws on failure. */
    async act(hostId: string, instance: string, action: EnvInstanceAction) {
      const key = instanceKey(hostId, instance)
      this.busy[key] = action
      try {
        await call('env_instance_action', { hostId, instance, action })
        if (action === 'delete') {
          delete this.components[key]
          await this.closeDesktop(hostId, instance)
        }
      } finally {
        this.busy[key] = null
        await this.refreshInstances(hostId)
      }
    },

    async refreshComponents(hostId: string, instance: string) {
      const key = instanceKey(hostId, instance)
      this.loadingComponents[key] = true
      try {
        this.components[key] = await call('env_components', { hostId, instance })
        this.componentErrors[key] = null
      } catch (e) {
        this.componentErrors[key] = message(e)
      } finally {
        this.loadingComponents[key] = false
      }
    },

    /* Terminal-based: each returns the pty id to attach a terminal view to. */
    /** Install, initialise or update Incus on the server, in a terminal. Probe again when it exits. */
    setupServer(hostId: string, cols: number, rows: number) {
      return call('env_server_setup', { hostId, cols, rows })
    },
    create(input: EnvCreateInput, cols: number, rows: number) {
      return call('env_create', { input, cols, rows })
    },
    install(hostId: string, instance: string, components: EnvComponentId[], cols: number, rows: number) {
      return call('env_install', { hostId, instance, components, cols, rows })
    },
    shell(hostId: string, instance: string, cwd: string | null, cols: number, rows: number) {
      return call('env_shell', { hostId, instance, cwd, cols, rows })
    },
    login(hostId: string, instance: string, tool: EnvLoginTool, cols: number, rows: number) {
      return call('env_login', { hostId, instance, tool, cols, rows })
    },

    /** Make sure a folder exists in the instance (optionally cloning into it); returns its absolute path. */
    prepareDir(hostId: string, instance: string, dir: string, cloneUrl: string | null) {
      return call('env_prepare_dir', { hostId, instance, dir, cloneUrl })
    },

    async openDesktop(hostId: string, instance: string) {
      const key = instanceKey(hostId, instance)
      const d = await call('env_desktop_open', { hostId, instance })
      this.desktops[key] = d
      return d
    },
    async closeDesktop(hostId: string, instance: string) {
      const key = instanceKey(hostId, instance)
      if (!this.desktops[key]) return
      delete this.desktops[key]
      await call('env_desktop_close', { hostId, instance }).catch(() => {})
    },

    /* ---- sharing: one environment, with a one-line link ---- */

    /** Who the instance is shared with. */
    async refreshShares(hostId: string, instance: string) {
      const key = instanceKey(hostId, instance)
      this.loadingShares[key] = true
      try {
        this.shares[key] = await call('env_shares', { hostId, instance })
        this.shareErrors[key] = null
      } catch (e) {
        this.shareErrors[key] = message(e)
      } finally {
        this.loadingShares[key] = false
      }
      return this.shares[key] ?? []
    },

    /**
     * A new share and its link: the only time the link exists outside the link itself.
     * The first share of an instance installs an SSH server in it, which can take a minute.
     */
    async createShare(hostId: string, instance: string, label: string, via: EnvShareVia, expiresInDays: number | null) {
      const link = await call('env_share_create', { hostId, instance, label, via, expiresInDays })
      const key = instanceKey(hostId, instance)
      this.shares[key] = [link.share, ...(this.shares[key] ?? []).filter(s => s.id !== link.share.id)]
      return link
    },

    /** Remove one person's access. Throws with a readable message. */
    async revokeShare(hostId: string, instance: string, shareId: string) {
      this.revoking[shareId] = true
      try {
        await call('env_share_revoke', { hostId, instance, shareId })
        const key = instanceKey(hostId, instance)
        this.shares[key] = (this.shares[key] ?? []).filter(s => s.id !== shareId)
      } finally {
        delete this.revoking[shareId]
      }
    },

    /** What a pasted link would add; saves nothing. */
    joinPreview(link: string): Promise<EnvJoinPreview> {
      return call('env_join_preview', { link })
    },

    /** Save the environment from a link (replacing one joined from the same share) and show its page. */
    async join(link: string, name: string | null) {
      const host = await call('env_join', { link, name: name?.trim() || null })
      const at = this.hosts.findIndex(h => h.id === host.id || (!!h.direct && h.direct.shareId === host.direct?.shareId))
      if (at >= 0) {
        const old = this.hosts[at]!
        delete this.probes[old.id]
        delete this.instances[old.id]
        if (old.id !== host.id) await this.closeDesktop(old.id, old.direct?.instance ?? '')
        this.hosts.splice(at, 1, host)
      } else {
        this.hosts.push(host)
      }
      delete this.probes[host.id]
      delete this.instances[host.id]
      this.select(host.id)
      this.refreshHost(host.id)
      return host
    },
  },
})
