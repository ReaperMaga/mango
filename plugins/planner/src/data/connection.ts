/**
 * The planner server this computer is connected to, if any: its address and access token (kept in the plugin's
 * storage), and the `RemoteSource` that the routed source reads it through.
 */

import { shallowRef, type ShallowRef } from 'vue'
import type { MangoPluginApi } from '../host.ts'
import { isObject } from '../patch.ts'
import { hello, RemoteSource, serverUrl, type RemoteConfig, type RemoteHello } from './remote.ts'
import { SourceError } from './source.ts'
import type { RoutedSource } from './routed.ts'

const KEY = 'server'

export interface ServerConnection {
  /** The address connected to, or null. Never the token. */
  readonly url: Readonly<ShallowRef<string | null>>
  /** What the server said when it was connected. */
  readonly space: Readonly<ShallowRef<RemoteHello | null>>
  /** Checks the address and token with the server, then connects. The reason it could not, or null. */
  connect(address: string, token: string): Promise<string | null>
  disconnect(): void
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

  function use(config: RemoteConfig, said: RemoteHello | null) {
    const remote = new RemoteSource(config, { storage: host.storage, log: host.log })
    if (said) remote.label = said.space.name
    url.value = config.url
    space.value = said
    routed.setServer(remote)
  }

  const start = saved(host)
  if (start) use(start, start.hello ?? null)

  return {
    url,
    space,
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
    disconnect() {
      host.storage.delete(KEY)
      url.value = null
      space.value = null
      routed.setServer(null)
    },
  }
}
