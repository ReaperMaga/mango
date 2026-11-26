import { defineStore } from 'pinia'
import type {
  EnvComponent, EnvComponentId, EnvCreateInput, EnvDesktop, EnvHost, EnvInstance, EnvInstanceAction, EnvJoinPreview, EnvLoginTool,
  EnvDirListing, EnvProbe, EnvResizeInput, EnvShare, EnvShareVia, EnvVersion, EnvVersions, LoreNew,
} from '~/types/ipc'
import { call } from '~/composables/useBackend'
import { formatLocale, t } from '~/i18n'
import { useWorkspace } from '~/stores/workspace'
import { useThreads } from '~/stores/threads'
import { useFiles } from '~/stores/files'

/** `${hostId}/${instance}`: the key for per-instance state. */
export const instanceKey = (hostId: string, instance: string) => `${hostId}/${instance}`

/** What Mango is doing to an instance right now: a power action, or renaming or resizing it. */
export type EnvBusy = EnvInstanceAction | 'rename' | 'resize'

/** Images offered when creating an instance (any other `remote:alias` can be typed). */
export const ENV_IMAGES = [
  { id: 'images:ubuntu/24.04', name: 'Ubuntu 24.04 LTS' },
  { id: 'images:ubuntu/26.04', name: 'Ubuntu 26.04 LTS' },
  { id: 'images:debian/13', name: 'Debian 13' },
] as const

/** Where projects go inside an instance unless the user picks another folder. */
export const ENV_WORK_DIR = '/home/agent/work'
/** The agent user's home inside an instance (`~`). */
export const ENV_HOME_DIR = '/home/agent'

/**
 * The one-click components, for choosing them before an instance exists (the create dialog).
 * Once an instance runs, `env_components` is the source of truth for versions and requirements.
 */
export const ENV_COMPONENTS: ReadonlyArray<{ id: EnvComponentId; requires: EnvComponentId[]; versioned?: boolean }> = [
  // Same order and requirements as the backend's recipes (src-tauri/src/envs/recipes.rs).
  { id: 'base', requires: [] },
  { id: 'node', requires: ['base'], versioned: true },
  { id: 'java', requires: ['base'], versioned: true },
  { id: 'gh', requires: ['base'] },
  { id: 'glab', requires: ['base'] },
  { id: 'claude', requires: ['base'] },
  { id: 'codex', requires: ['base'] },
  { id: 'chromium', requires: ['base', 'node'] },
  { id: 'desktop', requires: ['base'] },
  { id: 'docker', requires: ['base'] },
  { id: 'tailscale', requires: ['base'] },
]

/** A component's name, in the interface language. */
export const envComponentName = (id: EnvComponentId) => t(`envs.components.${id}.name`)

/** What a versioned component installs when no version is picked. */
export function envDefaultVersion(id: EnvComponentId) {
  return id === 'node' ? t('envs.versions.node') : id === 'java' ? t('envs.versions.java') : t('envs.common.default')
}

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
 * after creating it, or asked for from elsewhere (the chat's place menu, the clone dialog);
 * for a server (keyed by its id) leading to the Incus setup after adding it.
 */
export type EnvIntent = 'login-claude' | 'login-gh' | `login-glab:${string}` | 'open-project' | 'open-desktop' | 'setup-incus'

/** How a server is doing, for its row and its page: reachability first, then Incus. */
export type HostTone = 'ready' | 'setup' | 'bad' | 'checking' | 'unknown'
export function hostState(probe: EnvProbe | null | undefined, probing: boolean): { tone: HostTone; label: string } {
  if (probing && !probe) return { tone: 'checking', label: t('envs.state.checking') }
  if (!probe) return { tone: 'unknown', label: t('envs.state.notChecked') }
  if (!probe.reachable) return { tone: 'bad', label: t('envs.state.cantReach') }
  switch (probe.incus) {
    case 'ready': return { tone: 'ready', label: probe.incusVersion ? `Incus ${probe.incusVersion}` : t('envs.state.ready') }
    case 'missing': return { tone: 'setup', label: t('envs.state.incusMissing') }
    case 'uninitialised': return { tone: 'setup', label: t('envs.state.incusNotSetUp') }
    case 'no-access': return { tone: 'setup', label: t('envs.state.incusNoAccess') }
    default: return { tone: probe.ok ? 'ready' : 'setup', label: probe.ok ? t('envs.state.ready') : t('envs.state.incusNotReady') }
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
  return d.toLocaleDateString(formatLocale(), { day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }) })
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
  if (problem === 'expired') return { tone: 'setup', label: t('envs.state.accessEnded') }
  if (probing && !probe) return { tone: 'checking', label: t('envs.state.checking') }
  if (!probe) return { tone: 'unknown', label: t('envs.state.notChecked') }
  switch (problem) {
    case 'host-key': return { tone: 'bad', label: t('envs.state.identityChanged') }
    case 'refused': return { tone: 'setup', label: t('envs.state.accessRefused') }
    case 'unreachable': return { tone: 'bad', label: t('envs.state.cantReach') }
  }
  return { tone: 'ready', label: t('envs.state.connected') }
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
  disk: null,
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
    /** What Node.js and Java can install, by component id (fetched once per session, on demand). */
    versions: {} as Partial<Record<EnvComponentId, EnvVersion[]>>,
    loadingVersions: {} as Partial<Record<EnvComponentId, boolean>>,
    versionErrors: {} as Partial<Record<EnvComponentId, string | null>>,
    loadingComponents: {} as Record<string, boolean>,
    componentErrors: {} as Record<string, string | null>,
    /** Instances with an action in flight, and which. */
    busy: {} as Record<string, EnvBusy | null>,
    desktops: {} as Record<string, EnvDesktop>,
    /** Who an instance is shared with, per instance (see `instanceKey`). */
    shares: {} as Record<string, EnvShare[]>,
    loadingShares: {} as Record<string, boolean>,
    shareErrors: {} as Record<string, string | null>,
    /** Shares being revoked, by share id. */
    revoking: {} as Record<string, boolean>,
    /** Per instance: something to tell about the last rename or resize (e.g. it didn't start again). */
    notes: {} as Record<string, string>,

    /* ---- UI (Settings > Environments) ---- */
    /** The page showing: null is the list of servers. */
    selected: null as EnvSelection | null,
    dialog: null as EnvDialog | null,
    /** Per instance (see `instanceKey`) or server (its id): picked up by its page when it shows. */
    intents: {} as Record<string, EnvIntent>,
    /** The self-managed GitLab servers Mango knows (`gitlab_hosts`), offered for a glab sign-in; null until read. */
    gitlabHosts: null as string[] | null,
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

    /**
     * Rename an instance. A running one is stopped and started again (Incus renames only stopped
     * instances). Mango's own references move along: what is kept per instance here, and the
     * projects, chats and prefs in it (`env://<host>/<instance>/…`). Its page is the caller's to
     * switch to (`select`). Returns a note to show, or null.
     * Throws with a readable message.
     */
    async rename(hostId: string, instance: string, newName: string) {
      const name = newName.trim()
      if (name === instance) return null
      const key = instanceKey(hostId, instance)
      this.busy[key] = 'rename'
      // Its desktop tunnel points at the old name and dies with the stop anyway.
      await this.closeDesktop(hostId, instance)
      const files = useFiles()
      const release = await files.holdInstance(hostId, instance, name)
      let note: string | null
      try {
        note = await call('env_rename', { hostId, instance, newName: name })
      } catch (e) {
        release()
        this.busy[key] = null
        await this.refreshInstances(hostId)
        throw e
      }
      const to = instanceKey(hostId, name)
      for (const map of [this.components, this.componentErrors, this.shares, this.shareErrors, this.intents, this.notes] as Array<Record<string, unknown>>) {
        if (key in map) { map[to] = map[key]; delete map[key] }
      }
      this.busy[key] = null
      try {
        // Before the tabs with nothing unsaved close.
        files.moveUnsaved(hostId, instance, name)
        useWorkspace().moveEnvInstance(hostId, instance, name)
        useThreads().moveEnvInstance(hostId, instance, name)
      } finally {
        release()
      }
      await this.refreshInstances(hostId)
      return note
    },

    /** Change CPUs, memory and the root disk; the list refreshes afterwards. Returns a note to show, or null. Throws on failure. */
    async resize(hostId: string, instance: string, input: EnvResizeInput) {
      const key = instanceKey(hostId, instance)
      this.busy[key] = 'resize'
      try {
        return await call('env_resize', { hostId, instance, input })
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

    /** The versions a component can install; fetched once, again with `force` (or after a failure). */
    async loadVersions(component: EnvComponentId, force = false) {
      if (this.loadingVersions[component] || (!force && this.versions[component])) return
      this.loadingVersions[component] = true
      this.versionErrors[component] = null
      try {
        this.versions[component] = await call('env_versions', { component })
      } catch (e) {
        this.versionErrors[component] = message(e)
      } finally {
        this.loadingVersions[component] = false
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
    install(hostId: string, instance: string, components: EnvComponentId[], cols: number, rows: number, versions?: EnvVersions) {
      return call('env_install', { hostId, instance, components, ...(versions && Object.keys(versions).length ? { versions } : {}), cols, rows })
    },
    shell(hostId: string, instance: string, cwd: string | null, cols: number, rows: number) {
      return call('env_shell', { hostId, instance, cwd, cols, rows })
    },
    /** `host`: the GitLab server a glab sign-in is for (gitlab.com when none). */
    login(hostId: string, instance: string, tool: EnvLoginTool, cols: number, rows: number, host?: string | null) {
      return call('env_login', { hostId, instance, tool, ...(host ? { host } : {}), cols, rows })
    },
    /** Read the GitLab servers again (a glab sign-in menu opening); an unreadable list counts as empty. */
    async loadGitlabHosts() {
      try {
        this.gitlabHosts = await call('gitlab_hosts', {})
      } catch {
        this.gitlabHosts ??= []
      }
    },

    /**
     * Make sure a folder exists in the instance, cloning into it (git, or `lore clone` for a `lore://` URL)
     * or running `git init` / `lore repository create` in it when asked; returns its absolute path.
     */
    prepareDir(hostId: string, instance: string, dir: string, cloneUrl: string | null, gitInit = false, lore: LoreNew | null = null) {
      return call('env_prepare_dir', { hostId, instance, dir, cloneUrl, ...(gitInit ? { gitInit: true } : {}), ...(lore ? { lore } : {}) })
    },

    /** The sub-folders of `dir` inside the instance (`~` is the agent's home). Throws with a readable message. */
    listDir(hostId: string, instance: string, dir: string): Promise<EnvDirListing> {
      return call('env_list_dir', { hostId, instance, dir })
    },

    /** Settings > Environments on an instance's page, with something for the page to do once it shows. */
    openInstance(hostId: string, instance: string, intent?: EnvIntent) {
      if (intent) this.intents[instanceKey(hostId, instance)] = intent
      this.select(hostId, instance)
      this.openView()
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
