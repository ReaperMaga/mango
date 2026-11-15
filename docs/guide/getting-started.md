# Getting started

This page walks through the first launch: setting up an agent, opening a project and starting a chat. It assumes you have [installed Mango](./install).

## Get started

The first time Mango starts, it opens **Get started**. It lists Claude Code, Codex and Git, with what Mango found for each:

- **Ready**: installed and signed in. The row shows the account.
- **Installed**: Git is there.
- **Not signed in**: installed, but not signed in yet. **Sign in** runs the CLI's own login (`claude auth login` or `codex login`) in a terminal inside the dialog. Finish in your browser; if the page gives you a code, paste it into the terminal and press <kbd>Enter</kbd>.
- **Not installed**: **Install** runs the vendor's own installer in a terminal inside the dialog. The row shows the exact command before you press it:

| Tool | Windows | Linux | macOS |
| --- | --- | --- | --- |
| Claude Code | `irm https://claude.ai/install.ps1 \| iex` (PowerShell) | `curl -fsSL https://claude.ai/install.sh \| bash` | same as Linux |
| Codex | `irm https://chatgpt.com/codex/install.ps1 \| iex` (PowerShell) | `curl -fsSL https://chatgpt.com/codex/install.sh \| sh` | same as Linux |
| Git | `winget install --id Git.Git -e --source winget` | `sudo apt-get install -y git` (or `dnf`, `pacman`, `zypper`) | `brew install git`, or Apple's Command Line Tools |

An installer may ask you something, such as your password for `sudo` or a WinGet agreement: answer it in the terminal. On Windows the Git installer may also ask for permission in a separate window. When Mango has no installer it can run (for example on Linux without `curl`), the row links to the tool's download page instead.

One agent is enough; Git is for the [Changes](./changes) view and cloning. While an installer or a sign-in runs, the dialog stays open; **Stop** or **Cancel** ends it. Then press **Done**, or **Skip for now** if you want to set things up later. If you quit Mango before closing the dialog, it opens again on the next launch.

To open it again, choose **Get started** in the command palette (<kbd>Ctrl</kbd> <kbd>K</kbd>), or **Install…** on an agent that is not installed in **Settings > Agents**.

## The start screen

With no project open, Mango shows its start screen:

- **Open folder** (<kbd>Ctrl</kbd> <kbd>O</kbd>): work on a project that is already on disk.
- **New project** (<kbd>Ctrl</kbd> <kbd>N</kbd>): create an empty folder, with git if you want it.
- **Clone repository**: clone from GitHub or any git remote.
- **Recent**: projects you opened before, with their current branch. Remove one with the **×** on its row or the <kbd>Delete</kbd> key.

If no agent CLI is installed, the footer says so and opens **Get started**.

On macOS-style keyboards <kbd>⌘</kbd> takes the place of <kbd>Ctrl</kbd> throughout Mango.

### New project

Give the project a **Name** and a **Location** (or **Browse…**). Leave **Initialize git repository** on to run `git init` in the new folder. The dialog shows the full path it will create before you press **Create project**.

### Clone repository

Paste the **Repository URL**, pick a **Destination** folder, and optionally a **Folder name** (it defaults to the repository name). Mango runs `git clone` and shows git's progress live. If the clone fails, the error and git's output stay in the dialog and the button changes to **Try again**.

Git never waits on a password prompt inside Mango. For private repositories, set up access the way you normally do (an SSH key or a credential helper).

## The workspace

Once a project is open the window has four parts:

- **Titlebar**: the sidebar toggle, the project menu (switch between open projects, open, create or clone another, close the current one), the branch button, a search field that opens the command palette, a marker when chats need you, the terminal toggle and the theme toggle.
- **Sidebar** on the left: the chats of the current project, or the [Changes](./changes) view. Switch with the two icons at its top or <kbd>Ctrl</kbd> <kbd>Shift</kbd> <kbd>G</kbd>.
- **Chat area** in the middle: chat tabs, one pane or two side by side.
- **Terminal** docked at the bottom, toggled with <kbd>Ctrl</kbd> <kbd>J</kbd>. See [Terminal](./terminal).

You can have several projects open; the project menu in the titlebar switches between them, and the sidebar always shows the chats of the selected one.

## Your first chat

An empty chat pane asks "What should we work on in *project*?" with a large message box. Below the box, three suggestions fill it in for you: explain the project's structure, run the tests and fix what fails, or review uncommitted changes.

Before you send, check the three pickers under the message box:

1. **Agent**: Claude Code or Codex. An agent that is not installed is marked so.
2. **Model**: **Default** lets the CLI use whatever it is configured with; the others pick a specific model.
3. **Permissions**: how much the agent may do without asking. New chats start with the default from **Settings > General**. See [permission modes](./chats#permission-modes).

Type your request and press <kbd>Enter</kbd> to send (<kbd>Shift</kbd> <kbd>Enter</kbd> adds a line). The chat gets its title from your first message, and the agent's reply streams in: text, thinking, the files it reads and edits (with diffs), and the commands it runs (with their output).

To stop a running turn, press <kbd>Esc</kbd> in the chat or the stop button where the send button was.

## Next

- [Chats and agents](./chats): statuses, approvals, tabs and split view.
- [Changes](./changes): review and commit what the agent did.
- [Keyboard shortcuts](./shortcuts).
