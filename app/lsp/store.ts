import { defineStore } from 'pinia'
import { watch } from 'vue'
import type { LspServer, LspServerId } from '~/types/ipc'
import type { SessionView } from '~/lsp/session'
import { poolKey } from '~/lsp/pool'
import { call } from '~/composables/useBackend'
import { useFiles } from '~/stores/files'
import { useGit } from '~/stores/git'
import { useWorkspace } from '~/stores/workspace'
import { useThreads } from '~/stores/threads'
import { useWindows } from '~/stores/windows'
import { sameFolder } from '~/utils/autoSave'
import { isEnvPath } from '~/utils/envPath'

/** What was last seen of a folder servers could run in (`lsp_folder`). */
interface Folder {
  /** The project it could follow when looked at (`ownerToFollow`). */
  owner: string
  /** Whose answer counts: the owner's while this is a linked worktree of it, else its own. */
  project: string
  /** Which folder that project was; null: none on this computer. */
  id: string | null
  /** The folder the backend was told servers here are allowed for. */
  allowed: string | null
}

/** Looks at one folder run one after another, so the backend keeps the last one's word. */
const looking = new Map<string, Promise<void>>()
let following = false
let loadAgain = false

/** The project `root` could follow as its worktree: none (itself) where it is open as a project of its own. */
function ownerToFollow(root: string): string {
  const owner = useThreads().ownerOf(root)
  if (owner === root) return root
  const ownProject = useWorkspace().openProjects.some(p => sameFolder(p.path, root))
    || Object.values(useWindows().table).some(claims => claims.some(c => c.kind === 'project' && sameFolder(c.key, root)))
  return ownProject ? root : owner
}

/**
 * Language servers as the interface sees them: which exist here, where they may run, and how each
 * running one is doing. `lsp/service.ts` runs them.
 *
 * The user allows them for a project's folder, not for its path: the answer is kept with the
 * folder's identity, and the backend checks that once more as each server starts.
 */
export const useLanguageServers = defineStore('languageServers', {
  state: () => ({
    /** Null until asked. */
    servers: null as LspServer[] | null,
    loading: false,
    error: null as string | null,
    /** The running (or failed) sessions, by `poolKey`. */
    sessions: {} as Record<string, SessionView>,
    /** By folder: what `checkFolder` saw. */
    folders: {} as Record<string, Folder>,
  }),

  getters: {
    /** The installed server for a language (an LSP language id). */
    serverFor: s => (language: string | null | undefined): LspServer | null =>
      (language ? s.servers?.find(x => x.installed && x.languages.includes(language)) : null) ?? null,
    /**
     * The user's answer that counts in a folder: its project's in a linked git worktree of that, else
     * the folder's own. Null: not asked yet, or asked about another folder at that path. False while
     * that is not known yet.
     */
    consentOf: s => (root: string): boolean | null => {
      const owner = ownerToFollow(root)
      const all = useWorkspace().projectPrefs
      const seen = s.folders[root]
      if (!seen || seen.owner !== owner) {
        return all[root]?.languageServers === undefined && all[owner]?.languageServers === undefined ? null : false
      }
      const prefs = all[seen.project]
      if (prefs?.languageServers === undefined) return null
      if (!seen.id) return false
      return seen.id === prefs.languageServersFolder ? prefs.languageServers : null
    },
    /** A server may run in this folder: local, not turned off, and allowed for the folder its project is now. */
    allowed(): (root: string) => boolean {
      return (root) => {
        if (isEnvPath(root) || !useWorkspace().editorLanguageServers || this.consentOf(root) !== true) return false
        const seen = this.folders[root]!
        return seen.allowed === seen.id
      }
    },
    session: s => (server: LspServerId, root: string): SessionView | null => s.sessions[poolKey({ server, root })] ?? null,
  },

  actions: {
    /** Ask which servers are installed; again when `force` (after installing one). */
    async load(force = false) {
      if (this.loading) {
        loadAgain ||= force
        return
      }
      if (this.servers && !force) return
      this.loading = true
      try {
        do {
          loadAgain = false
          this.servers = await call('lsp_servers', { roots: this.openRoots() })
        } while (loadAgain)
        this.error = null
      } catch (e) {
        this.error = e instanceof Error ? e.message : String(e)
      } finally {
        this.loading = false
      }
    },

    /** The open projects on this computer, worktrees included: their own programs never count as installed. */
    openRoots(): string[] {
      const threads = useThreads()
      return useWorkspace().openProjects
        .flatMap(p => [p.path, ...threads.worktreesOf(p.path)])
        .filter(path => !isEnvPath(path))
    },

    /** Look whose answer counts in `root` and which folder that is, and tell the backend what the user allowed there. */
    checkFolder(root: string): Promise<void> {
      if (isEnvPath(root)) return Promise.resolve()
      const look = (looking.get(root) ?? Promise.resolve()).then(async () => {
        const owner = ownerToFollow(root)
        const ask = async (project: string) => {
          const prefs = useWorkspace().projectPrefs[project]
          const allowed = prefs?.languageServers === true ? prefs.languageServersFolder ?? null : null
          return { owner, project, allowed, id: await call('lsp_folder', { root, project, allowed }) ?? null }
        }
        try {
          let found = await ask(owner)
          // No worktree of it (any more): what is there now is asked about for itself.
          if (!found.id && owner !== root) found = await ask(root)
          this.folders[root] = found
        } catch {
          this.folders[root] = { owner, project: root, id: null, allowed: null }
        }
      })
      looking.set(root, look)
      void look.finally(() => { if (looking.get(root) === look) looking.delete(root) })
      return look
    },

    /** The user's answer, for the folder they were asked about. */
    async setConsent(root: string, on: boolean) {
      const owner = ownerToFollow(root)
      if (this.folders[root]?.owner !== owner || !this.folders[root]?.id) await this.checkFolder(root)
      const seen = this.folders[root]
      if (!seen?.id || seen.owner !== owner) return
      // For what was looked at: a folder that is no worktree of the project answers for itself only.
      useWorkspace().setProjectPref(seen.project, { languageServers: on, languageServersFolder: seen.id })
      await this.checkFolder(root)
    },

    /** Keep `folders` right as projects, files and answers come and go. Once, as the workspace starts. */
    follow() {
      if (following) return
      following = true
      const ws = useWorkspace()
      const threads = useThreads()
      const files = useFiles()
      const git = useGit()
      const roots = () => [...new Set([
        ...ws.openProjects.map(p => p.path),
        ...(threads.workdir ? [threads.workdir] : []),
        ...Object.values(files.open).map(f => f.projectPath),
        ...Object.keys(this.sessions).map(key => key.slice(key.indexOf('\0') + 1)),
      ])].filter(root => !isEnvPath(root))
      const checkAll = () => {
        for (const root of roots()) void this.checkFolder(root)
      }
      watch(() => roots().map((root) => {
        const owner = ownerToFollow(root)
        // A clone or a checkout moves HEAD, and in a clone the folder may be new.
        return [root, owner, ...[root, owner].flatMap((path) => {
          const prefs = ws.projectPrefs[path]
          return [prefs?.languageServers, prefs?.languageServersFolder, git.status(path)?.head]
        })].join('\n')
      }).join('\0'), checkAll, { immediate: true })
      window.addEventListener('focus', checkAll)
      window.addEventListener('mango:files-changed', checkAll)
      // What is installed depends on whose folders don't count.
      watch(() => this.openRoots().join('\0'), () => { if (this.servers || this.loading) void this.load(true) })
    },
  },
})
