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
