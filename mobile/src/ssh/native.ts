import type { ExecHandlers, ExecProcess, HostKeyInfo, RunOptions, RunResult, SshApi, SshEndpoint } from './types'

/** Whole lines of one stream of an `exec`, in order (one event per read, not per line). */
export interface LinesEvent {
  id: string
  stream: 'stdout' | 'stderr'
  lines: string[]
}

/** The end of an `exec`, once, after its last lines. */
export interface ExitEvent {
  id: string
  code: number | null
}

export interface Subscription {
  remove(): void
}

/**
 * What the native module `MangoSsh` exposes (`modules/mango-ssh/ios/MangoSshModule.swift`).
 * Streams are addressed by an id chosen here, so their handlers exist before the stream starts.
 */
export interface MangoSshModule {
  importKey(keyId: string, seed: string): Promise<void>
  generateKey(keyId: string, comment: string): Promise<string>
  publicKey(keyId: string): Promise<string | null>
  deleteKey(keyId: string): Promise<void>
  probeHostKey(host: string, port: number): Promise<HostKeyInfo>
  run(endpoint: SshEndpoint, command: string, options: RunOptions): Promise<RunResult>
  exec(id: string, endpoint: SshEndpoint, command: string): Promise<void>
  write(id: string, data: string): Promise<void>
  closeStdin(id: string): Promise<void>
  kill(id: string): Promise<void>
  disconnect(endpoint: SshEndpoint): Promise<void>
  addListener(event: 'onLines', listener: (e: LinesEvent) => void): Subscription
  addListener(event: 'onExit', listener: (e: ExitEvent) => void): Subscription
}

let counter = 0
const nextId = () => `${Date.now().toString(36)}-${++counter}`

/** Only the fields the module reads, whatever else the caller's object carries. */
const plain = (e: SshEndpoint): SshEndpoint => ({ host: e.host, port: e.port, user: e.user, keyId: e.keyId, hostKey: e.hostKey })

/** A handler that throws must not cost the stream its remaining lines. */
function deliver(fn: (line: string) => void, line: string) {
  try {
    fn(line)
  } catch (e) {
    console.error('An SSH output handler failed:', e)
  }
}

/** `SshApi` over the native module: routes its stream events to each `exec`'s handlers. */
export function createNativeSsh(native: MangoSshModule, newId: () => string = nextId): SshApi {
  const streams = new Map<string, ExecHandlers>()

  native.addListener('onLines', e => {
    const h = streams.get(e.id)
    if (!h) return
    const fn = e.stream === 'stderr' ? h.onStderr?.bind(h) : h.onLine.bind(h)
    if (fn) for (const line of e.lines) deliver(fn, line)
  })
  native.addListener('onExit', e => {
    const h = streams.get(e.id)
    if (!h) return
    streams.delete(e.id)
    try {
      h.onExit?.(e.code)
    } catch (err) {
      console.error('An SSH exit handler failed:', err)
    }
  })

  return {
    real: true,
    importKey: (keyId, seed) => native.importKey(keyId, seed),
    generateKey: (keyId, comment) => native.generateKey(keyId, comment),
    publicKey: keyId => native.publicKey(keyId),
    deleteKey: keyId => native.deleteKey(keyId),
    probeHostKey: (host, port) => native.probeHostKey(host, port),
    run: (endpoint, command, options = {}) => {
      const o: RunOptions = {}
      if (options.stdin !== undefined) o.stdin = options.stdin
      if (options.timeoutMs !== undefined) o.timeoutMs = options.timeoutMs
      if (options.maxBytes !== undefined) o.maxBytes = options.maxBytes
      return native.run(plain(endpoint), command, o)
    },
    async exec(endpoint, command, handlers): Promise<ExecProcess> {
      const id = newId()
      streams.set(id, handlers)
      try {
        await native.exec(id, plain(endpoint), command)
      } catch (e) {
        streams.delete(id)
        throw e
      }
      return {
        write: data => native.write(id, data),
        closeStdin: () => native.closeStdin(id),
        kill: () => native.kill(id),
      }
    },
    disconnect: endpoint => native.disconnect(plain(endpoint)),
  }
}
