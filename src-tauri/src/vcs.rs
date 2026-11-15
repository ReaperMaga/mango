//! The source-control commands behind the Changes view, diffs and branch
//! popup. Each one works out which version control the folder is under and
//! hands the call to git (`git.rs`) or Unity VCS (`plastic.rs`), so the
//! frontend makes the same calls and gets the same shapes either way.

use std::path::{Path, PathBuf};

use crate::git::{self, blocking, GitBranchList, GitBranches, GitCommit, GitStatus, Vcs};
use crate::plastic;

/// Where a folder's version control lives.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Backend {
    /// A git work tree, or no version control at all (git is what `init` creates).
    Git,
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

pub(crate) fn detect(path: &str) -> Backend {
    let dir = PathBuf::from(path.trim());
    match detect_on_disk(&dir) {
        Some((Vcs::Plastic, root)) => Backend::Plastic(root),
        Some((Vcs::Git, _)) => Backend::Git,
        // Not on disk: maybe a workspace whose metadata lives elsewhere.
        None if dir.is_dir() => plastic::workspace_by_cm(&dir).map_or(Backend::Git, Backend::Plastic),
        None => Backend::Git,
    }
}

/// Run `git` or `plastic` off the UI thread, for whichever the folder uses.
macro_rules! dispatch {
    ($path:ident, git => $git:expr, plastic($root:pat) => $plastic:expr) => {
        blocking(move || match detect(&$path) {
            Backend::Plastic($root) => $plastic,
            Backend::Git => $git,
        })
        .await
    };
}

#[tauri::command]
pub async fn git_status(path: String) -> Result<GitStatus, String> {
    dispatch!(path, git => git::status_of(&path), plastic(root) => plastic::status(&root))
}

#[tauri::command]
pub async fn git_diff(path: String, file: String, staged: bool) -> Result<String, String> {
    dispatch!(path, git => git::diff_of(&path, &file, staged), plastic(root) => plastic::diff(&root, &file))
}

#[tauri::command]
pub async fn git_stage(path: String, files: Vec<String>) -> Result<(), String> {
    dispatch!(path, git => git::stage(&path, &files), plastic(root) => plastic::stage(&root, &files))
}

#[tauri::command]
pub async fn git_unstage(path: String, files: Vec<String>) -> Result<(), String> {
    dispatch!(path, git => git::unstage(&path, &files), plastic(root) => plastic::unstage(&root, &files))
}

#[tauri::command]
pub async fn git_discard(path: String, files: Vec<String>) -> Result<(), String> {
    dispatch!(path, git => git::discard(&path, &files), plastic(root) => plastic::discard(&root, &files))
}

/// Git commit, or Unity VCS checkin (no amend there).
#[tauri::command]
pub async fn git_commit(path: String, message: String, amend: bool) -> Result<String, String> {
    dispatch!(path, git => git::commit(&path, &message, amend), plastic(root) => {
        if amend { plastic::unsupported("Amending a changeset") } else { plastic::checkin(&root, &message) }
    })
}

#[tauri::command]
pub async fn git_fetch(path: String) -> Result<String, String> {
    dispatch!(path, git => git::fetch(&path), plastic(_root) => plastic::unsupported("Fetch"))
}

/// Git pull, or Unity VCS update.
#[tauri::command]
pub async fn git_pull(path: String) -> Result<String, String> {
    dispatch!(path, git => git::pull(&path), plastic(root) => plastic::update(&root))
}

#[tauri::command]
pub async fn git_push(path: String) -> Result<String, String> {
    dispatch!(path, git => git::push(&path), plastic(_root) => plastic::unsupported("Push"))
}

#[tauri::command]
pub async fn git_log(path: String, limit: u32) -> Result<Vec<GitCommit>, String> {
    dispatch!(path, git => git::log(&path, limit), plastic(root) => plastic::log(&root, limit))
}

#[tauri::command]
pub async fn git_branches(path: String) -> Result<GitBranches, String> {
    dispatch!(path, git => git::branches(&path), plastic(root) => plastic::branches(&root))
}

#[tauri::command]
pub async fn git_checkout(path: String, branch: String, create: bool) -> Result<(), String> {
    dispatch!(path, git => git::checkout(&path, &branch, create), plastic(root) => plastic::checkout(&root, &branch, create))
}

/// Local and remote branches with upstream state, newest commit first.
#[tauri::command]
pub async fn git_branch_list(path: String) -> Result<GitBranchList, String> {
    dispatch!(path, git => git::branch_list(&path), plastic(root) => plastic::branch_list(&root))
}

#[tauri::command]
pub async fn git_branch_create(path: String, name: String, from: Option<String>, checkout: bool) -> Result<(), String> {
    dispatch!(path, git => git::branch_create(&path, &name, from.as_deref(), checkout),
        plastic(root) => plastic::branch_create(&root, &name, from.as_deref(), checkout))
}

/// Returns the name of the local branch that is now checked out.
#[tauri::command]
pub async fn git_checkout_remote(path: String, branch: String) -> Result<String, String> {
    dispatch!(path, git => git::checkout_remote(&path, &branch), plastic(_root) => plastic::unsupported("Remote branches"))
}

#[tauri::command]
pub async fn git_merge(path: String, branch: String) -> Result<String, String> {
    dispatch!(path, git => git::merge(&path, &branch), plastic(_root) => plastic::unsupported("Merging from Mango"))
}

#[tauri::command]
pub async fn git_rebase(path: String, onto: String) -> Result<String, String> {
    dispatch!(path, git => git::rebase(&path, &onto), plastic(_root) => plastic::unsupported("Rebase"))
}

#[tauri::command]
pub async fn git_branch_rename(path: String, from: String, to: String) -> Result<(), String> {
    dispatch!(path, git => git::branch_rename(&path, &from, &to), plastic(root) => plastic::branch_rename(&root, &from, &to))
}

#[tauri::command]
pub async fn git_branch_delete(path: String, branch: String, force: bool) -> Result<(), String> {
    dispatch!(path, git => git::branch_delete(&path, &branch, force), plastic(root) => plastic::branch_delete(&root, &branch))
}

/// `git init` in `path`. Does nothing when it is already under version control.
#[tauri::command]
pub async fn git_init(path: String) -> Result<(), String> {
    dispatch!(path, git => git::init(&path), plastic(_root) => Ok(()))
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
