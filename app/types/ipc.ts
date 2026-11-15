/**
 * IPC contract between the Nuxt frontend and the Rust (Tauri) backend.
 * Command names are snake_case Tauri commands; argument objects use camelCase
 * keys (Tauri converts them to snake_case Rust parameters).
 * Rust structs serialize with #[serde(rename_all = "camelCase")].
 */

/** Version control a project is under: git, or Unity Version Control (formerly Plastic SCM, CLI `cm`). */
export type VcsKind = 'git' | 'plastic'

export interface ProjectInfo {
  /** Absolute path of the project folder. */
  path: string
  /** Folder name. */
  name: string
  /** Under version control: a git repository or a Unity VCS workspace (see `vcs`). */
  isGit: boolean
  /** Which version control; null (or missing, from older builds) when there is none. */
  vcs?: VcsKind | null
  /** Current branch (`/main/task` for Unity VCS), null when there is none or it is detached. */
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

/** Something Mango needs, offered by the setup dialog (`setup_check`). */
export type SetupToolId = 'git' | 'claude' | 'codex'

export interface SetupTool {
  id: SetupToolId
  name: string
  installed: boolean
  /** First line of `<bin> --version`, as the tool prints it. */
  version: string | null
  path: string | null
  /** How Mango would install it on this computer; null when it can't (send the user to `helpUrl`). */
  install: { command: string; via: string } | null
  /** The vendor's own install page. */
  helpUrl: string
}

/* ---------- source control ----------
 * The `git_*` commands serve git repositories and Unity VCS workspaces alike:
 * the backend works out which one a folder is and answers in these shapes.
 * Unity VCS has no staging area; "staged" files are the ones picked for the
 * next checkin, remembered by the backend while it runs.
 */

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
  vcs: VcsKind
  /** Unity VCS only: the repository the workspace is bound to, e.g. "game@org@cloud". */
  repository: string | null
  isRepo: boolean
  /** Repository root (absolute), null when not a repo. */
  root: string | null
  /** Current branch, null when detached or not a repo. */
  branch: string | null
  /** Short hash of HEAD (Unity VCS: the loaded changeset number), null on an unborn branch. */
  head: string | null
  /** Upstream ref such as "origin/main", null when none is set. */
  upstream: string | null
  ahead: number
  /** Commits on the upstream not here yet (Unity VCS: newer changesets on the branch). */
  behind: number
  files: GitFile[]
}

export interface GitCommit {
  hash: string
  /** e.g. "a1b2c3d"; "cs:12" for a Unity VCS changeset. */
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

/* ---------- project files (the Files view and the editor) ----------
 * Paths are relative to the project folder, with forward slashes; the backend
 * refuses anything that leads outside it.
 */

export interface FsEntry {
  name: string
  /** Relative to the project, e.g. "app/stores/files.ts". */
  path: string
  isDir: boolean
  /** Matched by the repository's ignore rules (git only). */
  ignored: boolean
}

export interface FsListing {
  /** Folders first, then by name. `.git` is left out. */
  entries: FsEntry[]
  /** The folder holds more than 5000 entries; the rest are left out. */
  truncated: boolean
}

export interface FileContent {
  /** The file as text; null when it is binary or too large to open. */
  text: string | null
  binary: boolean
  /** Over 5 MB: not opened. */
  tooLarge: boolean
  size: number
  /** The file starts with a UTF-8 byte order mark (not part of `text`; written back on save). */
  bom: boolean
  /** ms since the epoch: hand it back on save so a change on disk is noticed. */
  modifiedMs: number
}

export interface WriteResult {
  /** False when the file changed on disk since `expectedModifiedMs`; nothing was written. */
  saved: boolean
  modifiedMs: number
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

/** A newer release found on GitHub (`update_check`). */
export interface UpdateInfo {
  version: string
  currentVersion: string
  /** Release notes (markdown), when the release has any. */
  notes: string | null
  /** Publish date, ms since the epoch. */
  dateMs: number | null
}
export interface UpdateProgress { downloaded: number; total: number | null }

/** A Whisper speech model for voice input (`voice_models`). Multilingual; runs on this computer. */
export type VoiceModelId = 'tiny' | 'base' | 'small'
export interface VoiceModel {
  id: VoiceModelId
  name: string
  /** Bytes to download. */
  sizeBytes: number
  downloaded: boolean
  downloading: boolean
}
export interface VoiceProgress { model: VoiceModelId; downloaded: number; total: number }
export interface Transcript {
  text: string
  /** Whisper language code that was used, e.g. "en"; detected unless one was asked for. */
  language: string | null
  /** Seconds of audio. */
  duration: number
}

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

  /** Git and the agent CLIs: installed or not, and how Mango would install the missing ones here. */
  setup_check: [Record<string, never>, SetupTool[]]
  /**
   * Run the installer of one tool in a PTY (the backend picks the command). Returns the pty id;
   * output and the exit code arrive as `pty://data` / `pty://exit`, and `pty_write` / `pty_kill` work on it.
   */
  setup_install: [{ tool: SetupToolId; cols: number; rows: number }, string]
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
  /** Commits what is staged (Unity VCS: checks it in; no amend). Returns the new short hash, or "cs:12". */
  git_commit: [{ path: string; message: string; amend: boolean }, string]
  /**
   * These three return git's output for display. Push sets the upstream when there is none.
   * Unity VCS: pull is `cm update`; fetch and push are refused (checkins go straight to the server).
   */
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
  /**
   * Create `name` at `from` (HEAD when null) and optionally switch to it.
   * Unity VCS: a name without a leading `/` becomes a child of `from` (or the current branch).
   */
  git_branch_create: [{ path: string; name: string; from: string | null; checkout: boolean }, void]
  /** Check out a remote branch as a local tracking branch. Returns the local branch name. */
  git_checkout_remote: [{ path: string; branch: string }, string]
  /** Merge `branch` into the current branch. Returns git's output. */
  git_merge: [{ path: string; branch: string }, string]
  /** Rebase the current branch onto `onto`. Returns git's output. */
  git_rebase: [{ path: string; onto: string }, string]
  git_branch_rename: [{ path: string; from: string; to: string }, void]
  /**
   * Without `force`, an unmerged branch is refused with an error containing "not fully merged".
   * Unity VCS refuses branches with changesets or children; merge, rebase and remote checkout are git only.
   */
  git_branch_delete: [{ path: string; branch: string; force: boolean }, void]

  /** One folder of a project (`dir` "" for the top). */
  fs_list_dir: [{ root: string; dir: string }, FsListing]
  fs_read_file: [{ root: string; file: string }, FileContent]
  /**
   * Overwrite an existing file (never creates one). With `expectedModifiedMs`, a file that
   * changed on disk since then is left alone and `saved` is false; null writes regardless.
   */
  fs_write_file: [{ root: string; file: string; text: string; bom: boolean; expectedModifiedMs: number | null }, WriteResult]

  /** Reads `latest.json` of the latest GitHub release. Null when Mango is up to date. */
  update_check: [Record<string, never>, UpdateInfo | null]
  /**
   * Downloads, verifies and installs the update from the last check, then restarts Mango
   * (terminals and agent runs are stopped). Emits `update://progress`. Never resolves on success.
   */
  update_install: [Record<string, never>, void]

  /** The speech models on offer and which are downloaded. */
  voice_models: [Record<string, never>, VoiceModel[]]
  /** Fetch a model from Hugging Face (pinned commit, SHA-256 checked). Emits `voice://progress`; resolves when ready. */
  voice_download: [{ model: VoiceModelId }, void]
  /** Stops a download in progress; `voice_download` then rejects with "Download cancelled.". */
  voice_download_cancel: [{ model: VoiceModelId }, void]
  voice_delete: [{ model: VoiceModelId }, void]
  /**
   * Speech to text, locally. `audio` is base64 of 16 kHz mono 16-bit little-endian PCM, at most 10 minutes.
   * `language` is a Whisper code such as "en"; null detects it.
   */
  voice_transcribe: [{ model: VoiceModelId; audio: string; language: string | null }, Transcript]
}

/** Events emitted by the backend. */
export interface Events {
  'pty://data': PtyDataEvent
  'pty://exit': PtyExitEvent
  'clone://progress': CloneProgress
  'agent://stdout': AgentLineEvent
  'agent://stderr': AgentLineEvent
  'agent://exit': AgentExitEvent
  'update://progress': UpdateProgress
  'voice://progress': VoiceProgress
}
