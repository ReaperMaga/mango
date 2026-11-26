//! Locks (exclusive checkouts). Unity scenes, prefabs and binary assets can't
//! be merged, so a server's lock rules make `cm checkout` lock the files they
//! cover: nobody else can check them out until the lock is released, by a
//! checkin (on a task branch the lock is kept as "Retained" until the change
//! reaches the destination branch) or by `cm lock unlock`.
//!
//! What Mango does with them:
//! - lists the repository's locks (`cm lock list`, every status, in the
//!   machine-readable smart-lock layout split on control characters);
//! - locks files by checking them out (`cm checkout`): a plain user can't
//!   create a lock any other way, and the server's rules decide whether the
//!   checkout locks. When it didn't, the result says so;
//! - releases the user's own locks (`cm lock unlock itemid:…`). Releasing
//!   someone else's is for server administrators, so it is refused here.
//!
//! The lock rules themselves live on the server and no `cm` command edits them.

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use super::{cm, key, parse_date, path_arg, rel_path, workspace_info};
use crate::git::clean_rel;

/// Between fields and after each record: control characters never appear in names or paths.
const FIELD: char = '\u{1f}';
const RECORD: char = '\u{1e}';
/// Lock reads ask the server; don't let a slow one hold the Changes view for long.
const LOCK_TIMEOUT: Duration = Duration::from_secs(30);

pub use crate::vcs::VcsLock;

/// The arguments that make `cm lock list` print one record per lock in the
/// smart-lock layout (`parse_locks`).
fn list_args(repository: &str) -> Vec<String> {
    vec![
        "lock".into(),
        "list".into(),
        // Retained locks block other people's checkouts too.
        "--anystatus".into(),
        format!("--repository={repository}"),
        "--machinereadable".into(),
        "--smartlocks".into(),
        format!("--fieldseparator={FIELD}"),
        format!("--endlineseparator={RECORD}"),
        "--dateformat=yyyy-MM-ddTHH:mm:sszzz".into(),
    ]
}

/// Parse `cm lock list --machinereadable --smartlocks` output. Fields, in
/// order: repository, item id, GUID, date, destination branch, its revision,
/// holder branch, its revision, status, user, workspace, server path.
/// `me` is the signed-in user, to mark their own locks.
pub(crate) fn parse_locks(text: &str, me: Option<&str>) -> Vec<VcsLock> {
    let mut out: Vec<VcsLock> = Vec::new();
    for record in text.split(RECORD) {
        let fields: Vec<&str> = record.split(FIELD).map(str::trim).collect();
        let [_repo, item, _guid, date, _dst, _dst_rev, holder, _holder_rev, status, owner, workspace, path, ..] = fields[..] else {
            continue;
        };
        let Ok(item_id) = item.parse::<u64>() else { continue };
        // Server paths start at the repository root, which is the workspace root.
        let Some(path) = rel_path(path.trim_start_matches('/')) else { continue };
        let lock = VcsLock {
            path,
            owner: owner.to_string(),
            workspace: workspace.to_string(),
            branch: holder.to_string(),
            status: if status.eq_ignore_ascii_case("retained") { "retained" } else { "locked" },
            time: parse_date(date),
            mine: me.is_some_and(|me| !me.is_empty() && me.eq_ignore_ascii_case(owner)),
            item_id,
        };
        // An item holds one lock per destination branch; show it once, a current one first.
        match out.iter_mut().find(|l| l.path == lock.path) {
            Some(seen) if seen.status == "retained" && lock.status == "locked" => *seen = lock,
            Some(_) => {}
            None => out.push(lock),
        }
    }
    out.sort_by(|a, b| a.path.cmp(&b.path));
    out
}

// ---------------------------------------------------------------------------
// What is asked once per workspace
// ---------------------------------------------------------------------------

fn cached(map: &'static OnceLock<Mutex<HashMap<String, String>>>, root: &Path, read: impl FnOnce() -> Result<String, String>) -> Result<String, String> {
    let map = map.get_or_init(Default::default);
    if let Some(v) = map.lock().ok().and_then(|m| m.get(&key(root)).cloned()) {
        return Ok(v);
    }
    let v = read()?;
    if let Ok(mut m) = map.lock() {
        m.insert(key(root), v.clone());
    }
    Ok(v)
}

/// The repository the workspace is bound to, e.g. "game@org@cloud".
fn repository(root: &Path) -> Result<String, String> {
    static REPO: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    cached(&REPO, root, || {
        workspace_info(root)?
            .repository
            .ok_or_else(|| "Couldn't tell which Unity VCS repository this workspace is bound to.".to_string())
    })
}

/// The user `cm` is signed in as, for the workspace's server (`cm whoami`).
fn whoami(root: &Path) -> Option<String> {
    static ME: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    cached(&ME, root, || {
        let out = cm(root)?.arg("whoami").timeout(LOCK_TIMEOUT).run_ok("cm whoami")?;
        Some(out.line().trim().to_string()).filter(|u| !u.is_empty()).ok_or_else(|| "cm whoami printed nothing".to_string())
    })
    .ok()
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Every lock in the workspace's repository, by path.
pub(crate) fn locks(root: &Path) -> Result<Vec<VcsLock>, String> {
    let repo = repository(root)?;
    let out = cm(root)?.args(list_args(&repo)).timeout(LOCK_TIMEOUT).run_ok("cm lock list")?;
    Ok(parse_locks(&out.text(), whoami(root).as_deref()))
}

fn checked(files: &[String]) -> Result<(), String> {
    if files.is_empty() {
        return Err("Pick the files to lock or unlock".into());
    }
    for f in files {
        clean_rel(f)?;
    }
    Ok(())
}

fn name_of(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

fn held_by(lock: &VcsLock) -> String {
    let mut who = lock.owner.clone();
    if !lock.workspace.is_empty() {
        who.push_str(&format!(" (workspace {})", lock.workspace));
    }
    who
}

/// Lock files by checking them out. Files someone else holds are refused up
/// front with who holds them. Returns what is worth telling: the files the
/// server's lock rules don't cover (checked out, but not locked); empty when
/// everything locked.
pub(crate) fn lock(root: &Path, files: &[String]) -> Result<String, String> {
    checked(files)?;
    let before = locks(root)?;
    for f in files {
        if let Some(l) = before.iter().find(|l| &l.path == f && !l.mine) {
            return Err(format!(
                "{} is locked by {}. Ask them to check it in or release the lock.",
                name_of(f),
                held_by(l)
            ));
        }
    }
    let todo: Vec<String> = files
        .iter()
        .filter(|f| !before.iter().any(|l| &l.path == *f && l.mine && l.status == "locked"))
        .map(|f| path_arg(f))
        .collect();
    if todo.is_empty() {
        return Ok(String::new());
    }
    cm(root)?.arg("checkout").args(&todo).timeout(LOCK_TIMEOUT).run_ok("cm checkout")?;
    let after = locks(root)?;
    let unlocked: Vec<&str> = files
        .iter()
        .filter(|f| !after.iter().any(|l| &l.path == *f && l.mine))
        .map(|f| name_of(f))
        .collect();
    Ok(match unlocked.as_slice() {
        [] => String::new(),
        [one] => format!(
            "Checked out {one}, but it isn't locked.\nThe server's lock rules don't cover this file. An administrator sets them in the Unity Cloud dashboard (or the server's lock.conf)."
        ),
        many => format!(
            "Checked out {} files, but {} of them aren't locked: {}.\nThe server's lock rules don't cover them. An administrator sets them in the Unity Cloud dashboard (or the server's lock.conf).",
            files.len(),
            many.len(),
            many.join(", ")
        ),
    })
}

/// Release the user's own locks on `files`; the files stay as they are.
pub(crate) fn unlock(root: &Path, files: &[String]) -> Result<(), String> {
    checked(files)?;
    let repo = repository(root)?;
    let held = locks(root)?;
    let mut specs = Vec::new();
    for f in files {
        let Some(l) = held.iter().find(|l| &l.path == f) else {
            return Err(format!("{} isn't locked.", name_of(f)));
        };
        if !l.mine {
            return Err(format!(
                "{} is locked by {}. Only they, or a server administrator, can release it.",
                name_of(f),
                held_by(l)
            ));
        }
        specs.push(format!("itemid:{}@{repo}", l.item_id));
    }
    cm(root)?.args(["lock", "unlock"]).args(&specs).timeout(LOCK_TIMEOUT).run_ok("cm lock unlock")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(fields: [&str; 12]) -> String {
        format!("{}{RECORD}\n", fields.join(&FIELD.to_string()))
    }

    #[test]
    fn parses_lock_list() {
        let text = [
            record(["fruit-stand", "118", "f1d0", "2026-09-25T10:00:00+02:00", "/main", "-1", "/main/task1", "-1", "Locked", "priya@orchard.studio", "priya-wk", "/Assets/Scenes/Farm.unity"]),
            record([" fruit-stand", "7", "aa01", "2026-09-24T08:30:00Z", "/main", "12", "/main/art", "14", "Retained", "sam", "sam-wk", "/Assets/Art/Barn Ü.psd"]),
            record(["fruit-stand", "9", "bb02", "2026-09-25T09:00:00+00:00", "/main", "-1", "/main", "-1", "Locked", "You@Orchard.Studio", "you-wk", "/Assets/Scripts/Inventory/InventoryGrid.cs "]),
            // Not a lock line: fewer fields, a bad id, the repository root.
            "Total: 3".into(),
            record(["fruit-stand", "x", "cc03", "", "/main", "-1", "/main", "-1", "Locked", "a", "b", "/a.txt"]),
            record(["fruit-stand", "1", "dd04", "", "/main", "-1", "/main", "-1", "Locked", "a", "b", "/"]),
        ]
        .concat();
        let locks = parse_locks(&text, Some("you@orchard.studio"));
        assert_eq!(locks.len(), 3, "{locks:?}");
        let farm = locks.iter().find(|l| l.path == "Assets/Scenes/Farm.unity").unwrap();
        assert_eq!(
            farm,
            &VcsLock {
                path: "Assets/Scenes/Farm.unity".into(),
                owner: "priya@orchard.studio".into(),
                workspace: "priya-wk".into(),
                branch: "/main/task1".into(),
                status: "locked",
                time: Some(1_790_323_200_000), // 2026-09-25T08:00:00Z
                mine: false,
                item_id: 118,
            }
        );
        let barn = locks.iter().find(|l| l.path == "Assets/Art/Barn Ü.psd").unwrap();
        assert_eq!((barn.status, barn.item_id, barn.mine), ("retained", 7, false));
        let mine = locks.iter().find(|l| l.path == "Assets/Scripts/Inventory/InventoryGrid.cs").unwrap();
        assert!(mine.mine);
        assert!(locks.windows(2).all(|w| w[0].path < w[1].path));
        // Nobody known: nothing is mine.
        assert!(parse_locks(&text, None).iter().all(|l| !l.mine));
        assert!(parse_locks("", Some("me")).is_empty());
    }

    #[test]
    fn one_row_per_file_current_lock_first() {
        let text = [
            record(["r", "5", "g", "", "/main", "-1", "/main/a", "-1", "Retained", "sam", "w1", "/A.unity"]),
            record(["r", "5", "g", "", "/main/release", "-1", "/main/b", "-1", "Locked", "ana", "w2", "/A.unity"]),
        ]
        .concat();
        let locks = parse_locks(&text, None);
        assert_eq!(locks.len(), 1);
        assert_eq!((locks[0].owner.as_str(), locks[0].status), ("ana", "locked"));
    }

    #[test]
    fn list_arguments() {
        let args = list_args("game@org@cloud");
        assert_eq!(&args[..4], ["lock", "list", "--anystatus", "--repository=game@org@cloud"]);
        assert!(args.contains(&"--fieldseparator=\u{1f}".to_string()));
        assert!(args.contains(&"--smartlocks".to_string()));
    }

    #[test]
    fn refuses_paths_outside_the_workspace() {
        assert!(checked(&[]).is_err());
        assert!(checked(&["../x".into()]).is_err());
        assert!(checked(&["/etc/passwd".into()]).is_err());
        assert!(checked(&["Assets/a b.unity".into()]).is_ok());
    }

    /// Against a real workspace whose server has a lock rule covering
    /// `MANGO_CM_LOCK_FILE` (a checked-in file, relative to the root):
    /// `MANGO_CM_WORKSPACE=… MANGO_CM_LOCK_FILE=… cargo test --lib plastic::locks::tests::real_locks -- --ignored --nocapture`.
    /// It checks the file out (taking the lock), lists, releases and undoes the checkout.
    #[test]
    #[ignore]
    fn real_locks() {
        let (Some(root), Some(file)) = (std::env::var_os("MANGO_CM_WORKSPACE"), std::env::var("MANGO_CM_LOCK_FILE").ok()) else {
            eprintln!("MANGO_CM_WORKSPACE or MANGO_CM_LOCK_FILE is not set; skipping");
            return;
        };
        let root = std::path::PathBuf::from(root);
        println!("locks before: {:?}", locks(&root).unwrap());
        let said = lock(&root, std::slice::from_ref(&file)).unwrap();
        println!("lock: {said:?}");
        let held = locks(&root).unwrap();
        let l = held.iter().find(|l| l.path == file).expect("the file should be locked");
        assert!(l.mine && l.status == "locked", "{l:?}");
        unlock(&root, std::slice::from_ref(&file)).unwrap();
        assert!(!locks(&root).unwrap().iter().any(|l| l.path == file && l.status == "locked"));
        super::super::discard(&root, std::slice::from_ref(&file)).unwrap();
    }
}
