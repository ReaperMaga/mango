/**
 * The planner server this computer is connected to, if any: its address and access token (kept in the plugin's
 * storage), and the `RemoteSource` that the routed source reads it through.
 */

import { shallowRef, type ShallowRef } from 'vue'
import type { MangoPluginApi } from '../host.ts'
import { isObject } from '../patch.ts'
import { hello, personOf, RemoteSource, serverUrl, type RemoteConfig, type RemoteHello } from './remote.ts'
import { SourceError } from './source.ts'
import type { Person } from '../model.ts'
import type { RoutedSource } from './routed.ts'

const KEY = 'server'

export interface ServerConnection {
  /** The address connected to, or null. Never the token. */
  readonly url: Readonly<ShallowRef<string | null>>
  /** What the server said when it was connected. */
  readonly space: Readonly<ShallowRef<RemoteHello | null>>
  /** The person this computer is in the space, as the server says now; null before it said or on an older server. */
  readonly me: Readonly<ShallowRef<Person | null>>
  /** Checks the address and token with the server, then connects. The reason it could not, or null. */
  connect(address: string, token: string): Promise<string | null>
  disconnect(): void
  /** Gives this computer's person a new name, for everyone in the space. The reason it could not, or null. */
  rename(name: string): Promise<string | null>
}

type Host = Pick<MangoPluginApi, 'storage' | 'log'>

function saved(host: Host): (RemoteConfig & { hello?: RemoteHello }) | null {
  const v = host.storage.get<unknown>(KEY)
  if (!isObject(v) || typeof v.url !== 'string' || typeof v.token !== 'string') return null
  const url = serverUrl(v.url)
  return url ? { url, token: v.token, ...(isObject(v.hello) ? { hello: v.hello as unknown as RemoteHello } : {}) } : null
}

export function createConnection(host: Host, routed: RoutedSource): ServerConnection {
  const url = shallowRef<string | null>(null)
  const space = shallowRef<RemoteHello | null>(null)
  const me = shallowRef<Person | null>(null)
  let remote: RemoteSource | null = null
  let unlisten = () => {}

  function use(config: RemoteConfig, said: RemoteHello | null) {
    const r = new RemoteSource(config, { storage: host.storage, log: host.log })
    remote = r
    // Saved by an older version, `me` may be something else.
    const saidMe = said ? personOf(said.me) : null
    if (said) {
      r.label = said.space.name
      r.knownAs(saidMe?.id ?? null)
    }
    me.value = saidMe
    unlisten()
    unlisten = r.onPeople(() => {
      const people = r.peopleOf()
      me.value = people?.all.find(p => p.id === people.me) ?? null
    })
    url.value = config.url
    space.value = said
    routed.setServer(remote)
  }

  const start = saved(host)
  if (start) use(start, start.hello ?? null)

  return {
    url,
    space,
    me,
    async connect(address, token) {
      const at = serverUrl(address)
      if (!at) return 'That is not a web address. It looks like https://planner.example.com.'
      const key = token.trim()
      if (!key) return 'Paste the access token the server gave you.'
      let said: RemoteHello
      try {
        said = await hello({ url: at, token: key })
      } catch (e) {
        if (e instanceof SourceError && e.kind === 'refused') return 'The server did not accept that access token.'
        return e instanceof Error ? e.message : String(e)
      }
      host.storage.set(KEY, { url: at, token: key, hello: said })
      use({ url: at, token: key }, said)
      return null
    },
    async rename(name) {
      const r = remote
      if (!r) return 'Connect to a planner server first.'
      const trimmed = name.trim()
      if (!trimmed) return 'Type the name everyone in the space should see.'
      if (trimmed.startsWith('@')) return 'A name does not start with @.'
      try {
        await r.rename(trimmed)
      } catch (e) {
        return e instanceof Error ? e.message : String(e)
      }
      const people = r.peopleOf()
      const me = people?.all.find(p => p.id === people.me)
      const saved = host.storage.get<unknown>(KEY)
      if (me && space.value && isObject(saved)) {
        space.value = { ...space.value, me: { id: me.id, name: me.name } }
        host.storage.set(KEY, { ...saved, hello: space.value })
      }
      return null
    },
    disconnect() {
      unlisten()
      unlisten = () => {}
      me.value = null
      remote = null
      host.storage.delete(KEY)
      url.value = null
      space.value = null
      routed.setServer(null)
    },
  }
}
