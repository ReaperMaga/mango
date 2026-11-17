/**
 * IPC contract between the Nuxt frontend and the Rust (Tauri) backend.
 * Command names are snake_case Tauri commands; argument objects use camelCase
 * keys (Tauri converts them to snake_case Rust parameters).
 * Rust structs serialize with #[serde(rename_all = "camelCase")].
 */

import type { Attachment } from '~/types/chat'

/** A stored attachment as the backend reports it (the preview is made in the webview). */
export type AttachmentInfo = Omit<Attachment, 'thumb'>

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
  /** a team or company the account belongs to; null for a personal account */
  organization: string | null
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
  /**
   * Set when this folder is a linked git worktree (`git worktree add`): the root of the
   * repository's main working tree, in the same form as `root`. Null for the main one and for Unity VCS.
   */
  mainRoot: string | null
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

/** How far a folder's branch is ahead of another (`git_ahead`). */
export interface GitAhead {
  /** The branch compared with. */
  base: string
  /** Commits on HEAD that `base` doesn't have. */
  ahead: number
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

/**
 * One working tree of a repository (`git worktree list`): the main one the clone made, and the
 * linked ones that let chats work on their own branches side by side.
 */
export interface GitWorktree {
  /** Its folder, in the same form as the `path` asked about (an `env://` path for a remote project). */
  path: string
  /** Checked-out branch, null when detached. */
  branch: string | null
  /** Short hash of its HEAD, null when unborn. */
  head: string | null
  /** The repository's main working tree. */
  isMain: boolean
  /** The working tree the asked-about folder is in. */
  isCurrent: boolean
  locked: boolean
  /** Its folder is gone; git would drop it on `worktree prune`. */
  prunable: boolean
}

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

/**
 * A Unity VCS lock (exclusive checkout) in the workspace's repository (`vcs_locks`).
 * Unity scenes, prefabs and binary assets can't be merged, so the server's lock rules
 * make a checkout lock them; nobody else can check them out until it is released.
 */
export interface VcsLock {
  /** Relative to the workspace root, forward slashes. */
  path: string
  /** Who holds it, as the server names them (often an email address). */
  owner: string
  /** The workspace it was taken from. */
  workspace: string
  /** The branch it was taken on. */
  branch: string
  /** `locked`: checked out now. `retained`: checked in on a task branch, held until it reaches the destination branch. */
  status: 'locked' | 'retained'
  /** When it was taken, unix ms; null when unknown. */
  time: number | null
  /** Held by the signed-in user (in any workspace). */
  mine: boolean
}

/** Unity VCS: what merging a branch into the workspace would do, read before anything changes. */
export interface MergePreview {
  /** The branch merged from (`/main/task`). */
  branch: string
  /** The branch the workspace is on, which the merge goes into. */
  into: string | null
  /** Items the merge changes, relative to the workspace root. Empty with no conflicts: nothing to merge. */
  files: string[]
  /** Items changed on both branches. Mango doesn't merge these; the Unity VCS app resolves them. */
  conflicts: string[]
  /** Why the merge can't run from Mango right now (pending changes, not up to date). */
  blocker: string | null
}

/* ---------- pull requests and issues (linked to chats, read through the GitHub CLI) ---------- */

export interface GhLabel {
  name: string
  /** Hex without `#`, as GitHub stores it. */
  color: string
}

export type GhState = 'open' | 'draft' | 'merged' | 'closed'

/** A Unity VCS code review's status (`cm codereview --status`). */
export type PlasticReviewStatus = 'underReview' | 'reviewed' | 'reworkRequired'

export interface PlasticReviewer {
  /** A user or group name (an email on Unity Cloud). */
  name: string
  status: PlasticReviewStatus
}

/** One Unity VCS code review as `cm find review` reports it. */
export interface PlasticReview {
  id: number
  guid: string | null
  title: string
  status: PlasticReviewStatus
  owner: string
  /** The single assignee of older reviews; newer ones have reviewers. */
  assignee: string | null
  reviewers: PlasticReviewer[]
  targetType: 'branch' | 'changeset'
  /** The branch (`/main/task-1`) or changeset (`cs:12`); empty when `cm` named it only by id. */
  target: string
  /** Unix ms; 0 when unknown. */
  created: number
  /** Last activity, Unix ms, when the client reports it. */
  modified: number | null
  comments: number | null
  /** Change requests not applied plus questions not answered, when the client reports it. */
  unresolved: number | null
}

/** Code reviews of a Unity VCS workspace (`plastic_reviews`). */
export interface PlasticReviews {
  repository: string | null
  /** The branch the workspace is on; null when pinned to a changeset or label. */
  branch: string | null
  /** Reviews of that branch, newest first, whatever their status (at most 20). */
  branchReviews: PlasticReview[]
  /** The repository's reviews under review or waiting for rework, newest first, without the branch's own (at most 50). */
  open: PlasticReview[]
  /** More open reviews exist than `open` holds. */
  more: boolean
}

/** One pull request or issue as `gh_item` reads it. */
export interface GhItem {
  kind: 'pr' | 'issue'
  url: string
  host: string
  owner: string
  repo: string
  number: number
  title: string
  state: GhState
  /** Closed issues: "completed", "not_planned" or "duplicate". */
  stateReason: string | null
  author: { login: string; avatarUrl: string | null } | null
  /** ISO timestamps. */
  createdAt: string
  updatedAt: string
  /** The description as GitHub renders it. Untrusted: sanitise before showing (`utils/safeHtml.ts`). */
  bodyHtml: string
  labels: GhLabel[]
  comments: number
  /* Pull requests only; null for issues. */
  headRef: string | null
  baseRef: string | null
  additions: number | null
  deletions: number | null
  changedFiles: number | null
  reviewDecision: 'approved' | 'changes_requested' | 'review_required' | null
  /** The latest commit's checks. */
  checks: 'success' | 'failure' | 'pending' | null
  /** Each check on the latest commit; empty for issues. */
  checkRuns: GhCheck[]
  /** The commit the branch points at; `gh_merge` only goes through while it still does. */
  headSha: string | null
  /** "unknown" while GitHub is still working it out. */
  mergeable: 'mergeable' | 'conflicting' | 'unknown' | null
  /** GitHub's `mergeStateStatus`, lower case. */
  mergeState: GhMergeState | null
  /** The merge methods the repository allows. */
  mergeMethods: GhMergeMethod[]
  defaultMergeMethod: GhMergeMethod | null
  /** The account gh is signed in with may merge (write access or more). */
  canMerge: boolean
}

export type GhMergeMethod = 'merge' | 'squash' | 'rebase'
export type GhMergeState = 'clean' | 'blocked' | 'behind' | 'dirty' | 'unstable' | 'has_hooks' | 'draft' | 'unknown'

/** One check on a pull request's latest commit: a GitHub Actions job, another app's check run, or a commit status. */
export interface GhCheck {
  name: string
  /** The workflow a GitHub Actions job belongs to. */
  workflow: string | null
  state: 'success' | 'failure' | 'pending' | 'cancelled' | 'skipped' | 'neutral'
  /** Its log or details page. */
  url: string | null
  /** A commit status's one-line description. */
  description: string | null
  /** Branch protection requires it before merging. */
  required: boolean
}

/** A job's or step's state: like a check's, plus "queued" for one that has not started. */
export type GhRunState = GhCheck['state'] | 'queued'

/** One step of a GitHub Actions job, with its share of the log. */
export interface GhJobStep {
  number: number
  name: string
  state: GhRunState
  /** ISO timestamps. */
  startedAt: string | null
  completedAt: string | null
  /** Its log lines without timestamps: untrusted text with ANSI colour codes and `##[group]`-style markers. */
  lines: string[]
  /** Earlier lines left out of a very long step. */
  omitted: number
}

/** A GitHub Actions job as `gh_job` reads it. */
export interface GhJob {
  id: number
  name: string
  workflow: string | null
  /** The job's page on GitHub. */
  url: string
  state: GhRunState
  startedAt: string | null
  completedAt: string | null
  steps: GhJobStep[]
  /** The log was read; GitHub has it only once the job finished. */
  logReady: boolean
  /** Why a finished job's log could not be read. */
  logError: string | null
  /** The log was too long and its end is missing. */
  logTruncated: boolean
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

/* ---------- the browser: native webviews laid over browser tabs (src-tauri/src/browser.rs) ---------- */

/** Where a browser's webview sits, in CSS pixels of the main window (getBoundingClientRect). */
export interface BrowserBounds {
  x: number
  y: number
  width: number
  height: number
}

/** A browser's page as it changes (`browser://state`). */
export interface BrowserState {
  /** The id the browser was opened with. */
  id: string
  url: string
  title: string
  loading: boolean
}

/**
 * An agent's first browser call in a chat with no browser yet (`browser://agent-open`): open a browser
 * tab with this id for that chat (its root chat) and call `browser_open` with it. The tool call waits
 * up to 15 seconds for it.
 */
export interface BrowserAgentOpen {
  id: string
  threadId: string
  url: string
}

/** The browser tools Mango hands an agent run (an MCP server over HTTP on 127.0.0.1). */
export interface BrowserMcp {
  /** Streamable-HTTP MCP endpoint; the secret token in its path ties it to the chat. */
  url: string
  /** Name to register the server under: tools are `mcp__<name>__<tool>` in Claude Code. */
  name: string
  /** Tools that only read the page (snapshot, screenshot, console logs), safe to allow without asking. */
  readOnlyTools: string[]
}

/** A picture an agent's reply points at (`chat_image`). */
export interface ChatImage {
  /** The whole file, base64. */
  data: string
  /** Read from the file's bytes, not its name. */
  mime: string
  size: number
  modifiedMs: number
}

export interface FileBytes {
  /** The whole file, base64. */
  data: string
  size: number
  modifiedMs: number
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

/** An env file at a project's root (Project settings > Environment variables). */
export interface EnvFile {
  /** File name at the project root, e.g. ".env", ".env.vault", "prod.env". */
  name: string
  size: number
  modifiedMs: number
  /** Whether git ignores it (`git check-ignore`); null when the folder is not a git repository or git is unavailable. */
  ignored: boolean | null
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

/* ---------- remote environments ----------
 * Incus instances (containers and VMs) on a "master" server Mango reaches over SSH.
 * Mango runs nothing of its own there: each action is one `ssh … incus …` call that uses
 * the user's own SSH keys. Instances are addressed as { hostId, instance }.
 */

/** Tailscale for a server's instances: they join the tailnet with these tags. */
export interface EnvTailscale {
  /** e.g. ['tag:mango']; the tailnet's ACLs decide what the tags may reach. */
  tags: string[]
  /** A file on the master holding a Tailscale auth key. Null: interactive sign-in (the installer prints a link). */
  authKeyFile: string | null
}

/** A master server. `id` is '' when adding one with `env_host_save`. */
export interface EnvHost {
  id: string
  name: string
  /** `user@host`, or an alias from ~/.ssh/config */
  ssh: string
  port: number | null
  /** A private key on this computer; null uses the SSH defaults. */
  identityFile: string | null
  /** The Incus remote on the master that holds the instances (`incus remote list`); null is its default. */
  incusRemote: string | null
  tailscale: EnvTailscale | null
  /** The address other people reach this server at, for share links over a public port; null uses the SSH host name. */
  publicAddress?: string | null
  /**
   * Set for an environment joined from a share link (`env_join`): SSH goes straight into that one environment
   * as its agent user. There is no master and no Incus: it has exactly one instance, `direct.instance`, which can't
   * be started, stopped, created or deleted from here.
   */
  direct?: EnvDirect | null
}

export interface EnvDirect {
  /** The environment's name, shown as the only instance. */
  instance: string
  /** Its pinned SSH host key (base64 `ssh-ed25519` blob). */
  hostKey: string
  /** Where it was shared from, as the link says, e.g. "forge/dev". */
  sharedFrom: string
  shareId: string
  /** When access ends (unix ms); null = no end. */
  expiresAt: number | null
}

/**
 * How a share link reaches the environment:
 * - `public`: a port on the server (an Incus proxy device) forwards to the environment's own SSH server, key-only.
 * - `tailscale`: the environment's tailnet address (the person joining must be able to reach it on the tailnet).
 */
export type EnvShareVia = 'public' | 'tailscale'

/** One person's access to an environment (a key in its agent user's authorized_keys). */
export interface EnvShare {
  id: string
  /** Who it is for, e.g. "Sam". */
  label: string
  via: EnvShareVia
  /** host:port the link connects to. */
  endpoint: string
  /** unix ms */
  createdAt: number
  /** unix ms; null = no end */
  expiresAt: number | null
}

/** A new share: the link exists only here, once (Mango keeps no copy of its key). */
export interface EnvShareLink {
  share: EnvShare
  /** `mango://join/…`, one line; also shown as a QR code. */
  url: string
  /** What the owner may still need to do, e.g. open the port in a firewall (with a ufw command when ufw is active). */
  note?: string | null
}

/** What a share link would add, before joining. */
export interface EnvJoinPreview {
  instance: string
  sharedFrom: string
  endpoint: string
  expiresAt: number | null
  /** An environment from this link (same share id) is already in the list. */
  alreadyJoined: boolean
}

/**
 * Incus on a server, as `env_probe` finds it:
 * - `ready`: installed, initialised, and usable by the SSH user
 * - `missing`: not installed (`env_server_setup` can install it when `canSetup`)
 * - `uninitialised`: installed but has no storage pool or network yet (`env_server_setup` initialises it)
 * - `no-access`: installed, but the SSH user may not use it (not in `incus-admin`; setup adds them)
 */
export type EnvIncusState = 'ready' | 'missing' | 'uninitialised' | 'no-access'

export interface EnvProbe {
  /** SSH worked and Incus is ready to use. */
  ok: boolean
  /** SSH worked (whatever the state of Incus). */
  reachable: boolean
  /** null when the server could not be reached. */
  incus: EnvIncusState | null
  incusVersion: string | null
  /** The server's OS, e.g. "Ubuntu 24.04.1 LTS". */
  os: string | null
  /** Mango can install, initialise or update Incus here (a supported distribution with systemd). */
  canSetup: boolean
  /** Why it can't, when `canSetup` is false and Incus isn't ready (e.g. "Fedora is not supported yet"). */
  setupNote: string | null
  /** Instance remotes the server's `incus` knows. */
  remotes: string[]
  error: string | null
}

export type EnvKind = 'container' | 'vm'
export type EnvInstanceStatus = 'running' | 'stopped' | 'starting' | 'stopping' | 'frozen' | 'error' | 'unknown'

export interface EnvInstance {
  name: string
  kind: EnvKind
  status: EnvInstanceStatus
  /** The image's description, e.g. "Ubuntu noble amd64 (20261101_07:42)". */
  image: string | null
  ipv4: string[]
  /** Address on the tailnet, once it has joined one. */
  tailscaleIp: string | null
  cpus: number | null
  /** e.g. "8GiB" */
  memory: string | null
  /** The root disk's size, e.g. "40GiB"; null is the storage pool's default (or unknown). */
  disk: string | null
  /** Unix ms */
  createdAt: number
}

export type EnvInstanceAction = 'start' | 'stop' | 'restart' | 'delete'

/** What an instance can have installed with one click (and updated the same way). */
export type EnvComponentId = 'base' | 'claude' | 'codex' | 'gh' | 'node' | 'desktop' | 'tailscale'

export interface EnvComponent {
  id: EnvComponentId
  name: string
  description: string
  installed: boolean
  version: string | null
  /** Installed along with it when missing. */
  requires: EnvComponentId[]
}

export interface EnvCreateInput {
  hostId: string
  name: string
  /** e.g. 'images:ubuntu/24.04' (VMs use the '/cloud' variant automatically) */
  image: string
  kind: EnvKind
  cpus: number | null
  memoryGib: number | null
  diskGib: number | null
  components: EnvComponentId[]
}

/** New limits for an instance (`env_resize`); null leaves that one as it is. A disk only grows. */
export interface EnvResizeInput {
  cpus: number | null
  memoryGib: number | null
  diskGib: number | null
}

/** A folder inside an environment, for picking where a project lives. */
export interface EnvDirEntry {
  name: string
  /** Absolute path inside the environment. */
  path: string
  /** Has a `.git` folder. */
  isGit: boolean
}

export interface EnvDirListing {
  /** The folder listed (absolute, normalised; `~` resolved to the agent's home). */
  dir: string
  /** Its parent; null at `/`. */
  parent: string | null
  /** Sub-folders only, sorted by name; hidden ones (`.x`) left out. */
  entries: EnvDirEntry[]
  /** More than the limit (500) existed. */
  truncated: boolean
}

/** The desktop of an instance, served by noVNC through a tunnel on this computer. */
export interface EnvDesktop { url: string }

/** Where a remote agent run happens. */
export interface EnvRemote { hostId: string; instance: string }

/** What `env_login` can sign in to inside an instance (each CLI's own flow, in a terminal). */
export type EnvLoginTool = 'claude' | 'codex' | 'gh' | 'tailscale'

/** One chat as saved in the chat history (`chats_save`): the chat itself is JSON. */
export interface ChatRow { id: string; projectPath: string; updatedAt: number; data: string }

/** The saved chat history (`chats_load`): every chat's JSON, and the layout's (null before the first save). */
export interface ChatSnapshot { threads: string[]; ui: string | null }

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
  /** `cwd` '' starts it in the home folder (for questions that need no project). */
  agent_spawn: [{ agent: 'claude' | 'codex'; args: string[]; cwd: string; env?: Record<string, string> | null; remote?: EnvRemote | null }, string]
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
  /**
   * Merge `branch` into the current branch. Returns git's output.
   * Unity VCS: merges into the workspace, leaving pending changes (picked for the checkin) that a checkin
   * finishes; refused when the workspace has pending changes, is not up to date, or the merge has conflicts.
   */
  git_merge: [{ path: string; branch: string }, string]
  /** Unity VCS only: what `git_merge` would change, and whether it can run. Fails for git. */
  git_merge_preview: [{ path: string; branch: string }, MergePreview]
  /** Rebase the current branch onto `onto`. Returns git's output. */
  git_rebase: [{ path: string; onto: string }, string]
  git_branch_rename: [{ path: string; from: string; to: string }, void]
  /**
   * Without `force`, an unmerged branch is refused with an error containing "not fully merged".
   * Unity VCS refuses branches with changesets or children; rebase and remote checkout are git only.
   */
  git_branch_delete: [{ path: string; branch: string; force: boolean }, void]
  /** The repository's working trees, the main one first. Empty for Unity VCS or no repository. */
  git_worktrees: [{ path: string }, GitWorktree[]]
  /**
   * Add a linked worktree for `branch` in a folder the backend picks beside the repository
   * (`<parent>/<repo>.worktrees/<branch>`). `create`: a new branch from `from` (HEAD when null);
   * otherwise an existing local branch that no other worktree has checked out.
   */
  git_worktree_add: [{ path: string; branch: string; from: string | null; create: boolean }, GitWorktree]
  /**
   * Remove the linked worktree at `worktree` (its folder; a locked one is unlocked first); the branch is
   * kept. Refuses the main one, and one with uncommitted or untracked changes unless `force`.
   */
  git_worktree_remove: [{ path: string; worktree: string; force: boolean }, void]
  /**
   * Commits on the branch at `path` that `base` doesn't have. Without `base`: compared with the branch
   * checked out in the repository's main working tree (what a linked worktree is merged into); fails when
   * that is detached. Git only.
   */
  git_ahead: [{ path: string; base: string | null }, GitAhead]
  /** Unity VCS: every lock in the workspace's repository. Empty for git. */
  vcs_locks: [{ path: string }, VcsLock[]]
  /**
   * Unity VCS: lock files (paths relative to the root) by checking them out; the server's lock rules decide
   * whether a checkout locks. Refuses files someone else holds. Returns a note naming the files that were
   * checked out but not locked; empty when all are locked. Git: an error.
   */
  vcs_lock: [{ path: string; files: string[] }, string]
  /** Unity VCS: release the user's own locks on files (the files stay as they are). Refuses other people's. */
  vcs_unlock: [{ path: string; files: string[] }, void]

  /** One folder of a project (`dir` "" for the top). */
  /**
   * A pull request or issue, by link, `owner/repo#12`, or number (`#12`: in the GitHub repository of
   * the project at `path`). Needs the GitHub CLI, signed in; the error says what to do when it is not.
   */
  gh_item: [{ path: string; reference: string }, GhItem]
  /**
   * Merge a pull request on GitHub, only while its branch still points at `headSha` (otherwise it
   * fails and says the branch moved). The local checkout is not touched.
   */
  gh_merge: [{ path: string; reference: string; method: GhMergeMethod; headSha: string }, void]
  /**
   * Open a pull request from the branch checked out at `path` (push it first) into `base`, titled from
   * its commits like `gh pr create --fill`, and read it back. When one is already open for the branch,
   * that one comes back. Works for remote projects.
   */
  gh_pr_create: [{ path: string; base: string }, GhItem]
  /**
   * A GitHub Actions job by its link (a check's `url`, `…/actions/runs/<run>/job/<job>`): its steps,
   * and once it finished, its log split into them. Other links are refused.
   */
  gh_job: [{ url: string }, GhJob]
  /**
   * Unity VCS code reviews for the workspace holding `path`: its branch's, and the repository's open
   * ones. Fails for a git folder.
   */
  plastic_reviews: [{ path: string }, PlasticReviews]
  /**
   * Ask for a code review of the branch the workspace at `path` is on (`cm codereview`), optionally
   * naming reviewers (comma-separated users). Returns the new review's id.
   */
  plastic_review_create: [{ path: string; title: string; reviewers: string | null }, number]

  fs_list_dir: [{ root: string; dir: string }, FsListing]
  fs_read_file: [{ root: string; file: string }, FileContent]
  /** A file's raw bytes, for the image viewer. Files over 25 MB are refused. */
  fs_read_bytes: [{ root: string; file: string }, FileBytes]
  /**
   * Overwrite an existing file (never creates one). With `expectedModifiedMs`, a file that
   * changed on disk since then is left alone and `saved` is false; null writes regardless.
   */
  fs_write_file: [{ root: string; file: string; text: string; bom: boolean; expectedModifiedMs: number | null }, WriteResult]
  /** Create a new file (never overwrites: an existing file is an error). `file` is project-relative. Returns its modifiedMs. */
  fs_create_file: [{ root: string; file: string; text: string }, WriteResult]
  /** Delete one file in the project (never a folder; a symlink is removed itself, not its target). */
  fs_delete_file: [{ root: string; file: string }, void]
  /**
   * Env files at the project root: names that are `.env`, start with `.env.`, or end in `.env`, except
   * example/template files (`.env.example`, `.env.sample`, `.env.template`, `example.env`, `sample.env`,
   * `template.env`, any case); plus any `extra` names that exist as files there (templates included).
   * Sorted, `.env` first. Works for remote (env://) projects. `extra` must be plain file names (no
   * separators, not `.`/`..`).
   */
  env_files: [{ root: string; extra: string[] }, EnvFile[]]
  /**
   * Append `/<name>` on its own line to the project's root .gitignore (creating it; adds a leading newline
   * if the file doesn't end with one; no-op if that exact line is already there). Glob characters in the
   * name are escaped (`\*`), and a CRLF file gets CRLF.
   */
  env_gitignore_add: [{ root: string; name: string }, void]

  /** Stores pasted or browser-picked bytes (`data` is base64, at most 25 MB) as an attachment called `name`. */
  attachment_save: [{ name: string; data: string }, AttachmentInfo]
  /** Copies a picked or dropped file (absolute path) into the attachment store. */
  attachment_import: [{ path: string }, AttachmentInfo]
  /** A stored attachment's bytes as base64. Paths outside the store are refused. */
  attachment_read: [{ path: string }, string]
  /**
   * A picture an agent's reply shows (`![alt](path)`): an absolute path anywhere on this computer,
   * or relative to `base`, the chat's project folder. Only real PNG, JPEG, GIF, WebP, AVIF or BMP
   * files are read (checked by their bytes, not their name), up to 25 MB.
   */
  chat_image: [{ path: string; base: string | null }, ChatImage]
  /** Every saved chat and the layout, from the chat history database. */
  chats_load: [Record<string, never>, ChatSnapshot]
  /** Save the chats that changed and delete the removed ones, in one transaction; `ui` only when it changed. */
  chats_save: [{ upsert: ChatRow[]; remove: string[]; ui: string | null }, void]

  /*
   * The browser. Each browser is a native webview, its own label `browser-<id>` (`id`: letters,
   * digits, `-`, `_`, up to 64), laid over the main window at `bounds` and kept until `browser_close`,
   * hidden while its tab is not in a pane. Only http(s) pages and about:blank load in it; it has no
   * access to Mango's commands. Page changes arrive as `browser://state`.
   */
  /**
   * Create the webview (or, for an id that exists, move it and load `url`). `projectPath` is the
   * tab's project: in a remote environment (`env://…`) local addresses such as `localhost:3000` are
   * the environment's own, reached through an SSH tunnel; `browser://state` reports them as typed.
   */
  browser_open: [{ id: string; url: string; bounds: BrowserBounds; visible: boolean; projectPath: string | null }, void]
  /** Move or resize it, show or hide it (hidden while an overlay covers it or its tab is not shown). */
  browser_bounds: [{ id: string; bounds: BrowserBounds; visible: boolean }, void]
  /** Load a page (routed like `browser_open`, by the project it was opened with). */
  browser_navigate: [{ id: string; url: string }, void]
  browser_go: [{ id: string; action: 'back' | 'forward' | 'reload' | 'stop' }, void]
  /** The webview's own developer tools. */
  browser_devtools: [{ id: string }, void]
  browser_close: [{ id: string }, void]
  /** Close every browser webview (the frontend calls it when it starts: a reloaded UI leaves none behind). */
  browser_reset: [Record<string, never>, void]
  /** The page as a PNG, base64. Linux only for now; elsewhere it rejects with a message saying so. */
  browser_screenshot: [{ id: string }, string]
  /**
   * The browser tools for an agent run in `threadId` (the root chat) of the project at `projectPath`.
   * Starts the local MCP server on first use; the URL stays the same for the chat while Mango runs.
   * For a remote environment the URL is one that works inside it (a reverse SSH forward back to Mango).
   */
  browser_mcp: [{ threadId: string; projectPath: string }, BrowserMcp]

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

  /* remote environments (see EnvHost) */
  env_hosts: [Record<string, never>, EnvHost[]]
  /** Add (id '') or update a server; returns it with its id. */
  env_host_save: [{ host: EnvHost }, EnvHost]
  /** Forget a server (its instances are untouched). */
  env_host_remove: [{ id: string }, void]
  /** Can Mango reach it over SSH, and what does its incus know? */
  env_probe: [{ hostId: string }, EnvProbe]
  /**
   * Install Incus on the server (or update it when installed), initialise it when it has no storage
   * pool or network, and let the SSH user use it. Runs in a terminal (sudo may ask for a password); returns the pty id.
   */
  env_server_setup: [{ hostId: string; cols: number; rows: number }, string]
  env_instances: [{ hostId: string }, EnvInstance[]]
  /** 'delete' removes the instance and everything in it (the UI confirms first). */
  env_instance_action: [{ hostId: string; instance: string; action: EnvInstanceAction }, void]
  /** Launch an instance and install `components`, in a terminal; returns the pty id. */
  env_create: [{ input: EnvCreateInput; cols: number; rows: number }, string]
  /**
   * Rename an instance (Incus renames only stopped ones: a running one is stopped and started again).
   * Returns a note when the rename worked but something after it did not.
   */
  env_rename: [{ hostId: string; instance: string; newName: string }, string | null]
  /** Change an instance's CPUs, memory and root disk. Returns a note to show (e.g. a VM grows its disk on its next start). */
  env_resize: [{ hostId: string; instance: string; input: EnvResizeInput }, string | null]
  /** Which components are installed, with versions (runs a probe inside the instance). */
  env_components: [{ hostId: string; instance: string }, EnvComponent[]]
  /** Install or update components (with what they require), in a terminal; returns the pty id. */
  env_install: [{ hostId: string; instance: string; components: EnvComponentId[]; cols: number; rows: number }, string]
  /** A login shell as the agent user inside the instance; returns the pty id. */
  env_shell: [{ hostId: string; instance: string; cwd: string | null; cols: number; rows: number }, string]
  /** Run a CLI's own sign-in inside the instance, in a terminal; returns the pty id. */
  env_login: [{ hostId: string; instance: string; tool: EnvLoginTool; cols: number; rows: number }, string]
  /**
   * Make sure a project folder exists in the instance (cloning `cloneUrl` into it when given, or running
   * `git init` in a new or empty folder when `gitInit`); returns its absolute path.
   */
  env_prepare_dir: [{ hostId: string; instance: string; dir: string; cloneUrl: string | null; gitInit?: boolean }, string]
  /** The sub-folders of `dir` inside the environment (as the agent user); `dir` may be '~'. */
  env_list_dir: [{ hostId: string; instance: string; dir: string }, EnvDirListing]
  /** Open (or reuse) a tunnel to the instance's desktop. */
  env_desktop_open: [{ hostId: string; instance: string }, EnvDesktop]
  env_desktop_close: [{ hostId: string; instance: string }, void]

  /* sharing: give someone full access to one environment (not the server) with a one-line link */
  env_shares: [{ hostId: string; instance: string }, EnvShare[]]
  /** Add an access key to the environment (setting up its SSH server and, for `public`, the forwarded port). */
  env_share_create: [{ hostId: string; instance: string; label: string; via: EnvShareVia; expiresInDays: number | null }, EnvShareLink]
  /** Remove that key (and the forwarded port when no public share is left). */
  env_share_revoke: [{ hostId: string; instance: string; shareId: string }, void]
  /** Read a pasted link without saving anything. */
  env_join_preview: [{ link: string }, EnvJoinPreview]
  /** Save the environment from a link (its key is stored in Mango's app data); returns the new direct host. */
  env_join: [{ link: string; name: string | null }, EnvHost]
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
  /** A browser's page changed: URL, title, loading. */
  'browser://state': BrowserState
  /** An agent wants a browser for its chat: open a tab with this id (see BrowserAgentOpen). */
  'browser://agent-open': BrowserAgentOpen
  /** A `mango://join/…` link was opened (deep link): show the join dialog for it. */
  'envs://join': { link: string }
}
