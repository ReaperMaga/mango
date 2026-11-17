import AsyncStorage from '@react-native-async-storage/async-storage'
import { createChatSync } from './chatSyncCore'
import { backend } from './index'

/**
 * The phone's mirror of remote projects' chats (see `chatSyncCore.ts`, a port of the desktop's
 * `app/utils/remoteChats.ts`): over the app's `backend`, its state in AsyncStorage.
 */

export { envOf, fromShared, parseShared, toShared, type RemoteSource } from './chatSyncCore'

const sync = createChatSync(backend, AsyncStorage)

/** Start mirroring (the chat store calls this once it has loaded its chats). */
export const attachRemoteChats = sync.attachRemoteChats
/** Chats saved locally just now (the chat store, after each save). */
export const noteSaved = sync.noteSaved
/** Send what is pending now (e.g. when the app goes to the background). */
export const flushRemoteChats = sync.flushRemoteChats
/** Pull an environment's chats (when a project or env opens, or the app comes back). */
export const syncEnv = sync.syncEnv
