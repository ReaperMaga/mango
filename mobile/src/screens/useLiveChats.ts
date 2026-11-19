import { useCallback } from 'react'
import { AppState } from 'react-native'
import { useFocusEffect } from 'expo-router'
import { envOf, syncEnv } from '@/remote/chatSync'
import { useEnvs } from '@/state/envs'
import { useNetwork } from '@/state/network'
import { startPolling } from './livePoll'

/**
 * Keep a remote project's chats current while its screen is in front: a run on another computer
 * (and the moment it ends) shows up on its own. Only while this screen is focused and the app is
 * in the foreground (iOS cuts sockets in the background; coming back, `lifecycle.ts` catches up).
 * `path` is any place inside the project's environment; anything else polls nothing.
 */
export function useLiveChats(path: string | null | undefined, ms: number, immediate = false) {
  useFocusEffect(useCallback(() => {
    const at = envOf(path)
    if (!at) return undefined
    return startPolling(
      () => syncEnv(at),
      ms,
      {
        immediate,
        canRun: () => AppState.currentState === 'active'
          && useNetwork.getState().online !== false
          && !!useEnvs.getState().byId(at.hostId),
      },
    )
  }, [path, ms, immediate]))
}
