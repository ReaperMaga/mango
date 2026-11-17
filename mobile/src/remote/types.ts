import type { AgentId } from '~/types/chat'
import type { SpawnFn } from '~/agents/types'
import type { SshEndpoint } from '@/ssh/types'

/**
 * The contract between the app's state/screens and a remote environment. Implemented over SSH
 * (`src/remote/sshBackend.ts`, the real one) and in memory (`src/remote/mockBackend.ts`, for the
 * web preview and the simulator without a server). `src/remote/index.ts` picks one.
 *
 * Everything here mirrors the desktop (`src-tauri/src/envs/`, `chats_remote.rs`, `git.rs`), so a
 * phone is just one more computer opening the same environment: same commands inside the
 * instance, same chat files, same `env://` project paths.
 */

/** A saved environment on this phone (the desktop's `EnvHost`). */
export interface Env {
  /** This phone's id for it: `[a-z0-9-]{1,64}`, the `<hostId>` of `env://<hostId>/…`. */
  id: string
  name: string
  /** Where SSH goes. `keyId` names the Keychain entry with this env's private key. */
  endpoint: SshEndpoint
  /**
   * Joined from a share link (`mango://join/…`): SSH lands inside the environment as its agent
   * user, there is exactly one instance (`instance`), no master, no Incus.
   */
  joined?: {
    instance: string
    /** e.g. "forge/dev", as the link says */
    sharedFrom: string
    shareId: string
    /** unix ms; null = no end */
    expiresAt: number | null
  }
  /**
   * A master server added by hand (the user put this phone's public key in its
   * `authorized_keys`): instances are reached with `incus exec`.
   */
  server?: {
    /** The Incus remote on the master holding the instances; null = its default. */
    incusRemote: string | null
  }
  addedAt: number
}

/** As the desktop maps Incus' statuses (`envs/incus.rs::status_of`). */
export type InstanceState = 'running' | 'stopped' | 'starting' | 'stopping' | 'frozen' | 'error' | 'unknown'

export interface Instance {
  name: string
  state: InstanceState
  /** 'container' | 'virtual-machine' | … as Incus says; null for a joined env. */
  kind: string | null
}

/** A project folder inside an instance. */
export interface RemoteProject {
  /** `env://<envId>/<instance>/<absolute dir>` (see `~/utils/envPath.ts`). */
  path: string
  name: string
  /** Current branch when it is a git repository, else null. */
  branch: string | null
}

/** The desktop's `chats_remote` listing: a chat's revision, null when it was deleted there. */
export interface RemoteChatEntry {
  id: string
  rev: number | null
}

export type RemotePut = 'ok' | 'stale' | 'gone'

/** Which instance of which env (the desktop's `EnvRemote`, with this phone's env id). */
export interface EnvRemote {
  hostId: string
  instance: string
}

export type GitChangeKind = 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' | 'conflicted'

export interface GitChange {
  path: string
  /** For a rename: where it came from. */
  from?: string
  kind: GitChangeKind
  staged: boolean
  additions: number | null
  deletions: number | null
}

export interface GitState {
  /** False when the folder is not a git repository. */
  repo: boolean
  branch: string | null
  ahead: number
  behind: number
  /** Has an upstream to push to. */
  upstream: boolean
  changes: GitChange[]
}

export interface RemoteBackend {
  /** True for SSH; false for the simulation (its replies are labelled "Simulated"). */
  readonly real: boolean

  /**
   * How `env://<hostId>/…` paths and `EnvRemote`s find their saved env: the envs store
   * (`src/state/envs.ts`) hands this over when it loads.
   */
  setEnvLookup(lookup: (hostId: string) => Env | null): void

  /** Connect and run a trivial command; rejects with a message a person can act on. */
  check(env: Env): Promise<void>
  instances(env: Env): Promise<Instance[]>
  /** Project folders in an instance (git repositories under the agent's home, as the desktop finds them). */
  projects(env: Env, instance: string): Promise<RemoteProject[]>
  /** Which agent CLIs are installed in the instance. */
  agentsInstalled(env: Env, instance: string): Promise<AgentId[]>

  /* Chats kept in the environment: exactly the desktop's `chats_remote_*` scripts and files. */
  chatsList(at: EnvRemote): Promise<RemoteChatEntry[]>
  /** The chats' JSON, in the shared form (`env://@/…`), skipping missing ones. */
  chatsFetch(at: EnvRemote, ids: string[]): Promise<string[]>
  chatsPut(at: EnvRemote, id: string, base: number, rev: number, data: string): Promise<RemotePut>
  chatsRemove(at: EnvRemote, ids: string[]): Promise<void>

  /**
   * Put a file attached to a message into the environment, where the agent can read it:
   * `~/.local/share/mango/attachments/<id>/<name>` of the agent user. `data` is base64.
   * Resolves with the file's absolute path there.
   */
  attachmentPut(at: EnvRemote, id: string, name: string, data: string): Promise<string>

  /* Git, in a project folder (`projectPath` is an env:// path). */
  gitState(projectPath: string): Promise<GitState>
  /** Unified diff of one file (staged and unstaged together, against HEAD; untracked: the whole file). */
  gitDiff(projectPath: string, file: string): Promise<string>
  /** Stage everything (or `files`) and commit; resolves with the new commit's short hash. */
  gitCommit(projectPath: string, message: string, files?: string[]): Promise<string>
  /** Push the current branch (publishing it on the first push); resolves with what happened, in a sentence. */
  gitPush(projectPath: string): Promise<string>

  /**
   * The adapters' process bridge for one agent CLI in a project folder (or the agent's home
   * when `projectPath` is the instance root): the same `SpawnFn` the desktop builds over
   * `agent_spawn`, so `~/agents/claude.ts` and `codex.ts` run unchanged. Every run is tagged
   * `MANGO_RUN=<id>` and `kill()` stops its whole process tree in the instance.
   */
  spawnFor(agent: AgentId, projectPath: string): SpawnFn

  /** Forget shared connections (after the app returns from the background, or an env is removed). */
  reset(env?: Env): Promise<void>
}
