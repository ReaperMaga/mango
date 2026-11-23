import type { Thread } from '~/types/chat'
import { parseEnvPath } from '~/utils/envPath'
import type { EnvRemote, RemoteBackend } from './types'

/**
 * Chats of remote projects, kept inside their environment, so the phone and every computer that
 * opens the environment see the same ones. A port of the desktop's `app/utils/remoteChats.ts`
 * with the same semantics, so they interoperate: the phone's chat store stays the working copy
 * and this mirrors it both ways through `backend.chats*` (the desktop's `chats_remote_*`).
 *
 * Each copy there has a revision (when it was saved, ms). The phone remembers the revision it
 * last saw of each chat (`known`), so:
 * - push: a chat saved here is sent (debounced: an agent streams many changes, and a chat can be
 *   large) as a new revision, refused when the copy there moved on since `known` (another
 *   computer saved it; then that copy is fetched). A deleted chat leaves a mark there so other
 *   computers drop it.
 * - pull (`syncEnv`): the environment lists every chat's revision; only the ones newer than
 *   `known` are fetched, and chats deleted there are dropped here. A chat running here is left alone.
 * When both changed, the environment's copy wins, unless the chat is running here: then this
 * copy wins and replaces it (`claim`).
 *
 * Chats are stored there with their place written as `env://@/…`: the env's id differs from one
 * computer to the next (this phone has its own), so each puts its own back in.
 *
 * Pure of the app's singletons: `chatSync.ts` makes the one instance (over `backend` and
 * AsyncStorage); tests make their own. The state is read once before anything else happens (`ready`).
 */

const DEBOUNCE_MS = 3000
/** While an agent streams, send at least this often. */
const MAX_WAIT_MS = 15000
/** After a failed send (offline, environment stopped), wait this long before trying again. */
const RETRY_MS = 30000
const FETCH_CHUNK = 40
/** What must outlive a restart: revisions seen, and sends and deletes not done yet. */
const STORAGE_KEY = 'mango.envChats'
const SHARED = 'env://@'

interface State {
  /** Chat id -> the revision of it this phone last saw in its environment. */
  known: Record<string, number>
  /** Chats to send. */
  put: string[]
  /** Chats to delete there, and where. */
  remove: Record<string, EnvRemote>
}

export interface RemoteSource {
  byId: (id: string) => Thread | null
  threads: () => Thread[]
  /** The chat is running here: what the environment holds must not replace it. */
  busy: (t: Thread) => boolean
  /** Take these chats from the environment (new, or newer than here); returns them as stored here. */
  adopt: (threads: Thread[]) => Thread[]
  /** Chats deleted in the environment. */
  drop: (ids: string[]) => void
}

/** Where the state is kept (AsyncStorage's shape). */
export interface KeyValue {
  getItem(key: string): Promise<string | null>
  setItem(key: string, value: string): Promise<void>
}

export type ChatBackend = Pick<RemoteBackend, 'chatsList' | 'chatsFetch' | 'chatsPut' | 'chatsRemove'>

const envKey = (e: EnvRemote) => `${e.hostId}/${e.instance}`
const here = (e: EnvRemote) => `env://${e.hostId}/${e.instance}`

/** The environment a chat's project is in; null for anything else. */
export function envOf(path: string | null | undefined): EnvRemote | null {
  const loc = parseEnvPath(path)
  return loc ? { hostId: loc.hostId, instance: loc.instance } : null
}

/** A chat's JSON as the environment keeps it: this phone's id for the env taken out. */
export function toShared(json: string, e: EnvRemote): string {
  const p = here(e)
  return json.split(`${p}/`).join(`${SHARED}/`).split(`${p}"`).join(`${SHARED}"`)
}

/** The other way: the shared form with this phone's place for the environment put in. */
export function fromShared(json: string, e: EnvRemote): string {
  const p = here(e)
  return json.split(`${SHARED}/`).join(`${p}/`).split(`${SHARED}"`).join(`${p}"`)
}

/** A chat from the environment, if it is one and belongs there (never a place elsewhere). */
export function parseShared(json: string, e: EnvRemote): Thread | null {
  try {
    const t = JSON.parse(fromShared(json, e)) as Thread
    if (!t || typeof t.id !== 'string' || !Array.isArray(t.messages) || typeof t.updatedAt !== 'number') return null
    const inside = (p: unknown) => typeof p === 'string' && envOf(p) !== null && envKey(envOf(p)!) === envKey(e)
    if (!inside(t.projectPath)) return null
    if (t.worktree != null && !inside(t.worktree)) return null
    return t
  } catch {
    return null
  }
}

/** Saved state, tolerating anything an older build (or a damaged store) left. */
export function readState(raw: string | null): State {
  try {
    const v = JSON.parse(raw || 'null')
    if (v && typeof v === 'object') {
      return {
        known: v.known && typeof v.known === 'object' ? v.known : {},
        put: Array.isArray(v.put) ? v.put.filter((x: unknown) => typeof x === 'string') : [],
        remove: v.remove && typeof v.remove === 'object' ? v.remove : {},
      }
    }
  } catch { /* start over: everything is compared again on the next sync */ }
  return { known: {}, put: [], remove: {} }
}

export interface ChatSync {
  attachRemoteChats(s: RemoteSource): Promise<void>
  noteSaved(changed: Thread[], removed: { id: string; projectPath: string }[]): void
  flushRemoteChats(): Promise<void>
  syncEnv(env: EnvRemote): Promise<void>
}

/** The mirror over `chats` (the backend) with its state in `storage`. One per app; tests make their own. */
export function createChatSync(chats: ChatBackend, storage: KeyValue): ChatSync {
  let source: RemoteSource | null = null
  let state: State = { known: {}, put: [], remove: {} }
  /** Each chat's JSON as the environment last got it from here or gave it (this session only). */
  const sent = new Map<string, string>()
  let timer: ReturnType<typeof setTimeout> | null = null
  let firstChangeAt = 0
  let flushing: Promise<void> | null = null
  const syncing = new Map<string, Promise<void>>()
  const reported = new Set<string>()
  /** A revision newer than the last one seen, and than any this phone made before. */
  let lastRev = 0

  const ready: Promise<void> = storage.getItem(STORAGE_KEY)
    .then((raw) => { state = readState(raw) })
    .catch(() => { /* storage unavailable: start empty */ })

  function write() {
    storage.setItem(STORAGE_KEY, JSON.stringify(state)).catch(() => { /* storage unavailable */ })
  }

  function report(e: EnvRemote, what: string, err: unknown) {
    const key = `${envKey(e)} ${what}`
    if (reported.has(key)) return
    reported.add(key)
    console.warn(`Mango could not ${what} the chats kept in ${e.instance}:`, err)
  }

  function schedule(wait?: number) {
    const now = Date.now()
    if (!timer) firstChangeAt = now
    else clearTimeout(timer)
    const delay = wait ?? Math.max(0, Math.min(DEBOUNCE_MS, firstChangeAt + MAX_WAIT_MS - now))
    timer = setTimeout(() => { timer = null; void flushRemoteChats() }, delay)
  }

  function nextRev(base: number) {
    lastRev = Math.max(Date.now(), base + 1, lastRev + 1)
    return lastRev
  }

  /** Start mirroring once the saved state is read; sends left over from last time go out soon. */
  async function attachRemoteChats(s: RemoteSource) {
    await ready
    source = s
    if (state.put.length || Object.keys(state.remove).length) schedule()
  }

  /** Chats saved locally just now: the remote projects' ones go to their environment. */
  function noteSaved(changed: Thread[], removed: { id: string; projectPath: string }[]) {
    // Serialised now: the chat may change again before the state is read.
    const jsons = changed.map(t => [t, JSON.stringify(t)] as const)
    const apply = () => {
      let any = false
      for (const [t, json] of jsons) {
        if (!envOf(t.projectPath) || sent.get(t.id) === json) continue
        if (!state.put.includes(t.id)) state.put.push(t.id)
        any = true
      }
      for (const r of removed) {
        const env = envOf(r.projectPath)
        if (!env) continue
        state.remove[r.id] = env
        state.put = state.put.filter(id => id !== r.id)
        sent.delete(r.id)
        any = true
      }
      if (any) { write(); schedule() }
    }
    void ready.then(apply)
  }

  /** Send what is pending now: deletes first, then changed chats, one at a time. */
  function flushRemoteChats(): Promise<void> {
    if (timer) { clearTimeout(timer); timer = null }
    if (flushing) return flushing
    flushing = (async () => {
      await ready
      let failed = false
      const byEnv = new Map<string, { env: EnvRemote; ids: string[] }>()
      for (const [id, env] of Object.entries(state.remove)) {
        const key = envKey(env)
        if (!byEnv.has(key)) byEnv.set(key, { env, ids: [] })
        byEnv.get(key)!.ids.push(id)
      }
      for (const { env, ids } of byEnv.values()) {
        try {
          await chats.chatsRemove(env, ids)
          for (const id of ids) { delete state.remove[id]; delete state.known[id] }
          write()
        } catch (e) { failed = true; report(env, 'delete', e) }
      }
      const stale = new Map<string, EnvRemote>()
      for (const id of [...state.put]) {
        const t = source?.byId(id)
        const env = envOf(t?.projectPath)
        const done = () => { state.put = state.put.filter(x => x !== id); write() }
        if (!t || !env) { done(); continue }
        const json = JSON.stringify(t)
        if (sent.get(id) === json) { done(); continue }
        const base = state.known[id] ?? 0
        const rev = nextRev(base)
        try {
          const answer = await chats.chatsPut(env, id, base, rev, toShared(json, env))
          // Refused while it runs here: it stays queued, and the pull below lets this copy win (`claim`).
          const keep = answer === 'stale' && !!source?.busy(source.byId(id) ?? t)
          // Changed again while it was sent: it stays in the list for the next round.
          if (!keep && JSON.stringify(source?.byId(id)) === json) done()
          if (answer === 'ok') { state.known[id] = rev; sent.set(id, json); write() }
          else if (answer === 'gone') { if (!source?.busy(t)) source?.drop([id]) }
          else stale.set(envKey(env), env)
        } catch (e) {
          failed = true
          report(env, 'save', e)
        }
      }
      // Another computer saved a newer copy: fetch it.
      for (const env of stale.values()) void syncEnv(env)
      if (failed) schedule(RETRY_MS)
      else if (state.put.length) schedule()
    })().finally(() => { flushing = null })
    return flushing
  }

  /**
   * A newer copy of a chat running here: this one wins. Its revision counts as seen, so the next
   * send replaces it rather than being refused as stale for as long as the run goes on (which kept
   * the other computers on the old copy, and then gave the old copy back here when the run ended).
   */
  function claim(id: string, rev: number) {
    state.known[id] = Math.max(rev, state.known[id] ?? 0)
    sent.delete(id)
    if (!state.put.includes(id)) state.put.push(id)
  }

  /**
   * Bring this phone's chats of an environment up to date with the copy kept there, and send
   * there what it lacks. Calls for the same environment share one run.
   */
  function syncEnv(env: EnvRemote): Promise<void> {
    const key = envKey(env)
    const running = syncing.get(key)
    if (running) return running
    const run = (async () => {
      await ready
      const s = source
      if (!s) return
      let list
      try {
        list = await chats.chatsList(env)
      } catch (e) {
        report(env, 'read', e)
        return
      }
      const there = new Map(list.map(x => [x.id, x.rev]))
      const drop: string[] = []
      const fetch: string[] = []
      for (const { id, rev } of list) {
        if (state.remove[id]) continue
        const local = s.byId(id)
        if (rev === null) {
          if (local && !s.busy(local)) drop.push(id)
          delete state.known[id]
          continue
        }
        if (!local) fetch.push(id)
        else if (rev > (state.known[id] ?? 0)) {
          if (s.busy(local)) claim(id, rev)
          else fetch.push(id)
        }
      }
      if (drop.length) {
        for (const id of drop) sent.delete(id)
        state.put = state.put.filter(id => !drop.includes(id))
        s.drop(drop)
      }
      for (let i = 0; i < fetch.length; i += FETCH_CHUNK) {
        let jsons: string[]
        try {
          jsons = await chats.chatsFetch(env, fetch.slice(i, i + FETCH_CHUNK))
        } catch (e) {
          report(env, 'read', e)
          break
        }
        const incoming: Thread[] = []
        for (const json of jsons) {
          const t = parseShared(json, env)
          // Checked again: it may have started running, or been deleted, while this was fetched.
          const local = t && s.byId(t.id)
          if (!t || state.remove[t.id]) continue
          if (local && s.busy(local)) claim(t.id, there.get(t.id) ?? 0)
          else incoming.push(t)
        }
        for (const t of s.adopt(incoming)) {
          sent.set(t.id, JSON.stringify(t))
          state.known[t.id] = there.get(t.id) ?? 0
          state.put = state.put.filter(id => id !== t.id)
        }
      }
      // What the environment lacks: chats made here, or here before they were mirrored.
      for (const t of s.threads()) {
        const at = envOf(t.projectPath)
        if (!at || envKey(at) !== key || state.remove[t.id] || there.has(t.id)) continue
        delete state.known[t.id]
        sent.delete(t.id)
        if (!state.put.includes(t.id)) state.put.push(t.id)
      }
      write()
      if (state.put.length || Object.keys(state.remove).length) schedule()
    })().finally(() => { syncing.delete(key) })
    syncing.set(key, run)
    return run
  }

  return { attachRemoteChats, noteSaved, flushRemoteChats, syncEnv }
}
