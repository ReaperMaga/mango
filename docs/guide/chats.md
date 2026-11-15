# Chats and agents

A chat is one conversation with one agent in one project. You can run as many as you like at the same time.

## Agents

Mango drives two agent CLIs:

| Agent | Command | How Mango runs it |
| --- | --- | --- |
| Claude Code | `claude` | One process per turn, streaming JSON over stdio; the conversation resumes with `--resume` |
| Codex | `codex` | One `codex app-server` process per turn (JSON-RPC over stdio); the conversation resumes on the same Codex thread |

Mango starts your installed CLI in the project folder for each turn and shows what it streams: text, thinking, tool calls (reads, edits, writes, commands, searches, web requests, sub-agents), diffs of the files it changes and the output of commands it runs. Each finished turn shows how long it took.

Because the CLI keeps its own session, a conversation picks up where it left off on the next turn and after you restart Mango. The agents keep their session files where they always do (`~/.claude`, `~/.codex`).

### Changing agent or model

The **Agent** and **Model** pickers under the message box work at any time between turns. Switching a chat to the other agent starts a fresh conversation with that agent (each CLI only knows its own history) and resets the model to **Default**.

| Agent | Models |
| --- | --- |
| Claude Code | Default, Opus, Sonnet, Haiku |
| Codex | Default, GPT-6-Luna, GPT-5.6-Terra, GPT-5.6-Luna |

**Default** means whatever the CLI itself is configured to use.

## Permission modes

The **Permissions** picker sets how much the agent may do before it checks with you. It applies from the next turn, so you can tighten or loosen it in the middle of a chat. The default for new chats is in **Settings > General**.

| Mode | What it means |
| --- | --- |
| **Plan** | Read-only. The agent explores and proposes a plan; it changes nothing. |
| **Ask first** | The agent asks before every edit and every command. |
| **Accept edits** | The agent edits files without asking, and still asks before commands. |
| **Full auto** | The agent never asks. It edits files and runs commands on its own. Use with care. |

Each mode maps onto the CLI's own permission system, so the exact behaviour follows the agent:

| Mode | Claude Code | Codex |
| --- | --- | --- |
| Plan | `--permission-mode plan` | read-only sandbox, never asks |
| Ask first | `--permission-mode default` | asks for every file change and command (`untrusted`), runs inside the workspace sandbox |
| Accept edits | `--permission-mode acceptEdits` | edits and sandboxed commands run without asking; a command that has to leave the sandbox (network, writing outside the project) asks first |
| Full auto | `--permission-mode bypassPermissions` | never asks, but stays sandboxed to the project: a command that needs more fails instead of escalating |

Codex has no "edits free, every command asks" setting, so **Accept edits** uses the closest one.

## Approvals

When an agent wants to do something its mode does not allow on its own, the chat shows a card with what it wants to run and why, and two buttons: **Allow once** and **Deny**. Until you answer, the chat's status is **Needs you** and the titlebar shows a marker with the number of chats that need you; click it to jump to one.

Once answered, the card shrinks to a single line: "You allowed this", "You denied this", or "Not answered" if the turn ended first.

There are no "always allow" rules yet; every request asks again.

## Statuses

Every chat shows its status with a small dot in the sidebar and on its tab.

| Status | When |
| --- | --- |
| **Working** | A new chat, an agent running, or a finished turn waiting for your next message. |
| **Needs you** | An approval is open. Only a run sets this. |
| **Failed** | The run failed (for example the CLI is missing, not signed in, or crashed). Only a run sets this. |
| **Settled** | You marked the chat as done. |
| **Archived** | You put the chat away. |

A chat never settles by itself: every finished turn lands back on **Working**. When you are done with a chat, press the check mark on its sidebar row (**Mark as settled**); press it again to go back to **Working**. The mark is disabled while the agent is still running.

A finished turn you have not looked at yet gets an extra marker, so you can see at a glance which chats have new results.

## The sidebar

The sidebar shows the chats of the project selected in the titlebar, in three groups:

- **Working** at the top, with a row to start a new chat. Chats that need you or failed stay here.
- **Settled**, below. It folds away; a folded group still shows when it holds unread results.
- **Archived**, at the bottom, also foldable.

### Arranging chats

New chats arrive on top. Arrange them by hand by dragging a row, with <kbd>Alt</kbd> <kbd>↑</kbd> / <kbd>Alt</kbd> <kbd>↓</kbd> on a focused row, or with **Move up** / **Move down** in the row's menu.

### The chat menu

The **...** button on a row opens:

- **Rename**: edit the title in place (<kbd>Enter</kbd> saves, <kbd>Esc</kbd> cancels). Otherwise a chat is named after its first message.
- **Open to the side**: show it in the second pane of a split.
- **Move up** / **Move down**.
- **Working** / **Archived**: set the status by hand.
- **Delete chat**.

An archived chat has an **Unarchive** button on its row. Sending a message in an archived chat also brings it back.

## Tabs and split view

Every chat you open becomes a tab above the chat area. <kbd>Ctrl</kbd> <kbd>1</kbd>…<kbd>9</kbd> switch to a tab, <kbd>Ctrl</kbd> <kbd>W</kbd> or a middle click closes one, and <kbd>Ctrl</kbd> <kbd>N</kbd> or the **+** starts a new chat. Closing a tab does not delete the chat; it stays in the sidebar.

<kbd>Ctrl</kbd> <kbd>\\</kbd> (or the split button at the right of the tab bar) splits the chat area into two panes; press it again to close the split. Drag the divider to resize the panes; double-click it to make them equal. Diffs from the [Changes](./changes) view open as tabs in the same area, so you can read a diff next to the chat that made it.

## Drafts

Text you have typed but not sent is kept per chat, so switching tabs or panes never loses it. Drafts live in memory: they do not survive quitting Mango.

## Where chats are stored

Chat history, tabs and preferences are stored in the app's local storage on your computer. The agents keep their own session files as usual.

## Not there yet

Attaching files and images to a message is not available yet (the paperclip in the message box is disabled). Neither are multiple-choice questions from agents, "always allow" approval rules, or per-chat git worktrees.
