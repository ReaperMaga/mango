//! The source-control commands behind the Changes view, diffs and branch
//! popup. Each one works out which version control the folder is under and
//! hands the call to git (`git.rs`), Unity VCS (`plastic/`) or Lore (`lore/`), so
//! the frontend makes the same calls and gets the same shapes either way.

use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::AppHandle;

use crate::envs::{self, hosts};
use crate::git::{self, blocking, At, EnvAt, GitAhead, GitBranchList, GitBranches, GitCommit, GitCommitDetail, GitGraph, GitStatus, GitWorktree, Vcs};
use crate::lore;
use crate::plastic::{self, MergePreview};

/// Where a folder's version control lives.
#[derive(Debug, Clone)]
pub(crate) enum Backend {
    /// A git work tree, or no version control at all (git is what `init` creates),
    /// on this computer or in a remote environment.
    Git(At),
    /// A Unity VCS workspace and its root folder.
    Plastic(PathBuf),
    /// A Lore repository's root folder, on this computer or in a remote environment.
    Lore(At),
}

/// Look for the nearest `.git`, `.lore` or `.plastic` walking up from `dir`, the way
/// each tool finds its own. When several sit in the same folder, git wins, then Lore.
pub(crate) fn detect_on_disk(dir: &Path) -> Option<(Vcs, PathBuf)> {
    dir.ancestors().find_map(|at| {
        if at.join(".git").exists() {
            Some((Vcs::Git, at.to_path_buf()))
        } else if at.join(".lore").is_dir() {
            Some((Vcs::Lore, at.to_path_buf()))
        } else if at.join(".plastic").is_dir() {
            Some((Vcs::Plastic, at.to_path_buf()))
        } else {
            None
        }
    })
}

/// A remote project (`env://<hostId>/<instance>/<folder>`, see `envs::parse_env_path`) is git or
/// Lore, run inside its instance; Unity VCS is for folders on this computer. Which one a remote
/// folder is comes from its last status read, which looks for `.lore` in the same SSH call as
/// git's own reads; a command before any status read looks once (`lore::probe_env`).
pub(crate) fn detect(app: &AppHandle, path: &str) -> Result<Backend, String> {
    if let Some(env) = env_at(app, path) {
        let env = env?;
        let root = match lore::env_known(&env) {
            Some(known) => known,
            None => {
                let found = lore::probe_env(&env)?;
                lore::remember_env(&env, found.clone());
                found
            }
        };
        return Ok(match root {
            Some(root) => Backend::Lore(At::Env(Box::new(EnvAt { dir: root, ..env }))),
            None => Backend::Git(At::Env(Box::new(env))),
        });
    }
    let dir = PathBuf::from(path.trim());
    let git = || Backend::Git(At::local(&dir));
    Ok(match detect_on_disk(&dir) {
        Some((Vcs::Plastic, root)) => Backend::Plastic(root),
        Some((Vcs::Lore, root)) => Backend::Lore(At::local(root)),
        Some((Vcs::Git, _)) => git(),
        // Not on disk: maybe a workspace whose metadata lives elsewhere.
        None if dir.is_dir() => plastic::workspace_by_cm(&dir).map_or_else(git, Backend::Plastic),
        None => git(),
    })
}

/// Status of a remote folder. A folder known to be Lore asks Lore (one round trip); any other
/// reads git's status with a look for `.lore` in the same call, so git projects pay nothing extra
/// and a Lore one costs a second round trip only the first time it is seen.
fn env_status(env: EnvAt) -> Result<GitStatus, String> {
    if let Some(Some(root)) = lore::env_known(&env) {
        let at = At::Env(Box::new(EnvAt { dir: root, ..env.clone() }));
        match lore::status(&at) {
            Err(e) if e.contains("Repository not found") || e.contains("isn't in a Lore repository") => lore::remember_env(&env, None),
            other => return other,
        }
    }
    let at = At::Env(Box::new(env.clone()));
    let words = lore::probe_words();
    let wins = |out: &git::Output| lore::probe_root(out).is_some();
    let (status, probed) = git::status_probing(&at, Some((&words, &wins)))?;
    let root = probed.as_ref().and_then(lore::probe_root);
    lore::remember_env(&env, root.clone());
    match root {
        Some(root) => lore::status(&At::Env(Box::new(EnvAt { dir: root, ..env }))),
        None => Ok(status),
    }
}

/// The instance folder behind a remote project path (`env://…`); `None` for a folder on this computer.
pub(crate) fn env_at(app: &AppHandle, path: &str) -> Option<Result<EnvAt, String>> {
    let folder = envs::parse_env_path(path)?;
    Some(folder.and_then(|folder| {
        let host = hosts::get(app, &folder.host_id)?;
        Ok(EnvAt { host, instance: folder.instance, dir: folder.dir })
    }))
}

/// One lock in the repository: Unity VCS (`plastic::locks`) or Lore (`lore::locks`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VcsLock {
    /// Relative to the workspace (repository) root, forward slashes.
    pub path: String,
    /// The user who holds it, as the server names them (often an email address).
    pub owner: String,
    /// The workspace it was taken from (Unity VCS; empty for Lore).
    pub workspace: String,
    /// The branch it was taken on.
    pub branch: String,
    /// "locked": checked out right now. "retained": checked in on a task branch,
    /// held until that change reaches the destination branch.
    pub status: &'static str,
    /// When it was taken, unix ms.
    pub time: Option<i64>,
    /// Held by the signed-in user (in any workspace).
    pub mine: bool,
    /// Unity VCS's item id, for releasing it; 0 for Lore.
    #[serde(skip)]
    pub item_id: u64,
}

/// Run `git`, `plastic` or `lore` off the UI thread, for whichever the folder uses.
macro_rules! dispatch {
    ($app:ident, $path:ident, git($at:ident) => $git:expr, plastic($root:pat) => $plastic:expr, lore($lore:pat) => $lored:expr) => {
        blocking(move || match detect(&$app, &$path)? {
            Backend::Plastic($root) => $plastic,
            Backend::Git($at) => $git,
            Backend::Lore($lore) => $lored,
        })
        .await
    };
}

#[tauri::command]
pub async fn git_status(app: AppHandle, path: String) -> Result<GitStatus, String> {
    blocking(move || {
        if let Some(env) = env_at(&app, &path) {
            return env_status(env?);
        }
        match detect(&app, &path)? {
            Backend::Plastic(root) => plastic::status(&root),
            Backend::Git(at) => git::status_of(&at),
            Backend::Lore(root) => lore::status(&root),
        }
    })
    .await
}

#[tauri::command]
pub async fn git_diff(app: AppHandle, path: String, file: String, staged: bool) -> Result<String, String> {
    dispatch!(app, path, git(at) => git::diff_of(&at, &file, staged), plastic(root) => plastic::diff(&root, &file), lore(root) => lore::diff(&root, &file))
}

/// What a file holds in the last commit (Unity VCS: the loaded revision; Lore: the current one), for
/// the editor's change markers; `file` is relative to `path`. `None` when there is nothing to compare with.
#[tauri::command]
pub async fn git_base(app: AppHandle, path: String, file: String) -> Result<Option<String>, String> {
    let dir = PathBuf::from(path.trim());
    let folder = match envs::parse_env_path(&path) {
        Some(f) => f.map(|f| f.dir).unwrap_or_default(),
        None => path.trim().to_string(),
    };
    dispatch!(app, path, git(at) => git::base_of(&at, &file), plastic(root) => plastic::base(&root, &dir, &file),
        lore(root) => lore::base(&root, &folder, &file))
}

#[tauri::command]
pub async fn git_stage(app: AppHandle, path: String, files: Vec<String>) -> Result<(), String> {
    dispatch!(app, path, git(at) => git::stage(&at, &files), plastic(root) => plastic::stage(&root, &files), lore(root) => lore::stage(&root, &files))
}

#[tauri::command]
pub async fn git_unstage(app: AppHandle, path: String, files: Vec<String>) -> Result<(), String> {
    dispatch!(app, path, git(at) => git::unstage(&at, &files), plastic(root) => plastic::unstage(&root, &files), lore(root) => lore::unstage(&root, &files))
}

#[tauri::command]
pub async fn git_discard(app: AppHandle, path: String, files: Vec<String>) -> Result<(), String> {
    dispatch!(app, path, git(at) => git::discard(&at, &files), plastic(root) => plastic::discard(&root, &files), lore(root) => lore::discard(&root, &files))
}

/// Git commit, or Unity VCS checkin (no amend there).
#[tauri::command]
pub async fn git_commit(app: AppHandle, path: String, message: String, amend: bool) -> Result<String, String> {
    dispatch!(app, path, git(at) => git::commit(&at, &message, amend), plastic(root) => {
        if amend { plastic::unsupported("Amending a changeset") } else { plastic::checkin(&root, &message) }
    }, lore(root) => lore::commit(&root, &message, amend))
}

#[tauri::command]
pub async fn git_fetch(app: AppHandle, path: String) -> Result<String, String> {
    dispatch!(app, path, git(at) => git::fetch(&at), plastic(_root) => plastic::unsupported("Fetch"), lore(root) => lore::fetch(&root))
}

/// Git pull, Unity VCS update, or Lore sync.
#[tauri::command]
pub async fn git_pull(app: AppHandle, path: String) -> Result<String, String> {
    dispatch!(app, path, git(at) => git::pull(&at), plastic(root) => plastic::update(&root), lore(root) => lore::pull(&root))
}

#[tauri::command]
pub async fn git_push(app: AppHandle, path: String) -> Result<String, String> {
    dispatch!(app, path, git(at) => git::push(&at), plastic(_root) => plastic::unsupported("Push"), lore(root) => lore::push(&root))
}

#[tauri::command]
pub async fn git_log(app: AppHandle, path: String, limit: u32) -> Result<Vec<GitCommit>, String> {
    dispatch!(app, path, git(at) => git::log(&at, limit), plastic(root) => plastic::log(&root, limit), lore(root) => lore::log(&root, limit))
}

/// The history graph's commands' answer for a Unity VCS workspace.
const GRAPH_GIT_ONLY: &str = "The commit graph is for git repositories; Unity Version Control workspaces don't have one.";

/// A page of the history graph. `refs` null or empty: every local branch, remote branch, tag and HEAD.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn git_graph(
    app: AppHandle,
    path: String,
    refs: Option<Vec<String>>,
    skip: u32,
    limit: u32,
    text: Option<String>,
    author: Option<String>,
    paths: Option<Vec<String>>,
) -> Result<GitGraph, String> {
    let query = git::GraphQuery { refs, skip, limit, text, author, paths };
    dispatch!(app, path, git(at) => git::graph(&at, &query), plastic(_root) => Err(GRAPH_GIT_ONLY.into()), lore(root) => lore::graph(&root, &query))
}

/// One commit with its full message and the files it changed against its first parent.
#[tauri::command]
pub async fn git_commit_show(app: AppHandle, path: String, hash: String) -> Result<GitCommitDetail, String> {
    dispatch!(app, path, git(at) => git::commit_show(&at, &hash), plastic(_root) => Err(GRAPH_GIT_ONLY.into()),
        lore(root) => lore::commit_show(&root, &hash))
}

/// Unified diff of one file of a commit against its first parent.
#[tauri::command]
pub async fn git_commit_diff(app: AppHandle, path: String, hash: String, file: String) -> Result<String, String> {
    dispatch!(app, path, git(at) => git::commit_diff(&at, &hash, &file), plastic(_root) => Err(GRAPH_GIT_ONLY.into()),
        lore(root) => lore::commit_diff(&root, &hash, &file))
}

#[tauri::command]
pub async fn git_branches(app: AppHandle, path: String) -> Result<GitBranches, String> {
    dispatch!(app, path, git(at) => git::branches(&at), plastic(root) => plastic::branches(&root), lore(root) => lore::branches(&root))
}

#[tauri::command]
pub async fn git_checkout(app: AppHandle, path: String, branch: String, create: bool) -> Result<(), String> {
    dispatch!(app, path, git(at) => git::checkout(&at, &branch, create), plastic(root) => plastic::checkout(&root, &branch, create),
        lore(root) => lore::checkout(&root, &branch, create))
}

/// Check out one commit (git: a detached HEAD; Lore: the working tree synced to that revision).
#[tauri::command]
pub async fn git_checkout_commit(app: AppHandle, path: String, hash: String) -> Result<(), String> {
    dispatch!(app, path, git(at) => git::checkout_commit(&at, &hash), plastic(_root) => Err("Checking out a single commit is for git repositories; in Unity Version Control, switch to a branch or changeset in its own app.".into()),
        lore(root) => lore::checkout_commit(&root, &hash))
}

/// Local and remote branches with upstream state, newest commit first.
#[tauri::command]
pub async fn git_branch_list(app: AppHandle, path: String) -> Result<GitBranchList, String> {
    dispatch!(app, path, git(at) => git::branch_list(&at), plastic(root) => plastic::branch_list(&root), lore(root) => lore::branch_list(&root))
}

#[tauri::command]
pub async fn git_branch_create(app: AppHandle, path: String, name: String, from: Option<String>, checkout: bool) -> Result<(), String> {
    dispatch!(app, path, git(at) => git::branch_create(&at, &name, from.as_deref(), checkout),
        plastic(root) => plastic::branch_create(&root, &name, from.as_deref(), checkout),
        lore(root) => lore::branch_create(&root, &name, from.as_deref(), checkout))
}

/// Returns the name of the local branch that is now checked out.
#[tauri::command]
pub async fn git_checkout_remote(app: AppHandle, path: String, branch: String) -> Result<String, String> {
    dispatch!(app, path, git(at) => git::checkout_remote(&at, &branch), plastic(_root) => plastic::unsupported("Remote branches"),
        lore(root) => lore::checkout_remote(&root, &branch))
}

/// Git merge, a Unity VCS merge into the workspace (pending changes to check in), or a Lore merge
/// (committed by Lore itself when nothing conflicts).
#[tauri::command]
pub async fn git_merge(app: AppHandle, path: String, branch: String) -> Result<String, String> {
    dispatch!(app, path, git(at) => git::merge(&at, &branch), plastic(root) => plastic::merge(&root, &branch), lore(root) => lore::merge(&root, &branch))
}

/// What merging `branch` would change, before anything does. Unity VCS only:
/// git merges straight away and stops on its own conflicts.
#[tauri::command]
pub async fn git_merge_preview(app: AppHandle, path: String, branch: String) -> Result<MergePreview, String> {
    dispatch!(app, path, git(_at) => Err("Merge previews are for Unity VCS workspaces.".into()),
        plastic(root) => plastic::merge_preview(&root, &branch),
        lore(_root) => Err("Merge previews are for Unity VCS workspaces.".into()))
}

#[tauri::command]
pub async fn git_rebase(app: AppHandle, path: String, onto: String) -> Result<String, String> {
    dispatch!(app, path, git(at) => git::rebase(&at, &onto), plastic(_root) => plastic::unsupported("Rebase"), lore(_root) => lore::unsupported("Rebase"))
}

/// Unity VCS refuses merges with conflicts, so nothing is ever half way there.
const NO_PLASTIC_OPERATION: &str = "Unity VCS workspaces never stop half way through a merge here; resolve conflicts in the Unity Version Control app.";

/// Abort the merge, rebase, cherry-pick or revert in progress (Lore: the merge). Destroys the
/// resolutions made so far: the UI asks first.
#[tauri::command]
pub async fn git_operation_abort(app: AppHandle, path: String) -> Result<String, String> {
    dispatch!(app, path, git(at) => git::operation_abort(&at), plastic(_root) => Err(NO_PLASTIC_OPERATION.into()), lore(root) => lore::conflicts::abort(&root))
}

/// Go on with the rebase, cherry-pick or revert in progress once its conflicts are resolved; no editor opens.
#[tauri::command]
pub async fn git_operation_continue(app: AppHandle, path: String) -> Result<String, String> {
    dispatch!(app, path, git(at) => git::operation_continue(&at), plastic(_root) => Err(NO_PLASTIC_OPERATION.into()),
        lore(_root) => Err("A Lore merge goes on by committing it.".into()))
}

/// Leave out the commit a rebase (or cherry-pick) is applying and go on with the next.
#[tauri::command]
pub async fn git_operation_skip(app: AppHandle, path: String) -> Result<String, String> {
    dispatch!(app, path, git(at) => git::operation_skip(&at), plastic(_root) => Err(NO_PLASTIC_OPERATION.into()), lore(_root) => lore::unsupported("Skipping a commit"))
}

/// The base, ours and theirs of a conflicted file (relative to the repository root), for the merge editor.
#[tauri::command]
pub async fn git_conflict(app: AppHandle, path: String, file: String) -> Result<git::GitConflict, String> {
    dispatch!(app, path, git(at) => git::conflict_of(&at, &file), plastic(_root) => Err(NO_PLASTIC_OPERATION.into()), lore(root) => lore::conflicts::conflict_of(&root, &file))
}

/// Take one side ("ours" or "theirs") of a conflicted file whole. Git: into the working tree, still
/// in conflict until marked resolved; Lore resolves it at once.
#[tauri::command]
pub async fn git_conflict_take(app: AppHandle, path: String, file: String, side: String) -> Result<(), String> {
    dispatch!(app, path, git(at) => git::conflict_take(&at, &file, &side), plastic(_root) => Err(NO_PLASTIC_OPERATION.into()),
        lore(root) => lore::conflicts::take(&root, &file, &side))
}

/// The commit subjects on each side of the operation in progress since the sides met (git only;
/// Lore: none). At most 30 each.
#[tauri::command]
pub async fn git_conflict_history(app: AppHandle, path: String) -> Result<git::GitConflictHistory, String> {
    dispatch!(app, path, git(at) => git::conflict_history(&at, 30), plastic(_root) => Ok(Default::default()), lore(_root) => Ok(Default::default()))
}

#[tauri::command]
pub async fn git_branch_rename(app: AppHandle, path: String, from: String, to: String) -> Result<(), String> {
    dispatch!(app, path, git(at) => git::branch_rename(&at, &from, &to), plastic(root) => plastic::branch_rename(&root, &from, &to),
        lore(_root) => lore::unsupported("Renaming a branch"))
}

#[tauri::command]
pub async fn git_branch_delete(app: AppHandle, path: String, branch: String, force: bool, with_worktree: bool) -> Result<Option<String>, String> {
    dispatch!(app, path, git(at) => git::branch_delete(&at, &branch, force, with_worktree),
        plastic(root) => plastic::branch_delete(&root, &branch).map(|()| None),
        lore(root) => lore::branch_delete(&root, &branch))
}

/// The repository's worktrees, the main one first. For Unity VCS: the project's workspace and
/// the chat workspaces Mango made beside it (`plastic::workspaces`). Lore has no linked working copies: none.
#[tauri::command]
pub async fn git_worktrees(app: AppHandle, path: String) -> Result<Vec<GitWorktree>, String> {
    dispatch!(app, path, git(at) => git::worktrees(&at), plastic(root) => plastic::workspaces::list(&root), lore(_root) => Ok(Vec::new()))
}

/// Add a linked worktree for `branch` beside the repository (`<parent>/<repo>.worktrees/<branch>`).
/// Unity VCS: a new workspace of the same repository in that folder, switched to `branch`.
#[tauri::command]
pub async fn git_worktree_add(app: AppHandle, path: String, branch: String, from: Option<String>, create: bool) -> Result<GitWorktree, String> {
    dispatch!(app, path, git(at) => git::worktree_add(&at, &branch, from.as_deref(), create),
        plastic(root) => plastic::workspaces::add(&root, &branch, from.as_deref(), create),
        lore(_root) => lore::unsupported("A working copy of its own for a chat"))
}

/// Remove the linked worktree (Unity VCS: the chat workspace) in the folder `worktree`; its branch is kept.
#[tauri::command]
pub async fn git_worktree_remove(app: AppHandle, path: String, worktree: String, force: bool) -> Result<(), String> {
    dispatch!(app, path, git(at) => git::worktree_remove(&at, &worktree, force),
        plastic(root) => plastic::workspaces::remove(&root, &worktree, force),
        lore(_root) => lore::unsupported("A working copy of its own for a chat"))
}

/// How many commits the folder's branch has that `base` doesn't. Without `base`: compared with the
/// branch checked out in the repository's main working tree (what a linked worktree merges into).
#[tauri::command]
pub async fn git_ahead(app: AppHandle, path: String, base: Option<String>) -> Result<GitAhead, String> {
    dispatch!(app, path, git(at) => git::ahead_of(&at, base.as_deref()), plastic(_root) => Err(NO_PLASTIC_AHEAD.into()),
        lore(_root) => lore::unsupported("Comparing with the project's branch"))
}

const NO_PLASTIC_AHEAD: &str = "Unity VCS workspaces aren't compared with the project's branch.";

/// `git init` in `path`. Does nothing when it is already under version control.
#[tauri::command]
pub async fn git_init(app: AppHandle, path: String) -> Result<(), String> {
    dispatch!(app, path, git(at) => git::init(&at), plastic(_root) => Ok(()), lore(_root) => Ok(()))
}

const NO_GIT_LOCKS: &str = "Locks are a Unity Version Control and Lore feature; git has no file locks.";

/// Unity VCS and Lore: the locks in the repository. Empty for git.
#[tauri::command]
pub async fn vcs_locks(app: AppHandle, path: String) -> Result<Vec<VcsLock>, String> {
    dispatch!(app, path, git(_at) => Ok(Vec::new()), plastic(root) => plastic::locks::locks(&root), lore(root) => lore::locks::locks(&root))
}

/// Unity VCS: lock files by checking them out; Lore: `lore lock acquire`. Returns a note when
/// some of them were left unlocked; empty when all are locked.
#[tauri::command]
pub async fn vcs_lock(app: AppHandle, path: String, files: Vec<String>) -> Result<String, String> {
    dispatch!(app, path, git(_at) => Err(NO_GIT_LOCKS.into()), plastic(root) => plastic::locks::lock(&root, &files), lore(root) => lore::locks::lock(&root, &files))
}

/// Unity VCS and Lore: release the user's own locks on files.
#[tauri::command]
pub async fn vcs_unlock(app: AppHandle, path: String, files: Vec<String>) -> Result<(), String> {
    dispatch!(app, path, git(_at) => Err(NO_GIT_LOCKS.into()), plastic(root) => plastic::locks::unlock(&root, &files), lore(root) => lore::locks::unlock(&root, &files))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nearest_metadata_folder_wins() {
        let base = std::env::temp_dir().join(format!("mango-vcs-{}", uuid::Uuid::new_v4()));
        let ws = base.join("game");
        let inner = ws.join("Packages").join("tool");
        std::fs::create_dir_all(inner.join(".git")).unwrap();
        std::fs::create_dir_all(ws.join(".plastic")).unwrap();
        std::fs::create_dir_all(ws.join("Assets")).unwrap();

        assert_eq!(detect_on_disk(&ws.join("Assets")), Some((Vcs::Plastic, ws.clone())));
        assert_eq!(detect_on_disk(&inner), Some((Vcs::Git, inner.clone())));
        // Lore nearer than Unity VCS; in one folder with git, git.
        let lore_dir = ws.join("Tools");
        std::fs::create_dir_all(lore_dir.join(".lore")).unwrap();
        assert_eq!(detect_on_disk(&lore_dir.join("x")), Some((Vcs::Lore, lore_dir.clone())));
        std::fs::create_dir_all(lore_dir.join(".git")).unwrap();
        assert_eq!(detect_on_disk(&lore_dir), Some((Vcs::Git, lore_dir.clone())));
        // Both in one folder: git.
        std::fs::create_dir_all(ws.join(".git")).unwrap();
        assert_eq!(detect_on_disk(&ws), Some((Vcs::Git, ws.clone())));
        std::fs::remove_dir_all(&base).unwrap();
    }
}
