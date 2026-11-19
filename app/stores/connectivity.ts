import { defineStore } from 'pinia'
import { call, isTauri, on } from '~/composables/useBackend'
import { parseEnvPath } from '~/utils/envPath'
import { connectionBack, envOf, syncEnv } from '~/utils/remoteChats'
import { useWorkspace } from '~/stores/workspace'
import { useThreads } from '~/stores/threads'
import { useUpdater } from '~/stores/updater'
import { useLinks } from '~/stores/links'

/**
 * Which remote environments' servers Mango can reach right now, and what to do when one comes back.
 *
 * A server is marked down by what notices a drop first: an agent run that lost its connection
 * (`agent://connection`), a remote terminal whose `ssh` ended with 255, or the window going
 * offline. Then it is checked with one cheap SSH call (`env_ping`), after 3 s and then less
 * often (up to every 30 s), and at once when the window goes online or comes to the front.
 * When it answers, whatever the drop broke picks up again (`revive`): runs reattach now, remote
 * terminals start a fresh shell (they watch `backAt`), the chats kept there are sent and read,
 * and the open projects' changes and files are read again. Projects on this computer only care
 * about the network as a whole: when the window goes online, failed pull request reads and a
 * missed update check go again.
 */

const FIRST_CHECK_MS = 3_000
const MAX_CHECK_MS = 30_000

/** Per host: the next check, and how many came back negative in a row. */
const checks = new Map<string, { timer: ReturnType<typeof setTimeout> | null; misses: number; running: boolean }>()
let offs: Array<() => void> = []

export const useConnectivity = defineStore('connectivity', {
  state: () => ({
    /** The window's own idea of the network (`navigator.onLine`). */
    online: typeof navigator === 'undefined' ? true : navigator.onLine,
    /** Servers out of reach, by host id: since when. */
    down: {} as Record<string, number>,
    /** When each server last came back, by host id: what waits on it (terminals) watches this. */
    backAt: {} as Record<string, number>,
  }),

  getters: {
    isDown: s => (hostId: string) => hostId in s.down,
  },

  actions: {
    /** Called once when the app mounts; `stop` undoes it. */
    async start() {
      if (offs.length) return
      const onOnline = () => this.windowOnline()
      const onOffline = () => this.windowOffline()
      const onFocus = () => this.checkAll()
      window.addEventListener('online', onOnline)
      window.addEventListener('offline', onOffline)
      window.addEventListener('focus', onFocus)
      offs.push(
        () => window.removeEventListener('online', onOnline),
        () => window.removeEventListener('offline', onOffline),
        () => window.removeEventListener('focus', onFocus),
      )
      if (!isTauri()) return
      offs.push(await on('agent://connection', (e) => {
        if (e.state === 'lost') this.markDown(e.hostId)
        // The run found its way back by itself: the server is reachable.
        else if (e.hostId in this.down) this.markBack(e.hostId)
      }))
    },

    stop() {
      offs.splice(0).forEach(off => off())
      for (const c of checks.values()) if (c.timer) clearTimeout(c.timer)
      checks.clear()
    },

    /** Something noticed `hostId` dropped: check it until it answers. */
    markDown(hostId: string) {
      if (!(hostId in this.down)) this.down[hostId] = Date.now()
      const c = checks.get(hostId)
      if (c?.timer || c?.running) return
      this._schedule(hostId, FIRST_CHECK_MS)
    },

    _schedule(hostId: string, wait: number) {
      const c = checks.get(hostId) ?? { timer: null, misses: 0, running: false }
      checks.set(hostId, c)
      if (c.timer) clearTimeout(c.timer)
      c.timer = setTimeout(() => { c.timer = null; void this.check(hostId) }, wait)
    },

    /** Ask `hostId` now (once at a time); back up, or try again later. */
    async check(hostId: string) {
      if (!(hostId in this.down)) return
      const c = checks.get(hostId) ?? { timer: null, misses: 0, running: false }
      checks.set(hostId, c)
      if (c.running) return
      if (c.timer) { clearTimeout(c.timer); c.timer = null }
      // No network at all: wait for the window's `online`, which checks every server at once.
      if (!this.online) return
      c.running = true
      let up = false
      try {
        up = await call('env_ping', { hostId })
      } catch {
        // The server is no longer saved: nothing to wait for.
        delete this.down[hostId]
        checks.delete(hostId)
        return
      } finally {
        c.running = false
      }
      if (!(hostId in this.down)) return
      if (up) {
        this.markBack(hostId)
        return
      }
      c.misses++
      this._schedule(hostId, Math.min(MAX_CHECK_MS, FIRST_CHECK_MS * 2 ** c.misses))
    },

    /** Check every server marked down, now. */
    checkAll() {
      for (const hostId of Object.keys(this.down)) void this.check(hostId)
    },

    /** `hostId` answers again: pick up everything the drop broke. */
    markBack(hostId: string) {
      delete this.down[hostId]
      const c = checks.get(hostId)
      if (c?.timer) clearTimeout(c.timer)
      checks.delete(hostId)
      this.backAt[hostId] = Date.now()
      void this.revive(hostId)
    },

    async revive(hostId: string) {
      if (isTauri()) {
        // Runs waiting to reattach go now; the browser tools' way back is made again.
        call('agent_reconnect_now', { hostId }).catch(() => {})
      }
      const ws = useWorkspace()
      const threads = useThreads()
      // The folders on screen in that server's environments: open projects, and the chat's worktree.
      const paths = new Set(ws.openProjects.map(p => p.path).concat(threads.workdir ?? [])
        .filter(p => parseEnvPath(p)?.hostId === hostId))
      // Chats kept in those environments: send what waits, then read what changed there meanwhile.
      await connectionBack(hostId).catch(() => {})
      const envs = new Map([...paths].map(p => envOf(p)).filter(e => !!e).map(e => [`${e!.hostId}/${e!.instance}`, e!]))
      for (const e of envs.values()) void syncEnv(e)
      if (!paths.size) return
      const [{ useGit }, { useFiles }] = await Promise.all([import('~/stores/git'), import('~/stores/files')])
      const git = useGit()
      const files = useFiles()
      for (const p of paths) {
        void git.refresh(p).catch(() => {})
        if (files.trees[p]) void files.refresh(p).catch(() => {})
      }
    },

    windowOffline() {
      this.online = false
      // Every server in use is out of reach now; each is checked when the window is online again.
      const hosts = new Set(useWorkspace().openProjects.map(p => parseEnvPath(p.path)?.hostId).filter(h => !!h))
      for (const hostId of hosts) if (!(hostId! in this.down)) this.down[hostId!] = Date.now()
    },

    windowOnline() {
      this.online = true
      for (const c of checks.values()) c.misses = 0
      this.checkAll()
      // Nothing of this computer's own projects needs a server of ours: only GitHub and the updater.
      useLinks().retryFailed()
      useUpdater().recheck()
    },
  },
})
