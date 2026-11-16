import { Laptop, Server, ServerOff, Settings2 } from 'lucide-vue-next'
import type { EnvRemote } from '~/types/ipc'
import type { MenuItem } from '~/types/ui'
import { instanceKey, useEnvironments } from '~/stores/environments'
import { envLabels, envState, refreshEnv, remotePlace, samePlace } from '~/composables/envProjects'

/**
 * The places a project can go, for the "Where" choice in Open folder, New project and Clone:
 * this computer, every running environment on the user's servers (grouped by server), and the
 * environments joined from a link ("Shared with you"). One that isn't running is listed but can't
 * be picked; starting it is Settings' job. Reactive: the list fills in as servers answer.
 */
export function whereItems(current: EnvRemote | null, pick: (where: EnvRemote | null) => void, manage: () => void): MenuItem[] {
  const envs = useEnvironments()
  const items: MenuItem[] = [{ label: 'This computer', icon: Laptop, checked: !current, onSelect: () => pick(null) }]

  for (const server of envs.servers) {
    const id = server.id
    const probe = envs.probes[id]
    const list = envs.instances[id]
    const head = { group: server.name, divider: true }
    if (!list) {
      if (envs.probing[id] || envs.loadingInstances[id] || !probe) items.push({ ...head, label: 'Checking…', icon: Server, disabled: true })
      else if (!probe.reachable) items.push({ ...head, label: 'Can\'t reach this server', icon: ServerOff, disabled: true })
      else items.push({ ...head, label: 'Incus isn\'t ready here', icon: ServerOff, disabled: true })
      continue
    }
    if (!list.length) {
      items.push({ ...head, label: 'No environments yet', icon: ServerOff, disabled: true })
      continue
    }
    list.forEach((inst, i) => {
      const state = envState(id, inst.name)
      const where = { hostId: id, instance: inst.name }
      items.push({
        ...(i === 0 ? head : {}),
        label: inst.name,
        icon: Server,
        // One short state word; starting it, or finding out why, is "Manage environments…".
        hint: state.tone === 'ready' ? undefined : state.label,
        disabled: state.tone !== 'ready',
        checked: samePlace(current, where),
        onSelect: () => pick(where),
      })
    })
  }

  envs.joined.forEach((host, i) => {
    const where = { hostId: host.id, instance: host.direct!.instance }
    const state = envState(host.id, where.instance)
    items.push({
      ...(i === 0 ? { group: 'Shared with you', divider: true } : {}),
      label: host.name,
      icon: Server,
      hint: state.tone === 'bad' ? state.label : `From ${host.direct!.sharedFrom}`,
      disabled: state.tone === 'bad',
      checked: samePlace(current, where),
      onSelect: () => pick(where),
    })
  })

  items.push({ label: 'Manage environments…', icon: Settings2, divider: true, onSelect: manage })
  return items
}

/** The short label of a place: "This computer", or an environment's name with where it is ("on forge", "shared"). */
export function whereLabel(where: EnvRemote | null): { label: string; sub: string | null } {
  if (!where) return { label: 'This computer', sub: null }
  const l = envLabels(where.hostId, where.instance)
  return { label: l.label, sub: l.sub }
}

/**
 * Opening the Environment tool window is the moment to catch up: how the environment is doing
 * (unless checked in the last minute) and what is installed in it.
 */
export async function refreshPlace(path: string | null | undefined) {
  const place = remotePlace(path)
  if (!place) return
  await refreshEnv(place.hostId)
  const envs = useEnvironments()
  const key = instanceKey(place.hostId, place.instance)
  if (envState(place.hostId, place.instance).tone === 'ready' && !envs.components[key] && !envs.loadingComponents[key]) {
    await envs.refreshComponents(place.hostId, place.instance)
  }
}
