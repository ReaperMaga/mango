import { requireOptionalNativeModule } from 'expo'

import { createMockSsh } from './mock'
import { createNativeSsh, type MangoSshModule } from './native'
import type { SshApi } from './types'

export type * from './types'

/**
 * The app's SSH: the native module in a development or release build (`modules/mango-ssh`),
 * the in-memory stand-in where there is none (the browser preview, Expo Go).
 */
const native = requireOptionalNativeModule<MangoSshModule>('MangoSsh')

export const ssh: SshApi = native ? createNativeSsh(native) : createMockSsh()
