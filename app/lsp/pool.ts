/**
 * One session per server and project folder, shared by its files: started when the first needs it,
 * stopped a while after the last is gone, and at once when it is no longer allowed.
 */

export interface PoolKey<S extends string = string> { server: S; root: string }

export const poolKey = ({ server, root }: PoolKey) => `${server}\0${root}`

/** Long enough to close one tab and open the next without indexing the project again. */
export const IDLE_MS = 120_000

interface Pooled {
  start(): Promise<void>
  stop(now?: boolean): Promise<void>
}

export interface PoolHost<S extends string, T extends Pooled> {
  create(key: PoolKey<S>): T
  allowed(key: PoolKey<S>): boolean
  idleMs?: number
}

export class Pool<S extends string, T extends Pooled> {
  private host: PoolHost<S, T>
  private entries = new Map<string, { key: PoolKey<S>; session: T; timer?: ReturnType<typeof setTimeout> }>()

  constructor(host: PoolHost<S, T>) {
    this.host = host
  }

  get(key: PoolKey<S>): T | null {
    return this.entries.get(poolKey(key))?.session ?? null
  }

  all() {
    return [...this.entries.values()]
  }

  /** `wanted`: what the open files need now. */
  update(wanted: Iterable<PoolKey<S>>) {
    const need = new Map<string, PoolKey<S>>()
    for (const key of wanted) if (this.host.allowed(key)) need.set(poolKey(key), key)
    for (const [id, entry] of this.entries) {
      if (!this.host.allowed(entry.key)) {
        this.remove(id, true)
      } else if (need.has(id)) {
        clearTimeout(entry.timer)
        entry.timer = undefined
      } else {
        entry.timer ??= setTimeout(() => this.remove(id), this.host.idleMs ?? IDLE_MS)
      }
    }
    for (const [id, key] of need) {
      if (this.entries.has(id)) continue
      const session = this.host.create(key)
      this.entries.set(id, { key, session })
      void session.start()
    }
  }

  stopAll() {
    for (const id of [...this.entries.keys()]) this.remove(id, true)
  }

  private remove(id: string, now = false) {
    const entry = this.entries.get(id)
    if (!entry) return
    this.entries.delete(id)
    clearTimeout(entry.timer)
    void entry.session.stop(now)
  }
}
