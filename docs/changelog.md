# Changelog

All notable changes to Mango. Versions follow [semantic versioning](https://semver.org); installers for each version are on its [GitHub release](https://github.com/ReaperMaga/mango/releases).

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
