import { defineStore } from 'pinia'
import type { McpServerConfig } from '~/types/ipc'
import { call } from '~/composables/useBackend'
import { mcpInEffect } from '~/utils/mcpServers'

/**
 * The MCP servers the user added for agent chats, as Settings shows and edits them. The list lives
 * in the backend (`mcp-servers.json`, owner-only, see src-tauri/src/mcp.rs), not in localStorage,
 * because env values and headers are secrets; every change saves the whole list, checked there.
 * Runs read the saved list themselves (`agents/index.ts`), so nothing here has to be loaded first.
 */
export const useMcp = defineStore('mcp', {
  state: () => ({
    servers: [] as McpServerConfig[],
    loaded: false,
    loading: false,
    loadError: null as string | null,
  }),
  getters: {
    global: s => s.servers.filter(x => x.project === null),
    ofProject: s => (path: string) => s.servers.filter(x => x.project === path),
    inEffect: s => (path: string) => mcpInEffect(s.servers, path),
  },
  actions: {
    async load(force = false) {
      if ((this.loaded && !force) || this.loading) return
      this.loading = true
      try {
        this.servers = await call('mcp_servers')
        this.loaded = true
        this.loadError = null
      } catch (e) {
        this.loadError = e instanceof Error ? e.message : String(e)
      } finally {
        this.loading = false
      }
    },
    /** Saves `next` as the whole list. Rejects with the backend's message (it names the server, never a value). */
    async save(next: McpServerConfig[]) {
      // The whole list is written: never from one that was not read, or the saved servers would be lost.
      if (!this.loaded) throw new Error('The saved servers could not be read, so nothing was changed. Reopen Settings to try again.')
      this.servers = await call('mcp_servers_save', { servers: next })
    },
    /** Adds `server` (no id yet) or replaces the one with its id; resolves to it as saved. */
    async put(server: McpServerConfig): Promise<McpServerConfig> {
      const at = server.id ? this.servers.findIndex(s => s.id === server.id) : -1
      const next = [...this.servers]
      if (at >= 0) next[at] = server
      else next.push(server)
      await this.save(next)
      return at >= 0 ? this.servers[at]! : this.servers[this.servers.length - 1]!
    },
    async remove(id: string) {
      await this.save(this.servers.filter(s => s.id !== id))
    },
    /** Drops a project's own servers (the project was removed from Mango). */
    async forgetProject(path: string) {
      await this.load()
      if (this.loaded && this.servers.some(s => s.project === path)) await this.save(this.servers.filter(s => s.project !== path))
    },
    async setEnabled(id: string, enabled: boolean) {
      await this.save(this.servers.map(s => (s.id === id ? { ...s, enabled } : s)))
    },
  },
})
