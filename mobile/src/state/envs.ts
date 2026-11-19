import AsyncStorage from '@react-native-async-storage/async-storage'
import { randomUUID } from 'expo-crypto'
import { create } from 'zustand'
import { ssh } from '@/ssh'
import type { HostKeyInfo } from '@/ssh/types'
import { backend } from '@/remote'
import { MOCK_ENVS } from '@/remote/mockBackend'
import { checkNotExpired, decode, envFromToken, pickName, preview, type JoinPreview } from '@/remote/shareLink'
import { hasControl, validEnvId, validRemote, validSshDest } from '@/remote/shell'
import type { Env, Instance, RemoteProject } from '@/remote/types'

/**
 * The environments saved on this phone (the desktop's `EnvHost` list): joined from a share link,
 * or servers added by hand. The list lives in AsyncStorage; private keys never do: each env's
 * key is in the Keychain behind `endpoint.keyId`, handled only by `ssh`.
 *
 * Also per env: whether it answers (`status`), its instances and their projects, read through
 * `backend` on `refresh`. The preview (`!backend.real`) starts with the simulation's envs.
 */

const STORAGE_KEY = 'mango.envs'

/**
 * `reconnecting`: it answered before, then a run or a command lost its connection to it, and
 * Mango is trying again (runs there keep working). Cleared by the next thing that reaches it.
 */
export type ConnState = 'unknown' | 'checking' | 'ok' | 'error' | 'reconnecting'

export interface EnvStatus {
  state: ConnState
  /** Why it failed, in words a person can act on. */
  message: string | null
}

/** A server about to be added: what the user must see before trusting it. */
export interface ServerDraft {
  /** Saved by `trustServer` as it is. */
  env: Env
  /** `ssh-ed25519 AAAA… comment`: the line to put in the server's `~/.ssh/authorized_keys`. */
  publicKey: string
  /** The key the server presented: confirm its fingerprint before trusting it. */
  hostKey: HostKeyInfo
}

export interface NewServer {
  name?: string
  /** `user@host` */
  ssh: string
  port?: number | null
  /** The Incus remote on the server holding the instances; empty for its default. */
  incusRemote?: string | null
}

export interface EnvsState {
  loaded: boolean
  envs: Env[]
  status: Record<string, EnvStatus>
  /** By env id. */
  instances: Record<string, Instance[]>
  /** By `projectsKey(envId, instance)`. */
  projects: Record<string, RemoteProject[]>
  /** Why an instance's projects could not be listed, by `projectsKey`. */
  projectErrors: Record<string, string>

  load(): Promise<void>
  byId(id: string): Env | null
  /** What a link would join (throws a readable message for a bad link). */
  previewLink(link: string): JoinPreview
  /** Save the env a link shares, or refresh it when this share was joined before. Refuses an expired link. */
  join(link: string, name?: string | null): Promise<Env>
  /** Make this phone's key for a server and read its host key; nothing is saved yet. */
  addServer(input: NewServer): Promise<ServerDraft>
  /** Save a server the user has seen the fingerprint of (and given this phone's key to). */
  trustServer(draft: ServerDraft): Promise<Env>
  /** Drop a draft that will not be saved (its key goes). */
  cancelServer(draft: ServerDraft): Promise<void>
  /** Forget an env: its key is deleted and its connection closed. */
  remove(id: string): Promise<void>
  rename(id: string, name: string): Promise<void>
  /** Connect and run a trivial command. */
  check(id: string): Promise<void>
  /** Its instances, then the projects of the running ones. */
  refresh(id: string): Promise<void>
  refreshProjects(id: string, instance: string): Promise<RemoteProject[]>
}

export const projectsKey = (envId: string, instance: string) => `${envId}/${instance}`

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** A name a person typed: trimmed, short, printable. */
function cleanName(name: string, fallback: string): string {
  const n = name.trim() || fallback
  if ([...n].length > 60) throw new Error('Keep the name under 60 characters.')
  if (hasControl(n)) throw new Error("The name can't contain control characters.")
  return n
}

/** A saved entry, if it is still a usable one (tolerates data from older builds). */
function normalize(raw: unknown): Env | null {
  if (!raw || typeof raw !== 'object') return null
  const e = raw as Partial<Env>
  const ep = e.endpoint
  if (typeof e.id !== 'string' || !validEnvId(e.id) || typeof e.name !== 'string') return null
  if (!ep || typeof ep.host !== 'string' || typeof ep.user !== 'string' || typeof ep.keyId !== 'string' || typeof ep.hostKey !== 'string') return null
  if (typeof ep.port !== 'number' || !Number.isInteger(ep.port) || ep.port < 1 || ep.port > 65535) return null
  if (!e.joined === !e.server) return null
  const env: Env = {
    id: e.id,
    name: e.name,
    endpoint: { host: ep.host, port: ep.port, user: ep.user, keyId: ep.keyId, hostKey: ep.hostKey },
    addedAt: typeof e.addedAt === 'number' ? e.addedAt : 0,
  }
  if (e.joined) {
    const j = e.joined
    if (typeof j.instance !== 'string' || typeof j.shareId !== 'string') return null
    env.joined = {
      instance: j.instance,
      sharedFrom: typeof j.sharedFrom === 'string' ? j.sharedFrom : '',
      shareId: j.shareId,
      expiresAt: typeof j.expiresAt === 'number' ? j.expiresAt : null,
    }
  } else {
    env.server = { incusRemote: typeof e.server?.incusRemote === 'string' && e.server.incusRemote ? e.server.incusRemote : null }
  }
  return env
}

/** A fresh Keychain entry name: a new one per key, so a replaced key is only dropped once the new one is saved. */
const newKeyId = (envId: string) => `env-${envId}-${randomUUID().slice(0, 8)}`

export const useEnvs = create<EnvsState>()((set, get) => {
  async function save(envs: Env[]) {
    set({ envs })
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, envs }))
  }

  const setStatus = (id: string, s: EnvStatus) => set(st => ({ status: { ...st.status, [id]: s } }))

  const need = (id: string) => {
    const env = get().byId(id)
    if (!env) throw new Error("That environment is no longer in Mango's list.")
    return env
  }

  let loading: Promise<void> | null = null

  return {
    loaded: false,
    envs: [],
    status: {},
    instances: {},
    projects: {},
    projectErrors: {},

    load() {
      loading ??= (async () => {
        let envs: Env[] = []
        try {
          const raw = JSON.parse((await AsyncStorage.getItem(STORAGE_KEY)) || 'null')
          const list: unknown[] = Array.isArray(raw?.envs) ? raw.envs : []
          envs = list.map(normalize).filter((e): e is Env => e !== null)
        } catch { /* unreadable: start empty */ }
        if (!backend.real && !envs.length) envs = MOCK_ENVS.map(e => ({ ...e }))
        set({ envs, loaded: true })
      })()
      return loading
    },

    byId(id) {
      return get().envs.find(e => e.id === id) ?? null
    },

    previewLink(link) {
      return preview(decode(link), get().envs)
    },

    async join(link, name) {
      await get().load()
      const t = decode(link)
      checkNotExpired(t, Date.now())
      const before = get().envs.find(e => e.joined?.shareId === t.id) ?? null
      const id = before?.id ?? randomUUID()
      const label = pickName(name, before?.name, t)
      const keyId = newKeyId(id)
      await ssh.importKey(keyId, t.k)
      const env = envFromToken(t, id, label, keyId, before?.addedAt ?? Date.now())
      try {
        await save(before ? get().envs.map(e => (e.id === id ? env : e)) : [...get().envs, env])
      } catch (e) {
        // Nothing was saved: don't leave a key behind for an entry that doesn't exist.
        await ssh.deleteKey(keyId).catch(() => {})
        throw new Error(`Could not save the environment: ${messageOf(e)}`)
      }
      if (before) {
        // Joined again: the old key and its connection go.
        await backend.reset(before)
        if (before.endpoint.keyId !== keyId) await ssh.deleteKey(before.endpoint.keyId).catch(() => {})
      }
      setStatus(id, { state: 'unknown', message: null })
      return env
    },

    async addServer(input) {
      await get().load()
      const dest = input.ssh.trim()
      validSshDest(dest)
      const at = dest.lastIndexOf('@')
      const user = at > 0 ? dest.slice(0, at) : ''
      const host = at > 0 ? dest.slice(at + 1) : ''
      if (!user || !host || !/^[a-z_][a-z0-9_.-]*$/i.test(user) || !/^[A-Za-z0-9.:-]+$/.test(host) || host.startsWith('-')) {
        throw new Error(`"${dest}" is not an SSH destination. Use user@host, e.g. ops@203.0.113.10.`)
      }
      const port = input.port ?? 22
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`${port} is not a port. Use a number from 1 to 65535.`)
      const remote = (input.incusRemote ?? '').trim().replace(/:+$/, '') || null
      if (remote) validRemote(remote)
      const name = cleanName(input.name ?? '', host)
      const id = randomUUID()
      const keyId = newKeyId(id)
      const publicKey = await ssh.generateKey(keyId, `mango-phone:${id.slice(0, 8)}`)
      let hostKey: HostKeyInfo
      try {
        hostKey = await ssh.probeHostKey(host, port)
        if (hostKey.type !== 'ssh-ed25519') {
          throw new Error(`${host} offers a ${hostKey.type} host key; Mango pins ssh-ed25519 keys only. Enable an Ed25519 host key on the server (OpenSSH has one by default).`)
        }
      } catch (e) {
        await ssh.deleteKey(keyId).catch(() => {})
        const m = messageOf(e)
        throw new Error(m.includes('Ed25519') ? m : `Could not reach ${host} at port ${port}: ${m}`)
      }
      const env: Env = {
        id,
        name,
        endpoint: { host, port, user, keyId, hostKey: hostKey.key },
        server: { incusRemote: remote },
        addedAt: Date.now(),
      }
      return { env, publicKey, hostKey }
    },

    async trustServer(draft) {
      const env = normalize(draft.env)
      if (!env || !env.server) throw new Error('That server draft is damaged. Add the server again.')
      await save([...get().envs.filter(e => e.id !== env.id), env])
      setStatus(env.id, { state: 'unknown', message: null })
      return env
    },

    async cancelServer(draft) {
      if (get().byId(draft.env.id)) return
      await ssh.deleteKey(draft.env.endpoint.keyId).catch(() => {})
    },

    async remove(id) {
      const env = get().byId(id)
      if (!env) return
      await save(get().envs.filter(e => e.id !== id))
      await backend.reset(env)
      await ssh.deleteKey(env.endpoint.keyId).catch(() => {})
      set((st) => {
        const drop = <T>(r: Record<string, T>) =>
          Object.fromEntries(Object.entries(r).filter(([k]) => k !== id && !k.startsWith(`${id}/`)))
        return { status: drop(st.status), instances: drop(st.instances), projects: drop(st.projects), projectErrors: drop(st.projectErrors) }
      })
    },

    async rename(id, name) {
      const env = need(id)
      const n = cleanName(name, env.name)
      await save(get().envs.map(e => (e.id === id ? { ...e, name: n } : e)))
    },

    async check(id) {
      const env = need(id)
      // Already saying "Reconnecting…": checking is part of that, no need to flicker.
      if (get().status[id]?.state !== 'reconnecting') setStatus(id, { state: 'checking', message: null })
      try {
        await backend.check(env)
        setStatus(id, { state: 'ok', message: null })
      } catch (e) {
        setStatus(id, { state: 'error', message: messageOf(e) })
        throw e
      }
    },

    async refresh(id) {
      const env = need(id)
      setStatus(id, { state: 'checking', message: null })
      let instances: Instance[]
      try {
        instances = await backend.instances(env)
      } catch (e) {
        setStatus(id, { state: 'error', message: messageOf(e) })
        return
      }
      setStatus(id, { state: 'ok', message: null })
      set(st => ({ instances: { ...st.instances, [id]: instances } }))
      // Over the env's one shared connection, side by side.
      await Promise.all(instances.filter(i => i.state === 'running').map(i => get().refreshProjects(id, i.name).catch(() => {})))
    },

    async refreshProjects(id, instance) {
      const env = need(id)
      const key = projectsKey(id, instance)
      try {
        const list = await backend.projects(env, instance)
        set((st) => {
          const { [key]: _, ...errors } = st.projectErrors
          return { projects: { ...st.projects, [key]: list }, projectErrors: errors }
        })
        return list
      } catch (e) {
        set(st => ({ projectErrors: { ...st.projectErrors, [key]: messageOf(e) } }))
        throw e
      }
    },
  }
})

// Remote paths (`env://<envId>/…`) and chat mirrors find their env here.
backend.setEnvLookup(id => useEnvs.getState().byId(id))

// A run or a command that lost its connection marks the env reconnecting; whatever reaches it
// again clears that (and an earlier failure). A failure with words of its own (`error`) stays.
backend.watchConnections((id, state) => {
  const st = useEnvs.getState()
  if (!st.byId(id)) return
  const now = st.status[id]?.state
  if (state === 'lost' ? now === 'error' || now === 'reconnecting' : now !== 'reconnecting' && now !== 'error') return
  useEnvs.setState(s => ({ status: { ...s.status, [id]: { state: state === 'lost' ? 'reconnecting' : 'ok', message: null } } }))
})
