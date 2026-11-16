<img src="assets/icon.svg" width="64" height="64" alt="">

# Mango

A desktop workbench for coding agents. Open a project, run several Claude Code
and Codex chats side by side, and keep a real terminal docked at the bottom.

Built with Rust + [Tauri 2](https://tauri.app) and [Nuxt 4](https://nuxt.com) (SPA).

**Documentation:** [reapermaga.github.io/mango](https://reapermaga.github.io/mango/): install, guides and development notes.

## Status

- **Projects:** open a folder, create a project (with `git init`), clone a repository with live git progress, recent projects.
- **Agents:** real Claude Code and Codex runs. Mango starts your installed `claude` / `codex` CLI for each turn, streams text, thinking and tool calls, shows diffs and command output, and asks you before edits and commands (per the chat's permission mode: Plan, Ask first, Accept edits, Full auto). Conversations resume across turns and app restarts. The model picker shows every model the installed CLI offers your account (asked from the CLI itself, without running a turn, and cached), and the effort chip next to it shows and sets the reasoning effort per chat (Claude Code: low to max; Codex: the levels its model accepts). With no level picked it shows the level the CLI will use (Claude Code's from your settings, Codex's per model), else "Default". You can keep writing while an agent works: sending steers it, and it reads the message at its next step within the same turn. A message the run can't take right then goes out as the next turn once it finishes (Stop drops it).
- **Files (left sidebar, next to threads):** the project's folders as a tree, with git status and ignored files dimmed. A click previews a file in a tab beside the chats (the next click replaces it); a double-click or an edit keeps the tab. Files open in a Monaco editor: save with `Ctrl/⌘ S`, and Mango asks before closing a tab with unsaved edits. If a file changes on disk while you edit it (an agent, the terminal), saving stops and asks whether to discard your edits or overwrite the file. Binary files and files over 5 MB are not opened.
- **Changes (left sidebar, next to files):** git status, diffs in the main pane (side by side or one column), stage / unstage / discard, commit, fetch / pull / push, branches, history.
- **Unity Version Control (Plastic SCM):** a folder inside a Unity VCS workspace (it has a `.plastic` folder) uses the same Changes view, diffs and branch popup, driven by your own `cm` client. Pending changes, diffs, checkin, undo, update, changeset history, and branches (`/main/...`: switch, create, rename, delete) all work. Unity VCS has no staging area: what you stage is what the next checkin takes (nothing staged takes everything), and Mango remembers that choice while it runs. There is no fetch, push, amend, merge or rebase for Unity VCS in Mango. Sign in with the Unity Version Control app or Unity Hub; Mango never handles credentials.
- **Terminal:** a real PTY docked at the bottom, with tabs. Mango finds the shells on your machine (login shell and `/etc/shells` on Linux/macOS; PowerShell, Command Prompt, Git Bash, MSYS2/Cygwin, Nushell and WSL distributions on Windows); pick one per terminal from the arrow next to the +, and set the default, font size and cursor in Settings > Terminal.
- **Attachments:** paste a screenshot or copied files into the message box, pick files with the paperclip, or drop them on a chat. Mango keeps a copy in its app data folder; Claude Code gets images inline and other files by path (with read access to that folder), Codex gets images by path. Up to 10 per message, 25 MB each; large images are shrunk to fit the model's limits.
- **Voice input:** press the microphone in the message box (or `Ctrl/⌘ Shift Space`) and speak; press it again and the transcript lands at the caret (Esc discards). Speech is turned into text on your computer by OpenAI's Whisper (run in Rust with candle), in any of its ~100 languages, detected automatically. In Settings > Voice pick a model (Tiny 154 MB, Base 293 MB, Small 969 MB), download it once from Hugging Face (pinned and checksum-verified), choose and test the microphone, fix the language, and optionally send as soon as the transcript is in.
- **Updates:** checks the latest GitHub release at launch and every hour; **Update** in the titlebar downloads, verifies and installs it, then restarts Mango.
- **Get started:** on the first launch, a dialog shows whether Claude Code, Codex and Git are installed and signed in, installs what is missing with each vendor's own installer (run in an embedded terminal, so you see and answer it), and signs you in. Open it again from the command palette.
- **Settings:** installed agents, sign in / sign out (runs the CLI's own login in an embedded terminal), default agent and permission mode, theme and color scheme (Mango, Blue, Purple, Pink, Graphite).
- **Branches:** click the branch name (titlebar or Changes view) for a JetBrains-style popup: search, update / push / fetch, local and remote branches, and per-branch checkout, new branch from, merge, rebase, rename and delete. For Unity VCS a new branch is a child of the one it starts from (`task` from `/main` is `/main/task`).
- **Sidebar:** shows the chats of the project picked in the titlebar, grouped by status: Working on top, Settled and Archived at the bottom of the list, where they fold away.
- **Chat status:** Working, Settled and Archived (plus "Needs you" and "Failed" while a run needs attention). New chats and every finished turn are Working; a chat is Settled only when you press the check mark on its sidebar row (press it again to go back to Working). Archive from the thread's menu in the sidebar.
- **Order:** drag chats in the sidebar to arrange them (or Alt+↑ / Alt+↓, or Move up / Move down in the menu). New chats arrive on top, and the list holds still while agents answer: activity never reorders it.
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
| `Ctrl/⌘ Shift E` | Switch the sidebar between threads and files |
| `Ctrl/⌘ Shift G` | Switch the sidebar between threads and changes |
| `Ctrl/⌘ S` | Save the file in the active tab |
| `Ctrl/⌘ ,` | Settings |
| `Ctrl/⌘ \` | Split chat / close split |
| `Ctrl/⌘ W` | Close tab |
| `Ctrl/⌘ 1…9` | Switch tab |
| `Ctrl/⌘ Shift Space` | Dictate in the message box (again to transcribe, Esc to discard) |

## Layout

```
app/                  Nuxt frontend
  agents/             agent adapters: claude.ts, codex.ts (CLI protocol -> events), index.ts (runtime)
  assets/css/         design tokens (tokens.css) and base styles
  components/         titlebar, sidebar, chat, terminal, git, files, settings, welcome hub, dialogs, palette
  composables/        useBackend (typed IPC + browser mock), useShortcuts
  stores/             workspace (projects, layout), threads (chats, panes), git, files (tree, open files), voice
  types/ipc.ts        the frontend <-> Rust contract
src-tauri/src/        Rust backend
  agent_proc.rs       starts agent CLIs, bridges their stdio as events
  auth.rs             agent sign-in status / sign-out
  setup.rs            Get started: installed tools and the per-OS installer recipes
  vcs.rs              the source-control commands: picks git or Unity VCS per folder
  git.rs              git for the changes panel
  files.rs            the Files view: list folders, read and save files inside the project
  plastic.rs          Unity Version Control (`cm`) for the same commands
  pty.rs              terminals
  projects.rs         projects, clone, recents
  updater.rs          self-update from GitHub releases
  voice.rs            voice input: Whisper model download and local speech-to-text
scripts/try-agent.ts  run an adapter against the real CLI from a terminal
PRODUCT.md            product context
DESIGN.md             design system
```

## Next

- Multiple-choice questions from agents.
- "Always allow" rules for approvals.
- Move chat history from localStorage to a file in the app data dir.
- Per-thread git worktrees.
