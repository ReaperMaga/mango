import { defineStore } from 'pinia'
import type { GitCommitDetail, GitGraphCommit } from '~/types/ipc'
import { call } from '~/composables/useBackend'
import { openDialog, toast } from '~/plugin-host/uiState'
import { useWorkspace } from '~/stores/workspace'
import { useThreads } from '~/stores/threads'
import { useGit } from '~/stores/git'
import { useFiles } from '~/stores/files'
import { GIT_LOG_TAB } from '~/utils/builtIns'
import { fileInFolder } from '~/utils/gitLog'
import { parseEnvPath } from '~/utils/envPath'
import { copyText } from '~/utils/clipboard'
import { baseName } from '~/utils/paths'

/** Tauri rejects with the Rust error string; the browser mock throws Errors. */
export const gitLogError = (e: unknown) =>
  (typeof e === 'string' ? e : e instanceof Error ? e.message : String(e)).trim() || 'Something went wrong'

/** The commit details read last. A hash's message and files never change; its refs do, so the log's rows bring their own. */
const details = new Map<string, GitCommitDetail>()
const DETAILS_KEPT = 60
const detailKey = (path: string, hash: string) => `${path}\u0001${hash}`

async function askText(title: string, placeholder: string, body?: string): Promise<string | null> {
  const answer = await openDialog({ kind: 'prompt', pluginId: null, title, placeholder, body }) as string | null
  return answer?.trim() || null
}

/**
 * What the Git log shares beyond its view (`useGitLogView`): a commit to show, asked for from a diff tab or
 * the palette, and what can be done to a commit. The actions live here because a toast's button may run
 * one after the log has closed.
 */
export const useGitLog = defineStore('gitLog', {
  state: () => ({
    /** A commit to show: the log of `path` takes it. */
    jump: null as { path: string; hash: string } | null,
    /** Bumped when an action here may have changed what the log shows. */
    revision: 0,
  }),

  actions: {
    open() {
      useWorkspace().openPanelTab(GIT_LOG_TAB)
    },

    show(path: string, hash: string) {
      this.jump = { path, hash }
      this.open()
    },

    /** "Go to commit…": a hash, branch or tag, typed. */
    async goToCommit() {
      const path = useThreads().workdir
      if (!path) return
      const rev = await askText('Go to commit', 'A hash, branch or tag')
      if (!rev) return
      try {
        const { commits } = await call('git_graph', { path, refs: [rev], skip: 0, limit: 1 })
        if (!commits[0]) throw new Error(`Nothing found for ${rev}`)
        this.show(path, commits[0].hash)
      } catch (e) {
        toast({ title: `Could not find ${rev}`, body: gitLogError(e), kind: 'warning' })
      }
    },

    cachedDetail(path: string, hash: string): GitCommitDetail | null {
      return details.get(detailKey(path, hash)) ?? null
    },

    async loadDetail(path: string, hash: string): Promise<GitCommitDetail> {
      const detail = this.cachedDetail(path, hash) ?? await call('git_commit_show', { path, hash })
      details.set(detailKey(path, hash), detail)
      if (details.size > DETAILS_KEPT) details.delete(details.keys().next().value!)
      return detail
    },

    async copy(text: string, what: string) {
      if (await copyText(text)) toast({ title: `Copied the ${what}`, kind: 'success', timeout: 1800 })
      else toast({ title: `Could not copy the ${what}`, kind: 'error' })
    },

    /** A commit's file as it is in the working copy at `path`, which may sit below the repository root. */
    async openFile(path: string, file: string) {
      try {
        const git = useGit()
        if (!git.status(path)?.root) await git.refresh(path)
        const root = git.status(path)?.root
        const folder = parseEnvPath(path)?.dir ?? path
        const inside = root ? fileInFolder(folder, root, file) : file
        if (inside === null) throw new Error(`It is outside ${baseName(folder)}, the folder open in Mango.`)
        await useFiles().openFile(path, inside, true)
      } catch (e) {
        toast({ title: `Could not open ${file}`, body: gitLogError(e), kind: 'error' })
      }
    },

    async afterChange(path: string) {
      this.revision++
      await useGit().refresh(path)
    },

    checkoutBranch(path: string, name: string, remote: boolean) {
      const to = remote ? `a local branch tracking ${name} (made if it doesn't exist yet)` : name
      useWorkspace().confirm = {
        title: `Check out ${name}?`,
        body: `Switches ${baseName(path)} to ${to}. Git stops if uncommitted changes would be overwritten.`,
        label: 'Check out',
        run: async () => {
          try {
            let now = name
            await useFiles().aroundChange([path], async () => {
              if (remote) now = await call('git_checkout_remote', { path, branch: name }) || name
              else await call('git_checkout', { path, branch: name, create: false })
            })
            toast({ title: `Switched to ${now}`, kind: 'success' })
          } catch (e) {
            toast({ title: `Could not check out ${name}`, body: gitLogError(e), kind: 'error', timeout: 0 })
          } finally {
            await this.afterChange(path)
          }
        },
      }
    },

    /** Check out one commit, leaving HEAD detached (no branch). */
    checkoutCommit(path: string, c: GitGraphCommit) {
      useWorkspace().confirm = {
        title: `Check out ${c.shortHash}?`,
        body: `Puts ${baseName(path)} on "${c.subject}" with no branch checked out (a detached HEAD). Commits made there belong to no branch until you start one. Git stops if uncommitted changes would be overwritten.`,
        label: 'Check out',
        run: async () => {
          try {
            await useFiles().aroundChange([path], () => call('git_checkout_commit', { path, hash: c.hash }))
            toast({
              title: `Checked out ${c.shortHash}`,
              body: 'HEAD is detached.',
              kind: 'success',
              action: { label: 'New branch here', run: () => void this.newBranchAt(path, c, true) },
            })
          } catch (e) {
            toast({ title: `Could not check out ${c.shortHash}`, body: gitLogError(e), kind: 'error', timeout: 0 })
          } finally {
            await this.afterChange(path)
          }
        },
      }
    },

    async newBranchAt(path: string, c: GitGraphCommit, checkout = false) {
      const name = await askText(
        'New branch',
        'feat/my-change',
        `Starts at ${c.shortHash}, "${c.subject}". ${checkout ? 'Switches to it.' : 'Your working copy stays where it is.'}`,
      )
      if (!name) return
      try {
        const create = () => call('git_branch_create', { path, name, from: c.hash, checkout })
        await (checkout ? useFiles().aroundChange([path], create) : create())
        toast(checkout
          ? { title: `Switched to ${name}`, kind: 'success' }
          : { title: `Created ${name}`, kind: 'success', action: { label: 'Check out', run: () => this.checkoutBranch(path, name, false) } })
      } catch (e) {
        toast({ title: `Could not create ${name}`, body: gitLogError(e), kind: 'error', timeout: 0 })
      } finally {
        await this.afterChange(path)
      }
    },
  },
})
