/**
 * The contract between the app and SSH. On iOS it is the local Expo module
 * `modules/mango-ssh` (Swift, SwiftNIO SSH); on web and in tests it is the mock in
 * `src/ssh/mock.ts`. Everything above this layer only ever sees these types.
 *
 * Mirrors what the desktop does with OpenSSH (`src-tauri/src/envs/ssh.rs`):
 * - keys are Ed25519 only, and the private half never leaves the native side once
 *   imported (it lives in the iOS Keychain, this device only);
 * - every connection pins the server's host key: an unknown or changed key is refused;
 * - one connection per endpoint is kept open and shared by short commands (like the
 *   desktop's ControlMaster); `exec` streams open their own channel on it.
 */

export interface SshEndpoint {
  host: string
  port: number
  user: string
  /** The Keychain entry holding the private key (see `importKey` / `generateKey`). */
  keyId: string
  /**
   * The server's pinned host key: the base64 blob of its `ssh-ed25519` public key
   * (exactly what `known_hosts` and a share link's `hk` hold). Any other key is refused.
   */
  hostKey: string
}

export interface HostKeyInfo {
  /** e.g. `ssh-ed25519` */
  type: string
  /** base64 blob, as `SshEndpoint.hostKey` */
  key: string
  /** `SHA256:…` as `ssh-keygen -lf` prints it */
  fingerprint: string
}

export interface RunOptions {
  /** Written to the command's stdin, which is then closed. */
  stdin?: string
  /** Default 30 s. On timeout the promise rejects and the channel is closed. */
  timeoutMs?: number
  /** Refuse (reject) when stdout grows beyond this many bytes. Default 64 MiB. */
  maxBytes?: number
}

export interface RunResult {
  /** null when the command was killed by a signal or the server sent no exit status. */
  code: number | null
  stdout: string
  stderr: string
}

export interface ExecHandlers {
  /** One complete line of stdout, without its `\n` (UTF-8 decoded on whole lines). */
  onLine(line: string): void
  onStderr?(line: string): void
  /** Exactly once, when the channel closes. */
  onExit?(code: number | null): void
}

export interface ExecProcess {
  /** Raw text to stdin (add `\n` yourself). */
  write(data: string): Promise<void>
  closeStdin(): Promise<void>
  /** Close the channel (the remote process may survive it: stop it by its run tag too). */
  kill(): Promise<void>
}

export interface SshApi {
  /** Whether this is the real transport (false: the browser preview's simulation). */
  readonly real: boolean
  /** Store an Ed25519 key from its 32-byte seed (base64url, as a share link's `k`). */
  importKey(keyId: string, seed: string): Promise<void>
  /** Make a new Ed25519 key in the Keychain; returns its `ssh-ed25519 AAAA… comment` line. */
  generateKey(keyId: string, comment: string): Promise<string>
  /** The public line of a stored key, null when there is none. */
  publicKey(keyId: string): Promise<string | null>
  deleteKey(keyId: string): Promise<void>
  /**
   * Connect without trusting anything, only to read the server's host key (to show its
   * fingerprint before the user trusts it for a server they add by hand). Authenticates nothing.
   */
  probeHostKey(host: string, port: number): Promise<HostKeyInfo>
  /** Run one command line (passed to the remote user's shell as-is) and capture its output. */
  run(endpoint: SshEndpoint, command: string, options?: RunOptions): Promise<RunResult>
  /** Start a long-running command and stream it line by line; handlers are attached before output can arrive. */
  exec(endpoint: SshEndpoint, command: string, handlers: ExecHandlers): Promise<ExecProcess>
  /** Drop the shared connection to an endpoint (after a network change, or when an env is removed). */
  disconnect(endpoint: SshEndpoint): Promise<void>
}
