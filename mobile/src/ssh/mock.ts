import type { HostKeyInfo, SshApi } from './types'

const NO_SSH = 'The browser preview has no SSH.'

/** base64 of an `ssh-ed25519` wire blob around 32 made-up bytes. */
function blob(key: Uint8Array): string {
  const bytes = [0, 0, 0, 11, ...Array.from('ssh-ed25519', c => c.charCodeAt(0)), 0, 0, 0, 32, ...key]
  return btoa(String.fromCharCode(...bytes))
}

/** The host key every probe "finds": 32 bytes of 'm'. Its fingerprint is precomputed (see mock.test.ts). */
export const MOCK_HOST_KEY: HostKeyInfo = {
  type: 'ssh-ed25519',
  key: blob(new Uint8Array(32).fill(0x6d)),
  fingerprint: 'SHA256:S4QrG4wxrzL3obNVPfywy8dyGYBAGs9xbR14IoIuTKE',
}

/**
 * The SSH of the browser preview (`real` false): keys live in memory with made-up public
 * halves, and nothing connects. The app runs its mock backend there instead, so only key
 * handling and host key probes are ever called.
 */
export function createMockSsh(): SshApi {
  const keys = new Map<string, string>()
  const line = (comment: string) => {
    const key = crypto.getRandomValues(new Uint8Array(32))
    return `ssh-ed25519 ${blob(key)} ${comment}`.trimEnd()
  }
  return {
    real: false,
    async importKey(keyId) {
      keys.set(keyId, line(''))
    },
    async generateKey(keyId, comment) {
      const l = line(comment)
      keys.set(keyId, l)
      return l
    },
    async publicKey(keyId) {
      return keys.get(keyId) ?? null
    },
    async deleteKey(keyId) {
      keys.delete(keyId)
    },
    async probeHostKey() {
      return { ...MOCK_HOST_KEY }
    },
    async run() {
      throw new Error(NO_SSH)
    },
    async exec() {
      throw new Error(NO_SSH)
    },
    async disconnect() {},
  }
}
