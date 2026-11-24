import type { AgentId } from '~/types/chat'
import type { SpawnFn } from '~/agents/types'
import type { SshEndpoint } from '@/ssh/types'
import type { GhJob, GhMergeMethod, GhRunAction, GhRunDetail } from '~/types/ipc'
import type { GhDetail, GhRef, GhState } from './github'
import type { ChatPicture } from './images'
import type { Releases } from './releases'
import type { AgentAuth } from './auth'

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

/** A git worktree of a project (the desktop's `GitWorktree`, without what the phone doesn't show). */
export interface GitWorktree {
  /** Its folder, as an `env://` path in the same environment. */
  path: string
  /** Checked-out branch; null when detached. */
  branch: string | null
  /** The repository's main working tree (listed first). */
  isMain: boolean
}

/** What naming a new worktree's branch must avoid: the worktrees there are, and the local branches. */
export interface GitWorktreeList {
  worktrees: GitWorktree[]
  branches: string[]
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
  /** Whether the installed agent CLIs are signed in (their own status commands; Claude Code and Codex, always both). */
  agentAuth(env: Env, instance: string): Promise<AgentAuth[]>

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
  /** The repository's worktrees (main first) and local branches, in one round trip. */
  gitWorktrees(projectPath: string): Promise<GitWorktreeList>
  /**
   * Add a linked worktree on a new branch `branch` from HEAD, beside the repository
   * (`<parent>/<repo>.worktrees/<branch>`, the desktop's `git_worktree_add` with `create`).
   * Rejects with git's reason; a taken name says "already exists".
   */
  gitWorktreeAdd(projectPath: string, branch: string): Promise<GitWorktree>

  /**
   * A linked pull request's or issue's title and state, read with the GitHub CLI inside the
   * project's environment (`github.ts`). Rejects with a message a person can act on when gh is
   * missing or signed out there, or the item is not on github.com.
   */
  ghItem(projectPath: string, ref: GhRef): Promise<GhState>

  /*
   * The pull request screen: the desktop's `gh_item`, `gh_merge`, `gh_job` and `gh_pr_create`, with gh
   * run inside the project's environment (the phone has none of its own). Only github.com. Each rejects
   * with a message a person can act on (gh missing or signed out there, no such item, a refused merge).
   */

  /** One pull request or issue in full: state, branches, checks, reviews, labels, description, merge options. */
  ghDetail(projectPath: string, ref: GhRef): Promise<GhDetail>
  /**
   * The item `reference` names, to link it to a chat: a github.com link, `owner/repo#12`, or `#12` / `12`
   * in the project's own repository (read from its git remotes inside the environment).
   */
  ghResolve(projectPath: string, reference: string): Promise<GhDetail>
  /**
   * Merge a pull request on GitHub with `method`, only while its branch still points at `headSha`
   * (GitHub refuses with 409 otherwise). Nothing in the environment's checkout changes.
   */
  ghMerge(projectPath: string, ref: GhRef, method: GhMergeMethod, headSha: string): Promise<void>
  /**
   * A GitHub Actions job by its details link (`https://github.com/o/r/actions/runs/<run>/job/<job>`):
   * its steps, and once it finished, its log split into them (the desktop's `split_log`).
   */
  ghJob(projectPath: string, url: string): Promise<GhJob>
  /**
   * Open a pull request from the branch checked out in `projectPath` (pushed already) into `base`
   * (null: the repository's default branch), titled and described from its commits (`gh pr create
   * --fill`), or find the one already open for the branch; then read it.
   */
  ghPrCreate(projectPath: string, base: string | null): Promise<GhDetail>

  /*
   * The Releases screen: the desktop's `gh_releases`, `gh_tag_run`, `gh_run` and `gh_run_action`, with gh run
   * inside the project's environment against the repository its git remotes name (github.com only).
   */

  /**
   * The project's repository on github.com, from its git remotes in the folder (the desktop's
   * `gh_repo_link`), for the link to it; null when the folder is no git repository or no remote is on github.com.
   */
  ghRepo(projectPath: string): Promise<{ owner: string; repo: string } | null>
  /** The project's GitHub releases, newest first, up to `count`, with the repository's recent workflow runs. */
  ghReleases(projectPath: string, count: number): Promise<Releases>
  /** The newest workflow run for a release's tag, with its jobs; null when no workflow ran for it. */
  ghTagRun(projectPath: string, tag: string): Promise<GhRunDetail | null>
  /** A workflow run by id, with its jobs. */
  ghRun(projectPath: string, id: number): Promise<GhRunDetail>
  /** Re-run a run's failed jobs (`rerun-failed`), the whole run (`rerun`), or cancel it (`cancel`). */
  ghRunAction(projectPath: string, id: number, action: GhRunAction): Promise<void>

  /**
   * A picture an agent's reply points at (`![alt](path)`): a file inside the project's environment,
   * `path` absolute or relative to `projectPath`. Only real raster images are read (by their bytes,
   * `images.ts`); rejects with a message a person can act on. The desktop's `chat_image`.
   */
  chatImage(projectPath: string, path: string): Promise<ChatPicture>

  /**
   * The adapters' process bridge for one agent CLI in a project folder (or the agent's home
   * when `projectPath` is the instance root): the same `SpawnFn` the desktop builds over
   * `agent_spawn`, so `~/agents/claude.ts` and `codex.ts` run unchanged. Every run is tagged
   * `MANGO_RUN=<id>` and `kill()` stops its whole process tree in the instance. A run outlives a
   * dropped connection: it is attached again (`onConnection` 'lost', then 'back'), see `agentRun.ts`.
   */
  spawnFor(agent: AgentId, projectPath: string): SpawnFn

  /**
   * The connection may be back (the network returned, the app came to the foreground): runs
   * that lost theirs attach again now instead of after their backoff, and stops and closes still
   * owed to an environment are sent.
   */
  reconnectNow(): void

  /**
   * Hear when an environment's connection fails (`'lost'`: a run's dropped, or a command could
   * not reach it) and when it works again (`'back'`). Returns how to stop listening.
   */
  watchConnections(listener: (envId: string, state: 'lost' | 'back') => void): () => void

  /** Forget shared connections (after the app returns from the background, or an env is removed). */
  reset(env?: Env): Promise<void>
}
