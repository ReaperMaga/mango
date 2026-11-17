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
| Branches | Switch, create, rename, delete and merge, from the branch popup |
| Code reviews | The branch's reviews and the repository's open ones in the Pull requests tool window; request a review of the branch |
| Locks | See who holds which file, lock files and release your own locks (see below) |

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

## Locks

Scenes, prefabs and binary assets can't be merged, so Unity VCS teams lock them: while one person has such a file checked out, nobody else can check it out. Which files lock is decided by lock rules on the server (the Unity Cloud dashboard, or `lock.conf` on your own server); only an administrator can change them.

- **Lock marks.** A file in the Changes list that is locked shows a lock: in the accent colour when you hold it, and with the holder's name when someone else does. Hover the row for who, from which workspace and on which branch.
- **Locks section.** Below the changes, **Locks** lists every lock in the workspace's repository, other people's first, including files you haven't touched. A lock marked **kept** was checked in on a task branch and stays until that branch is merged.
- **Lock a file.** Right-click a changed file (or press the context-menu key or Shift+F10 on it) and choose **Lock**. Mango checks the file out (`cm checkout`); if the server's lock rules cover it, that takes the lock. If they don't, the file is checked out but not locked, and the result line says so. New and deleted files can't be locked.
- **Release a lock.** Choose **Release lock** in the same menu, or hover your lock in the Locks section and press the open-lock button. The file stays as it is. Only the holder, or a server administrator, can release a lock, so Mango doesn't offer it for other people's.
- **Undo and checkin.** Undoing a checked-out file releases its lock. Checking it in releases it too, or keeps it (**kept**) until a task branch is merged.
- **Warning before a checkin.** When the next checkin would take a file someone else has locked, the line under the checkin comment says so. Mango doesn't stop you, but the server will likely refuse the checkin until the lock is released.

Locks come from the server, so Mango reads them at most every 30 seconds, and right away after a lock, release, undo, checkin or branch switch, or when you press refresh.

## Merging

**Merge into** (on a branch in the branch popup) merges that branch into the one your workspace is on, the way Unity VCS does: into the workspace. Mango first asks `cm` what the merge would do and shows it before anything changes:

- the files it changes, with a **Merge** button;
- or why it can't run yet: the workspace has pending changes (check them in or undo them first, so the merge result is all that is left to check in), or the branch has changesets your workspace doesn't have (update first);
- or the files changed on both branches. Mango only runs merges that need no resolving by hand, so it stops there and lists them: merge that branch in the Unity Version Control app, which resolves conflicts, then check in from Mango.

The merge result is pending changes in the Changes view, already staged ("Merged /main/task: 5 files changed, check in to finish"). Check them in to finish the merge, or discard them to drop it. If `cm` fails part way, Mango undoes what the merge left so the workspace is as it was.

Private files don't count as pending changes here and are left alone.

## What is not there

Unity VCS checkins go straight to the server, so there is no fetch, push or publish. Mango also does not offer amend or rebase for Unity VCS workspaces, and leaves merges with conflicts to the Unity Version Control app.

The Changes view refreshes less often for Unity VCS (every 15 seconds instead of every 4), because `cm status` scans the whole workspace and can take seconds on a large project.
