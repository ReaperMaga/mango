<img src="assets/icon.svg" width="64" height="64" alt="">

# Mango

A desktop workbench for coding agents. Open a project, run several Claude Code
and Codex chats side by side, and keep a real terminal docked at the bottom.

Built with Rust + [Tauri 2](https://tauri.app) and [Nuxt 4](https://nuxt.com) (SPA).

**Documentation:** [reapermaga.github.io/mango](https://reapermaga.github.io/mango/): install, guides and development notes.

## Status

- **Projects:** open a folder, create a project (with `git init`), clone a repository with live git progress, recent projects.
- **Agents:** real Claude Code and Codex runs. Mango starts your installed `claude` / `codex` CLI for each turn, streams text, thinking and tool calls (runs of steps fold into one summary line, such as "Ran 3 commands, read 2 files", that opens on click), shows diffs and command output, and asks you before edits and commands (per the chat's permission mode: Plan, Ask first, Accept edits, Full auto). Conversations resume across turns and app restarts. The model picker shows every model the installed CLI offers your account (asked from the CLI itself, without running a turn, and cached), and the effort chip next to it shows and sets the reasoning effort per chat (Claude Code: low to max; Codex: the levels its model accepts). With no level picked it shows the level the CLI will use (Claude Code's from your settings, Codex's per model), else "Default". You can keep writing while an agent works: sending steers it, and it reads the message at its next step within the same turn. A message the run can't take right then goes out as the next turn once it finishes (Stop drops it).
- **Background tasks and sub-agents (Claude Code):** commands the agent starts in the background (or that outlive their timeout) and sub-agents nobody waits for are listed above the composer while they run, with how long each has run, a peek at a command's output and a stop button. The run stays open until they finish, and when one does, Claude Code picks it up by itself in a new reply that says what finished. Each sub-agent gets a read-only chat of its own, nested under the chat that started it in the sidebar (sub-agents of sub-agents nest further), opened from there or from the "Open" link on its Delegated row.
- **Slash commands:** type `/` at the start of a message to list the commands of the chat's agent, filtered as you type (arrows to move, Tab to complete, Enter to run or complete, Esc to close). Claude Code's list comes from the CLI itself, so it includes its built-ins that work outside the terminal UI (`/compact`, `/context`, `/code-review`, …) and your own commands and skills. For Codex, Mango runs `/review` (the uncommitted changes, or your instructions), `/compact` and `/init` through the Codex app-server, and lists your Codex skills. `/clear` is Mango's own for both: the chat starts a new conversation and the agent forgets the messages above. A command sent while the agent works waits and runs as a turn of its own.
- **Files (tool window on the right):** the project's folders as a tree, with git status and ignored files dimmed. A click previews a file in a tab beside the chats (the next click replaces it); a double-click or an edit keeps the tab. Files open in a Monaco editor: save with `Ctrl/⌘ S`, and Mango asks before closing a tab with unsaved edits. If a file changes on disk while you edit it (an agent, the terminal), saving stops and asks whether to discard your edits or overwrite the file. Pictures (PNG, JPEG, GIF, WebP, AVIF, BMP, ICO) open in an image viewer that fits them to the pane and zooms (buttons, `Ctrl` + wheel, `+` / `-` / `0`); SVG files open as a picture with a Preview / Code switch, and the preview follows unsaved edits. Other binary files and text files over 5 MB are not opened.
- **Changes (tool window on the right):** git status, diffs in the main pane (side by side or one column), stage / unstage / discard, commit, fetch / pull / push, branches, history.
- **Pull requests (tool window on the right):** the pull requests and issues linked to the chat in front of you. When the agent opens one in a chat (`gh pr create`, `gh issue create`, or a GitHub MCP tool), Mango links it to that chat and opens it beside the chats: state, title, author, branches, changes, checks and review, labels, and the description as GitHub renders it, pictures included. The tool row that created it gets a `#42` button that shows it again, and the chat's row in the sidebar leads its title with the pull request's icon, coloured by its state, and shows its number (`+1` when more are linked). While a pull request is open in the tool window, Mango keeps reading it (every 10 seconds while checks run, every minute otherwise) and lists each check, failed ones first, each opening its log on GitHub; when all of them pass it just says so. Merge it from there with any method the repository allows (merge commit, squash, rebase); Mango asks once more first, and GitHub refuses if the branch got new commits since you looked. Link others by hand with a link, `owner/repo#12` or `#12` (looked up in the project's GitHub repository). Details are read through the [GitHub CLI](https://cli.github.com) (`gh`), signed in with `gh auth login`; Mango never sees a token. Descriptions are sanitised before they are shown.
- **Unity Version Control (Plastic SCM):** a folder inside a Unity VCS workspace (it has a `.plastic` folder) uses the same Changes view, diffs and branch popup, driven by your own `cm` client. Pending changes, diffs, checkin, undo, update, changeset history, and branches (`/main/...`: switch, create, rename, delete) all work. Unity VCS has no staging area: what you stage is what the next checkin takes (nothing staged takes everything), and Mango remembers that choice while it runs. There is no fetch, push, amend, merge or rebase for Unity VCS in Mango. Sign in with the Unity Version Control app or Unity Hub; Mango never handles credentials.
- **Terminal:** a real PTY docked at the bottom, with tabs. Mango finds the shells on your machine (login shell and `/etc/shells` on Linux/macOS; PowerShell, Command Prompt, Git Bash, MSYS2/Cygwin, Nushell and WSL distributions on Windows); pick one per terminal from the arrow next to the +, and set the default, font size and cursor in Settings > Terminal.
- **Attachments:** paste a screenshot or copied files into the message box, pick files with the paperclip, or drop them on a chat. Mango keeps a copy in its app data folder; Claude Code gets images inline and other files by path (with read access to that folder), Codex gets images by path. Up to 10 per message, 25 MB each; large images are shrunk to fit the model's limits.
- **Voice input:** press the microphone in the message box (or `Ctrl/⌘ Shift Space`) and speak; press it again and the transcript lands at the caret (Esc discards). Speech is turned into text on your computer by OpenAI's Whisper (run in Rust with candle), in any of its ~100 languages, detected automatically. In Settings > Voice pick a model (Tiny 154 MB, Base 293 MB, Small 969 MB), download it once from Hugging Face (pinned and checksum-verified), choose and test the microphone, fix the language, and optionally send as soon as the transcript is in.
- **Remote environments:** run agents inside [Incus](https://linuxcontainers.org/incus/) containers and VMs on a server you reach over SSH (Settings > Environments, also "Environments" in the command palette and on the welcome screen). Add a server by its SSH destination (`user@host` or a `~/.ssh/config` alias, optional port and key file); all it needs is SSH access and sudo. On a plain Debian or Ubuntu server Mango installs Incus for you from the server's page (its packages, a storage pool and a network, and your SSH user in `incus-admin`), sets up an Incus that is installed but not initialised, and updates it later; the setup runs in a terminal you watch, where `sudo` can ask for your password. An existing Incus works as is, optionally with an Incus remote that points at IncusOS hosts. Nothing of Mango's keeps running on the server: every action is one `ssh … incus …` call signed in with your own SSH keys and agent, and Mango never sees a password. Create an environment (Ubuntu or Debian, container or VM, CPUs, memory, disk) and pick components to install with one click: the `agent` user and build tools, Claude Code, Codex, GitHub CLI, Node.js, an XFCE desktop and Tailscale. Installing again updates them, and each install runs in a terminal you watch. Start, stop, restart and delete (you type the name to confirm), sign in to Claude Code, Codex, GitHub CLI or Tailscale with each tool's own flow in a terminal inside the environment, open a shell, view the desktop in Mango (noVNC, tunnelled over SSH, never exposed to the network), and open a project folder there (optionally cloning a repository into it). Chats on that project run the agent inside the environment as the `agent` user, and the terminal opens a shell there; stopping a run stops the agent's processes in the environment too. Pictures are attached inline; other attachments stay on your computer. Changes, Files and Pull requests are not available for remote projects yet. **Tailscale** is optional per server: new environments join your tailnet with the tags you set (for example `tag:mango`, so your ACLs keep them on their own network) and Tailscale SSH. They sign in through a link in the terminal, or with an auth key read from a file on the server (never by Mango).
- **Updates:** checks the latest GitHub release at launch and every hour; **Update** in the titlebar downloads, verifies and installs it, then restarts Mango.
- **Get started:** on the first launch, a dialog shows whether Claude Code, Codex and Git are installed and signed in, installs what is missing with each vendor's own installer (run in an embedded terminal, so you see and answer it), and signs you in. Open it again from the command palette.
- **Usage limits:** the gauge in the titlebar (or `Ctrl/⌘ Shift U`, or the command palette) shows how much of each plan's 5-hour and weekly allowance Claude Code and Codex have used, per-model weekly limits where the plan has them, and when each window resets. Mango asks the CLIs themselves (`get_usage` for Claude Code, `account/rateLimits/read` for Codex), which spends no quota.
- **Settings:** installed agents, sign in / sign out (runs the CLI's own login in an embedded terminal), default agent and permission mode, theme and color scheme (Mango, Blue, Purple, Pink, Graphite).
- **Branches:** click the branch name (titlebar or Changes view) for a JetBrains-style popup: search, update / push / fetch, local and remote branches, and per-branch checkout, new branch from, merge, rebase, rename and delete. The Local and Remote sections start folded (searching opens them); the trash button on Local deletes every local branch except the current one and `main` / `master` / `develop` / `trunk`, after a confirmation that lists them, and asks once more before deleting any with unmerged commits. Results read as a short summary, such as "Pulled 3 commits into main" with the files and lines changed, instead of git's raw output; failures keep git's own words. For Unity VCS a new branch is a child of the one it starts from (`task` from `/main` is `/main/task`).
- **Sidebar:** shows the chats of the project picked in the titlebar, grouped by status: Working on top, Settled and Archived at the bottom of the list, where they fold away. A chat's sub-agents fold under it (open while one of them works).
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
| `Ctrl/⌘ Shift E` | Show or hide the Files tool window |
| `Ctrl/⌘ Shift G` | Show or hide the Changes tool window |
| `Ctrl/⌘ Shift P` | Show or hide the Pull requests tool window |
| `Ctrl/⌘ S` | Save the file in the active tab |
| `Ctrl/⌘ ,` | Settings |
| `Ctrl/⌘ Shift U` | Usage limits |
| `Ctrl/⌘ \` | Split chat / close split |
| `Ctrl/⌘ W` | Close tab |
| `Ctrl/⌘ 1…9` | Switch tab |
| `Ctrl/⌘ Shift Space` | Dictate in the message box (again to transcribe, Esc to discard) |

## Layout

```
app/                  Nuxt frontend
  agents/             agent adapters: claude.ts, codex.ts (CLI protocol -> events), index.ts (runtime)
  assets/css/         design tokens (tokens.css) and base styles
  components/         titlebar, sidebar, chat, terminal, git, files, envs (remote environments), settings, welcome hub, dialogs, palette
  composables/        useBackend (typed IPC + browser mock), useShortcuts
  stores/             workspace (projects, layout), environments (servers, instances), threads (chats, panes, linked pull requests), git, files (tree, open files), links (pull request details), voice
  types/ipc.ts        the frontend <-> Rust contract
src-tauri/src/        Rust backend
  agent_proc.rs       starts agent CLIs, bridges their stdio as events
  auth.rs             agent sign-in status / sign-out
  setup.rs            Get started: installed tools and the per-OS installer recipes
  vcs.rs              the source-control commands: picks git or Unity VCS per folder
  git.rs              git for the changes panel
  files.rs            the Files view: list folders, read and save files inside the project
  github.rs           pull requests and issues linked to chats, read through the GitHub CLI
  plastic.rs          Unity Version Control (`cm`) for the same commands
  pty.rs              terminals
  projects.rs         projects, clone, recents
  updater.rs          self-update from GitHub releases
  voice.rs            voice input: Whisper model download and local speech-to-text
  envs/               remote environments: ssh + incus (hosts, instances, component recipes, remote shells and agents, desktop tunnel)
scripts/try-agent.ts  run an adapter against the real CLI from a terminal
PRODUCT.md            product context
DESIGN.md             design system
```

## Next

- Multiple-choice questions from agents.
- "Always allow" rules for approvals.
- Move chat history from localStorage to a file in the app data dir.
- Per-thread git worktrees.
