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
| Code reviews | The branch's reviews and the repository's open ones in the Pull requests tool window; request a review of the branch |

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

## Code reviews

For a Unity VCS workspace, the **Pull requests** tool window on the right (`Ctrl/⌘ Shift P`) shows Unity VCS code reviews instead of GitHub pull requests:

- **This branch:** every review of the branch the workspace is on (the newest 20), whatever its status.
- **Open in the repository:** the reviews still **Under review** or waiting on **Rework required** (the newest 50), with the branch or changeset each one is for.

Each review shows its title, status, number, who asked for it and when, the number of unresolved change requests and questions when your client reports them, and each reviewer with their own verdict (older reviews have a single assignee instead). Statuses use the same colours as chats: under review is ripening, rework required needs you, reviewed is ripe. Mango reads the list when the window opens and when you press **Refresh** (`cm find review`); it does not poll.

**Request a review** (the speech-bubble button, or the button in an empty list) asks Unity VCS for a review of the current branch (`cm codereview br:/main/… "title"`), with optional reviewers: users or groups, separated by commas (`--users`). Commenting, approving and asking for rework happen in the Unity Version Control app or Unity Cloud; Mango only reads them. There is no "open in Unity VCS" link, because Unity documents no stable address for a review.

## What is not there

Unity VCS checkins go straight to the server, so there is no fetch, push or publish. Mango also does not offer amend, merge or rebase for Unity VCS workspaces.

The Changes view refreshes less often for Unity VCS (every 15 seconds instead of every 4), because `cm status` scans the whole workspace and can take seconds on a large project.
