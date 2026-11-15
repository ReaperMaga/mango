<img src="assets/icon.svg" width="64" height="64" alt="">

# Mango

A desktop workbench for coding agents. Open a project, run several Claude Code
and Codex chats side by side, and keep a real terminal docked at the bottom.

Built with Rust + [Tauri 2](https://tauri.app) and [Nuxt 4](https://nuxt.com) (SPA).

**Documentation:** [reapermaga.github.io/mango](https://reapermaga.github.io/mango/): install, guides and development notes.

## Status

- **Projects:** open a folder, create a project (with `git init`), clone a repository with live git progress, recent projects.
- **Agents:** real Claude Code and Codex runs. Mango starts your installed `claude` / `codex` CLI for each turn, streams text, thinking and tool calls, shows diffs and command output, and asks you before edits and commands (per the chat's permission mode: Plan, Ask first, Accept edits, Full auto). Conversations resume across turns and app restarts.
- **Changes (left sidebar, next to threads):** git status, diffs in the main pane (side by side or one column), stage / unstage / discard, commit, fetch / pull / push, branches, history.
- **Unity Version Control (Plastic SCM):** a folder inside a Unity VCS workspace (it has a `.plastic` folder) uses the same Changes view, diffs and branch popup, driven by your own `cm` client. Pending changes, diffs, checkin, undo, update, changeset history, and branches (`/main/...`: switch, create, rename, delete) all work. Unity VCS has no staging area: what you stage is what the next checkin takes (nothing staged takes everything), and Mango remembers that choice while it runs. There is no fetch, push, amend, merge or rebase for Unity VCS in Mango. Sign in with the Unity Version Control app or Unity Hub; Mango never handles credentials.
- **Terminal:** a real PTY docked at the bottom, with tabs. Mango finds the shells on your machine (login shell and `/etc/shells` on Linux/macOS; PowerShell, Command Prompt, Git Bash, MSYS2/Cygwin, Nushell and WSL distributions on Windows); pick one per terminal from the arrow next to the +, and set the default, font size and cursor in Settings > Terminal.
- **Updates:** checks the latest GitHub release at launch and every hour; **Update** in the titlebar downloads, verifies and installs it, then restarts Mango.
- **Get started:** on the first launch, a dialog shows whether Claude Code, Codex and Git are installed and signed in, installs what is missing with each vendor's own installer (run in an embedded terminal, so you see and answer it), and signs you in. Open it again from the command palette.
- **Settings:** installed agents, sign in / sign out (runs the CLI's own login in an embedded terminal), default agent and permission mode, theme and color scheme (Mango, Blue, Purple, Pink, Graphite).
- **Branches:** click the branch name (titlebar or Changes view) for a JetBrains-style popup: search, update / push / fetch, local and remote branches, and per-branch checkout, new branch from, merge, rebase, rename and delete. For Unity VCS a new branch is a child of the one it starts from (`task` from `/main` is `/main/task`).
- **Sidebar:** shows the chats of the project picked in the titlebar, grouped by status: Working on top, Settled and Archived at the bottom of the list, where they fold away.
- **Chat status:** Working, Settled and Archived (plus "Needs you" and "Failed" while a run needs attention). New chats and every finished turn are Working; a chat is Settled only when you press the check mark on its sidebar row (press it again to go back to Working). Archive from the thread's menu in the sidebar.
- **Order:** drag chats in the sidebar to arrange them (or Alt+↑ / Alt+↓, or Move up / Move down in the menu). New chats arrive on top.
- Chat tabs, split view, per-thread drafts, command palette, dark and light themes.

Mango uses the agents' own sign-in: it never sees or stores your credentials.

Chat history is stored in the webview's localStorage for now; the agents keep
their own session files (`~/.claude`, `~/.codex`) as usual.

## Run it

```bash
pnpm install
pnpm app          # tauri dev: starts Nuxt on :1420 and opens the window
pnpm app:build    # release build + installers
pnpm bump minor   # new version (patch, minor, major or an exact 1.2.3) in every file that holds it
```

The version you are running, with the commit it was built from, is in Settings > General.

Linux needs the Tauri system packages (`libwebkit2gtk-4.1-dev`, `libgtk-3-dev`,
`librsvg2-dev`, `libayatana-appindicator3-dev`, `libssl-dev`).

Cross-compiling the Windows installer from Linux (needs `nsis`, `lld`, `llvm`,
`clang`, `rustup target add x86_64-pc-windows-msvc` and `cargo install cargo-xwin`):

```bash
pnpm tauri build --runner cargo-xwin --target x86_64-pc-windows-msvc
```

`pnpm dev` alone serves the UI at http://localhost:1420 with an in-memory mock
backend, which is handy for working on the frontend in a browser. There, agent
replies are simulated (and labelled so), and "Load demo threads" in the command
palette fills it with sample threads.

To try an agent adapter against the real CLI without the app:

```bash
node scripts/try-agent.ts claude /path/to/project "say hi" --mode ask
```

## Shortcuts

| Keys | Action |
| --- | --- |
| `Ctrl/⌘ K` | Command palette |
| `Ctrl/⌘ N` | New chat |
| `Ctrl/⌘ O` | Open folder |
| `Ctrl/⌘ J` or `` Ctrl/⌘ ` `` | Toggle terminal |
| `Ctrl/⌘ Shift T` | New terminal |
| `Ctrl/⌘ B` | Toggle sidebar |
| `Ctrl/⌘ Shift G` | Switch the sidebar between threads and changes |
| `Ctrl/⌘ ,` | Settings |
| `Ctrl/⌘ \` | Split chat / close split |
| `Ctrl/⌘ W` | Close tab |
| `Ctrl/⌘ 1…9` | Switch tab |

## Layout

```
app/                  Nuxt frontend
  agents/             agent adapters: claude.ts, codex.ts (CLI protocol -> events), index.ts (runtime)
  assets/css/         design tokens (tokens.css) and base styles
  components/         titlebar, sidebar, chat, terminal, git, settings, welcome hub, dialogs, palette
  composables/        useBackend (typed IPC + browser mock), useShortcuts
  stores/             workspace (projects, layout), threads (chats, panes), git
  types/ipc.ts        the frontend <-> Rust contract
src-tauri/src/        Rust backend
  agent_proc.rs       starts agent CLIs, bridges their stdio as events
  auth.rs             agent sign-in status / sign-out
  setup.rs            Get started: installed tools and the per-OS installer recipes
  vcs.rs              the source-control commands: picks git or Unity VCS per folder
  git.rs              git for the changes panel
  plastic.rs          Unity Version Control (`cm`) for the same commands
  pty.rs              terminals
  projects.rs         projects, clone, recents
  updater.rs          self-update from GitHub releases
scripts/try-agent.ts  run an adapter against the real CLI from a terminal
PRODUCT.md            product context
DESIGN.md             design system
```

## Next

- Attach files and images to a message; multiple-choice questions from agents.
- "Always allow" rules for approvals.
- Move chat history from localStorage to a file in the app data dir.
- Per-thread git worktrees.
