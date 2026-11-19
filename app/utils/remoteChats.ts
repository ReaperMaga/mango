import { call } from '~/composables/useBackend'
import type { Thread } from '~/types/chat'
import type { EnvRemote } from '~/types/ipc'
import { parseEnvPath } from '~/utils/envPath'

/**
 * Chats of remote projects, kept inside their environment too (`chats_remote_*`), so every
 * computer that opens the environment sees them. The local chat history stays the working
 * copy (`chatHistory.ts`); this mirrors it both ways.
 *
 * Each copy there has a revision (when it was saved, ms). This computer remembers the revision
 * it last saw of each chat (`known`), so:
 * - push: a remote project's chat saved locally is sent (debounced: an agent streams many
 *   changes, and a chat can be large) as a new revision, refused when the copy there moved on
 *   since `known` (another computer saved it; then that copy is fetched). A deleted chat leaves
 *   a mark there so other computers drop it.
 * - pull (`syncEnv`): the environment lists every chat's revision; only the ones newer than
 *   `known` are fetched, and chats deleted there are dropped here. A chat running here is left alone.
 * When both changed, the environment's copy wins, unless the chat is running here.
 *
 * Chats are stored there with their place written as `env://@/…`: the server's id differs from
 * one computer to the next (a joined environment has its own), so each puts its own back in.
 *
 * Mango's windows (`utils/windows.ts`) share what is kept in localStorage: each window writes back
 * only the entries it changed (`write`), so one window never undoes another's, and chats a window
 * hands to another are let go without touching what is stored for them (`forgetRemote`).
 */

const DEBOUNCE_MS = 3000
/** While an agent streams, send at least this often. */
const MAX_WAIT_MS = 15000
/** After a failed send (offline, environment stopped), wait this long before trying again. */
const RETRY_MS = 30000
const FETCH_CHUNK = 40
/** What must outlive a restart: revisions seen, and sends and deletes not done yet. */
const LS_KEY = 'mango.envChats'
const SHARED = 'env://@'

interface State {
  /** Chat id -> the revision of it this computer last saw in its environment. */
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

let source: RemoteSource | null = null
let state: State = read()
/** What this window last read or wrote to storage: `write` sends only what differs from it. */
let stored: State = clone(state)
/** Each chat's JSON as the environment last got it from here or gave it (this session only). */
const sent = new Map<string, string>()
let timer: ReturnType<typeof setTimeout> | null = null
let firstChangeAt = 0
let flushing: Promise<void> | null = null
const syncing = new Map<string, Promise<void>>()
const reported = new Set<string>()

const envKey = (e: EnvRemote) => `${e.hostId}/${e.instance}`
const here = (e: EnvRemote) => `env://${e.hostId}/${e.instance}`

function read(): State {
  try {
    const raw = JSON.parse(globalThis.localStorage?.getItem(LS_KEY) || 'null')
    if (raw && typeof raw === 'object') {
      return {
        known: raw.known && typeof raw.known === 'object' ? raw.known : {},
        put: Array.isArray(raw.put) ? raw.put.filter((x: unknown) => typeof x === 'string') : [],
        remove: raw.remove && typeof raw.remove === 'object' ? raw.remove : {},
      }
    }
  } catch { /* start over: everything is compared again on the next sync */ }
  return { known: {}, put: [], remove: {} }
}

function clone(s: State): State {
  return { known: { ...s.known }, put: [...s.put], remove: { ...s.remove } }
}

/** Write back the entries this window changed since it last wrote; other windows' stay as they are. */
function write() {
  try {
    const disk = read()
    const ids = new Set([...Object.keys(state.known), ...Object.keys(stored.known), ...state.put, ...stored.put,
      ...Object.keys(state.remove), ...Object.keys(stored.remove)])
    for (const id of ids) {
      if (state.known[id] !== stored.known[id]) {
        if (id in state.known) disk.known[id] = state.known[id]!
        else delete disk.known[id]
      }
      const putNow = state.put.includes(id)
      if (putNow !== stored.put.includes(id)) {
        if (putNow && !disk.put.includes(id)) disk.put.push(id)
        else if (!putNow) disk.put = disk.put.filter(x => x !== id)
      }
      if (JSON.stringify(state.remove[id]) !== JSON.stringify(stored.remove[id])) {
        if (state.remove[id]) disk.remove[id] = state.remove[id]!
        else delete disk.remove[id]
      }
    }
    localStorage.setItem(LS_KEY, JSON.stringify(disk))
    stored = clone(state)
  } catch { /* storage unavailable */ }
}

/** Not this window's chats (any more): leave them to the window that holds them, and what is stored for them as it is. */
export function forgetRemote(ids: Iterable<string>) {
  const gone = new Set(ids)
  for (const s of [state, stored]) {
    s.put = s.put.filter(id => !gone.has(id))
    for (const id of gone) { delete s.known[id]; delete s.remove[id] }
  }
  for (const id of gone) sent.delete(id)
}

/** Chats this window takes over from another: pick up what is stored for them (revisions seen, sends still due). */
export function adoptRemote(ids: Iterable<string>) {
  const disk = read()
  let due = false
  for (const id of ids) {
    for (const s of [state, stored]) {
      if (id in disk.known) s.known[id] = disk.known[id]!
      if (disk.put.includes(id) && !s.put.includes(id)) s.put.push(id)
      if (disk.remove[id]) s.remove[id] = disk.remove[id]!
    }
    due ||= disk.put.includes(id) || !!disk.remove[id]
  }
  if (due && source) schedule()
}

/** The environment a chat's project is in; null for a folder on this computer. */
export function envOf(path: string | null | undefined): EnvRemote | null {
  const loc = parseEnvPath(path)
  return loc ? { hostId: loc.hostId, instance: loc.instance } : null
}

/** A chat's JSON as the environment keeps it: this computer's id for the server taken out. */
export function toShared(json: string, e: EnvRemote): string {
  const p = here(e)
  return json.split(`${p}/`).join(`${SHARED}/`).split(`${p}"`).join(`${SHARED}"`)
}

/** The other way: the shared form with this computer's place for the environment put in. */
export function fromShared(json: string, e: EnvRemote): string {
  const p = here(e)
  return json.split(`${SHARED}/`).join(`${p}/`).split(`${SHARED}"`).join(`${p}"`)
}

/** A chat from the environment, if it is one and belongs there (never a folder on this computer). */
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

function report(e: EnvRemote, what: string, err: unknown) {
  const key = `${envKey(e)} ${what}`
  if (reported.has(key)) return
  reported.add(key)
  console.warn(`Mango could not ${what} the chats kept in ${e.instance}:`, err)
}

/**
 * The connection to `hostId` is back: failures from now on are worth a warning again (each is
 * reported once), and what waits to be sent goes now rather than at the end of its retry wait.
 */
export function connectionBack(hostId: string): Promise<void> {
  for (const key of [...reported]) if (key.startsWith(`${hostId}/`)) reported.delete(key)
  return flushRemoteChats()
}

/** Start mirroring; sends left over from last time go out soon. */
export function attachRemoteChats(s: RemoteSource) {
  source = s
  if (state.put.length || Object.keys(state.remove).length) schedule()
}

/** Chats saved locally just now (`chatHistory.ts`): the remote projects' ones go to their environment. */
export function noteSaved(changed: Thread[], removed: { id: string; projectPath: string }[]) {
  let any = false
  for (const t of changed) {
    if (!envOf(t.projectPath) || sent.get(t.id) === JSON.stringify(t)) continue
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

function schedule(wait?: number) {
  const now = Date.now()
  if (!timer) firstChangeAt = now
  else clearTimeout(timer)
  const delay = wait ?? Math.max(0, Math.min(DEBOUNCE_MS, firstChangeAt + MAX_WAIT_MS - now))
  timer = setTimeout(() => { timer = null; void flushRemoteChats() }, delay)
}

/** A revision newer than the last one seen, and than any this computer made before. */
let lastRev = 0
function nextRev(base: number) {
  lastRev = Math.max(Date.now(), base + 1, lastRev + 1)
  return lastRev
}

/** Send what is pending now: deletes first, then changed chats, one at a time. */
export function flushRemoteChats(): Promise<void> {
  if (timer) { clearTimeout(timer); timer = null }
  if (flushing) return flushing
  flushing = (async () => {
    let failed = false
    const byEnv = new Map<string, { env: EnvRemote; ids: string[] }>()
    for (const [id, env] of Object.entries(state.remove)) {
      const key = envKey(env)
      if (!byEnv.has(key)) byEnv.set(key, { env, ids: [] })
      byEnv.get(key)!.ids.push(id)
    }
    for (const { env, ids } of byEnv.values()) {
      try {
        await call('chats_remote_remove', { ...env, ids })
        for (const id of ids) { delete state.remove[id]; delete state.known[id] }
        write()
      } catch (e) { failed = true; report(env, 'delete', e) }
    }
    const stale = new Map<string, EnvRemote>()
    for (const id of [...state.put]) {
      const t = source?.byId(id)
      const env = envOf(t?.projectPath)
      const done = () => { state.put = state.put.filter(x => x !== id); write() }
      // Not held here: another window's (deleted ones went through `state.remove` above).
      if (!t) { forgetRemote([id]); continue }
      if (!env) { done(); continue }
      const json = JSON.stringify(t)
      if (sent.get(id) === json) { done(); continue }
      const base = state.known[id] ?? 0
      const rev = nextRev(base)
      try {
        const answer = await call('chats_remote_put', { ...env, id, base, rev, data: toShared(json, env) })
        // Changed again while it was sent: it stays in the list for the next round.
        if (JSON.stringify(source?.byId(id)) === json) done()
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
 * Bring this computer's chats of an environment up to date with the copy kept there, and send
 * there what it lacks. Calls for the same environment share one run.
 */
export function syncEnv(env: EnvRemote): Promise<void> {
  const key = envKey(env)
  const running = syncing.get(key)
  if (running) return running
  const run = (async () => {
    const s = source
    if (!s) return
    let list
    try {
      list = await call('chats_remote_list', env)
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
      else if (rev > (state.known[id] ?? 0) && !s.busy(local)) fetch.push(id)
    }
    if (drop.length) {
      for (const id of drop) sent.delete(id)
      state.put = state.put.filter(id => !drop.includes(id))
      s.drop(drop)
    }
    for (let i = 0; i < fetch.length; i += FETCH_CHUNK) {
      let jsons: string[]
      try {
        jsons = await call('chats_remote_fetch', { ...env, ids: fetch.slice(i, i + FETCH_CHUNK) })
      } catch (e) {
        report(env, 'read', e)
        break
      }
      const incoming: Thread[] = []
      for (const json of jsons) {
        const t = parseShared(json, env)
        // Checked again: it may have started running, or been deleted, while this was fetched.
        const local = t && s.byId(t.id)
        if (t && !(local && s.busy(local)) && !state.remove[t.id]) incoming.push(t)
      }
      for (const t of s.adopt(incoming)) {
        sent.set(t.id, JSON.stringify(t))
        state.known[t.id] = there.get(t.id) ?? 0
        state.put = state.put.filter(id => id !== t.id)
      }
    }
    // What the environment lacks: chats made here, or here before this feature.
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
