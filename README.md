<img src="assets/icon.svg" width="64" height="64" alt="">

# Mango

A desktop workbench for coding agents. Open a project, run several Claude Code
and Codex chats side by side, and keep a real terminal docked at the bottom.

Built with Rust + [Tauri 2](https://tauri.app) and [Nuxt 4](https://nuxt.com) (SPA).

**Documentation:** [reapermaga.github.io/mango](https://reapermaga.github.io/mango/): install, guides and development notes.

## Status

- **Projects:** open a folder, create a project (with `git init`), clone a repository with live git progress, recent projects. The project menu lists the open projects with their branches; the × on a row (or Delete) closes one.
- **Agents:** real Claude Code and Codex runs. Mango starts your installed `claude` / `codex` CLI for each turn, streams text, thinking and tool calls (runs of steps fold into one summary line, such as "Ran 3 commands, read 2 files", that opens on click), shows diffs and command output, ends each reply with the files it changed (a folder tree with added and removed lines per file and folder; a click opens the file's diff, or the file once its changes are committed, and "Review" opens Changes), and asks you before edits and commands (per the chat's permission mode: Plan, Ask first, Accept edits, Full auto). When an agent asks you something (Claude Code's multiple-choice questions, Codex's questions, or a form or sign-in link from one of their MCP servers), it shows as a card in the chat: pick options, type your own answer, then Answer or Dismiss; the chat shows "Needs your answer" meanwhile, and secret answers are never saved with the chat. Conversations resume across turns and app restarts. The model picker shows every model the installed CLI offers your account (asked from the CLI itself, without running a turn, and cached), and the effort chip next to it shows and sets the reasoning effort per chat (Claude Code: low to max; Codex: the levels its model accepts). With no level picked it shows the level the CLI will use (Claude Code's from your settings, Codex's per model), else "Default". You can keep writing while an agent works: the message waits in a queue above the input and goes out as the next turn once the run finishes, so the agent is not disturbed. "Send now" on a queued message hands it to the running turn instead (the agent reads it at its next step; if the run can't take it, it still goes out as the next turn). Stop keeps the queue but sends nothing until you send a message again or press "Send now".
- **Background tasks and sub-agents (Claude Code):** commands the agent starts in the background (or that outlive their timeout) and sub-agents nobody waits for are listed above the composer while they run, with how long each has run, a peek at a command's output and a stop button. The run stays open until they finish, and when one does, Claude Code picks it up by itself in a new reply that says what finished. Each sub-agent gets a read-only chat of its own, nested under the chat that started it in the sidebar (sub-agents of sub-agents nest further), opened from there or from the "Open" link on its Delegated row.
- **Slash commands:** type `/` at the start of a message to list the commands of the chat's agent, filtered as you type (arrows to move, Tab to complete, Enter to run or complete, Esc to close). Claude Code's list comes from the CLI itself, so it includes its built-ins that work outside the terminal UI (`/compact`, `/context`, `/code-review`, …) and your own commands and skills. For Codex, Mango runs `/review` (the uncommitted changes, or your instructions), `/compact` and `/init` through the Codex app-server, and lists your Codex skills. `/clear` is Mango's own for both: the chat starts a new conversation and the agent forgets the messages above. `/create-pr` is Mango's too: the agent follows the project's own conventions to commit the work on the branch (on a new branch if you are on the default one), run the project's checks, push, and open a GitHub pull request with `gh`, then reports the link and how each check went. Notes after the command go along (`/create-pr draft, mention the migration`). The new pull request is linked to the chat. A command sent while the agent works waits and runs as a turn of its own.
- **Files (tool window on the right):** the project's folders as a tree, with git status and ignored files dimmed. A click previews a file in a tab beside the chats (the next click replaces it); a double-click or an edit keeps the tab. Files open in a Monaco editor: save with `Ctrl/⌘ S`, and the gutter marks what changed since the last commit, as you type (a green bar for added lines, the modified colour for changed ones, a red wedge where lines were removed, and the same marks on the scrollbar); click a mark to see the committed lines and Revert them (undo brings your edit back), and Mango asks before closing a tab with unsaved edits. If a file changes on disk while you edit it (an agent, the terminal), saving stops and asks whether to discard your edits or overwrite the file. Pictures (PNG, JPEG, GIF, WebP, AVIF, BMP, ICO) open in an image viewer that fits them to the pane and zooms (buttons, `Ctrl` + wheel, `+` / `-` / `0`); SVG files open as a picture with a Preview / Code switch, and the preview follows unsaved edits. Other binary files and text files over 5 MB are not opened.
- **Changes (tool window on the right):** git status, diffs in the main pane (side by side or one column), stage / unstage / discard, commit, fetch / pull / push, branches, history.
- **Worktrees (parallel chats):** start a chat in its own git worktree (`Ctrl/⌘ Shift N`, the caret beside "+" in the sidebar, or "New chat in a worktree" in the command palette) and it gets its own folder and branch, so several agents can change the same project at once without touching each other's files or your project folder. The worktree is made when you send the first message: Mango names a new branch after it (`fix-the-login-redirect`, with `-2` … when taken) and adds the folder beside the repository (`<repo>.worktrees/<branch>`) from the project's current commit. The same menu continues in a worktree that is already there, with a new chat. The working copy in view follows the chat in front of you: the titlebar's branch, the Changes and Files tool windows, the branch popup and new terminals all work in that chat's worktree. Worktree chats show their branch in the sidebar and a worktree mark on their tab. "Remove worktree…" in a chat's menu removes the folder and keeps the branch and its commits; it refuses while the worktree has uncommitted changes unless you confirm once more. A project opened from a linked worktree is recognised as one too. In a Unity VCS project the same commands give a chat its own **workspace** instead: a child of the current branch named after the first message (`/main/task/fix-the-login`), in a new workspace of the same repository at `<project>.worktrees/<name>`, which first downloads that branch's files (this can take a while on a big project; the chat says so while it waits). "Remove workspace…" deletes that workspace and its folder and keeps the branch; it refuses with pending changes unless you confirm once more.
- **Pull requests (tool window on the right):** the pull requests and issues linked to the chat in front of you. When the agent opens one in a chat (`gh pr create`, `gh issue create`, or a GitHub MCP tool), Mango links it to that chat and opens it beside the chats: state, title, author, branches, changes, checks and review, labels, and the description as GitHub renders it, pictures included. The tool row that created it gets a `#42` button that shows it again, and the chat's row in the sidebar leads its title with the pull request's icon, coloured by its state, and shows its number (`+1` when more are linked). While a pull request is open in the tool window, Mango keeps reading it (every 10 seconds while checks run, every minute otherwise) and lists each check, failed ones first; when all of them pass it just says so. A GitHub Actions check opens its log right there, laid out like GitHub's job page: the job's steps with their state and time, each opening to its numbered log, with `##[group]` sections folded, errors and warnings marked and colours kept. A failed step opens by itself and its first error scrolls into view; while the job still runs, its steps update every few seconds and the log follows once it finishes. The `#42` button at the top (or Esc) goes back to the pull request. Other checks open their details on their own site. Merge it from there with any method the repository allows (merge commit, squash, rebase); Mango asks once more first, and GitHub refuses if the branch got new commits since you looked. Link others by hand with a link, `owner/repo#12` or `#12` (looked up in the project's GitHub repository). Details are read through the [GitHub CLI](https://cli.github.com) (`gh`), signed in with `gh auth login`; Mango never sees a token. Descriptions are sanitised before they are shown.
- **Browser:** real web pages in tabs beside the chats (the globe button at the right of the tab strip, `Ctrl/⌘ Shift B`, or "New browser tab" in the command palette), so a dev server's page can sit next to the chat working on it: split it right, reload, go back and forward, open the page in your system browser, or open its developer tools. Type `localhost:3000` (or `127.0.0.1:8080`, `[::1]:3000`) and Mango adds `http://`; an address with a dot gets `https://`; anything else is not searched for. Links to local dev servers (`localhost`, `127.0.0.1`, `0.0.0.0`, `[::1]`, `*.localhost`) in chats and in the terminal open in a browser tab beside the chat; other links still open in your system browser. Claude Code and Codex get browser tools for each chat: they open a page, read it (a snapshot of the page), click, type, press keys, scroll, run JavaScript, read the console and take screenshots. The first time an agent uses them in a chat, a browser tab opens beside that chat (its tooltip says which chat opened it). With Claude Code, reading the page, its console and screenshots runs without asking; everything else follows the chat's permission mode. Pages load only over http(s), never get access to Mango itself, and close with their tab (they are not restored after a restart). Remote projects get the browser too: `localhost` addresses in a remote project's browser are the environment's own, tunnelled over SSH (on the same port number here when it is free), and agents running in an environment reach the browser tools through a reverse SSH forward (an Incus proxy device `mango-browser` on the instance while Mango runs; joined environments use the SSH forward alone). Limits: screenshots work on Linux only for now; local `https` addresses in a remote project are not supported yet; the page is a native view drawn over the app, so it hides while a menu, dialog, the command palette or Settings is open, and while you drag a divider.
- **Unity Version Control (Plastic SCM):** a folder inside a Unity VCS workspace (it has a `.plastic` folder) uses the same Changes view, diffs and branch popup, driven by your own `cm` client. Pending changes, diffs, checkin, undo, update, changeset history, branches (`/main/...`: switch, create, rename, delete), and shelves (shelve the changes, optionally undoing them so the workspace is clean, then apply or delete a shelve from the Changes view) all work. Locks too: locked files show who holds them, a Locks section lists every lock in the repository, a file row's context menu locks a file (by checking it out, as the server's lock rules decide) or releases your own lock, and the checkin line warns when a file you are about to check in is locked by someone else. The Pull requests tool window shows its code reviews instead: the reviews of the current branch and the open ones in the repository, with status and each reviewer's verdict, and asks for a review of the branch (title and optional reviewers) through `cm codereview`; commenting and approving stay in Unity VCS. Unity VCS has no staging area: what you stage is what the next checkin takes (nothing staged takes everything), and Mango remembers that choice while it runs. Merge into the workspace from the branch popup: Mango shows what the merge changes first, leaves the result as staged pending changes to check in, and leaves merges with conflicts to the Unity Version Control app. There is no fetch, push, amend or rebase for Unity VCS in Mango. Sign in with the Unity Version Control app or Unity Hub; Mango never handles credentials.
- **Terminal:** a real PTY docked at the bottom, with tabs. Mango finds the shells on your machine (login shell and `/etc/shells` on Linux/macOS; PowerShell, Command Prompt, Git Bash, MSYS2/Cygwin, Nushell and WSL distributions on Windows); pick one per terminal from the arrow next to the +, and set the default, font size and cursor in Settings > Terminal.
- **Attachments:** paste a screenshot or copied files into the message box, pick files with the paperclip, or drop them on a chat. Mango keeps a copy in its app data folder; Claude Code gets images inline and other files by path (with read access to that folder), Codex gets images by path. Up to 10 per message, 25 MB each; large images are shrunk to fit the model's limits.
- **Pictures in replies:** when an agent's reply shows a picture with markdown (`![alt](path)`), Mango shows it in the chat if the path is a file on your computer: absolute, `file://`, or relative to the project. Click it to open it full size. Only real PNG, JPEG, GIF, WebP, AVIF and BMP files (judged by their contents, up to 25 MB) are read, and pictures on the web are never fetched; they stay as text.
- **Voice input:** press the microphone in the message box (or `Ctrl/⌘ Shift Space`) and speak; press it again and the transcript lands at the caret (Esc discards). Speech is turned into text on your computer by OpenAI's Whisper (run in Rust with candle), in any of its ~100 languages, detected automatically. In Settings > Voice pick a model (Tiny 154 MB, Base 293 MB, Small 969 MB), download it once from Hugging Face (pinned and checksum-verified), choose and test the microphone, fix the language, and optionally send as soon as the transcript is in.
- **Remote environments:** run agents inside [Incus](https://linuxcontainers.org/incus/) containers and VMs on a server you reach over SSH (Settings > Environments, also "Environments" in the command palette and on the welcome screen). Add a server by its SSH destination (`user@host` or a `~/.ssh/config` alias, optional port and key file); all it needs is SSH access and sudo. On a plain Debian or Ubuntu server Mango installs Incus for you from the server's page (its packages, a storage pool and a network, and your SSH user in `incus-admin`), sets up an Incus that is installed but not initialised, and updates it later; the setup runs in a terminal you watch, where `sudo` can ask for your password. An existing Incus works as is, optionally with an Incus remote that points at IncusOS hosts. Nothing of Mango's keeps running on the server: every action is one `ssh … incus …` call signed in with your own SSH keys and agent, and Mango never sees a password. Create an environment (Ubuntu or Debian, container or VM, CPUs, memory, disk) and pick components to install with one click: the `agent` user and build tools, Claude Code, Codex, GitHub CLI, Node.js, an XFCE desktop and Tailscale. Installing again updates them, and each install runs in a terminal you watch. Start, stop, restart and delete (you type the name to confirm), rename (Incus renames only stopped environments, so a running one is stopped and started again; its projects and chats in Mango move to the new name) and resize (CPUs, memory and disk from the environment's page, under its ⋯ menu; a disk only grows, and a VM's file system grows when it next starts), sign in to Claude Code, Codex, GitHub CLI or Tailscale with each tool's own flow in a terminal inside the environment, open a shell, view the desktop in Mango (noVNC, tunnelled over SSH, never exposed to the network), and open a project folder there (optionally cloning a repository into it). Projects also go into an environment from the usual flows: Open folder, New project and Clone repository (project menu, welcome screen, command palette) have a **Where** choice, this computer or any running environment (grouped by server, with "Shared with you" last), and Mango remembers the last one. In an environment, Open folder browses its folders in Mango's own picker (git repositories marked, or type a path), New project makes the folder there (with `git init` if you want it), and Clone runs `git clone` inside it (private repositories need the GitHub CLI signed in there). The **Environment** tool window, the first button on the right-hand tool stripe, shows where the active project runs: a laptop for this computer, a server for an environment, with a mark when it is stopped or can't be reached. It holds the folder, the environment's state and addresses, a shell in the terminal dock, its desktop, the CLIs' sign-ins, its components with versions and updates, and who it is shared with; it checks the environment when it opens, never in the background. Chats on that project run the agent inside the environment as the `agent` user, and the terminal opens a shell there; stopping a run stops the agent's processes in the environment too. Pictures are attached inline; other attachments stay on your computer. The Changes view and the branch popup work there too: git runs inside the environment as the `agent` user, so commits use that user's git identity and pushes its credentials (for example the GitHub CLI signed in there); it is read a little less often than on this computer, since every read goes over SSH. The titlebar shows the project's branch there, next to a server mark that opens the Environment tool window. The Files view browses, opens and saves files inside the environment (every path stays inside the project folder), and the Pull requests view finds the GitHub repository from the git remotes in the environment, then reads and merges through the GitHub CLI on this computer. **Tailscale** is optional per server: new environments join your tailnet with the tags you set (for example `tag:mango`, so your ACLs keep them on their own network) and Tailscale SSH. They sign in through a link in the terminal, or with an auth key read from a file on the server (never by Mango). **Sharing:** give one person full access to one environment, and nothing else on the server, with a one-line `mango://join/…` link or its QR code (Sharing on the environment's page, "Share…"). Say who it is for, how they reach it (over the internet, through a port on the server that leads only into that environment, using the server's public address or its SSH host; or Tailscale, the environment's tailnet address, when the person is on your tailnet), and when access ends (1, 7 or 30 days, or never). The first share installs an SSH server in the environment, which can take a few minutes. The link is a key: it gives root inside the environment, Mango shows it only once and keeps no copy, so send it privately. Revoke any share from the same list and the link stops working. **Joining:** whoever gets a link needs no server of their own: open it in Mango, or paste it under Settings > Environments > "Join with a link" (also "Join a shared environment" in the command palette). Mango shows what it leads to and when access ends before saving anything, then connects straight into that environment; it appears under "Shared with you" with everything above except starting, stopping, deleting and sharing. "Leave" removes it and deletes its key from your computer.
- **Updates:** checks the latest GitHub release at launch and every hour; **Update** in the titlebar downloads, verifies and installs it, then restarts Mango.
- **Get started:** on the first launch, a dialog shows whether Claude Code, Codex and Git are installed and signed in, installs what is missing with each vendor's own installer (run in an embedded terminal, so you see and answer it), and signs you in. Open it again from the command palette.
- **Environment variables** per project, in Settings > Projects ("Project settings…" in the project menu, or "Environment variables" in the command palette), for local and remote projects. It lists the `.env` files at the project root (`.env`, `.env.*`, `*.env`; example and template files such as `.env.example` are left out until you add them by name with New file, as is any other name you choose). Edit a file as rows of name and value (values masked until you show them; paste `NAME=value` lines into a name to add them all) or as raw text; untouched lines, comments and quoting are kept. Edits stay as drafts until you save (`Ctrl/⌘ S`) or revert, and a file changed on disk meanwhile asks before it is overwritten. A file git doesn't ignore gets a warning and an "Add to .gitignore" button. Create and delete files there too (deleting asks first).
- **Titlebar:** the project and branch widgets (the branch shows commits to push or pull and the number of changed files), the command search, an activity widget (how many chats run and how many need you, that is, wait on an approval or an answer; sub-agent chats are left out; click it for a list and jump to one with the keyboard), the usage meter, one layout control for the sidebar, terminal and tool panel (`Ctrl/⌘ Alt B` toggles the tool panel, reopening the tool window used last) and Settings. The theme is in Settings > Appearance and the command palette.
- **Usage limits:** the usage meter in the titlebar (it shows the most used limit) (or `Ctrl/⌘ Shift U`, or the command palette) shows how much of each plan's 5-hour and weekly allowance Claude Code and Codex have used, per-model weekly limits where the plan has them, and when each window resets. Mango asks the CLIs themselves (`get_usage` for Claude Code, `account/rateLimits/read` for Codex), which spends no quota. The same limits, with their reset times, are in Settings > Agents > Usage. When a limit drops a lot before its scheduled reset (an extra reset, for example), Mango says so there until you dismiss it; it infers this from two reads, because the CLIs do not announce it.
- **Settings:** installed agents, sign in / sign out (runs the CLI's own login in an embedded terminal), default agent and permission mode, theme and color scheme (Mango, Blue, Teal, Green, Purple, Pink, Red, Slate, Uchiha, Graphite). Settings > Agents has a Subscription tab with the plan each agent is signed in with (Pro, Max, Plus, …), the account, and a link to manage it with the vendor. At the bottom of the sidebar, Settings opens a menu of the settings sections, and the button next to it (Code settings) picks the agent for the chat on screen and new chats, with Usage limits and Subscription below.
- **Branches:** click the branch name (titlebar or Changes view) for a JetBrains-style popup: search, update / push / fetch, local and remote branches, and per-branch checkout, new branch from, merge, rebase, rename and delete. The Local and Remote sections start folded (searching opens them); the trash button on Local deletes every local branch except the current one and `main` / `master` / `develop` / `trunk`, after a confirmation that lists them, and asks once more before deleting any with unmerged commits. Results read as a short summary, such as "Pulled 3 commits into main" with the files and lines changed, instead of git's raw output; failures keep git's own words. For Unity VCS a new branch is a child of the one it starts from (`task` from `/main` is `/main/task`), and merge asks first, listing the files it changes (rebase is git only).
- **Sidebar:** shows the chats of the project picked in the titlebar, grouped by status: Working on top, Settled and Archived at the bottom of the list, where they fold away. A chat's sub-agents fold under it (open while one of them works).
- **Chat status:** Working, Settled and Archived (plus "Needs you" and "Failed" while a run needs attention). New chats and every finished turn are Working; a chat is Settled only when you press the check mark on its sidebar row (press it again to go back to Working). Archive from the thread's menu in the sidebar.
- **Order:** drag chats in the sidebar to arrange them (or Alt+↑ / Alt+↓, or Move up / Move down in the menu). New chats arrive on top, and the list holds still while agents answer: activity never reorders it.
- Chat tabs, split view, per-thread drafts, command palette, dark and light themes. Right-click a tab for Close, Close others, Close to the right, Close all (files with unsaved edits stay open), Split right, Copy path for files, and Mark as settled or Archive for chats.

Mango uses the agents' own sign-in: it never sees or stores your credentials.

Chat history is saved in a SQLite database, `chats.sqlite3` in Mango's app data
folder. Saves are incremental: only the chats that changed are written, and a
reply is saved while it streams. Chats from older versions move there on first
launch. The agents keep their own session files (`~/.claude`, `~/.codex`) as usual.

Chats of a remote project are also kept inside its environment
(`~/.local/share/mango/chats/` of the `agent` user), so every computer that opens
that environment, yours or one it is shared with, sees the same chats. A change is
sent a few seconds after it happens (at least every 15 seconds while an agent
replies), and Mango looks for changes from other computers when a remote project
opens, when its window comes to the front, and every minute while it is in front.
Deleting such a chat deletes it on the other computers too. When two computers
change the same chat, the environment's copy wins, unless the chat is running
here. Chats of folders on this computer stay on this computer.

## Run it

```bash
pnpm install
pnpm app          # tauri dev: starts Nuxt on :1420 and opens the window
pnpm app:build    # release build + installers
pnpm bump minor   # new version (patch, minor, major or an exact 1.2.3) in every file that holds it
```

The version you are running, with the commit it was built from, is in Settings > Preferences. What changed in each version is in Settings > Changelog (the same file as the docs site's changelog, `docs/changelog.md`).

macOS needs the Xcode command line tools. Linux needs the Tauri system packages (`libwebkit2gtk-4.1-dev`, `libgtk-3-dev`,
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

## Mobile (iOS)

`mobile/` is a separate Expo / React Native app for the iPhone and iPad: your chats in Mango's remote
environments, on the go. Join an environment by scanning its share code (on the desktop: the environment's page,
**Share…**) or opening a `mango://join/…` link, or add a server by putting the phone's own key
in its `authorized_keys` (both under Settings). Home lists your chats; New chat starts one in any project of any
environment, or any folder in it. Read and continue chats with Claude Code and Codex (approvals, questions,
permission mode, model), mark them Working, Settled or Archived, attach photos, camera shots and files (they are put into the environment, so the agent reads
every kind, and pictures are shown to it directly), dictate messages with the microphone (iOS recognizes the speech on the
phone where it can; language and "send after dictation" under Settings > Voice), and review, commit and push the changes.
The phone speaks SSH itself
(SwiftNIO SSH, keys in the Keychain, host keys pinned) and runs the same commands in the environment as the
desktop, so chats sync both ways with every computer that opens it.

```bash
cd mobile
pnpm install
pnpm web             # the UI in a browser with a simulated environment (no SSH there)
pnpm ios             # a development build on the iOS simulator or a connected iPhone (needs Xcode 16.3+)
pnpm typecheck && pnpm test
npx eas-cli@latest build --profile development --platform ios   # or build it in the cloud with EAS
```

## Shortcuts

| Keys | Action |
| --- | --- |
| `Ctrl/⌘ K` | Command palette |
| `Ctrl/⌘ N` | New chat |
| `Ctrl/⌘ Shift N` | New chat in a worktree |
| `Ctrl/⌘ O` | Open folder |
| `Ctrl/⌘ J` or `` Ctrl/⌘ ` `` | Toggle terminal |
| `Ctrl/⌘ Shift T` | New terminal |
| `Ctrl/⌘ B` | Toggle sidebar |
| `Ctrl/⌘ Shift B` | New browser tab |
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
  stores/             workspace (projects, layout), environments (servers, instances, shares), threads (chats, panes, linked pull requests), git, files (tree, open files), links (pull request details), reviews (Unity VCS code reviews), voice
  types/ipc.ts        the frontend <-> Rust contract
src-tauri/src/        Rust backend
  agent_proc.rs       starts agent CLIs, bridges their stdio as events
  auth.rs             agent sign-in status / sign-out
  setup.rs            Get started: installed tools and the per-OS installer recipes
  vcs.rs              the source-control commands: picks git or Unity VCS per folder
  git.rs              git for the changes panel
  files.rs            the Files view: list folders, read and save files inside the project
  github.rs           pull requests and issues linked to chats, and GitHub Actions job logs, read through the GitHub CLI
  plastic/            Unity Version Control (`cm`) for the same commands; workspaces.rs: a workspace per chat
  pty.rs              terminals
  projects.rs         projects, clone, recents
  updater.rs          self-update from GitHub releases
  voice.rs            voice input: Whisper model download and local speech-to-text
  envs/               remote environments: ssh + incus (hosts, instances, component recipes, remote shells and agents, desktop tunnel)
mobile/               the iOS app (Expo, React Native): remote environments over SSH, chats, changes
scripts/try-agent.ts  run an adapter against the real CLI from a terminal
PRODUCT.md            product context
DESIGN.md             design system
```

## Next

- Multiple-choice questions from agents.
- "Always allow" rules for approvals.
