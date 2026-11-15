# Changes

The Changes view is Mango's source control panel. It lives in the left sidebar, next to the chat list: switch to it with the second icon at the top of the sidebar or <kbd>Ctrl</kbd> <kbd>Shift</kbd> <kbd>G</kbd>. The icon shows how many files have changed.

Mango shells out to your own `git`, so it sees exactly what `git status` sees, uses your git configuration, and never waits on a prompt nobody can see. It refreshes on its own every few seconds while the window is visible, and after every action; the refresh button forces it.

This page covers git. A folder inside a Unity Version Control workspace uses the same view with a few differences; see [Unity Version Control](./unity-vcs).

## Not a repository yet

If the project folder is not a git repository, the view says so and offers **Initialize repository**, which runs `git init`.

## Files

Changed files are listed in two groups:

- **Staged**: what the next commit takes. **Unstage all** (the minus at the group's head) or the minus on a row moves files back.
- **Changes**: everything else, including untracked files. **Stage all** (the plus) or the plus on a row stages files.

Each row shows the file name, its folder and a letter for its state (modified, added, deleted, renamed, untracked, or **U** for a merge conflict). For a conflicted file, the plus marks it as resolved and stages it. <kbd>↑</kbd> and <kbd>↓</kbd> move between rows.

### Discarding changes

Discarding destroys work, so it always takes two steps. The undo arrow on a row asks before it discards that file's changes (for an untracked file, the action is **Delete**). **Discard all changes…** at the head of the Changes group asks once more, says how many new files will be deleted, and warns that it cannot be undone. Choose **Keep** to back out.

## Diffs

Click a file to open its diff in the main chat area, as a tab next to your chats. Clicking another file while a diff is showing replaces that tab instead of opening another, and you can put a diff in one pane of a split next to the chat that made it.

The diff header has:

- a layout switch: **Side by side** or **One column** (Mango remembers your choice);
- **Stage** or **Unstage** for that file;
- **Reload diff**.

Renamed files say what they were renamed from. Very large diffs stop at 400 KB.

## Commit

Write a message in the box at the top of the view and press **Commit**, or <kbd>Ctrl</kbd> <kbd>Enter</kbd> in the message box.

- With files staged, **Commit** commits exactly those.
- With nothing staged, the button reads **Commit all**: it stages every change first, then commits.

The arrow next to the button opens **Amend last commit**, which adds what is staged to the previous commit and replaces its message (or keeps the old message if the box is empty).

A short confirmation such as "Committed a1b2c3d" appears and clears itself. Errors and longer git output stay until you dismiss them.

## Fetch, pull and push

The buttons at the top of the view:

- **Fetch from the remote**.
- **Pull**, with the number of commits on the upstream branch you do not have yet.
- **Push**, with the number of local commits not pushed yet.

A branch that does not track a remote branch yet gets **Publish branch** instead, which pushes it and starts tracking it. The name of the upstream branch is shown next to the branch name.

## History

The **History** group at the bottom lists recent commits: subject, short hash and age. An up arrow marks commits that are not pushed yet. Hover a commit for its author and date.

## Branches

Click the branch name, in the titlebar or at the top of the Changes view, to open the branch popup. Type to search branches and actions; use <kbd>↑</kbd> <kbd>↓</kbd> and <kbd>Enter</kbd>, <kbd>→</kbd> to open a branch's actions and <kbd>←</kbd> or <kbd>Esc</kbd> to go back.

At the top are actions for the current branch:

- **Update**: pull the upstream branch.
- **Commit…**: open the Changes view.
- **Push** (or **Publish** for a branch with no upstream yet).
- **Fetch**.
- **New branch…**: create a branch from the current one and switch to it.

Below them, **Local** and **Remote** branches. Branch names with slashes (`feature/login`) are grouped into folders. Each branch has its own actions:

- **Checkout**.
- **New branch from here…**.
- **Merge into** *current branch* and **Rebase** *current branch* **onto this**.
- For local branches: **Rename…** and **Delete…**.

Deleting removes only the local branch; the remote branch, if any, stays. You cannot delete the branch you are on. If the branch has commits that are not merged anywhere, git refuses and Mango offers **Delete anyway**.
