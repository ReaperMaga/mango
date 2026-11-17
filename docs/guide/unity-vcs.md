# Unity Version Control

Mango supports Unity Version Control (formerly Plastic SCM) workspaces in the same [Changes view](./changes), diff tabs and branch popup it uses for git. Everything goes through your own `cm` command-line client.

## Requirements

- The Unity Version Control client, which includes `cm`. Mango looks for `cm` on your `PATH`, then in the default install locations (`PlasticSCM5\client` under Program Files on Windows; `/opt/plasticscm5/client` or `/usr/local/bin` on Linux).
- A signed-in client. Sign in with the Unity Version Control app or Unity Hub; Mango never handles credentials and `cm` never gets an interactive prompt from Mango.

If `cm` is missing, the Changes view says so: install Unity VCS (or the Plastic SCM client), then reopen Mango. If the server rejects the sign-in or cannot be reached, the error message says that first, followed by `cm`'s own output.

## How Mango detects a workspace

When you open a folder, Mango walks up from it looking for a `.git` or a `.plastic` folder, the way both tools find their own. The nearest one wins; when both sit in the same folder, git wins. If neither is found, Mango asks `cm` whether the folder belongs to a workspace whose metadata lives elsewhere.

## What works

| | Unity VCS in Mango |
| --- | --- |
| Pending changes | Listed in the Changes view, with diffs side by side or in one column |
| Checkin | **Check in** with a checkin comment; the result line names the new changeset (`cs:12`) |
| Undo | Discard a change (with the same two-step confirm as git); controlled changes are undone with `cm undo`, private and only-added files are deleted |
| Update | **Update** brings the workspace to the newest changeset on its branch (`cm update`), with a count of newer changesets |
| History | Recent changesets of the branch |
| Branches | Switch, create, rename and delete, from the branch popup |
| Parallel chats | A chat in its own workspace, on its own branch (see below) |

## No staging area

Unity VCS has no staging area. In Mango, "staging" a file picks it for the next checkin:

- With files staged, **Check in** takes exactly those.
- With nothing staged, the button reads **Check in all** and takes every pending change.

Mango keeps this selection in memory while it runs; it is not written to the workspace.

## Branches

Unity VCS branches are paths from the root, such as `/main` or `/main/task-12`, and the branch popup shows them as a tree.

- **New branch** creates a child of the branch it starts from: `task` from `/main` becomes `/main/task`. Type a full path starting with `/` to choose the parent yourself. The new branch starts at the newest changeset of its parent, and Mango switches to it right away.
- **Switch** keeps your pending changes: `cm` shelves and reapplies them instead of stopping at a prompt.
- **Rename** keeps the branch under its parent; only the last part of the name changes.
- **Delete** removes the branch from the repository for everyone. Unity VCS only deletes a branch that has no changesets and no child branches.

## A workspace per chat

What git projects do with [worktrees](./chats#worktrees-chats-that-work-in-parallel), Unity VCS projects do with workspaces: a chat can work in a workspace of its own, so several agents change the project at once without touching each other's files or yours.

Start one with <kbd>Ctrl</kbd> <kbd>Shift</kbd> <kbd>N</kbd>, the caret beside **+** in the sidebar, or **New chat in a workspace** in the command palette. Nothing is made until you send the first message. Then Mango:

1. creates a branch named after the message as a child of the project's current branch (`/main/feature/inventory/fix-the-login`; `-2`, `-3` … when the name is taken),
2. creates a new workspace of the same repository in a folder beside the project, `<project>.worktrees/fix-the-login` (registered with `cm` as `<project>-fix-the-login`),
3. switches that workspace to the new branch, which downloads the branch's files, and only then starts the agent there.

The download is the slow part: on a big Unity project it can take minutes, and the chat shows "Making a workspace and downloading its files" with the time so far. Mango waits up to an hour. If anything fails, the new workspace, its folder and the empty branch are removed again, and the message stays so you can send it again.

The workspaces Mango made for the project are listed under **Continue in** in the sidebar's new-chat menu and in the command palette. Only workspaces of the same repository in the `<project>.worktrees` folder are listed or removed; your other workspaces are never touched.

**Remove workspace…** in a chat's menu runs `cm workspace delete` and deletes the folder (which `cm` leaves on disk). The branch and its changesets stay. With pending changes in the workspace, private files included, Mango says so, and removing it anyway is a separate second step that throws them away.

## What is not there

Unity VCS checkins go straight to the server, so there is no fetch, push or publish. Mango also does not offer amend, merge or rebase for Unity VCS workspaces.

The Changes view refreshes less often for Unity VCS (every 15 seconds instead of every 4), because `cm status` scans the whole workspace and can take seconds on a large project.
