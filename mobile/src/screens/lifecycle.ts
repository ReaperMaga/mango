import { useEffect } from 'react'
import { AppState, type AppStateStatus } from 'react-native'
import { useEnvs } from '@/state/envs'
import { useThreads } from '@/state/threads'
import { backend } from '@/remote'
import { envOf, flushRemoteChats, syncEnv } from '@/remote/chatSync'
import type { EnvRemote } from '@/remote/types'

/**
 * The app's life around its data: read the saved environments and chats once, save before iOS
 * suspends the app, and catch up when it comes back. Connections die while the app is in the
 * background, so coming back drops them (`backend.reset`) and pulls what other computers wrote.
 */

/** Every environment instance some chat here lives in. */
function instancesWithChats(): EnvRemote[] {
  const seen = new Map<string, EnvRemote>()
  const envs = useEnvs.getState()
  for (const t of Object.values(useThreads.getState().threads)) {
    const at = envOf(t.projectPath)
    if (at && envs.byId(at.hostId)) seen.set(`${at.hostId}/${at.instance}`, at)
  }
  return [...seen.values()]
}

/** Pull the chats of every instance this phone has chats in (failures stay quiet: offline is normal). */
export function syncChatsEverywhere(): Promise<void> {
  return Promise.all(instancesWithChats().map(at => syncEnv(at).catch(() => {}))).then(() => {})
}

/** Check every saved environment's connection, side by side. */
export function checkAllEnvs(): Promise<void> {
  const envs = useEnvs.getState()
  return Promise.all(envs.envs.map(e => envs.check(e.id).catch(() => {}))).then(() => {})
}

/**
 * Refresh everything a person can see on Home: each env's instances and projects, then the chats
 * of every running instance (pull to refresh).
 */
export async function refreshAll(): Promise<void> {
  const envs = useEnvs.getState()
  await Promise.all(envs.envs.map(async (e) => {
    await envs.refresh(e.id)
    const running = (useEnvs.getState().instances[e.id] ?? []).filter(i => i.state === 'running')
    await Promise.all(running.map(i => syncEnv({ hostId: e.id, instance: i.name }).catch(() => {})))
  }))
}

let started: Promise<void> | null = null

/**
 * Load the saved envs, then the chats (which starts the sync), then catch up with the environments:
 * their instances and projects, and the chats of every running instance, so Home is current.
 */
export function startApp(): Promise<void> {
  started ??= (async () => {
    await useEnvs.getState().load()
    await useThreads.getState().load()
    void refreshAll()
  })()
  return started
}

/** Mounted once, in the root layout. */
export function useAppLifecycle() {
  useEffect(() => {
    void startApp()
    // iOS may come back through 'inactive', so remember the trip to the background itself.
    let away = AppState.currentState === 'background'
    const sub = AppState.addEventListener('change', (next: AppStateStatus) => {
      if (next === 'background' && !away) {
        away = true
        // iOS may end the app any time from here: write what is pending, here and in the environments.
        void useThreads.getState().flush()
        void flushRemoteChats()
      } else if (next === 'active' && away) {
        away = false
        void (async () => {
          await startApp()
          await backend.reset()
          await Promise.all([checkAllEnvs(), syncChatsEverywhere()])
        })()
      }
    })
    return () => sub.remove()
  }, [])
}
