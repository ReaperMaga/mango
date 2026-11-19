import { useEffect } from 'react'
import { AppState, type AppStateStatus } from 'react-native'
import { addNetworkStateListener, getNetworkStateAsync, type NetworkState } from 'expo-network'
import { useEnvs } from '@/state/envs'
import { useNetwork } from '@/state/network'
import { setStatusHook, useThreads } from '@/state/threads'
import { notifyChange } from '@/notify'
import { usePrefs } from '@/state/prefs'
import { backend } from '@/remote'
import { envOf, flushRemoteChats, syncEnv } from '@/remote/chatSync'
import type { EnvRemote } from '@/remote/types'
import { stopDictation } from '@/voice'
import { createCatchUp, watchNetwork, type NetworkSnapshot, type NetworkSource } from './connectivity'

/**
 * The app's life around its data: read the saved environments and chats once, save before iOS
 * suspends the app, and catch up when it comes back or the network does. Connections die while
 * the app is in the background or the network changes, so catching up drops them
 * (`backend.reset`): agent runs in environments keep working there and attach again
 * (`backend.reconnectNow`), and what other computers wrote is pulled, what is pending here sent.
 * A dictation in progress stops on the way out.
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

/**
 * Make every connection anew and catch up: on the way back from the background, and when the
 * network returns or changes interface. Offline, only the dead connections are dropped.
 */
export const catchUp = createCatchUp({
  reset: () => backend.reset(),
  reconnectNow: () => backend.reconnectNow(),
  checkAllEnvs,
  syncChatsEverywhere,
  flushRemoteChats,
  online: () => useNetwork.getState().online,
})

const snapshot = (s: NetworkState): NetworkSnapshot => ({
  // Connected to a network, and not known to be cut off from the internet.
  online: s.isConnected === undefined ? null : !!s.isConnected && s.isInternetReachable !== false,
  kind: String(s.type ?? 'UNKNOWN'),
})

/** The system's network state (NWPathMonitor on iOS, through expo-network). */
const systemNetwork: NetworkSource = {
  current: () => getNetworkStateAsync().then(snapshot),
  subscribe(listener) {
    const sub = addNetworkStateListener(s => listener(snapshot(s)))
    return () => sub.remove()
  },
}

let started: Promise<void> | null = null

/**
 * Load the saved envs, then the chats (which starts the sync), then catch up with the environments:
 * their instances and projects, and the chats of every running instance, so Home is current.
 */
export function startApp(): Promise<void> {
  started ??= (async () => {
    await usePrefs.getState().load()
    setStatusHook(notifyChange)
    // The chat store decides queue or steer inside `send`: hand it the preference now and when it changes.
    useThreads.getState().setFollowUp(usePrefs.getState().followUp)
    usePrefs.subscribe((now, before) => {
      if (now.followUp !== before.followUp) useThreads.getState().setFollowUp(now.followUp)
    })
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
        // iOS takes the microphone away in the background: end a dictation, keeping its words (never sending).
        stopDictation()
        // iOS may end the app any time from here: write what is pending, here and in the environments.
        void useThreads.getState().flush()
        void flushRemoteChats()
      } else if (next === 'active' && away) {
        away = false
        void (async () => {
          await startApp()
          await catchUp()
        })()
      }
    })
    return () => sub.remove()
  }, [])
}

/** Mounted once, in the root layout: keeps `useNetwork` current and catches up when the network is back. */
export function useNetworkWatch() {
  useEffect(() => watchNetwork(
    systemNetwork,
    s => useNetwork.getState().set(s.online, s.kind),
    () => { void startApp().then(catchUp) },
  ), [])
}
