# Changelog

All notable changes to Mango. Versions follow [semantic versioning](https://semver.org); installers for each version are on its [GitHub release](https://github.com/ReaperMaga/mango/releases).

## 0.12.2

### Fixes

- On Windows, a Lore server's sign-in actions (set up, add or remove a user, the GitHub secret, turn off) and the actions on a Lore server on an SSH machine start again: they failed with "The filename or extension is too long" before reaching the server.

## 0.12.1

### Fixes

- `lore login` finishes again on a Lore server whose sign-in was set up or changed with 0.12.0: the sign-in page said "Unregistered redirect_uri". To repair such a server, open its sign-in and choose Change…, then Apply.

## 0.12.0

### New

- Open settings from the welcome screen.

### Fixes

- A Lore server's sign-in no longer stops answering after a token refresh (`lore login` failed with exit code 28). Mango now installs Dex 2.45.1 and a watchdog that restarts Dex if it hangs; to update a server, open its sign-in and choose Change…, then Apply.

## 0.11.0

### New

- Resolve merge conflicts in a three-pane merge editor, for git and Lore: accept yours, theirs or both per block, then mark the file resolved.
- Changes shows a merge, rebase, cherry-pick or revert in progress, with Continue, Skip and Abort, and can hand the conflicts to the chat's agent ("Solve with agent").
- Create a Lore repository in an existing folder, with a `.loreignore` suggested from `.gitignore`, Unity VCS or a Unity template. "Initialize repository" in Changes offers Git or Lore.
- Changes and the titlebar show which version control a folder uses (Git, Unity VCS or Lore).
- Lore can be installed from Get started.
- The Git log opens on all branches.

### Fixes

- The Git log works for Lore repositories instead of showing "Detached HEAD".
- Changes stays responsive with tens of thousands of changed files, in Lore and git.

## 0.10.3

### New

- Sign in to a Lore server from its environment page.

### Fixes

- A Lore server with sign-in that was saved without its port (`lores://domain`) gets port 41337 back by itself.

## 0.10.2

### Fixes

- Lore servers with sign-in are reached at their own port (`lores://…:41337`): without it the Lore CLI used port 443 and failed with "invalid compression flag: 84". Press "Use as Lore server" again to update a saved one.

## 0.10.1

### Fixes

- Requiring sign-in for a Lore server no longer stops with exit code 2 on its first setup.

## 0.10.0

### New

- Add /handoff to go on in a new chat from a short handoff.
- Require sign-in for Lore servers Mango sets up.

## 0.9.0

### New

- Add Epic Games' Lore, its servers, and servers Mango sets up.

## 0.8.0

### New

- Transcribe voice input live while recording.

## 0.7.0

### New

- GitLab in remote projects: `glab` runs inside the environment, signed in there, and falls back to this computer's sign-in when the environment has none.

## 0.6.0

### New

- Planner server: each space has people, and everyone can rename themselves (`POST /v1/me`, `planner-server person rename`).
- Assign people in planner collections, Notion-style.

### Fixes

- Show a planner server's collections when Mango starts.

## 0.5.0

### New

- Add the Planner plugin: boards and tables for tasks and notes.
- Sync Planner collections through a self-hosted planner server.

## 0.4.1

### Fixes

- Keep Claude Code running through attachments, Stop and passing errors.

## 0.4.0

- Choose from how many tokens large chats are compacted after a break, also per project.
- Change model or effort in a Claude Code chat without restarting it.
- Stop losing a message sent while Claude Code compacts a chat.

### New

- Offer to compact large Claude Code chats after a long break.

### Fixes

- Notice when a Claude Code chat went on in a terminal.
- Show only a reply's own cost when a Claude Code chat is resumed.

## 0.3.1

### Fixes

- Stop re-sending edited instruction files with every message to Claude Code.

## 0.3.0

### New

- Show a remote environment's usage limits in its projects.
- Add German and Russian interface languages.

## 0.2.0

### New

- Send PDFs and other files to agents in remote projects.
- Support GitLab for merge requests, issues, pipelines and releases.

### Fixes

- Say the name is taken when renaming a folder onto an empty one on Windows.

## 0.1.48

### New

- Open the project's GitHub repository from the titlebar and the phone.

### Fixes

- List the models a remote environment's agent offers.

## 0.1.47

### New

- Keep language servers loaded and tell them about changes on disk.

### Fixes

- Always offer an Other field on agent questions.

## 0.1.46

### Fixes

- Keep a running chat's messages when another device saves it: opening a remote chat on the phone while it ran on the desktop stopped the phone from seeing new messages, and the desktop lost the run's messages when it ended.

### Performance

- Fetch and Update in remote projects take one SSH round trip instead of five or six, so they finish seconds sooner on a distant server.

## 0.1.45

### Fixes

- Keep a chat in its project when its agent changes folders: a `cd` into a subfolder no longer counts as a worktree, which made Files, Unity detection and language servers work in that subfolder. Chats already caught by it go back to their project.

## 0.1.44

### New

- Colour types, methods and constants as the language server knows them.
- `/create-release` in any chat: the agent picks the next version, runs the checks, tags, pushes and publishes a GitHub release, following the project's own release steps.

## 0.1.43

### New

- Open decompiled library source on go to definition in C#.

## 0.1.42

### New

- Add autosave, autocomplete, language servers and a smooth caret.

## 0.1.41

### New

- Add the Unity plugin: file icons, `.meta` files that stay hidden and follow their assets, project details and reference search.
- Let plugins shape the Files view, file icons and editor languages.

### Fixes

- Size SVG plugin icons like the other icons.
- Keep agents starting on Windows when several plugins add to the system prompt.

## 0.1.40

### New

- Add view options and excluded files to the Files view.
- Build the Git log into Mango, so it no longer needs a plugin: an installed Git log plugin stops running and can be removed.
- Add create, rename, duplicate and delete to the Files view.
- List a fork under the chat it was branched from.

### Fixes

- Show restore on the maximize button when maximized, keep new chat on one line.
- Recognise ignored files in and next to submodules and linked folders.
- Show an empty history in the Git log for a repository with no commits.
- Keep what you type elsewhere out of a file that finishes opening.

## 0.1.39

### New

- Move the sidebar toggle into the sidebar.
- Git log plugin, a commit graph in the bottom panel.

## 0.1.38

### New

- Show every tool window on the stripe again, with terminal and environment at its foot.

## 0.1.37

### New

- Install plugins from git, browse the official catalog, plugin api.

## 0.1.36

### New

- Show the agent's plan and usage in the sidebar footer.
- Group appearance options and make uchiha visibly red.
- Show the tokens and cost a reply used.
- Put the tool windows behind one button with a dropdown, and clear the env, panel, settings and usage buttons from the titlebar.

### Fixes

- Stop the agent with Esc wherever focus is.

## 0.1.35

### New

- Replace the app mark with a mango split down its ridge.
- Copy, edit, ask again, branch and pin messages, find and jump through a chat.

## 0.1.34

### New

- Browse the project's open pull requests when no chat is open.

## 0.1.33

### Fixes

- Remove recent projects from the project menu.
- Remove a branch's worktree when deleting the branch.

## 0.1.32

### New

- List projects as one list in the project menu.

## 0.1.31

### Fixes

- Stop listing projects as open in a window that let them go.

## 0.1.30

### New

- Write the changelog from commits when bumping.
- List recent projects in the project menu.
- Title each window with its project's name.

## 0.1.29

### New

- Add a releases tool window with the runs that build them.
- Split two chats from different projects side by side.

## 0.1.28

### Agents and chats

- **Link pull requests and issues:** pick an open pull request or issue from the Pull requests tool window to link it to the chat.

### Mobile

- Pull requests on the phone, as on the desktop.
- Categorized settings, live chats and four new color schemes (Ink, Cocoa, Neon and Solar).

### Builds

- The macOS app is signed and notarized, and the iOS app ships through TestFlight.

## 0.1.27

### Agents and chats

- Menu flyouts of the run menu open from their row and animate.

## 0.1.26

### Agents and chats

- **One run menu:** pick agent, model, effort and permissions from a single menu.
- **Context window:** a chat shows how full the agent's context window is.

### Mobile

- Categorized settings, appearance options and project folders.

## 0.1.25

### Environments

- The browser reaches dev servers that listen only on IPv6 in remote environments.

## 0.1.24

### Windows

- Each window closes on its own, and Mango asks where to open a project.

## 0.1.23

### Settings

- **Notifications and shortcuts:** desktop notifications when a chat needs you, finishes or fails, and keyboard shortcuts you can rebind.

### Environments

- **Java:** add Java through SDKMAN, and pick Node and Java versions.
- Remote agent runs get the login's umask.

## 0.1.22

### Agents and chats

- **Tabs per pane:** each split pane has its own tab strip.
- A chat's tab and pane close when the chat is settled.

### Environments

- **Docker** is a one-click component.
- Remote agent runs stay alive and reconnect after a dropped connection.

## 0.1.21

### Windows

- Open projects and chats in their own windows.
- Long project names fit in the project menu.

### Mobile

- Pictures from agent replies show on the phone.

## 0.1.20

### Agents and chats

- **MCP servers:** add your own MCP servers to agent chats.
- The empty chat pane no longer suggests prompts.

### Environments

- A headless Chromium component for agents.

### Mobile

- **The iOS app:** open remote environments and their chats from the phone.

## 0.1.19

### Environments

- A remote project's chats are kept in its environment, so other computers see them.

## 0.1.18

### Builds

- **macOS:** builds and downloads for Apple Silicon and Intel.

## 0.1.17

### Interface

- Smooth transitions across chats, panels, lists and settings.

### Environments

- The branch popup and Files are faster on remote projects.

## 0.1.16

### Interface

- Polish for the titlebar, menus and the in-app browser preview.

## 0.1.15

### Interface

- A rebuilt titlebar with widgets and one aligned header row.
- Tab titles no longer sit below their icons.

## 0.1.14

### Agents and chats

- **Questions in the chat:** answer questions from the agent and from MCP servers right in the chat.
- **Changed files:** shown under replies and as markers in the editor gutter.

### Version control

- **Unity VCS:** locks, shelves, merge, per-chat workspaces and code reviews.

### Interface

- Tabs are pills with file-type icons.

## 0.1.13

### Environments

- **Rename and resize:** an environment's ⋯ menu gains **Rename…** and **Resize…**. Renaming a running environment stops and restarts it, and its projects, chats, worktrees and terminals move along. Resize sets CPUs and memory and grows the root disk (a disk only grows; a VM's file system grows on its next start).
- An environment's page shows its root disk size.

## 0.1.12

### Agents and chats

- **Worktrees in the sidebar:** the **+** in Active is a split button with **New chat in a worktree** (`Ctrl/⌘ Shift N`) and **Continue in** an existing worktree. A worktree chat starts without a dialog: the worktree is made on a branch named from its first message.
- **Worktrees in Changes:** a linked worktree shows how many commits it is ahead of its base, with **Merge into** the base, **Pull request**, and Reveal in Files, Open terminal here and Remove worktree. Chats follow Claude Code when it enters or leaves a worktree itself.

### Settings

- **More color schemes and appearance options:** Teal, Green, Red, Slate and Uchiha (black and crimson) join the color schemes, and Settings > Appearance gains Text size, Corners and Animations.
- **Settings rail:** General and Technical are headlines with their sections under them. General holds Preferences (the old General page), Appearance and Voice; Technical holds Environments, Terminal and the new Maintenance page, which now has Updates.
- **Fonts and project badges:** choose the interface and code fonts in Settings > Appearance (five each), and a project's badge now shows in the titlebar and the Recent list.
- **Behaviour** in Settings: the send shortcut, queue or steer for messages written while the agent works, and how many tool calls a chat shows.
- **Projects** in Settings: per project, a display name and badge color, pinning, archiving, the agent, model and permission mode new chats start with, and removing the project.
- **Archive** in Settings: all archived chats in one list, to restore or delete.
- **Confirmations:** optional questions before a chat is archived or deleted (Settings > Preferences).
- **Environment variables** in Settings > Projects: a project's `.env` files as fields or raw text, values hidden until shown, a warning with **Add to .gitignore** for a file git does not ignore, and no silent overwrite when the file changed on disk.

## 0.1.11

### Agents and chats

- **Queued messages:** a message written while an agent works waits in a queue above the input and goes out as the next turn, so the run is not disturbed. **Send now** hands it to the running turn instead; the agent reads it at its next step. Stop keeps the queue but sends nothing.
- **Worktree chats:** a chat can work in its own git worktree (`Ctrl/⌘ Shift N`), so several agents change one project at once without touching each other's files. The titlebar, Changes, Files and new terminals follow the chat in front.
- Chats are saved in a SQLite database.

### Settings

- **Notifications:** a desktop notification when a chat needs you, finishes or fails, while Mango is in the background; choose which, hide the chat's text, add a sound, and send a test, in Settings > Notifications.
- **Shortcuts:** change any keyboard shortcut in Settings > Shortcuts. Conflicts are refused, and tooltips, menus and the command palette follow your keys.
- **Changelog** in Settings and in the Settings menu of the sidebar: what changed in each version.

### Environments

- Remote projects open faster: ssh connections are reused and git reads are batched.

## 0.1.10

### Browser

- Browser tabs beside the chats, with tools the agents can use.

### Environments

- Files, pull requests and the branch work for remote projects.

## 0.1.9

### Agents and chats

- Mango's own **/create-pr** command.

### Settings

- **Subscription** and **Usage** tabs in Settings > Agents: the plan and organization each agent is signed in with, and its usage limits with their reset times. A limit that drops a lot before its scheduled reset is noticed and noted.
- The agent choice and Settings moved into menus in the sidebar footer.

### Sidebar and tabs

- Tabs have a context menu.

### Environments and pull requests

- Git runs inside remote environments, so the Changes view and the branch popup work there too.
- The pull request window shows the log of a GitHub Actions check.

## 0.1.8

### Environments

- **Remote environments:** run a project in a container or VM on your own server over ssh and Incus, with a terminal and desktop per instance. Set them up in **Settings > Environments**.

### Agents and chats

- Sub-agent chats show tree lines under their parent in the sidebar.
- Pictures in an agent's reply show when they come from files on your computer.

## 0.1.7

### Pull requests

- Merge a pull request from the Pull requests window, and see the list of its checks.

## 0.1.6

### Agents and chats

- **Pull requests and issues** an agent creates are linked to the chat and shown in a window on the right.
- **Background tasks** (commands run in the background, sub-agents) show under the message box, with their output and a stop button. Sub-agents get a chat of their own.

## 0.1.5

### Agents and chats

- **Slash commands** in the message box: type <kbd>/</kbd> for the commands and skills the agent offers.

### Files and changes

- Files and Changes moved to the right, next to the chat, as tool windows.
- Pictures open in an image viewer.

### Fixes

- The agent logo is centred on the chip label, and the effort meter is coloured for the default level.

## 0.1.4

### Agents and chats

- **Usage limits:** the 5-hour and weekly allowance of each agent, and when it resets.
- Runs of tool calls and thinking fold into one summary line.
- The Claude Code and Codex logos replace the plain dots.

### Source control

- Branch sections are folded by default, and you can clear local branches.
- Sync results are summarized instead of showing raw git output.

### Sidebar

- Settled chats show a lime check mark.

## 0.1.3

### Agents and chats

- **Steer a working agent:** keep writing while an agent works. Press <kbd>Enter</kbd> (or the send button next to Stop) and the agent reads your message at its next step, in the same turn. A message it can't take right then goes out as the next turn once the current one ends; Stop drops it.
- The effort chip shows the level a chat will run at even when none is picked: Claude Code's from your Claude Code settings, Codex's per model.

### Sidebar

- The chat list holds still while agents answer. Chats keep the order you gave them (new ones on top); a reply no longer moves a chat to the top.

### Fixes

- A chat from another project could end up in the main pane, without a tab or sidebar row, and a message typed into it ran in that other project's folder. Closing a tab, splitting and <kbd>Ctrl</kbd> <kbd>1</kbd>–<kbd>9</kbd> now stay within the active project's tabs.

## 0.1.2

### Agents and chats

- **Attachments:** paste a screenshot or copied files into the message box, pick files with the paperclip, or drop them on a chat. Claude Code gets images inline and other files by path, Codex gets images by path. Up to 10 per message, 25 MB each; large images are shrunk to fit the model's limits.
- Images that agents produce show in the chat and open in a viewer.
- The model picker lists every model the installed CLI offers your account.
- Reasoning effort is set per chat with a slider next to the model picker (Claude Code: low to max; Codex: the levels its model accepts).
- **Voice input:** press the microphone in the message box (or <kbd>Ctrl</kbd> <kbd>Shift</kbd> <kbd>Space</kbd>) and speak. Speech is transcribed on your computer by Whisper; pick, download and test a model in **Settings > Voice**.

### Files

- A **Files** view next to the chat list (<kbd>Ctrl</kbd> <kbd>Shift</kbd> <kbd>E</kbd>) shows the project as a tree with git status. Files open in a Monaco editor tab; save with <kbd>Ctrl</kbd> <kbd>S</kbd>. Mango asks before closing unsaved edits and before overwriting a file that changed on disk.

### Look

- A new app mark: a ripe mango with a Roman capital M.

## 0.1.1

### Agents

- **Get started** opens on the first launch. It shows whether Claude Code, Codex and Git are installed and signed in, installs the missing ones with each vendor's own installer in a terminal inside the dialog, and signs in to the agents. Open it again from the command palette or **Settings > Agents**.
- **Settings > Agents** offers **Install…** for an agent that is not installed, instead of an `npm` command to copy.

### Sidebar

- The sidebar footer no longer has an **Open folder** button. Open a folder from the project menu in the titlebar, the command palette or <kbd>Ctrl</kbd> <kbd>O</kbd>.

## 0.1.0

The first release, for Windows x64 and Linux x64.

### Projects

- Start screen to open a folder, create a project (optionally with `git init`), or clone a repository with live git progress.
- Recent projects with their current branch; several projects open at once, switched from the titlebar.

### Agents and chats

- Real Claude Code and Codex runs through your installed `claude` and `codex` CLIs: streamed text, thinking and tool calls, diffs of edited files and command output.
- Permission modes per chat: Plan, Ask first, Accept edits, Full auto. Approvals ask before edits and commands as the mode requires (Allow once / Deny).
- Conversations resume across turns and app restarts.
- Chat statuses Working, Settled and Archived, plus Needs you and Failed while a run needs attention. Chats stay Working until you settle them with the check mark in the sidebar.
- Sidebar grouped by status, with Settled and Archived at the bottom where they fold away. Arrange chats by dragging, with <kbd>Alt</kbd> <kbd>↑</kbd> / <kbd>Alt</kbd> <kbd>↓</kbd>, or from the chat menu.
- Chat tabs, split view, per-chat drafts and a command palette.

### Source control

- Changes view next to the chat list: status, diffs in the main area (side by side or one column), stage, unstage, discard, commit and amend, fetch, pull, push, publish, history.
- Branch popup from the titlebar or the Changes view: search, update, push, fetch, and per branch checkout, new branch from, merge, rebase, rename and delete.
- Unity Version Control (Plastic SCM) workspaces in the same views through your own `cm` client: pending changes, diffs, checkin, undo, update, changeset history, and switching, creating, renaming and deleting branches.

### Terminal

- A real PTY docked at the bottom, with tabs.
- Shell discovery: login shell and `/etc/shells` on Linux and macOS; PowerShell, Command Prompt, Git Bash, MSYS2/Cygwin, Nushell and WSL distributions on Windows. Pick a shell per terminal, and set the default, font size and cursor in Settings.

### Settings and look

- Agents: install state, sign in and sign out through each CLI's own login, run in an embedded terminal. Mango never handles credentials.
- Default agent and permission mode for new chats.
- Dark, light and system themes; Mango, Blue, Purple, Pink and Graphite color schemes.
- Version and build commit in Settings > General.

### Updates

- Mango checks the latest GitHub release at launch and every hour, and shows **Update** in the titlebar when a newer version is out.
- **Update and restart** downloads the installer for your platform, verifies its signature, installs it and restarts Mango (Windows installer or MSI, AppImage, `.deb`, `.rpm`).
- Automatic checks can be turned off in Settings > General.
