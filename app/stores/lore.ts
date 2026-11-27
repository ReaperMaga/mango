import { defineStore } from 'pinia'
import type { LoreCli, LoreMachineAccess, LoreMachineProbe, LoreServer, LoreServerCheck, LoreServerInput } from '~/types/ipc'
import { call } from '~/composables/useBackend'

/** One server's last check from this computer. */
export interface LoreCheckState {
  check: LoreServerCheck | null
  loading: boolean
  /** The check itself could not run. */
  error: string | null
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

/**
 * Lore on this computer: the CLI, the saved servers (Settings > Lore) and what each answered when last
 * checked. Shared by Settings and the New project dialog, so a check made in one shows in the other.
 */
export const useLore = defineStore('lore', {
  state: () => ({
    cli: null as LoreCli | null,
    cliLoading: false,
    cliError: null as string | null,
    servers: null as LoreServer[] | null,
    serversError: null as string | null,
    /** The New project dialog asked Settings > Lore to install the CLI (it starts when the section shows). */
    installAsked: false,
    /** The New project dialog asked Settings > Lore to sign in to this server (it starts when its row shows). */
    signInAsked: null as string | null,
    /** By server URL. */
    checks: {} as Record<string, LoreCheckState>,
    /** The set-up dialog (a Lore server on a machine over SSH): a new one, or changing `server`. */
    machineDialog: null as { server: LoreServer | null } | null,
    /** "Create Lore repository" for an existing local project folder: the dialog, open for `path`. */
    initFor: null as { path: string; name: string } | null,
  }),

  actions: {
    async loadCli(): Promise<LoreCli | null> {
      this.cliLoading = true
      try {
        this.cli = await call('lore_cli', {})
        this.cliError = null
        return this.cli
      } catch (e) {
        this.cliError = message(e)
        return null
      } finally {
        this.cliLoading = false
      }
    },

    async loadServers(): Promise<LoreServer[]> {
      try {
        this.servers = await call('lore_servers', {})
        this.serversError = null
      } catch (e) {
        this.serversError = message(e)
      }
      return this.servers ?? []
    },

    /** Add or change a server; throws with the backend's message. Answers the saved entry. */
    async upsert(server: LoreServerInput): Promise<LoreServer | null> {
      const before = new Set((this.servers ?? []).map(s => s.id))
      this.servers = await call('lore_server_upsert', { server })
      return this.servers.find(s => (server.id ? s.id === server.id : !before.has(s.id))) ?? null
    },

    async remove(id: string) {
      this.servers = await call('lore_server_remove', { id })
    },

    /** A look at a machine over SSH (keys only); throws with the backend's message. */
    probeMachine(machine: LoreMachineAccess): Promise<LoreMachineProbe> {
      return call('lore_machine_probe', { machine })
    },

    checkOf(url: string): LoreCheckState | null {
      return this.checks[url] ?? null
    },

    /** Ask the server again (a check already running for it is reused). */
    async check(url: string): Promise<LoreServerCheck | null> {
      if (!this.checks[url]) this.checks[url] = { check: null, loading: false, error: null }
      // Through the store's proxy, so the change shows.
      const state = this.checks[url]!
      if (state.loading) return state.check
      state.loading = true
      try {
        state.check = await call('lore_server_check', { url })
        state.error = null
      } catch (e) {
        state.error = message(e)
      } finally {
        state.loading = false
      }
      return state.check
    },
  },
})
