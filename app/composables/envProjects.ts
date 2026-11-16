import { useEnvironments } from '~/stores/environments'
import { parseEnvPath } from '~/utils/envPath'

/** Where a remote project lives, for labels: its instance, server and folder. */
export interface RemotePlace {
  instance: string
  /** The server's name; its id while the saved servers have not been read, or once it is removed. */
  host: string
  /** The folder inside the instance. */
  dir: string
  /** "dev on forge" */
  where: string
}

/** Null for a project on this computer. Reactive: reads the environments store. */
export function remotePlace(path: string | null | undefined): RemotePlace | null {
  const loc = parseEnvPath(path)
  if (!loc) return null
  const saved = useEnvironments().host(loc.hostId)
  const host = saved?.name ?? 'a server Mango no longer knows'
  // A joined environment has no server of the user's: it is known by its own name ("review, shared").
  if (saved?.direct) return { instance: loc.instance, host, dir: loc.dir, where: `${saved.name}, shared` }
  return { instance: loc.instance, host, dir: loc.dir, where: `${loc.instance} on ${host}` }
}
