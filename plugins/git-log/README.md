# Git log

A **Git log** tab in the bottom panel, beside the terminals, with the history of the folder in view (the active chat's
worktree when it has one) drawn as a commit graph: branches and merges as coloured lanes, branch, remote and tag chips
on their commits, the checked-out branch marked. Each row is one line: graph, subject and refs, author, date, short
hash. The list is virtualised and reads 300 commits at a time as you scroll, so long histories stay smooth. In a narrow
panel the rows fold into two lines.

- **Details beside the log**: the selected commit's message, author and committer, parents (click one to go to it) and
  changed files sit in a split on the right; drag its edge to resize it. Click a file (or <kbd>Enter</kbd> on it) to open
  its diff in a tab, with **Open file** for the file in your working copy.
- **Search** (<kbd>Ctrl/⌘</kbd> <kbd>F</kbd> inside the tab): text finds commits whose message contains it,
  `author:name` an author. A hash (4 or more hex digits) jumps to that commit instead, reading further back as needed;
  one the log can't show still gets its details in the split. <kbd>Esc</kbd> clears the search.
- **Branches**: the log opens on the branch you are on and follows it when you check out another one. Switch to all
  branches or any local or remote branch from the branch filter; a new folder starts on the current branch again. The
  locate button beside a branch scrolls to its tip. **Authors**: show one person's commits.
- **Keyboard**: <kbd>↑</kbd> <kbd>↓</kbd>, <kbd>Page Up</kbd> <kbd>Page Down</kbd>, <kbd>Home</kbd> <kbd>End</kbd>
  move the selection; <kbd>Enter</kbd> moves to its files; <kbd>Ctrl/⌘</kbd> <kbd>C</kbd> copies its hash;
  <kbd>Shift</kbd> <kbd>F10</kbd> opens its menu.
- **Row menu** (right-click or the `…` button): copy hash or subject, start a new branch at the commit, check out a
  branch or remote branch on it, or **Check out revision**: the commit itself, with no branch (a detached HEAD; the toast
  offers to start a branch there). Checkouts ask first, and git stops if uncommitted changes would be overwritten.

The log refreshes when the folder changes, after an agent's turn, when Mango's window regains focus and when Mango sees
HEAD move, but only while the tab is showing (a hidden tab catches up when it is shown). **Show Git log**
(<kbd>Ctrl/⌘</kbd> <kbd>Alt</kbd> <kbd>9</kbd>, rebindable in Settings > Shortcuts) and **Go to commit…** are in the
command palette.

Git only: a Unity Version Control workspace, a folder that is not a repository and a repository with no commits yet
show a short note instead. A Mango without the history commands (`git_graph` and friends) says it needs updating.

Shows: `ui.panelTabs`, `ui.tabs`, `shortcuts`, `backend.call` (`git_graph`, `git_commit_show`, `git_commit_diff`,
branch commands), `chat.onTurnEnd`, read-only use of `stores.git`, a virtualised list and a resizable split written with
`mango.vue`, a teleported menu. The lane layout (`createLaneLayout`) is a pure function exported from `main.js` and
tested in `tests/gitLogLanes.test.ts`.
