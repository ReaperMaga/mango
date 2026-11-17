import { randomUUID } from 'expo-crypto'
import { ssh } from '@/ssh'
import { createMockBackend } from './mockBackend'
import { createSshBackend } from './sshBackend'
import type { RemoteBackend } from './types'

/**
 * The app's one `RemoteBackend`: SSH when the real transport is there (the iOS app), otherwise
 * the in-memory simulation (web preview, tests), whose replies are labelled "Simulated".
 */
export const backend: RemoteBackend = ssh.real ? createSshBackend({ ssh, newId: randomUUID }) : createMockBackend()

export type * from './types'
