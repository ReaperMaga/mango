import { defineStore } from 'pinia'
import type { UpdateInfo, UpdateProgress } from '~/types/ipc'
import { call, on } from '~/composables/useBackend'

/**
 * Self-update from GitHub releases. Checks shortly after launch and then every
 * hour (unless turned off in Settings > General); installing restarts Mango.
 * The backend (src-tauri/src/updater.rs) reads the latest release's latest.json.
 */

export type UpdatePhase = 'idle' | 'checking' | 'available' | 'downloading' | 'restarting' | 'error'

const KEY = 'mango.updates'
const FIRST_CHECK_MS = 4_000
const CHECK_EVERY_MS = 60 * 60 * 1000

function loadPrefs(): { autoCheck?: boolean } {
  try { return JSON.parse(localStorage.getItem(KEY) ?? '{}') ?? {} } catch { return {} }
}

/** Tauri rejects with the backend's message; a thrown Error stringifies as "Error: …". */
const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

let timer: ReturnType<typeof setInterval> | undefined
let firstTimer: ReturnType<typeof setTimeout> | undefined
let unlisten: (() => void) | undefined

export const useUpdater = defineStore('updater', {
  state: () => ({
    phase: 'idle' as UpdatePhase,
    /** The newer release, once a check found one. */
    update: null as UpdateInfo | null,
    progress: null as UpdateProgress | null,
    error: null as string | null,
    /** Whether the last error came from installing (as opposed to checking). */
    installFailed: false,
    lastChecked: null as number | null,
    autoCheck: loadPrefs().autoCheck ?? true,
    started: false,
  }),

  getters: {
    available: s => s.update !== null,
    busy: s => s.phase === 'checking' || s.phase === 'downloading' || s.phase === 'restarting',
    /** 0..1 while downloading, null when the size is unknown. */
    fraction: (s): number | null => {
      const p = s.progress
      if (!p || !p.total) return null
      return Math.min(1, p.downloaded / p.total)
    },
  },

  actions: {
    /** Called once when the app mounts. */
    start() {
      if (this.started) return
      this.started = true
      // Running from source, a check would offer the released build: only check when asked.
      if (import.meta.dev) return
      this.schedule()
    },

    schedule() {
      clearTimeout(firstTimer)
      clearInterval(timer)
      if (!this.autoCheck) return
      firstTimer = setTimeout(() => this.check(), FIRST_CHECK_MS)
      timer = setInterval(() => this.check(), CHECK_EVERY_MS)
    },

    setAutoCheck(on: boolean) {
      this.autoCheck = on
      try { localStorage.setItem(KEY, JSON.stringify({ autoCheck: on })) } catch { /* not persisted */ }
      if (!import.meta.dev) this.schedule()
    },

    /** `manual` checks report errors; background checks stay quiet and try again next hour. */
    async check(manual = false) {
      if (this.busy) return
      const before = this.phase
      this.phase = 'checking'
      try {
        this.update = await call('update_check')
        this.lastChecked = Date.now()
        this.error = null
        this.installFailed = false
        this.phase = this.update ? 'available' : 'idle'
      } catch (e) {
        if (manual) {
          this.error = message(e)
          this.installFailed = false
          this.phase = 'error'
        } else {
          this.phase = before === 'checking' ? 'idle' : before
        }
      }
    },

    /** Download, install and restart. Only resolves if something went wrong. */
    async install() {
      if (!this.update || this.busy) return
      this.phase = 'downloading'
      this.progress = { downloaded: 0, total: null }
      this.error = null
      unlisten?.()
      unlisten = await on('update://progress', p => {
        this.progress = p
        if (p.total && p.downloaded >= p.total) this.phase = 'restarting'
      })
      try {
        await call('update_install')
        this.phase = 'restarting'
      } catch (e) {
        this.error = message(e)
        this.installFailed = true
        this.phase = 'error'
      } finally {
        unlisten?.()
        unlisten = undefined
      }
    },
  },
})
