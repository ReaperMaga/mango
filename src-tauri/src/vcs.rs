//! The source-control commands behind the Changes view, diffs and branch
//! popup. Each one works out which version control the folder is under and
//! hands the call to git (`git.rs`) or Unity VCS (`plastic/`), so the
//! frontend makes the same calls and gets the same shapes either way.

use std::path::{Path, PathBuf};

use tauri::AppHandle;

use crate::envs::{self, hosts};
use crate::git::{self, blocking, At, EnvAt, GitAhead, GitBranchList, GitBranches, GitCommit, GitStatus, GitWorktree, Vcs};
use crate::plastic;

/// Where a folder's version control lives.
#[derive(Debug, Clone)]
pub(crate) enum Backend {
    /// A git work tree, or no version control at all (git is what `init` creates),
    /// on this computer or in a remote environment.
    Git(At),
    /// A Unity VCS workspace and its root folder.
    Plastic(PathBuf),
}

/// Look for the nearest `.git` or `.plastic` walking up from `dir`, the way
/// both tools find their own. When both sit in the same folder, git wins.
pub(crate) fn detect_on_disk(dir: &Path) -> Option<(Vcs, PathBuf)> {
    dir.ancestors().find_map(|at| {
        if at.join(".git").exists() {
            Some((Vcs::Git, at.to_path_buf()))
        } else if at.join(".plastic").is_dir() {
            Some((Vcs::Plastic, at.to_path_buf()))
        } else {
            None
        }
    })
}

/// A remote project (`env://<hostId>/<instance>/<folder>`, see `envs::parse_env_path`) is
/// always git, run inside its instance; Unity VCS is for folders on this computer.
pub(crate) fn detect(app: &AppHandle, path: &str) -> Result<Backend, String> {
    if let Some(env) = env_at(app, path) {
        return Ok(Backend::Git(At::Env(Box::new(env?))));
    }
    let dir = PathBuf::from(path.trim());
    let git = || Backend::Git(At::local(&dir));
    Ok(match detect_on_disk(&dir) {
        Some((Vcs::Plastic, root)) => Backend::Plastic(root),
        Some((Vcs::Git, _)) => git(),
        // Not on disk: maybe a workspace whose metadata lives elsewhere.
        None if dir.is_dir() => plastic::workspace_by_cm(&dir).map_or_else(git, Backend::Plastic),
        None => git(),
    })
}

/// The instance folder behind a remote project path (`env://…`); `None` for a folder on this computer.
pub(crate) fn env_at(app: &AppHandle, path: &str) -> Option<Result<EnvAt, String>> {
    let folder = envs::parse_env_path(path)?;
    Some(folder.and_then(|folder| {
        let host = hosts::get(app, &folder.host_id)?;
        Ok(EnvAt { host, instance: folder.instance, dir: folder.dir })
    }))
}

/// Run `git` or `plastic` off the UI thread, for whichever the folder uses.
macro_rules! dispatch {
    ($app:ident, $path:ident, git($at:ident) => $git:expr, plastic($root:pat) => $plastic:expr) => {
        blocking(move || match detect(&$app, &$path)? {
            Backend::Plastic($root) => $plastic,
            Backend::Git($at) => $git,
        })
        .await
    };
}

#[tauri::command]
pub async fn git_status(app: AppHandle, path: String) -> Result<GitStatus, String> {
    dispatch!(app, path, git(at) => git::status_of(&at), plastic(root) => plastic::status(&root))
}

#[tauri::command]
pub async fn git_diff(app: AppHandle, path: String, file: String, staged: bool) -> Result<String, String> {
    dispatch!(app, path, git(at) => git::diff_of(&at, &file, staged), plastic(root) => plastic::diff(&root, &file))
}

#[tauri::command]
pub async fn git_stage(app: AppHandle, path: String, files: Vec<String>) -> Result<(), String> {
    dispatch!(app, path, git(at) => git::stage(&at, &files), plastic(root) => plastic::stage(&root, &files))
}

#[tauri::command]
pub async fn git_unstage(app: AppHandle, path: String, files: Vec<String>) -> Result<(), String> {
    dispatch!(app, path, git(at) => git::unstage(&at, &files), plastic(root) => plastic::unstage(&root, &files))
}

#[tauri::command]
pub async fn git_discard(app: AppHandle, path: String, files: Vec<String>) -> Result<(), String> {
    dispatch!(app, path, git(at) => git::discard(&at, &files), plastic(root) => plastic::discard(&root, &files))
}

/// Git commit, or Unity VCS checkin (no amend there).
#[tauri::command]
pub async fn git_commit(app: AppHandle, path: String, message: String, amend: bool) -> Result<String, String> {
    dispatch!(app, path, git(at) => git::commit(&at, &message, amend), plastic(root) => {
        if amend { plastic::unsupported("Amending a changeset") } else { plastic::checkin(&root, &message) }
    })
}

#[tauri::command]
pub async fn git_fetch(app: AppHandle, path: String) -> Result<String, String> {
    dispatch!(app, path, git(at) => git::fetch(&at), plastic(_root) => plastic::unsupported("Fetch"))
}

/// Git pull, or Unity VCS update.
#[tauri::command]
pub async fn git_pull(app: AppHandle, path: String) -> Result<String, String> {
    dispatch!(app, path, git(at) => git::pull(&at), plastic(root) => plastic::update(&root))
}

#[tauri::command]
pub async fn git_push(app: AppHandle, path: String) -> Result<String, String> {
    dispatch!(app, path, git(at) => git::push(&at), plastic(_root) => plastic::unsupported("Push"))
}

#[tauri::command]
pub async fn git_log(app: AppHandle, path: String, limit: u32) -> Result<Vec<GitCommit>, String> {
    dispatch!(app, path, git(at) => git::log(&at, limit), plastic(root) => plastic::log(&root, limit))
}

#[tauri::command]
pub async fn git_branches(app: AppHandle, path: String) -> Result<GitBranches, String> {
    dispatch!(app, path, git(at) => git::branches(&at), plastic(root) => plastic::branches(&root))
}

#[tauri::command]
pub async fn git_checkout(app: AppHandle, path: String, branch: String, create: bool) -> Result<(), String> {
    dispatch!(app, path, git(at) => git::checkout(&at, &branch, create), plastic(root) => plastic::checkout(&root, &branch, create))
}

/// Local and remote branches with upstream state, newest commit first.
#[tauri::command]
pub async fn git_branch_list(app: AppHandle, path: String) -> Result<GitBranchList, String> {
    dispatch!(app, path, git(at) => git::branch_list(&at), plastic(root) => plastic::branch_list(&root))
}

#[tauri::command]
pub async fn git_branch_create(app: AppHandle, path: String, name: String, from: Option<String>, checkout: bool) -> Result<(), String> {
    dispatch!(app, path, git(at) => git::branch_create(&at, &name, from.as_deref(), checkout),
        plastic(root) => plastic::branch_create(&root, &name, from.as_deref(), checkout))
}

/// Returns the name of the local branch that is now checked out.
#[tauri::command]
pub async fn git_checkout_remote(app: AppHandle, path: String, branch: String) -> Result<String, String> {
    dispatch!(app, path, git(at) => git::checkout_remote(&at, &branch), plastic(_root) => plastic::unsupported("Remote branches"))
}

#[tauri::command]
pub async fn git_merge(app: AppHandle, path: String, branch: String) -> Result<String, String> {
    dispatch!(app, path, git(at) => git::merge(&at, &branch), plastic(_root) => plastic::unsupported("Merging from Mango"))
}

#[tauri::command]
pub async fn git_rebase(app: AppHandle, path: String, onto: String) -> Result<String, String> {
    dispatch!(app, path, git(at) => git::rebase(&at, &onto), plastic(_root) => plastic::unsupported("Rebase"))
}

#[tauri::command]
pub async fn git_branch_rename(app: AppHandle, path: String, from: String, to: String) -> Result<(), String> {
    dispatch!(app, path, git(at) => git::branch_rename(&at, &from, &to), plastic(root) => plastic::branch_rename(&root, &from, &to))
}

#[tauri::command]
pub async fn git_branch_delete(app: AppHandle, path: String, branch: String, force: bool) -> Result<(), String> {
    dispatch!(app, path, git(at) => git::branch_delete(&at, &branch, force), plastic(root) => plastic::branch_delete(&root, &branch))
}

const NO_PLASTIC_WORKTREES: &str = "Worktrees are a git feature; Unity Version Control workspaces don't have them.";

/// The repository's worktrees, the main one first. Unity VCS has none.
#[tauri::command]
pub async fn git_worktrees(app: AppHandle, path: String) -> Result<Vec<GitWorktree>, String> {
    dispatch!(app, path, git(at) => git::worktrees(&at), plastic(_root) => Ok(Vec::new()))
}

/// Add a linked worktree for `branch` beside the repository (`<parent>/<repo>.worktrees/<branch>`).
#[tauri::command]
pub async fn git_worktree_add(app: AppHandle, path: String, branch: String, from: Option<String>, create: bool) -> Result<GitWorktree, String> {
    dispatch!(app, path, git(at) => git::worktree_add(&at, &branch, from.as_deref(), create),
        plastic(_root) => Err(NO_PLASTIC_WORKTREES.into()))
}

/// Remove the linked worktree in the folder `worktree`; its branch is kept.
#[tauri::command]
pub async fn git_worktree_remove(app: AppHandle, path: String, worktree: String, force: bool) -> Result<(), String> {
    dispatch!(app, path, git(at) => git::worktree_remove(&at, &worktree, force), plastic(_root) => Err(NO_PLASTIC_WORKTREES.into()))
}

/// How many commits the folder's branch has that `base` doesn't. Without `base`: compared with the
/// branch checked out in the repository's main working tree (what a linked worktree merges into).
#[tauri::command]
pub async fn git_ahead(app: AppHandle, path: String, base: Option<String>) -> Result<GitAhead, String> {
    dispatch!(app, path, git(at) => git::ahead_of(&at, base.as_deref()), plastic(_root) => Err(NO_PLASTIC_WORKTREES.into()))
}

/// `git init` in `path`. Does nothing when it is already under version control.
#[tauri::command]
pub async fn git_init(app: AppHandle, path: String) -> Result<(), String> {
    dispatch!(app, path, git(at) => git::init(&at), plastic(_root) => Ok(()))
}

const NO_GIT_LOCKS: &str = "Locks are a Unity Version Control feature; git has no file locks.";

/// Unity VCS: the locks in the workspace's repository. Empty for git.
#[tauri::command]
pub async fn vcs_locks(app: AppHandle, path: String) -> Result<Vec<plastic::locks::VcsLock>, String> {
    dispatch!(app, path, git(_at) => Ok(Vec::new()), plastic(root) => plastic::locks::locks(&root))
}

/// Unity VCS: lock files by checking them out. Returns a note when the server's
/// lock rules left some of them unlocked; empty when all are locked.
#[tauri::command]
pub async fn vcs_lock(app: AppHandle, path: String, files: Vec<String>) -> Result<String, String> {
    dispatch!(app, path, git(_at) => Err(NO_GIT_LOCKS.into()), plastic(root) => plastic::locks::lock(&root, &files))
}

/// Unity VCS: release the user's own locks on files.
#[tauri::command]
pub async fn vcs_unlock(app: AppHandle, path: String, files: Vec<String>) -> Result<(), String> {
    dispatch!(app, path, git(_at) => Err(NO_GIT_LOCKS.into()), plastic(root) => plastic::locks::unlock(&root, &files))
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
        // Both in one folder: git.
        std::fs::create_dir_all(ws.join(".git")).unwrap();
        assert_eq!(detect_on_disk(&ws), Some((Vcs::Git, ws.clone())));
        std::fs::remove_dir_all(&base).unwrap();
    }
}
