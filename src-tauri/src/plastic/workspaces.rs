//! Extra Unity VCS workspaces, one per chat: what linked worktrees are for git.
//!
//! A chat that runs on its own gets a new child branch and a workspace of the
//! same repository in a folder beside the project, laid out the way git's
//! worktrees are (`<parent>/<project>.worktrees/<name>`), switched to that
//! branch. Only workspaces in that folder and of the same repository are
//! listed or removed; the user's other workspaces are never touched.
//!
//! The `cm` commands:
//! - `cm workspace list --format={wkname}{tab}{path}`: every workspace of this client;
//! - `cm workspace create <name> <path> <repspec>`: a new, still empty workspace;
//! - `cm switch br:<branch> --noinput` in it: loads the branch's files (the slow part);
//! - `cm workspace delete <path>`: unregisters it and drops its `.plastic` metadata
//!   (the files stay on disk, so Mango deletes the folder itself).

use std::path::{Path, PathBuf};
use std::time::Duration;

use super::{all_branches, child_branch, cm, explain, key, last_status, read_status, safe_branch, staged, workspace_info};
use crate::git::{worktree_folder, GitWorktree};

/// A fresh workspace downloads every file of its branch: a big Unity project takes a while.
const LOAD_TIMEOUT: Duration = Duration::from_secs(60 * 60);
/// Reading the client's list of workspaces is local and quick.
const LIST_TIMEOUT: Duration = Duration::from_secs(30);
/// What every chat workspace's folder name ends with, beside its project.
const SIBLING_SUFFIX: &str = ".worktrees";

/// One line of `cm workspace list --format={wkname}{tab}{path}`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Registered {
    pub name: String,
    pub path: String,
}

pub(crate) fn parse_list(text: &str) -> Vec<Registered> {
    text.lines()
        .filter_map(|line| {
            let (name, path) = line.trim_end_matches('\r').split_once('\t')?;
            let (name, path) = (name.trim(), path.trim());
            (!name.is_empty() && !path.is_empty()).then(|| Registered { name: name.into(), path: path.into() })
        })
        .collect()
}

/// A workspace name from the project's folder and the chat's folder: letters, digits,
/// `-`, `_` and `.` only (`fruit stand` + `fix-login` → `fruit-stand-fix-login`), with
/// `-2`, `-3` … when the client already has one by that name (names are unique per client).
pub(crate) fn workspace_name(project: &str, leaf: &str, taken: &[String]) -> String {
    let clean = |s: &str| {
        let mapped: String = s.chars().map(|c| if c.is_ascii_alphanumeric() || "-_.".contains(c) { c } else { '-' }).collect();
        mapped.split('-').filter(|p| !p.is_empty()).collect::<Vec<_>>().join("-")
    };
    let mut base = [clean(project), clean(leaf)].into_iter().filter(|p| !p.is_empty()).collect::<Vec<_>>().join("-");
    base = base.trim_start_matches(['-', '.']).chars().take(80).collect();
    if base.is_empty() {
        base = "mango-chat".into();
    }
    let used = |n: &str| taken.iter().any(|t| t.eq_ignore_ascii_case(n));
    if !used(&base) {
        return base;
    }
    (2..1000).map(|i| format!("{base}-{i}")).find(|n| !used(n)).unwrap_or_else(|| format!("{base}-{}", uuid::Uuid::new_v4().simple()))
}

/// The folder name for a chat workspace of `branch` (a child name or a full path):
/// `/main/fix` → `main-fix`. Refuses anything that is not a plain folder name.
pub(crate) fn leaf_of(branch: &str) -> Result<String, String> {
    let leaf = branch.trim().trim_start_matches('/').replace(['/', '\\'], "-");
    if leaf.is_empty() || leaf.starts_with(['-', '.']) || leaf.contains("..") || leaf.chars().any(|c| c.is_control() || ":*?\"<>|".contains(c)) {
        return Err(format!("\"{branch}\" can't name a workspace folder"));
    }
    Ok(leaf)
}

/// A repository spec read from `cm`, safe to hand back to it as one argument.
fn safe_repo(repo: &str) -> Result<&str, String> {
    let ok = !repo.is_empty() && !repo.starts_with('-') && !repo.chars().any(|c| c.is_control() || c == '"');
    ok.then_some(repo).ok_or_else(|| format!("Unity VCS named an unexpected repository ({repo})"))
}

fn slash(p: &Path) -> String {
    p.to_string_lossy().replace('\\', "/").trim_end_matches('/').to_string()
}

/// The folder chat workspaces of `project` go in: `<parent>/<project>.worktrees`.
fn sibling_of(project: &Path) -> Result<String, String> {
    let any = worktree_folder(&slash(project), "x")?;
    Ok(any[..any.len() - 2].to_string())
}

/// The project workspace a folder belongs to: `root` itself, or, for a chat workspace
/// (`<parent>/<project>.worktrees/<name>`), the project beside that folder.
pub(crate) fn project_of(root: &Path) -> PathBuf {
    let up = root.parent().and_then(|sibling| {
        let name = sibling.file_name()?.to_str()?.strip_suffix(SIBLING_SUFFIX)?;
        let project = sibling.parent()?.join(name);
        (!name.is_empty() && project.join(".plastic").is_dir()).then_some(project)
    });
    up.unwrap_or_else(|| root.to_path_buf())
}

/// Every workspace this client knows of.
fn registered(project: &Path) -> Result<Vec<Registered>, String> {
    let out = cm(project)?
        .args(["workspace", "list", "--format={wkname}{tab}{path}"])
        .timeout(LIST_TIMEOUT)
        .run_ok("cm workspace list")?;
    Ok(parse_list(&out.text()))
}

/// The registered workspaces in the project's chat folder, with their folder as Mango
/// shows it (`<sibling>/<name>`, forward slashes, so it reads the same every time).
fn in_sibling(project: &Path) -> Result<Vec<(Registered, String)>, String> {
    let sibling = sibling_of(project)?;
    let want = key(Path::new(&sibling));
    Ok(registered(project)?
        .into_iter()
        .filter_map(|w| {
            let path = PathBuf::from(&w.path);
            let leaf = path.file_name()?.to_str()?.to_string();
            (key(path.parent()?) == want).then(|| (w, format!("{sibling}/{leaf}")))
        })
        .collect())
}

/// The workspaces chats work in: the project first (`is_main`), then each chat workspace
/// of the same repository beside it. A registered one whose folder is gone is `prunable`.
pub(crate) fn list(root: &Path) -> Result<Vec<GitWorktree>, String> {
    let project = project_of(root);
    let info = workspace_info(&project)?;
    let current = key(root);
    let mut out = vec![GitWorktree {
        path: project.to_string_lossy().into_owned(),
        branch: info.branch,
        head: info.changeset.map(|c| format!("cs:{c}")),
        is_main: true,
        is_current: key(&project) == current,
        locked: false,
        prunable: false,
    }];
    for (_, path) in in_sibling(&project)? {
        let dir = Path::new(&path);
        let gone = !dir.join(".plastic").is_dir();
        let here = if gone { None } else { workspace_info(dir).ok() };
        // Another repository's workspace that happens to sit there is not one of ours.
        if here.as_ref().is_some_and(|h| h.repository.is_some() && h.repository != info.repository) {
            continue;
        }
        out.push(GitWorktree {
            is_current: key(dir) == current,
            branch: here.as_ref().and_then(|h| h.branch.clone()),
            head: here.as_ref().and_then(|h| h.changeset).map(|c| format!("cs:{c}")),
            path,
            is_main: false,
            locked: false,
            prunable: gone,
        });
    }
    Ok(out)
}

/// Make a chat workspace: `branch` is a new child of `from` (the project's branch when
/// None) when `create`, or an existing branch. Its folder is
/// `<parent>/<project>.worktrees/<branch's last part>`, and it is left on that branch with
/// its files loaded. On failure nothing is left behind (a branch made here is deleted again).
pub(crate) fn add(root: &Path, branch: &str, from: Option<&str>, create: bool) -> Result<GitWorktree, String> {
    let project = project_of(root);
    let info = workspace_info(&project)?;
    let repo = safe_repo(info.repository.as_deref().ok_or("Unity VCS didn't say which repository this workspace uses")?)?.to_string();
    let full = if create {
        let parent = match from.map(str::trim).filter(|f| !f.is_empty()) {
            Some(f) => safe_branch(f)?,
            None => info.branch.clone().ok_or("The project's workspace isn't on a branch. Switch it to one first.")?,
        };
        child_branch(branch, &parent)?
    } else {
        safe_branch(branch)?
    };
    let leaf = leaf_of(if create && !branch.trim().starts_with('/') { branch } else { &full })?;
    let sibling = sibling_of(&project)?;
    let folder = format!("{sibling}/{leaf}");
    if Path::new(&folder).exists() {
        return Err(format!("{folder} already exists; pick another branch name"));
    }
    let known = registered(&project)?;
    if known.iter().any(|w| key(Path::new(&w.path)) == key(Path::new(&folder))) {
        return Err(format!("A workspace at {folder} already exists; pick another branch name"));
    }
    let exists = all_branches(&project)?.iter().any(|b| b.0 == full);
    if create && exists {
        return Err(format!("A branch named {full} already exists"));
    }
    if !create && !exists {
        return Err(format!("There is no branch named {full}"));
    }
    if create {
        cm(&project)?.args(["branch", "create"]).arg(&full).run_ok("cm branch create")?;
    }
    let undo_branch = || {
        if create {
            // Just made and still empty: Unity VCS deletes it, and would refuse otherwise.
            let _ = cm(&project).and_then(|c| c.args(["branch", "delete"]).arg(format!("br:{full}")).run());
        }
    };
    let taken: Vec<String> = known.into_iter().map(|w| w.name).collect();
    let project_name = project.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let name = workspace_name(&project_name, &leaf, &taken);
    if let Err(e) = std::fs::create_dir_all(&sibling) {
        undo_branch();
        return Err(format!("Couldn't create {sibling}: {e}"));
    }
    let made = cm(&project).and_then(|c| {
        c.args(["workspace", "create"]).arg(&name).arg(&folder).arg(&repo).run_ok("cm workspace create")
    });
    if let Err(e) = made {
        let _ = std::fs::remove_dir(&folder);
        let _ = std::fs::remove_dir(&sibling);
        undo_branch();
        return Err(e);
    }
    if let Err(e) = load(Path::new(&folder), &full) {
        // Half loaded is no use to anyone: take it all back.
        let _ = drop_workspace(&project, Path::new(&folder));
        let _ = std::fs::remove_dir(&sibling);
        undo_branch();
        return Err(e);
    }
    Ok(GitWorktree {
        path: folder,
        branch: Some(full),
        head: None,
        is_main: false,
        is_current: false,
        locked: false,
        prunable: false,
    })
}

/// Switch a fresh workspace to `branch`, which downloads its files.
fn load(dir: &Path, branch: &str) -> Result<(), String> {
    let out = cm(dir)?.timeout(LOAD_TIMEOUT).arg("switch").arg(format!("br:{branch}")).arg("--noinput").run();
    let out = match out {
        Ok(out) => out,
        Err(e) if e.contains("did not finish within") => {
            return Err(format!("Downloading {branch} into the new workspace took more than an hour, so Mango stopped it."))
        }
        Err(e) => return Err(e),
    };
    if !out.ok() {
        return Err(explain(out.error("cm switch")));
    }
    if workspace_info(dir)?.branch.as_deref() != Some(branch) {
        let detail = out.combined();
        return Err(explain(format!("Unity VCS didn't switch the new workspace to {branch}.\n\n{detail}").trim().to_string()));
    }
    Ok(())
}

/// Unregister a workspace (`cm workspace delete`, run from the project, never from inside
/// it) and delete its folder, which `cm` leaves on disk.
fn drop_workspace(project: &Path, dir: &Path) -> Result<(), String> {
    let out = cm(project)?.args(["workspace", "delete"]).arg(dir).run()?;
    // Already unregistered (deleted from the Unity VCS app, say): only the folder is left.
    if !out.ok() && dir.join(".plastic").is_dir() {
        return Err(explain(out.error("cm workspace delete")));
    }
    match std::fs::symlink_metadata(dir) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(format!("Couldn't read {}: {e}", dir.display())),
        Ok(meta) if meta.file_type().is_symlink() || !meta.is_dir() => {
            return Err(format!("{} is not a folder; Mango left it alone", dir.display()))
        }
        Ok(_) => std::fs::remove_dir_all(dir).map_err(|e| format!("Unity VCS let go of the workspace, but {} couldn't be deleted: {e}", dir.display()))?,
    }
    let k = key(dir);
    if let Ok(mut map) = staged().lock() {
        map.remove(&k);
    }
    if let Ok(mut map) = last_status().lock() {
        map.remove(&k);
    }
    Ok(())
}

/// Remove the chat workspace in the folder `workspace` (as [`list`] gives it); its branch
/// and changesets stay. Refuses the project itself, anything outside the project's chat
/// folder, and a workspace with pending changes (private files included) unless `force`.
pub(crate) fn remove(root: &Path, workspace: &str, force: bool) -> Result<(), String> {
    let project = project_of(root);
    let target = workspace.trim();
    if target.is_empty() {
        return Err("No workspace folder given".into());
    }
    let dir = PathBuf::from(target);
    if key(&dir) == key(&project) {
        return Err("The project's own workspace can't be removed here".into());
    }
    let ours = in_sibling(&project)?.into_iter().any(|(w, path)| key(Path::new(&path)) == key(&dir) || key(Path::new(&w.path)) == key(&dir));
    if !ours {
        return Err(format!("{target} is not a workspace Mango made for this project"));
    }
    if dir.join(".plastic").is_dir() {
        let here = workspace_info(&dir)?;
        let project_repo = workspace_info(&project)?.repository;
        if here.repository.is_some() && here.repository != project_repo {
            return Err(format!("{target} belongs to another repository; Mango left it alone"));
        }
        if !force {
            let pending = read_status(&dir)?.entries;
            if !pending.is_empty() {
                // "changes": the remove dialog offers "Remove anyway" on that word.
                let name = here.branch.unwrap_or_else(|| "This workspace".into());
                return Err(format!("{name} has pending changes; check them in or undo them first"));
            }
        }
    }
    drop_workspace(&project, &dir)?;
    // The chat folder goes too once the last workspace in it is gone.
    if let Ok(sibling) = sibling_of(&project) {
        let _ = std::fs::remove_dir(sibling);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_workspace_list() {
        let text = "game\t/home/me/game\r\ngame-fix-login\t/home/me/game.worktrees/fix-login\n\nbroken line\nwith space\tC:\\Users\\me\\My Game\n";
        assert_eq!(
            parse_list(text),
            vec![
                Registered { name: "game".into(), path: "/home/me/game".into() },
                Registered { name: "game-fix-login".into(), path: "/home/me/game.worktrees/fix-login".into() },
                Registered { name: "with space".into(), path: r"C:\Users\me\My Game".into() },
            ]
        );
    }

    #[test]
    fn names_workspaces() {
        assert_eq!(workspace_name("fruit-stand", "fix-the-login", &[]), "fruit-stand-fix-the-login");
        assert_eq!(workspace_name("Fruit Stand!", "main-fix", &[]), "Fruit-Stand-main-fix");
        assert_eq!(workspace_name("日本", "fix", &[]), "fix");
        assert_eq!(workspace_name("", "", &[]), "mango-chat");
        assert_eq!(workspace_name("-x", "y", &[]), "x-y");
        let taken = ["game-fix".to_string(), "GAME-FIX-2".to_string()];
        assert_eq!(workspace_name("game", "fix", &taken), "game-fix-3");
    }

    #[test]
    fn folder_names_from_branches() {
        assert_eq!(leaf_of("fix-the-login").unwrap(), "fix-the-login");
        assert_eq!(leaf_of("/main/feature/x").unwrap(), "main-feature-x");
        assert!(leaf_of("").is_err());
        assert!(leaf_of("..").is_err());
        assert!(leaf_of("-x").is_err());
        assert!(leaf_of("a:b").is_err());
    }

    #[test]
    fn chat_folder_sits_beside_the_project() {
        assert_eq!(sibling_of(Path::new("/home/me/game")).unwrap(), "/home/me/game.worktrees");
        assert_eq!(sibling_of(Path::new(r"C:\Users\me\game")).unwrap(), "C:/Users/me/game.worktrees");
        assert!(sibling_of(Path::new("/")).is_err());
    }

    #[test]
    fn finds_the_project_of_a_chat_workspace() {
        let base = std::env::temp_dir().join(format!("mango-plastic-wk-{}", uuid::Uuid::new_v4()));
        let project = base.join("game");
        let chat = base.join("game.worktrees").join("fix");
        std::fs::create_dir_all(project.join(".plastic")).unwrap();
        std::fs::create_dir_all(chat.join(".plastic")).unwrap();
        assert_eq!(project_of(&chat), project);
        assert_eq!(project_of(&project), project);
        // A folder that only looks like one: no project beside it.
        let lone = base.join("other.worktrees").join("x");
        std::fs::create_dir_all(&lone).unwrap();
        assert_eq!(project_of(&lone), lone);
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn repository_specs() {
        assert!(safe_repo("Crop Chop/Crop Chop@org@cloud").is_ok());
        assert!(safe_repo("-x").is_err());
        assert!(safe_repo("").is_err());
        assert!(safe_repo("a\"b").is_err());
    }

    /// Drives a real `cm`: set `MANGO_CM_WORKSPACE` to a throwaway workspace (on a branch,
    /// with no pending changes) and run
    /// `cargo test --lib plastic::workspaces::tests::real_cm_workspaces -- --ignored --nocapture`.
    /// It adds a chat workspace beside it on a new child branch, lists, and removes it.
    #[test]
    #[ignore]
    fn real_cm_workspaces() {
        let Some(root) = std::env::var_os("MANGO_CM_WORKSPACE").map(PathBuf::from) else {
            eprintln!("MANGO_CM_WORKSPACE is not set; skipping");
            return;
        };
        let id = uuid::Uuid::new_v4().simple().to_string()[..6].to_string();
        let leaf = format!("mango-wk-{id}");
        let made = add(&root, &leaf, None, true).unwrap();
        println!("made {} on {:?}", made.path, made.branch);
        assert!(Path::new(&made.path).join(".plastic").is_dir());
        let listed = list(&root).unwrap();
        assert!(listed[0].is_main && listed[0].is_current);
        assert!(listed.iter().any(|w| w.path == made.path && w.branch == made.branch));
        // Seen from inside the chat workspace, the project is still the main one.
        let inside = list(Path::new(&made.path)).unwrap();
        assert!(inside.iter().any(|w| w.path == made.path && w.is_current));
        // A pending private file stops a plain remove.
        std::fs::write(Path::new(&made.path).join("scratch.txt"), "x").unwrap();
        assert!(remove(&root, &made.path, false).unwrap_err().contains("pending changes"));
        remove(&root, &made.path, true).unwrap();
        assert!(!Path::new(&made.path).exists());
        assert!(!list(&root).unwrap().iter().any(|w| w.path == made.path));
        // The branch stays; it has no changesets, so it can go.
        let _ = super::super::branch_delete(&root, made.branch.as_deref().unwrap());
    }
}
