# Changelog

All notable changes to Mango. Versions follow [semantic versioning](https://semver.org); installers for each version are on its [GitHub release](https://github.com/ReaperMaga/mango/releases).

## 0.1.11

### Agents and chats

- **Queued messages:** a message written while an agent works waits in a queue above the input and goes out as the next turn, so the run is not disturbed. **Send now** hands it to the running turn instead; the agent reads it at its next step. Stop keeps the queue but sends nothing.
- **Worktree chats:** a chat can work in its own git worktree (`Ctrl/⌘ Shift N`), so several agents change one project at once without touching each other's files. The titlebar, Changes, Files and new terminals follow the chat in front.
- Chats are saved in a SQLite database.

### Settings

- **Changelog** in Settings and in the Settings menu of the sidebar: what changed in each version.

- **More color schemes and appearance options:** Teal, Green, Red, Slate and Uchiha (black and crimson) join the color schemes, and Settings > Appearance gains Text size, Corners and Animations.

- **Settings rail:** General and Technical are headlines with their sections under them. General holds Preferences (the old General page), Appearance and Voice; Technical holds Environments, Terminal and the new Maintenance page, which now has Updates.
- **Fonts and project badges:** choose the interface and code fonts in Settings > Appearance (five each), and a project's badge now shows in the titlebar and the Recent list.
- **Behaviour** in Settings: the send shortcut, queue or steer for messages written while the agent works, and how many tool calls a chat shows.
- **Projects** in Settings: per project, a display name and badge color, pinning, archiving, the agent, model and permission mode new chats start with, and removing the project.
- **Archive** in Settings: all archived chats in one list, to restore or delete.
- **Confirmations:** optional questions before a chat is archived or deleted (Settings > Preferences).

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
