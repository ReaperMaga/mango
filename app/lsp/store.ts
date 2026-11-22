import { defineStore } from 'pinia'
import type { LspServer, LspServerId } from '~/types/ipc'
import type { SessionView } from '~/lsp/session'
import { poolKey } from '~/lsp/pool'
import { call } from '~/composables/useBackend'
import { useWorkspace } from '~/stores/workspace'
import { useThreads } from '~/stores/threads'
import { isEnvPath } from '~/utils/envPath'

/**
 * Language servers as the interface sees them: which exist here, where they may run, and how each
 * running one is doing. `lsp/service.ts` runs them.
 */
export const useLanguageServers = defineStore('languageServers', {
  state: () => ({
    /** Null until asked. */
    servers: null as LspServer[] | null,
    loading: false,
    error: null as string | null,
    /** The running (or failed) sessions, by `poolKey`. */
    sessions: {} as Record<string, SessionView>,
  }),

  getters: {
    /** The installed server for a language (an LSP language id). */
    serverFor: s => (language: string | null | undefined): LspServer | null =>
      (language ? s.servers?.find(x => x.installed && x.languages.includes(language)) : null) ?? null,
    /** The user's answer for the project a folder belongs to (a worktree's is its project's); null: not asked yet. */
    consentOf: () => (root: string): boolean | null =>
      useWorkspace().projectPrefs[useThreads().ownerOf(root)]?.languageServers ?? null,
    /** A server may run in this folder: local, not turned off, and allowed for its project. */
    allowed(): (root: string) => boolean {
      return root => !isEnvPath(root) && useWorkspace().editorLanguageServers && this.consentOf(root) === true
    },
    session: s => (server: LspServerId, root: string): SessionView | null => s.sessions[poolKey({ server, root })] ?? null,
  },

  actions: {
    /** Ask which servers are installed; again when `force` (after installing one). */
    async load(force = false) {
      if (this.loading || (this.servers && !force)) return
      this.loading = true
      try {
        this.servers = await call('lsp_servers')
        this.error = null
      } catch (e) {
        this.error = e instanceof Error ? e.message : String(e)
      } finally {
        this.loading = false
      }
    },

    setConsent(root: string, on: boolean) {
      useWorkspace().setProjectPref(useThreads().ownerOf(root), { languageServers: on })
    },
  },
})
