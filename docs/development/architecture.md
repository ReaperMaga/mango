# Architecture

Mango is two halves joined by one typed contract:

- **Backend**: Rust + Tauri 2, in `src-tauri/`. It starts processes (agent CLIs, shells, git, `cm`), reads the file system and owns the native window.
- **Frontend**: Nuxt 4 as a single-page app (`ssr: false`), Vue 3 with `<script setup lang="ts">` and Pinia, in `app/`. It owns all UI state and the agent protocols.

Styling is plain CSS with design tokens (`app/assets/css/tokens.css`); there is no utility framework. The design system is described in `DESIGN.md`, the product context in `PRODUCT.md`, and contributor rules in `AGENTS.md`.

## Layout

```
app/
  agents/            claude.ts, codex.ts: CLI protocol -> AgentEvents. index.ts: runs turns, bridges to Rust
  assets/css/        tokens.css (the only source of colour/type/space/radius/motion), base.css
  components/        AppTitlebar, AppSidebar, AppWorkspace, ChatArea, CommandPalette
    chat/            ChatPane, ChatMessage, ChatTool, ChatApproval, ChatComposer, ChatWorking
    git/             GitPanel (sidebar Changes view), GitDiffPane + GitDiff (main-pane diffs), GitBranchPopup
    settings/        SettingsView and its sections (Agents, Terminal, Appearance, General)
    terminal/        TerminalPanel, TerminalView (xterm.js)
    ui/              UiButton, IconButton, UiMenu, UiDialog, UiField, RipenessDot, MangoMark
  composables/       useBackend.ts (typed IPC + browser mock), mockGit.ts, useShortcuts.ts
  stores/            workspace.ts (projects, layout, prefs), threads.ts (chats, tabs, panes), git.ts
  types/             ipc.ts (the frontend <-> Rust contract), chat.ts (threads, messages, statuses)
  utils/             mockAgent.ts, demoThreads.ts, diffTabs.ts, time.ts, paths.ts
src-tauri/src/
  agent_proc.rs      starts agent CLIs, forwards stdio line by line as events
  auth.rs            agent sign-in status / sign-out
  vcs.rs             the git_* commands: detects git or Unity VCS per folder and dispatches
  git.rs             everything the Changes view and branch popup need (shells out to git)
  plastic.rs         the same for Unity Version Control workspaces (shells out to cm, XML output)
  pty.rs, shells.rs  terminals; discovery of installed shells
  projects.rs        open / create / clone, recent projects
  bin.rs             finding binaries on PATH, hide_console
scripts/try-agent.ts run an adapter against the real CLI
```

## The IPC contract

`app/types/ipc.ts` is the single contract between the frontend and Rust. It lists every command (`Commands`: name, arguments, result) and every event (`Events`).

- **Commands** cover projects (`open_project`, `create_project`, `git_clone`, `recent_projects`, …), agents (`detect_agents`, `agent_spawn`, `agent_write`, `agent_kill`, `agent_auth_status`, `agent_logout`), terminals (`pty_spawn`, `pty_write`, `pty_resize`, `pty_kill`, `terminal_profiles`) and source control (`git_status`, `git_diff`, `git_stage`, `git_commit`, `git_push`, `git_branch_list`, `git_merge`, …).
- **Events** stream from Rust to the frontend: `pty://data` and `pty://exit`, `clone://progress`, and `agent://stdout`, `agent://stderr`, `agent://exit`.

Components never call Tauri's `invoke` directly; they go through `call()` and `on()` in `app/composables/useBackend.ts`. When Mango runs in a plain browser (`pnpm dev`), the same functions answer from an in-memory mock (`useBackend.ts`, `mockGit.ts`), so the UI works without a backend.

Adding a backend command takes four things:

1. The Rust command, registered in `src-tauri/src/lib.rs`. Commands are `async`, do blocking work off the UI thread, and return `Result<T, String>` with a message a person can act on. Structs use `#[serde(rename_all = "camelCase")]`.
2. Its entry in `Commands` (or `Events`) in `ipc.ts`.
3. A mock in `useBackend.ts` or `mockGit.ts`, so `pnpm dev` keeps working.
4. The caller.

## Agent adapters

An adapter (`app/agents/claude.ts`, `app/agents/codex.ts`) turns one CLI's protocol into a stream of `AgentEvent`s (`app/agents/types.ts`): session ids, text and thinking deltas, tool starts and updates, diffs, approval requests, and exactly one `turn-end` per run.

- **Claude Code** runs as `claude` with `--output-format stream-json --input-format stream-json`, permission prompts over stdio, `--permission-mode` from the chat's mode, and `--resume` with the stored session id.
- **Codex** runs as `codex app-server` (JSON-RPC over stdio), one process per turn: `initialize`, `thread/start` or `thread/resume`, `turn/start`, then the `item/*` notifications until `turn/completed`. The permission mode becomes Codex's approval policy and sandbox.

The Rust side (`agent_proc.rs`) knows nothing about these protocols: it starts the CLI (only known agent binaries), forwards stdout and stderr line by line as events, and writes to stdin. `app/agents/index.ts` picks the adapter for a chat, bridges it to Rust, and turns the events into message parts on the thread.

Adapters must stay runnable in plain Node (that is how `scripts/try-agent.ts` drives them): they import only types from the app, use no Vue, Pinia or Tauri APIs, and use erasable TypeScript only.

## State

- **Chats** (`stores/threads.ts`): threads, tabs and panes, persisted to the webview's local storage. Loading tolerates data written by older builds. While a run is active it owns the chat's status (see [statuses](../guide/chats#statuses)).
- **Workspace** (`stores/workspace.ts`): open projects, layout, preferences.
- **Git** (`stores/git.ts`): all source control state, refreshed after every action, since git is slow and external.

## Source control backends

`vcs.rs` implements every `git_*` command once: it works out whether a folder is a git work tree or a Unity VCS workspace and hands the call to `git.rs` or `plastic.rs`, which return the same shapes. The frontend describes the differences (words like "Commit" vs "Check in", and which actions exist) in `app/utils/vcs.ts`.

Safety rules in the backend:

- Ref names from the UI go through `safe_ref` (git) or `safe_branch` (Unity VCS) before reaching the tool.
- File names are literal (`GIT_LITERAL_PATHSPECS=1`), and `GIT_TERMINAL_PROMPT=0` so nothing waits on a prompt nobody sees. `cm` runs with `--noinput`.
- Discard and delete destroy work: the UI asks first, and the backend refuses unsafe cases.

## Cross-platform notes

- Every spawned process goes through `crate::bin::hide_console`, or Windows flashes a console window.
- Paths may use `\`: the frontend uses `utils/paths.ts`, never `split('/')`.
- No HTML5 drag and drop (the webview takes it over on Windows); reordering uses pointer events.
- Menus and popups are teleported to `<body>` with fixed positioning so no ancestor can clip them.
