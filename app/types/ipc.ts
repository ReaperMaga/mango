/**
 * IPC contract between the Nuxt frontend and the Rust (Tauri) backend.
 * Command names are snake_case Tauri commands; argument objects use camelCase
 * keys (Tauri converts them to snake_case Rust parameters).
 * Rust structs serialize with #[serde(rename_all = "camelCase")].
 */

export interface ProjectInfo {
  /** Absolute path of the project folder. */
  path: string
  /** Folder name. */
  name: string
  isGit: boolean
  /** Current branch, null when not a git repo or detached. */
  branch: string | null
  /** Unix ms, when it was last opened in Mango. */
  lastOpened: number
}

export interface AgentInfo {
  id: 'claude' | 'codex'
  name: string
  installed: boolean
  version: string | null
  /** Resolved binary path when installed. */
  path: string | null
}

export interface CloneProgress {
  /** Opaque id returned by git_clone's caller-supplied jobId. */
  jobId: string
  /** A raw line of git's stderr progress output. */
  line: string
}

/** Sign-in state of an agent CLI. */
export interface AuthStatus {
  agent: 'claude' | 'codex'
  installed: boolean
  loggedIn: boolean
  /** e.g. the account email, when the CLI reports one */
  account: string | null
  /** e.g. "max", "pro" */
  plan: string | null
  /** e.g. "claude.ai", "ChatGPT", "API key" */
  method: string | null
  /** raw first line of the CLI's status output */
  detail: string | null
}

/* ---------- git ---------- */

export interface GitFile {
  /** Path relative to the repository root, forward slashes. */
  path: string
  /** Previous path for renames/copies. */
  origPath: string | null
  /** Status of the staged side: 'M' | 'A' | 'D' | 'R' | 'C', or null when nothing is staged. */
  index: string | null
  /** Status of the working-tree side: 'M' | 'D', '?' for untracked, or null. */
  worktree: string | null
  conflicted: boolean
}

export interface GitStatus {
  isRepo: boolean
  /** Repository root (absolute), null when not a repo. */
  root: string | null
  /** Current branch, null when detached or not a repo. */
  branch: string | null
  /** Short hash of HEAD, null on an unborn branch. */
  head: string | null
  /** Upstream ref such as "origin/main", null when none is set. */
  upstream: string | null
  ahead: number
  behind: number
  files: GitFile[]
}

export interface GitCommit {
  hash: string
  shortHash: string
  subject: string
  author: string
  /** Unix ms */
  time: number
}

export interface GitBranches { current: string | null; local: string[] }

/** A local branch and how it stands against its upstream. */
export interface GitLocalBranch {
  name: string
  isCurrent: boolean
  /** e.g. "origin/main"; null when the branch tracks nothing. */
  upstream: string | null
  /** The upstream was deleted on the remote. */
  upstreamGone: boolean
  ahead: number
  behind: number
  /** Tip commit time, unix ms (0 on an unborn branch). */
  time: number
  subject: string
}

export interface GitRemoteBranch {
  /** e.g. "origin/feature/x" */
  name: string
  remote: string
  time: number
  subject: string
}

export interface GitBranchList {
  current: string | null
  local: GitLocalBranch[]
  remote: GitRemoteBranch[]
  remotes: string[]
}

/** A shell the terminal can run, found on this machine. */
export interface TerminalProfile {
  /** Stable id, e.g. "zsh", "git-bash", "wsl:Ubuntu". */
  id: string
  /** Display name, e.g. "Zsh", "PowerShell 7", "WSL · Ubuntu". */
  name: string
  /** Program to start, with its arguments. */
  path: string
  args: string[]
  /** What a new terminal uses when the user has not chosen a shell. */
  isDefault: boolean
}

export interface AgentLineEvent { id: string; line: string }
export interface AgentExitEvent { id: string; code: number | null }

export interface PtyDataEvent { id: string; data: string }
export interface PtyExitEvent { id: string; code: number | null }

/** Commands: name -> [args, result] */
export interface Commands {
  /** Recent projects, most recent first. Missing folders are filtered out. */
  recent_projects: [Record<string, never>, ProjectInfo[]]
  /** Inspect a folder and record it as recently opened. */
  open_project: [{ path: string }, ProjectInfo]
  forget_project: [{ path: string }, void]
  /** mkdir parent/name, optionally `git init`, record as recent. Errors if it exists and is non-empty. */
  create_project: [{ parent: string; name: string; gitInit: boolean }, ProjectInfo]
  /** `git clone --progress url parent/<name>`; streams `clone://progress` events. */
  git_clone: [{ url: string; parent: string; name: string | null; jobId: string }, ProjectInfo]
  /** Default folder for new projects (~/Projects, created lazily) */
  default_projects_dir: [Record<string, never>, string]
  detect_agents: [Record<string, never>, AgentInfo[]]
  /** Spawn the user's login shell in a PTY. Returns the pty id. Emits `pty://data` and `pty://exit`. */
  pty_spawn: [{ cwd: string | null; cols: number; rows: number; command?: string[] | null }, string]
  pty_write: [{ id: string; data: string }, void]
  pty_resize: [{ id: string; cols: number; rows: number }, void]
  pty_kill: [{ id: string }, void]
  /** Shells found on this machine (login shell, /etc/shells, PowerShell, Git Bash, WSL distributions, …). */
  terminal_profiles: [Record<string, never>, TerminalProfile[]]

  /**
   * Start an agent CLI (only the known binaries) with piped stdio. Returns a process id.
   * Emits `agent://stdout` / `agent://stderr` per line and `agent://exit` once.
   */
  agent_spawn: [{ agent: 'claude' | 'codex'; args: string[]; cwd: string; env?: Record<string, string> | null }, string]
  /** Raw write to the process's stdin (include the trailing newline yourself). */
  agent_write: [{ id: string; data: string }, void]
  agent_close_stdin: [{ id: string }, void]
  /** Kills the process and everything it started. Unknown ids succeed silently. */
  agent_kill: [{ id: string }, void]

  agent_auth_status: [{ agent: 'claude' | 'codex' }, AuthStatus]
  agent_logout: [{ agent: 'claude' | 'codex' }, void]

  /** `path` is any folder inside the repository (normally the project path). */
  git_status: [{ path: string }, GitStatus]
  /** Unified diff of one file. Untracked files come back as an all-added diff. */
  git_diff: [{ path: string; file: string; staged: boolean }, string]
  /** Empty `files` means everything. */
  git_stage: [{ path: string; files: string[] }, void]
  git_unstage: [{ path: string; files: string[] }, void]
  /** Throw away working-tree changes: restores tracked files, deletes untracked ones. */
  git_discard: [{ path: string; files: string[] }, void]
  /** Commits what is staged. Returns the new short hash. */
  git_commit: [{ path: string; message: string; amend: boolean }, string]
  /** These three return git's output for display. Push sets the upstream when there is none. */
  git_fetch: [{ path: string }, string]
  git_pull: [{ path: string }, string]
  git_push: [{ path: string }, string]
  git_log: [{ path: string; limit: number }, GitCommit[]]
  git_branches: [{ path: string }, GitBranches]
  git_checkout: [{ path: string; branch: string; create: boolean }, void]
  /** `git init` in `path`. Does nothing when the folder is already inside a repository. */
  git_init: [{ path: string }, void]

  /** Local and remote branches, newest commit first. */
  git_branch_list: [{ path: string }, GitBranchList]
  /** Create `name` at `from` (HEAD when null) and optionally switch to it. */
  git_branch_create: [{ path: string; name: string; from: string | null; checkout: boolean }, void]
  /** Check out a remote branch as a local tracking branch. Returns the local branch name. */
  git_checkout_remote: [{ path: string; branch: string }, string]
  /** Merge `branch` into the current branch. Returns git's output. */
  git_merge: [{ path: string; branch: string }, string]
  /** Rebase the current branch onto `onto`. Returns git's output. */
  git_rebase: [{ path: string; onto: string }, string]
  git_branch_rename: [{ path: string; from: string; to: string }, void]
  /** Without `force`, an unmerged branch is refused with an error containing "not fully merged". */
  git_branch_delete: [{ path: string; branch: string; force: boolean }, void]
}

/** Events emitted by the backend. */
export interface Events {
  'pty://data': PtyDataEvent
  'pty://exit': PtyExitEvent
  'clone://progress': CloneProgress
  'agent://stdout': AgentLineEvent
  'agent://stderr': AgentLineEvent
  'agent://exit': AgentExitEvent
}
